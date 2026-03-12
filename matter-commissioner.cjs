/**
 * Matter Commissioner 模块
 * 基于 matter.js CommissioningController 实现完整的 Matter Commissioner 功能
 * 直接通过 BLE/IP 与 Matter 设备通信，无需 SSH 中间层
 * 
 * 与 matter-controller.cjs (SSH 模式) 完全独立，互不影响
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

process.on('unhandledRejection', (reason, promise) => {
    console.error('[Global Error] Unhandled Rejection at:', promise, 'reason:', reason);
    if (reason && reason.stack) {
        console.error(reason.stack);
    }
});

// Commissioner 独立存储目录（与 SSH 模式隔离）
const COMMISSIONER_STORAGE_PATH = path.join(os.homedir(), '.iot-nexus-core', 'commissioner-storage');

// 状态变量
let commissioningController = null;
let environment = null;
let isInitialized = false;
let connectedNodes = new Map(); // nodeId(string) -> PairedNode
let bleAvailable = false;
let masterWin = null; // Reference for sending IPC logs
let commissioningAbortController = null; // { aborted: boolean, reject: Function }

const waitWithTimeout = async (promise, ms, rejectMsg = 'timeout') => {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(rejectMsg)), ms))
    ]);
};

// === Log Interceptor ===
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
const stripAnsi = (str) => typeof str === 'string' ? str.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') : String(str);

function forwardLog(level, ...args) {
    try {
        if (masterWin && !masterWin.isDestroyed()) {
            const rawMsg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
            const msg = stripAnsi(rawMsg);

            let stage = 'SYS';
            let type = 'info';

            if (msg.includes('[Commissioner]')) {
                stage = 'CMS';
                if (level === 'error') type = 'error';
                else if (level === 'warn') type = 'progress';
                else type = 'info';
            } else if (msg.match(/(DEBUG|INFO|NOTICE|WARN|ERROR|FATAL)/)) {
                const m = msg.match(/(DEBUG|INFO|NOTICE|WARN|ERROR|FATAL)\s+([a-zA-Z0-9_]+)\s/);
                stage = m ? m[2] : 'SDK';
                if (msg.includes('ERROR') || msg.includes('FATAL')) type = 'error';
                else if (msg.includes('WARN')) type = 'progress';
                else if (msg.includes('DEBUG')) type = 'debug';
                else type = 'info';
            } else {
                stage = 'RAW';
                type = 'debug';
            }

            if (masterWin.webContents) {
                masterWin.webContents.send('commissioner:log', {
                    stage,
                    message: msg,
                    type,
                    timestamp: new Date().toLocaleTimeString('en-US', { hour12: false })
                });
            }
        }
    } catch (e) {
        // ignore telemetry errors
    }
}

console.log = function (...args) {
    try { originalLog.apply(console, args); } catch (e) { }
    forwardLog('info', ...args);
};
console.warn = function (...args) {
    try { originalWarn.apply(console, args); } catch (e) { }
    forwardLog('warn', ...args);
};
console.error = function (...args) {
    try { originalError.apply(console, args); } catch (e) { }
    forwardLog('error', ...args);
};
const originalDebug = console.debug;
if (originalDebug) {
    console.debug = function (...args) {
        try { originalDebug.apply(console, args); } catch (e) { }
        forwardLog('debug', ...args);
    };
} else {
    console.debug = function (...args) {
        try { originalLog.apply(console, args); } catch (e) { }
        forwardLog('debug', ...args);
    };
}
// ========================

// 延迟加载的模块引用（CJS require 方式）
let _matterMain = null;
let _matterProtocol = null;
let _matterClusters = null;
let _matterTypes = null;
let _matterNodejs = null;
let _matterNodejsBle = null;
let _matterJs = null;
let _matterJsDevice = null;

/**
 * 延迟加载 matter.js 模块
 * 避免启动时就加载所有依赖，减少启动时间
 */
function loadMatterModules() {
    if (_matterMain) return; // 已加载

    try {
        _matterMain = require('@matter/main');
        _matterProtocol = require('@matter/main/protocol');
        _matterClusters = require('@matter/main/clusters');
        _matterTypes = require('@matter/main/types');
        _matterNodejs = require('@matter/nodejs');
        _matterJs = require('@project-chip/matter.js');
        _matterJsDevice = require('@project-chip/matter.js/device');

        console.log('[Commissioner] Matter modules loaded successfully');
    } catch (error) {
        console.error('[Commissioner] Failed to load matter modules:', error);
        throw error;
    }

    // 尝试加载 BLE 模块（可选）
    try {
        _matterNodejsBle = require('@matter/nodejs-ble');
        console.log('[Commissioner] BLE module loaded');
    } catch (error) {
        console.warn('[Commissioner] BLE module not available:', error.message);
        _matterNodejsBle = null;
    }

    // Electron BoringSSL 兼容性补丁：修复 aes-128-ccm 不可用问题
    patchCryptoForElectron();
}

/**
 * Electron 使用 BoringSSL 而非 OpenSSL，BoringSSL 不支持 aes-128-ccm。
 * Matter 协议要求 AES-128-CCM 进行安全通信。
 * 此函数检测是否缺少 CCM 支持，并用纯 JS 实现替代。
 * 
 * 实现基于 RFC 3610 (AES-CCM)，使用 aes-128-ecb 作为底层分组密码。
 */
function patchCryptoForElectron() {
    const crypto = require('crypto');

    // 检查是否支持 aes-128-ccm
    if (crypto.getCiphers().includes('aes-128-ccm')) {
        console.log('[Commissioner] Native aes-128-ccm supported, no patch needed');
        return;
    }

    console.log('[Commissioner] aes-128-ccm NOT supported (Electron/BoringSSL). Applying JS CCM patch...');

    // ---- 纯 JS AES-128-CCM 实现 (RFC 3610) ----

    /**
     * AES block encrypt (单个 16 字节块)
     * 使用 Node 原生 aes-128-ecb（BoringSSL 支持 ECB 模式）
     */
    function aesEncryptBlock(key, block) {
        const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
        cipher.setAutoPadding(false);
        return Buffer.concat([cipher.update(block), cipher.final()]);
    }

    /**
     * AES-128-CCM Encrypt (RFC 3610)
     * @param {Buffer} key - 16 字节密钥
     * @param {Buffer} plaintext - 明文
     * @param {Buffer} nonce - 13 字节 nonce
     * @param {Buffer} aad - 附加认证数据
     * @param {number} tagLength - 认证标签长度（16）
     * @returns {Buffer} 密文 + 认证标签
     */
    function aesCcmEncrypt(key, plaintext, nonce, aad, tagLength) {
        const M = tagLength;  // MAC length
        const L = 15 - nonce.length;  // Length field size (2 for 13-byte nonce)
        const hasAad = aad && aad.length > 0;

        // 1. 构造 CBC-MAC (Authentication)
        // 构造 B_0 (Flags | Nonce | Q)
        const flags0 = ((hasAad ? 1 : 0) << 6) | (((M - 2) / 2) << 3) | (L - 1);
        const b0 = Buffer.alloc(16);
        b0[0] = flags0;
        nonce.copy(b0, 1);
        // 写入 plaintext 长度 (big-endian, L bytes)
        let pLen = plaintext.length;
        for (let i = 15; i >= 16 - L; i--) {
            b0[i] = pLen & 0xff;
            pLen >>>= 8;
        }

        // CBC-MAC: X_1 = E(K, B_0)
        let x = aesEncryptBlock(key, b0);

        // 处理 AAD
        if (hasAad) {
            let aadBuf;
            if (aad.length < 0xff00) {
                // 2 字节长度前缀
                aadBuf = Buffer.alloc(2 + aad.length);
                aadBuf.writeUInt16BE(aad.length, 0);
                aad.copy(aadBuf, 2);
            } else {
                // 6 字节长度前缀
                aadBuf = Buffer.alloc(6 + aad.length);
                aadBuf.writeUInt16BE(0xfffe, 0);
                aadBuf.writeUInt32BE(aad.length, 2);
                aad.copy(aadBuf, 6);
            }
            // 补齐到 16 字节边界
            const padLen = (16 - (aadBuf.length % 16)) % 16;
            if (padLen > 0) {
                aadBuf = Buffer.concat([aadBuf, Buffer.alloc(padLen)]);
            }
            // 分块处理 CBC-MAC
            for (let i = 0; i < aadBuf.length; i += 16) {
                const block = aadBuf.slice(i, i + 16);
                const xored = Buffer.alloc(16);
                for (let j = 0; j < 16; j++) {
                    xored[j] = x[j] ^ block[j];
                }
                x = aesEncryptBlock(key, xored);
            }
        }

        // 处理 plaintext 块
        if (plaintext.length > 0) {
            let ptPadded = Buffer.from(plaintext);
            const padLen = (16 - (ptPadded.length % 16)) % 16;
            if (padLen > 0) {
                ptPadded = Buffer.concat([ptPadded, Buffer.alloc(padLen)]);
            }
            for (let i = 0; i < ptPadded.length; i += 16) {
                const block = ptPadded.slice(i, i + 16);
                const xored = Buffer.alloc(16);
                for (let j = 0; j < 16; j++) {
                    xored[j] = x[j] ^ block[j];
                }
                x = aesEncryptBlock(key, xored);
            }
        }

        // T = 前 M 字节的 X
        const T = x.slice(0, M);

        // 2. CTR 模式加密
        // A_0: Flags | Nonce | Counter(0)
        const a0 = Buffer.alloc(16);
        a0[0] = L - 1;
        nonce.copy(a0, 1);
        // counter = 0 (已经是0)

        // S_0 = E(K, A_0) -- 用于加密 MAC
        const s0 = aesEncryptBlock(key, a0);

        // 加密 plaintext 用 CTR 模式 (counter 从 1 开始)
        const ciphertext = Buffer.alloc(plaintext.length);
        for (let i = 0; i < plaintext.length; i += 16) {
            const counter = Math.floor(i / 16) + 1;
            const ai = Buffer.alloc(16);
            ai[0] = L - 1;
            nonce.copy(ai, 1);
            // 写入 counter (big-endian, L bytes)
            let c = counter;
            for (let j = 15; j >= 16 - L; j--) {
                ai[j] = c & 0xff;
                c >>>= 8;
            }
            const si = aesEncryptBlock(key, ai);
            const len = Math.min(16, plaintext.length - i);
            for (let j = 0; j < len; j++) {
                ciphertext[i + j] = plaintext[i + j] ^ si[j];
            }
        }

        // 用 S_0 加密 MAC
        const encryptedTag = Buffer.alloc(M);
        for (let j = 0; j < M; j++) {
            encryptedTag[j] = T[j] ^ s0[j];
        }

        return Buffer.concat([ciphertext, encryptedTag]);
    }

    /**
     * AES-128-CCM Decrypt (RFC 3610)
     */
    function aesCcmDecrypt(key, ciphertextWithTag, nonce, aad, tagLength) {
        const M = tagLength;
        const L = 15 - nonce.length;
        const hasAad = aad && aad.length > 0;

        const ciphertext = ciphertextWithTag.slice(0, ciphertextWithTag.length - M);
        const receivedTag = ciphertextWithTag.slice(ciphertextWithTag.length - M);

        // 1. CTR 解密
        const a0 = Buffer.alloc(16);
        a0[0] = L - 1;
        nonce.copy(a0, 1);
        const s0 = aesEncryptBlock(key, a0);

        const plaintext = Buffer.alloc(ciphertext.length);
        for (let i = 0; i < ciphertext.length; i += 16) {
            const counter = Math.floor(i / 16) + 1;
            const ai = Buffer.alloc(16);
            ai[0] = L - 1;
            nonce.copy(ai, 1);
            let c = counter;
            for (let j = 15; j >= 16 - L; j--) {
                ai[j] = c & 0xff;
                c >>>= 8;
            }
            const si = aesEncryptBlock(key, ai);
            const len = Math.min(16, ciphertext.length - i);
            for (let j = 0; j < len; j++) {
                plaintext[i + j] = ciphertext[i + j] ^ si[j];
            }
        }

        // 2. 解密 MAC tag
        const decryptedTag = Buffer.alloc(M);
        for (let j = 0; j < M; j++) {
            decryptedTag[j] = receivedTag[j] ^ s0[j];
        }

        // 3. 验证 CBC-MAC
        const flags0 = ((hasAad ? 1 : 0) << 6) | (((M - 2) / 2) << 3) | (L - 1);
        const b0 = Buffer.alloc(16);
        b0[0] = flags0;
        nonce.copy(b0, 1);
        let pLen = plaintext.length;
        for (let i = 15; i >= 16 - L; i--) {
            b0[i] = pLen & 0xff;
            pLen >>>= 8;
        }

        let x = aesEncryptBlock(key, b0);

        if (hasAad) {
            let aadBuf;
            if (aad.length < 0xff00) {
                aadBuf = Buffer.alloc(2 + aad.length);
                aadBuf.writeUInt16BE(aad.length, 0);
                aad.copy(aadBuf, 2);
            } else {
                aadBuf = Buffer.alloc(6 + aad.length);
                aadBuf.writeUInt16BE(0xfffe, 0);
                aadBuf.writeUInt32BE(aad.length, 2);
                aad.copy(aadBuf, 6);
            }
            const padLen = (16 - (aadBuf.length % 16)) % 16;
            if (padLen > 0) {
                aadBuf = Buffer.concat([aadBuf, Buffer.alloc(padLen)]);
            }
            for (let i = 0; i < aadBuf.length; i += 16) {
                const block = aadBuf.slice(i, i + 16);
                const xored = Buffer.alloc(16);
                for (let j = 0; j < 16; j++) {
                    xored[j] = x[j] ^ block[j];
                }
                x = aesEncryptBlock(key, xored);
            }
        }

        if (plaintext.length > 0) {
            let ptPadded = Buffer.from(plaintext);
            const padLen = (16 - (ptPadded.length % 16)) % 16;
            if (padLen > 0) {
                ptPadded = Buffer.concat([ptPadded, Buffer.alloc(padLen)]);
            }
            for (let i = 0; i < ptPadded.length; i += 16) {
                const block = ptPadded.slice(i, i + 16);
                const xored = Buffer.alloc(16);
                for (let j = 0; j < 16; j++) {
                    xored[j] = x[j] ^ block[j];
                }
                x = aesEncryptBlock(key, xored);
            }
        }

        const computedTag = x.slice(0, M);

        // 安全比较
        if (!crypto.timingSafeEqual(computedTag, decryptedTag)) {
            throw new Error('aes-128-ccm decryption failed: Authentication tag mismatch');
        }

        return plaintext;
    }

    // ---- Monkey-patch NodeJsCrypto ----
    const { NodeJsCrypto } = _matterNodejs;
    const originalEncrypt = NodeJsCrypto.prototype.encrypt;
    const originalDecrypt = NodeJsCrypto.prototype.decrypt;

    NodeJsCrypto.prototype.encrypt = function (key, data, nonce, aad) {
        const keyBuf = Buffer.from(key);
        const dataBuf = Buffer.from(data);
        const nonceBuf = Buffer.from(nonce);
        const aadBuf = aad ? Buffer.from(aad) : undefined;
        const result = aesCcmEncrypt(keyBuf, dataBuf, nonceBuf, aadBuf, 16);
        return new Uint8Array(result);
    };

    NodeJsCrypto.prototype.decrypt = function (key, data, nonce, aad) {
        const keyBuf = Buffer.from(key);
        const dataBuf = Buffer.from(data);
        const nonceBuf = Buffer.from(nonce);
        const aadBuf = aad ? Buffer.from(aad) : undefined;
        const result = aesCcmDecrypt(keyBuf, dataBuf, nonceBuf, aadBuf, 16);
        return new Uint8Array(result);
    };

    console.log('[Commissioner] AES-128-CCM JS patch applied successfully');
}

/**
 * 确保存储目录存在
 */
function ensureStorageDir() {
    if (!fs.existsSync(COMMISSIONER_STORAGE_PATH)) {
        fs.mkdirSync(COMMISSIONER_STORAGE_PATH, { recursive: true });
    }
}

// ============================================================
// 核心功能
// ============================================================

/**
 * 初始化 Commissioner
 * 创建 CommissioningController 并启动
 */
async function initializeCommissioner(win) {
    if (isInitialized && commissioningController) {
        masterWin = win;
        return { success: true, message: 'Commissioner already initialized', bleAvailable };
    }

    masterWin = win;
    try {
        console.log('[Commissioner] Initializing...');
        ensureStorageDir();

        // 1. 加载 matter.js 模块
        loadMatterModules();

        // 设置 matter.js SDK 日志级别为 DEBUG，输出配网过程中每个步骤的详细日志
        // LogLevel: 0=DEBUG, 1=INFO, 2=NOTICE, 3=WARN, 4=ERROR, 5=FATAL
        try {
            const { Logger } = require('@matter/general');
            Logger.level = 0; // DEBUG - 最详细的日志级别
            console.log('[Commissioner] SDK log level set to DEBUG for detailed commissioning logs');
        } catch (e) {
            console.warn('[Commissioner] Failed to set SDK log level:', e.message);
        }

        const { Environment, StorageService, Time } = _matterMain;
        const { CommissioningController } = _matterJs;

        // 2. 获取或创建 Environment
        environment = Environment.default;

        // --- 核心修复：强制 Matter.js 使用我们指定的自定义独立存储路径，防止跑到全局 AppData 里 ---
        environment.vars.set('path.root', COMMISSIONER_STORAGE_PATH);

        // 3. 初始化 BLE 支持
        bleAvailable = false;
        if (_matterNodejsBle) {
            try {
                const { Ble } = _matterProtocol;
                const { NodeJsBle } = _matterNodejsBle;
                const { singleton } = _matterMain;

                Ble.get = singleton(() => new NodeJsBle({ environment }));
                bleAvailable = true;
                console.log('[Commissioner] BLE initialized successfully');
            } catch (bleErr) {
                console.warn('[Commissioner] BLE init failed (IP-only mode):', bleErr.message);
            }
        }

        // 4. 创建唯一 ID（用于存储隔离）
        const storageService = environment.get(StorageService);
        const controllerStorage = (await storageService.open('commissioner')).createContext('data');

        let uniqueId;
        if (await controllerStorage.has('uniqueid')) {
            uniqueId = await controllerStorage.get('uniqueid');
        } else {
            uniqueId = `iot-nexus-commissioner-${Time.nowMs()}`;
            await controllerStorage.set('uniqueid', uniqueId);
        }

        let adminFabricLabel;
        if (await controllerStorage.has('fabriclabel')) {
            adminFabricLabel = await controllerStorage.get('fabriclabel');
        } else {
            adminFabricLabel = 'IoT Nexus Commissioner';
            await controllerStorage.set('fabriclabel', adminFabricLabel);
        }

        console.log(`[Commissioner] Storage ID: ${uniqueId}`);
        console.log(`[Commissioner] Fabric Label: ${adminFabricLabel}`);

        // 5. 创建 CommissioningController
        commissioningController = new CommissioningController({
            environment: {
                environment,
                id: uniqueId,
            },
            autoConnect: false,  // 不自动连接已配网设备，由用户手动触发
            adminFabricLabel,
        });

        // 6. 启动 Controller
        await commissioningController.start();

        isInitialized = true;
        console.log('[Commissioner] Initialized successfully');

        // 检查是否有已配网设备
        const existingNodes = commissioningController.getCommissionedNodes();
        console.log(`[Commissioner] Found ${existingNodes.length} previously commissioned node(s)`);

        return {
            success: true,
            bleAvailable,
            commissionedNodeCount: existingNodes.length,
            message: `Commissioner ready. BLE: ${bleAvailable ? 'available' : 'not available'}`
        };
    } catch (error) {
        console.error('[Commissioner] Init failed:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 发现可配网的 Matter 设备
 * 同时使用 BLE 和 mDNS (IP) 发现
 */
async function discoverDevices(win, options = {}) {
    if (!isInitialized || !commissioningController) {
        return { success: false, error: 'Commissioner not initialized. Please initialize first.' };
    }

    const { discriminator, timeoutSeconds = 30 } = options;
    const discoveredDevices = [];

    try {
        console.log(`[Commissioner] Starting device discovery (timeout: ${timeoutSeconds}s, discriminator: ${discriminator || 'any'})...`);

        // 构建发现标识
        const identifierData = {};
        if (discriminator != null && discriminator !== '') {
            const disc = parseInt(discriminator);
            if (!isNaN(disc)) {
                if (disc <= 15) {
                    identifierData.shortDiscriminator = disc;
                } else {
                    identifierData.longDiscriminator = disc;
                }
            }
        }

        // 发现能力：同时使用 BLE 和 IP
        const discoveryCapabilities = {};
        if (bleAvailable) {
            discoveryCapabilities.ble = true;
        }

        await commissioningController.discoverCommissionableDevices(
            identifierData,
            discoveryCapabilities,
            (device) => {
                // 转换设备信息为统一格式
                const deviceInfo = {
                    id: `commissioner-${device.deviceIdentifier || Date.now()}-${discoveredDevices.length}`,
                    deviceName: device.deviceName || device.productName || `Matter Device`,
                    discriminator: device.longDiscriminator ?? device.shortDiscriminator ?? null,
                    vendorId: device.vendorId || null,
                    productId: device.productId || null,
                    commissioningMode: device.commissioningMode ?? null,
                    addresses: device.addresses || [],
                    port: device.port || null,
                    discoveredVia: device.discoveredVia || 'unknown',
                    pairingHint: device.pairingHint || null,
                    pairingInstruction: device.pairingInstruction || null,
                    raw: device, // 保留原始数据以便配网时使用
                };

                console.log(`[Commissioner] Discovered: ${deviceInfo.deviceName} (discriminator: ${deviceInfo.discriminator}, via: ${deviceInfo.discoveredVia})`);

                discoveredDevices.push(deviceInfo);

                // 实时推送到前端
                if (win && !win.isDestroyed()) {
                    win.webContents.send('commissioner:device-discovered', deviceInfo);
                }
            },
            timeoutSeconds
        );

        console.log(`[Commissioner] Discovery complete. Found ${discoveredDevices.length} device(s)`);

        return { success: true, devices: discoveredDevices };
    } catch (error) {
        console.error('[Commissioner] Discovery error:', error);
        return { success: false, error: error.message, devices: discoveredDevices };
    }
}

/**
 * 停止设备发现
 */
async function stopDiscovery() {
    if (!isInitialized || !commissioningController) {
        return { success: false, error: 'Commissioner not initialized' };
    }

    try {
        // cancelCommissionableDeviceDiscovery 需要 (identifierData, discoveryCapabilities)
        // 空对象表示取消所有发现
        commissioningController.cancelCommissionableDeviceDiscovery(
            {},
            { ble: bleAvailable }
        );
        console.log('[Commissioner] Discovery stopped');
        return { success: true };
    } catch (error) {
        console.error('[Commissioner] Stop discovery error:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 配网 Matter 设备
 * 支持 BLE-WiFi 和 BLE-Thread 两种模式
 */
async function commissionDevice(win, params) {
    if (!isInitialized || !commissioningController) {
        return { success: false, error: 'Commissioner not initialized. Please initialize first.' };
    }

    const { passcode, discriminator, pairingMode, wifiSsid, wifiPassword, threadDataset, knownAddress } = params;

    const sendProgress = (stage, message) => {
        console.log(`[Commissioner] [${stage}] ${message}`);
        if (win && !win.isDestroyed()) {
            win.webContents.send('commissioner:commissioning-progress', { stage, message });
        }
    };

    try {
        // 1. 验证参数
        const pin = parseInt(passcode);
        if (isNaN(pin)) {
            return { success: false, error: 'Invalid passcode. Must be a numeric value.' };
        }

        const { GeneralCommissioning } = _matterClusters;

        // 2. 构建配网选项
        const commissioningOptions = {
            regulatoryLocation: GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor,
            regulatoryCountryCode: 'XX',
        };

        // 3. 配置网络凭证
        const mode = pairingMode || 'ble-wifi';
        if (mode === 'ble-wifi') {
            if (!wifiSsid || !wifiPassword) {
                return { success: false, error: 'WiFi SSID and password are required for BLE-WiFi commissioning.' };
            }
            commissioningOptions.wifiNetwork = {
                wifiSsid: wifiSsid,
                wifiCredentials: wifiPassword,
            };
            sendProgress('config', `Mode: BLE-WiFi, Network: ${wifiSsid}`);
        } else if (mode === 'ble-thread') {
            if (!threadDataset) {
                return { success: false, error: 'Thread operational dataset is required for BLE-Thread commissioning.' };
            }

            // Extract Network Name from Thread Dataset (TLV Type 3)
            let networkName = 'Thread';
            try {
                const hexClean = threadDataset.replace(/[^0-9a-fA-F]/g, '');
                const buf = Buffer.from(hexClean, 'hex');
                let i = 0;
                while (i < buf.length) {
                    const type = buf[i++];
                    const length = buf[i++];
                    if (type === 3) { // Network Name TLV
                        networkName = buf.subarray(i, i + length).toString('utf8');
                        break;
                    }
                    i += length;
                }
            } catch (e) {
                console.warn('[Commissioner] Failed to parse Thread network name from dataset, using default "Thread"');
            }

            commissioningOptions.threadNetwork = {
                networkName: networkName,
                operationalDataset: threadDataset,
            };
            sendProgress('config', `Mode: BLE-Thread, Network: ${networkName}`);
        } else {
            return { success: false, error: `Unknown pairing mode: ${mode}` };
        }

        // 4. 构建发现选项
        const discoveryOptions = {
            discoveryCapabilities: {
                ble: bleAvailable,
                onIpNetwork: true,  // 必须为 true，Reconnect 阶段需要通过 mDNS 发现设备
            },
        };

        // 设置 discriminator（如果提供）
        if (discriminator != null && discriminator !== '') {
            const disc = parseInt(discriminator);
            if (!isNaN(disc)) {
                if (disc <= 15) {
                    discoveryOptions.identifierData = { shortDiscriminator: disc };
                } else {
                    discoveryOptions.identifierData = { longDiscriminator: disc };
                }
            }
        } else {
            discoveryOptions.identifierData = {};
        }

        // 如果有已知地址，使用它
        if (knownAddress) {
            discoveryOptions.knownAddress = {
                ip: knownAddress.ip,
                port: knownAddress.port,
                type: 'udp',
            };
        }

        const nodeOptions = {
            commissioning: commissioningOptions,
            discovery: discoveryOptions,
            passcode: pin,
        };

        sendProgress('commissioning', 'Starting commissioning process...');
        sendProgress('discovery', 'Searching for device...');

        // 5. 执行配网（matter.js 自动完成完整流程）
        //    Discovery → BLE Connect → PASE → Certificate Exchange →
        //    Network Commissioning → CASE → Complete

        // Create abort controller for this commissioning session
        const nodeId = await new Promise((resolve, reject) => {
            commissioningAbortController = { aborted: false, reject };
            commissioningController.commissionNode(nodeOptions)
                .then(resolve)
                .catch(reject);
        });
        commissioningAbortController = null;

        const nodeIdStr = nodeId.toString();
        sendProgress('complete', `Commissioning successful! Node ID: ${nodeIdStr}`);

        console.log(`[Commissioner] Device commissioned successfully. Node ID: ${nodeIdStr}`);

        return {
            success: true,
            nodeId: nodeIdStr,
            networkType: mode === 'ble-thread' ? 'thread' : 'wifi',
            message: `Device commissioned with Node ID: ${nodeIdStr}`,
        };
    } catch (error) {
        console.error('[Commissioner] Commissioning failed:', error);

        // Parse thread-network-setup-failed to extract scanned networks
        let scannedNetworks = null;
        const errMsg = error.message || String(error);
        if (errMsg.includes('did not return the requested Network')) {
            try {
                const jsonMatch = errMsg.match(/\[(\{.*\})\]/s);
                if (jsonMatch) {
                    scannedNetworks = JSON.parse(`[${jsonMatch[0].slice(1, -1)}]`);
                    // Sort by signal strength
                    scannedNetworks.sort((a, b) => (b.rssi || -100) - (a.rssi || -100));
                }
            } catch { /* ignore parse error */ }
        }

        // Build user-friendly error message for Thread network mismatch
        const mode = pairingMode || 'ble-wifi';
        if (mode === 'ble-thread' && errMsg.includes('did not return the requested Network')) {
            // Extract the expected network name from the dataset we parsed earlier
            let expectedName = 'unknown';
            try {
                const hexClean = threadDataset.replace(/[^0-9a-fA-F]/g, '');
                const buf = Buffer.from(hexClean, 'hex');
                let idx = 0;
                while (idx < buf.length) {
                    const type = buf[idx++];
                    const length = buf[idx++];
                    if (type === 3) {
                        expectedName = buf.subarray(idx, idx + length).toString('utf8');
                        break;
                    }
                    idx += length;
                }
            } catch { /* ignore */ }

            const foundNames = scannedNetworks
                ? scannedNetworks.map(n => n.networkName).filter(Boolean)
                : [];

            sendProgress('error',
                `Commissioning failed: Thread network "${expectedName}" not found. ` +
                `The device scanned nearby Thread networks but could not find a match. ` +
                `Please ensure the Thread Border Router broadcasting "${expectedName}" is online and in range.`
            );
            if (foundNames.length > 0) {
                sendProgress('info',
                    `Device found ${foundNames.length} Thread network(s) nearby: ${scannedNetworks.map(n => `${n.networkName}(ch${n.channel},rssi:${n.rssi})`).join(', ')}. ` +
                    `None of these match the expected network "${expectedName}".`
                );
            } else {
                sendProgress('info', `Device did not find any Thread networks nearby.`);
            }
        } else {
            sendProgress('error', `Commissioning failed: ${errMsg}`);

            if (scannedNetworks) {
                sendProgress('info', `Device scanned ${scannedNetworks.length} Thread networks nearby: ${scannedNetworks.map(n => `${n.networkName}(ch${n.channel},rssi:${n.rssi})`).join(', ')}`);
            }
        }

        return {
            success: false,
            error: errMsg,
            scannedThreadNetworks: scannedNetworks,
        };
    } finally {
        commissioningAbortController = null;
    }
}

/**
 * 取消正在进行的配网
 */
async function cancelCommissioning() {
    if (!commissioningAbortController) {
        return { success: false, error: 'No commissioning in progress' };
    }

    try {
        console.log('[Commissioner] Cancelling commissioning...');
        commissioningAbortController.aborted = true;
        commissioningAbortController.reject(new Error('Commissioning cancelled by user'));
        commissioningAbortController = null;

        // Also try to cancel via the controller if possible
        if (commissioningController && commissioningController.cancelCommissionableDeviceDiscovery) {
            try {
                await commissioningController.cancelCommissionableDeviceDiscovery({}, { ble: bleAvailable, onIpNetwork: true });
            } catch { /* best effort */ }
        }

        return { success: true, message: 'Commissioning cancelled' };
    } catch (error) {
        console.error('[Commissioner] Cancel commissioning error:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 连接到已配网设备
 */
async function connectNode(nodeId) {
    if (!isInitialized || !commissioningController) {
        return { success: false, error: 'Commissioner not initialized' };
    }

    try {
        const { NodeId } = _matterTypes;
        const nId = NodeId(BigInt(nodeId.toString()));

        console.log(`[Commissioner] Connecting to node ${nodeId}...`);

        const node = await commissioningController.getNode(nId);

        // 启动连接
        if (!node.isConnected) {
            node.connect();
        }

        // 等待初始化完成
        if (!node.initialized) {
            console.log(`[Commissioner] Waiting for node ${nodeId} initialization...`);
            await waitWithTimeout(node.events.initialized, 15000, `Node ${nodeId} initialization timeout`);
        }

        connectedNodes.set(nodeId.toString(), node);
        console.log(`[Commissioner] Node ${nodeId} connected and initialized`);

        return { success: true, nodeId: nodeId.toString() };
    } catch (error) {
        console.error(`[Commissioner] Connect node ${nodeId} failed:`, error);
        return { success: false, error: error.message };
    }
}

/**
 * 断开设备连接
 */
async function disconnectNode(nodeId) {
    if (!isInitialized) {
        return { success: false, error: 'Commissioner not initialized' };
    }

    try {
        const node = connectedNodes.get(nodeId.toString());
        if (node) {
            await node.disconnect?.();
            connectedNodes.delete(nodeId.toString());
        }
        console.log(`[Commissioner] Node ${nodeId} disconnected`);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * 获取已配网设备列表
 */
async function getCommissionedNodes() {
    if (!isInitialized || !commissioningController) {
        return { success: false, error: 'Commissioner not initialized', nodes: [] };
    }

    try {
        const nodeIds = commissioningController.getCommissionedNodes();
        const details = commissioningController.getCommissionedNodesDetails();

        const nodes = details.map((detail, index) => ({
            nodeId: detail.nodeId?.toString() || nodeIds[index]?.toString(),
            isConnected: connectedNodes.has(detail.nodeId?.toString() || nodeIds[index]?.toString()),
            ...detail,
        }));

        return { success: true, nodes };
    } catch (error) {
        console.error('[Commissioner] Get nodes error:', error);
        return { success: false, error: error.message, nodes: [] };
    }
}

/**
 * 读取设备完整结构（Endpoint / Cluster / Attributes / Commands）
 */
async function getNodeStructure(nodeId) {
    if (!isInitialized || !commissioningController) {
        return { success: false, error: 'Commissioner not initialized' };
    }

    try {
        const { NodeId } = _matterTypes;
        const { BasicInformationCluster, DescriptorCluster } = _matterClusters;

        // 获取或连接 Node
        let node = connectedNodes.get(nodeId.toString());
        if (!node) {
            node = await commissioningController.getNode(NodeId(BigInt(nodeId.toString())));
            if (!node.isConnected) {
                node.connect();
                if (!node.initialized) await waitWithTimeout(node.events.initialized, 15000, 'Node init timeout');
            }
            connectedNodes.set(nodeId.toString(), node);
        }

        // 读取基本信息
        let deviceInfo = {};
        try {
            const basicInfo = node.getRootClusterClient(BasicInformationCluster);
            if (basicInfo) {
                const safeReadAttr = async (fetcher) => {
                    if (!fetcher) return null;
                    try {
                        return await Promise.race([
                            fetcher(),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)) // 1.5s timeout per attribute
                        ]);
                    } catch {
                        return null;
                    }
                };

                const [
                    vendorName, vendorId, productName, productId, nodeLabel, location, hardwareVersion,
                    hardwareVersionString, softwareVersion, softwareVersionString, manufacturingDate,
                    partNumber, productUrl, productLabel, serialNumber
                ] = await Promise.all([
                    safeReadAttr(() => basicInfo.getVendorNameAttribute()),
                    safeReadAttr(() => basicInfo.getVendorIdAttribute()),
                    safeReadAttr(() => basicInfo.getProductNameAttribute()),
                    safeReadAttr(() => basicInfo.getProductIdAttribute()),
                    safeReadAttr(() => basicInfo.getNodeLabelAttribute()),
                    safeReadAttr(() => basicInfo.getLocationAttribute()),
                    safeReadAttr(() => basicInfo.getHardwareVersionAttribute()),
                    safeReadAttr(() => basicInfo.getHardwareVersionStringAttribute()),
                    safeReadAttr(() => basicInfo.getSoftwareVersionAttribute()),
                    safeReadAttr(() => basicInfo.getSoftwareVersionStringAttribute()),
                    safeReadAttr(() => basicInfo.getManufacturingDateAttribute()),
                    safeReadAttr(() => basicInfo.getPartNumberAttribute()),
                    safeReadAttr(() => basicInfo.getProductUrlAttribute()),
                    safeReadAttr(() => basicInfo.getProductLabelAttribute()),
                    safeReadAttr(() => basicInfo.getSerialNumberAttribute())
                ]);

                deviceInfo = {
                    vendorName, vendorId, productName, productId, nodeLabel, location, hardwareVersion,
                    hardwareVersionString, softwareVersion, softwareVersionString, manufacturingDate,
                    partNumber, productUrl, productLabel, serialNumber
                };
            }
        } catch (e) {
            console.warn('[Commissioner] Failed to read basic info:', e.message);
        }

        // 读取设备端点结构
        const devices = node.getDevices();
        const endpoints = [];

        for (const device of devices) {
            const endpoint = {
                id: device.number,
                deviceTypes: [],
                clusters: [],
            };

            // 获取 Cluster Clients
            try {
                const clusterClients = device.getClusterClients ? device.getClusterClients() : [];
                for (const [clusterId, cluster] of clusterClients) {
                    endpoint.clusters.push({
                        id: clusterId,
                        name: cluster.name || `Cluster-0x${clusterId.toString(16).padStart(4, '0')}`,
                    });
                }
            } catch (e) {
                console.warn(`[Commissioner] Failed to read clusters for endpoint ${device.number}:`, e.message);
            }

            endpoints.push(endpoint);
        }

        // Root endpoint 信息
        try {
            const rootDescriptor = node.getRootClusterClient(DescriptorCluster);
            if (rootDescriptor) {
                const safeReadList = async (fetcher) => {
                    try {
                        return await Promise.race([
                            fetcher(),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500))
                        ]);
                    } catch {
                        return [];
                    }
                };
                const partsList = await safeReadList(() => rootDescriptor.getPartsListAttribute());
                const serverList = await safeReadList(() => rootDescriptor.getServerListAttribute());
                console.log(`[Commissioner] Node ${nodeId}: parts=${partsList?.length || 0}, servers=${serverList?.length || 0}`);
            }
        } catch (e) {
            // ignore
        }

        console.log(`[Commissioner] Node ${nodeId} structure: ${endpoints.length} endpoint(s), info: ${JSON.stringify(deviceInfo)}`);

        return { success: true, deviceInfo, endpoints };
    } catch (error) {
        console.error(`[Commissioner] Get structure for ${nodeId} failed:`, error);
        return { success: false, error: error.message };
    }
}

/**
 * 自动获取节点所有 Endpoint, Cluster 以及 Attribute 极其值
 */
async function readAllNodeAttributes(nodeIdStr) {
    if (!isInitialized || !commissioningController) {
        return { success: false, error: 'Commissioner not initialized' };
    }

    try {
        const { NodeId } = _matterTypes;
        let node = connectedNodes.get(nodeIdStr.toString());
        if (!node) {
            node = await commissioningController.getNode(NodeId(BigInt(nodeIdStr.toString())));
            if (!node.isConnected) {
                node.connect();
                if (!node.initialized) await waitWithTimeout(node.events.initialized, 15000, 'Node init timeout');
            }
            connectedNodes.set(nodeIdStr.toString(), node);
        }

        const data = { endpoints: [] };
        const devices = node.getDevices();
        const serializeValue = (v) => {
            if (v === null || v === undefined) return v;
            if (typeof v === 'bigint') return v.toString();
            if (v instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(v))) return `0x${Buffer.from(v).toString('hex')}`;
            if (Array.isArray(v)) return v.map(serializeValue);
            if (typeof v === 'object') {
                const res = {};
                for (const [k, v2] of Object.entries(v)) res[k] = serializeValue(v2);
                return res;
            }
            return v;
        };

        const interactionClient = await commissioningController.createInteractionClient(NodeId(BigInt(nodeIdStr.toString())));

        // Use fast cached attribute data instead of over-the-air getAllAttributes to avoid 'no-response-timeout' for slow devices.
        // It provides the immediate structure and last known values.
        console.log(`[Commissioner] Fetching cached cluster data...`);
        const allAttrs = interactionClient.getAllCachedClusterData();

        // 1. Initialize known endpoints & structure from node schema
        const epMap = new Map();
        for (const ep of devices) {
            epMap.set(ep.number, {
                id: ep.number,
                name: ep.name || `Endpoint ${ep.number}`,
                deviceTypes: (ep.deviceTypes || []).map(d => {
                    const dt = typeof d === 'object' ? (d.deviceType ?? d.code) : d;
                    return {
                        id: dt,
                        name: dt !== undefined ? `0x${dt.toString(16).padStart(4, '0')}` : 'Unknown'
                    };
                }),
                clusters: [],
                _clusterMap: new Map()
            });
        }

        // 2. Populate Attributes from cached data
        for (const attr of allAttrs) {
            const epId = Number(attr.path.endpointId);
            const clId = Number(attr.path.clusterId);
            const atId = Number(attr.path.attributeId);

            if (!epMap.has(epId)) {
                epMap.set(epId, { id: epId, name: `Endpoint ${epId}`, deviceTypes: [], clusters: [], _clusterMap: new Map() });
            }

            const epData = epMap.get(epId);
            if (!epData._clusterMap.has(clId)) {
                epData._clusterMap.set(clId, { id: clId, name: `Cluster-0x${clId.toString(16).padStart(4, '0')}`, attributes: [], commands: [] });
            }

            const clusterData = epData._clusterMap.get(clId);
            clusterData.attributes.push({
                id: atId,
                name: `Attr-0x${atId.toString(16).padStart(4, '0')}`,
                value: serializeValue(attr.value)
            });
        }

        // 3. Populate human readable names & commands from local node schemas
        for (const ep of devices) {
            const epData = epMap.get(ep.number);
            if (!epData || typeof ep.getClusterClients !== 'function') continue;

            try {
                const cClients = ep.getClusterClients();
                const entries = typeof cClients.entries === 'function' ? cClients.entries() : Object.entries(cClients);
                for (const [clIdRaw, cClient] of entries) {
                    const cid = Number(clIdRaw);

                    // If SDK knows about a cluster not in the cached attrs, initialize it
                    if (!epData._clusterMap.has(cid)) {
                        epData._clusterMap.set(cid, { id: cid, name: `Cluster-0x${cid.toString(16).padStart(4, '0')}`, attributes: [], commands: [] });
                    }

                    const clusterData = epData._clusterMap.get(cid);
                    if (cClient.name) clusterData.name = cClient.name;

                    // Replace attribute names and populate un-cached attributes
                    if (cClient.attributes) {
                        const cAttrs = Object.values(cClient.attributes);
                        for (const schemaAttr of cAttrs) {
                            const existing = clusterData.attributes.find(a => a.id === schemaAttr.id);
                            if (existing) {
                                if (schemaAttr.name) existing.name = schemaAttr.name;
                            } else {
                                // Add missing attribute placeholder (not in cache)
                                clusterData.attributes.push({
                                    id: schemaAttr.id,
                                    name: schemaAttr.name || `Attr-0x${schemaAttr.id.toString(16)}`,
                                    value: '--- (Not cached)'
                                });
                            }
                        }
                    }

                    // Populate supported commands
                    const cmds = Object.values(cClient.commands || cClient.supportedCommands || {});
                    for (const cmd of cmds) {
                        const cmdId = cmd.id || cmd.commandId;
                        if (!clusterData.commands.find(c => c.id === cmdId)) {
                            clusterData.commands.push({
                                id: cmdId,
                                name: cmd.name || `Cmd-0x${cmdId.toString(16)}`
                            });
                        }
                    }
                }
            } catch (e) {
                // ignore if schema iteration fails
            }
        }

        // 3.5 Fallback to global matter clusters registry for naming if still missing
        try {
            const allClustersSchema = require('@matter/main/clusters');
            const clusterMapById = new Map();
            for (const key in allClustersSchema) {
                const schemaObj = allClustersSchema[key];
                if (schemaObj && typeof schemaObj === 'object') {
                    const actualSchema = schemaObj.Complete || schemaObj.Base || schemaObj;
                    const id = actualSchema.id;
                    if (typeof id === 'number') {
                        const existing = clusterMapById.get(id);
                        if (!existing || (actualSchema.attributes && !existing.attributes)) {
                            clusterMapById.set(id, actualSchema);
                        }
                    }
                }
            }

            for (const epData of epMap.values()) {
                for (const clusterData of epData._clusterMap.values()) {
                    const schema = clusterMapById.get(clusterData.id);
                    if (!schema) continue;

                    // Fallback cluster name
                    if (clusterData.name.startsWith('Cluster-0x')) {
                        clusterData.name = schema.name || clusterData.name;
                    }

                    // Fallback attribute names
                    if (schema.attributes) {
                        const sAttrs = Object.entries(schema.attributes);
                        for (const attr of clusterData.attributes) {
                            if (attr.name.startsWith('Attr-0x')) {
                                const matcher = sAttrs.find(([k, sa]) => sa.id === attr.id);
                                if (matcher) attr.name = matcher[0];
                            }
                        }
                    }

                    // Fallback command names and missing commands injection
                    if (schema.commands) {
                        const sCmds = Object.entries(schema.commands);

                        // Feature: parse AcceptedCommandList (0xFFF9) to know precisely what commands are supported
                        const acceptedAttr = clusterData.attributes.find(a => a.id === 0xFFF9);
                        const acceptedIds = (acceptedAttr && Array.isArray(acceptedAttr.value))
                            ? new Set(acceptedAttr.value.map(v => Number(v)))
                            : null;

                        // Inject commands from global schema if they are explicitly reported as accepted,
                        // or if we have zero commands natively discovered so we list all possible ones for testing
                        for (const [k, sc] of sCmds) {
                            const cmdId = sc.requestId !== undefined ? sc.requestId : sc.responseId;
                            if (cmdId === undefined || cmdId === null) continue;

                            if (acceptedIds && !acceptedIds.has(cmdId)) continue;
                            if (clusterData.commands.length > 0 && !acceptedIds) continue;

                            if (!clusterData.commands.find(c => c.id === cmdId)) {
                                clusterData.commands.push({ id: cmdId, name: k });
                            }
                        }

                        // Still try to rename any existing commands that were discovered but kept weird names
                        for (const cmd of clusterData.commands) {
                            if (cmd.name.startsWith('Cmd-0x')) {
                                const matcher = sCmds.find(([k, sc]) => sc.requestId === cmd.id || sc.responseId === cmd.id);
                                if (matcher) cmd.name = matcher[0];
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[Commissioner] Failed to apply global schema fallback:', e);
        }

        // 4. Finalize Output Packaging
        data.endpoints = [];
        for (const epData of epMap.values()) {
            epData.clusters = Array.from(epData._clusterMap.values());
            delete epData._clusterMap;
            // Sort clusters & attributes for stable display
            epData.clusters.sort((a, b) => a.id - b.id).forEach(c => {
                c.attributes.sort((a, b) => a.id - b.id);
                c.commands.sort((a, b) => a.id - b.id);
            });
            data.endpoints.push(epData);
        }
        data.endpoints.sort((a, b) => a.id - b.id);

        return { success: true, data };
    } catch (error) {
        console.error(`[Commissioner] Get all attributes for ${nodeIdStr} failed:`, error);
        return { success: false, error: String(error) };
    }
}

/**
 * 读取属性
 * 使用 InteractionClient.getMultipleAttributes({ attributes: [...] }) 格式
 */
async function readAttribute(nodeId, endpointId, clusterId, attributeId) {
    if (!isInitialized || !commissioningController) {
        return { success: false, error: 'Commissioner not initialized' };
    }

    try {
        const { NodeId } = _matterTypes;

        // Ensure node is connected first
        let node = connectedNodes.get(nodeId.toString());
        if (!node) {
            node = await commissioningController.getNode(NodeId(BigInt(nodeId.toString())));
            if (!node.isConnected) {
                node.connect();
                if (!node.initialized) await waitWithTimeout(node.events.initialized, 15000, 'Node init timeout');
            }
            connectedNodes.set(nodeId.toString(), node);
        }

        const epId = parseInt(endpointId);
        const clId = parseInt(clusterId);
        const atId = parseInt(attributeId);

        // Try reading via ClusterClient first (high-level API, handles Sleepy devices better)
        const devices = node.getDevices();
        for (const device of devices) {
            if (device.number === epId) {
                const clusterClients = device.getClusterClients ? device.getClusterClients() : new Map();
                for (const [cId, cluster] of clusterClients) {
                    if (cId === clId) {
                        const attributes = cluster.attributes || {};
                        for (const [attrName, attr] of Object.entries(attributes)) {
                            if (attr?.id === atId) {
                                console.log(`[Commissioner] Reading attribute '${attrName}' from ClusterClient...`);
                                const methodName = 'get' + attrName.charAt(0).toUpperCase() + attrName.slice(1) + 'Attribute';
                                if (typeof cluster[methodName] === 'function') {
                                    try {
                                        // Try forcing a read from device directly (15s timeout for Sleepy devices)
                                        const value = await waitWithTimeout(cluster[methodName](true), 15000, 'Device read attribute timeout');
                                        return { success: true, value, path: { endpointId: epId, clusterId: clId, attributeId: atId } };
                                    } catch (err) {
                                        console.warn(`[Commissioner] Read from device failed: ${err.message}. Trying cached state...`);
                                        try {
                                            const cachedValue = await cluster[methodName]();
                                            return { success: true, value: cachedValue !== undefined ? cachedValue : '(no cache available)', path: { endpointId: epId, clusterId: clId, attributeId: atId }, cached: true };
                                        } catch (cachedErr) {
                                            console.warn(`[Commissioner] Read from cache failed: ${cachedErr.message}`);
                                        }
                                        return { success: false, error: err.message || JSON.stringify(err) };
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Fallback to Interaction Client
        const interactionClient = await commissioningController.createInteractionClient(NodeId(BigInt(nodeId.toString())));
        const result = await waitWithTimeout(interactionClient.getMultipleAttributes({
            attributes: [{ endpointId: epId, clusterId: clId, attributeId: atId }],
        }), 15000, 'Device read attribute timeout');

        if (result.length > 0) {
            console.log(`[Commissioner] Read ${nodeId}/${epId}/${clId}/${atId}: ${JSON.stringify(result[0].value)}`);
            return { success: true, value: result[0].value, path: result[0].path };
        }

        return { success: false, error: 'No data returned' };
    } catch (error) {
        console.error(`[Commissioner] Read attribute error:`, error);
        return { success: false, error: error.message || JSON.stringify(error) };
    }
}

/**
 * 写入属性
 * 注意: InteractionClient.setMultipleAttributes 需要完整的 attribute schema 对象。
 * 这里使用低级 API，先读取当前 attributes 上下文来获取 schema，然后写入。
 * 另一种方式是通过 PairedNode 的 ClusterClient 来写入。
 */
async function writeAttribute(nodeId, endpointId, clusterId, attributeId, value) {
    if (!isInitialized || !commissioningController) {
        return { success: false, error: 'Commissioner not initialized' };
    }

    try {
        const { NodeId } = _matterTypes;

        // 通过 PairedNode 获取 ClusterClient 来操作（更可靠）
        let node = connectedNodes.get(nodeId.toString());
        if (!node) {
            node = await commissioningController.getNode(NodeId(BigInt(nodeId.toString())));
            if (!node.isConnected) {
                node.connect();
                if (!node.initialized) await waitWithTimeout(node.events.initialized, 15000, 'Node init timeout');
            }
            connectedNodes.set(nodeId.toString(), node);
        }

        // 使用 InteractionClient 的底层方法
        const interactionClient = await commissioningController.createInteractionClient(
            NodeId(BigInt(nodeId.toString()))
        );

        // 通过 sendWriteCommand 直接写入原始值
        // 注意: 这需要正确的 TLV 编码，这里尝试直接写入
        const epId = parseInt(endpointId);
        const clId = parseInt(clusterId);
        const atId = parseInt(attributeId);

        // 先读取属性以验证路径有效，同时获取 schema 信息
        const readPromise = interactionClient.getMultipleAttributes({
            attributes: [{ endpointId: epId, clusterId: clId, attributeId: atId }],
        });
        const readResult = await waitWithTimeout(readPromise, 10000, 'Device read before write timeout');

        if (readResult.length === 0) {
            return { success: false, error: `Attribute ${epId}/${clId}/${atId} not found` };
        }

        // 使用 getAllAttributes 获取的 schema 来构建写入请求
        // 这是一个简化实现，完整实现需要通过 ClusterClient
        console.log(`[Commissioner] Write ${nodeId}/${epId}/${clId}/${atId} = ${JSON.stringify(value)} (via InteractionClient)`);

        // 尝试通过 interactionClient 写入
        // setMultipleAttributes 需要 attribute 对象包含 id 和 schema
        // 简化方案: 通过 PairedNode devices 来找到对应的 ClusterClient
        const devices = node.getDevices();
        for (const device of devices) {
            if (device.number === epId) {
                const clusterClients = device.getClusterClients ? device.getClusterClients() : new Map();
                for (const [cId, cluster] of clusterClients) {
                    if (cId === clId) {
                        // 找到 attribute 并使用 setAttribute
                        const attributes = cluster.attributes || {};
                        for (const [attrName, attr] of Object.entries(attributes)) {
                            if (attr?.id === atId) {
                                await waitWithTimeout(cluster.setAttribute(attr, value), 10000, 'Device write timeout');
                                console.log(`[Commissioner] Write success via ClusterClient: ${attrName}`);
                                return { success: true };
                            }
                        }
                    }
                }
            }
        }

        return { success: false, error: `Could not find writable attribute at ${epId}/${clId}/${atId}` };
    } catch (error) {
        console.error(`[Commissioner] Write attribute error:`, error);
        return { success: false, error: error.message || JSON.stringify(error) };
    }
}

/**
 * 调用命令
 * 通过 PairedNode 的 ClusterClient 来调用命令（提供正确的 command schema）
 */
async function invokeCommand(nodeId, endpointId, clusterId, commandId, commandFields = {}) {
    if (!isInitialized || !commissioningController) {
        return { success: false, error: 'Commissioner not initialized' };
    }

    try {
        const { NodeId } = _matterTypes;
        const epId = parseInt(endpointId);
        const clId = parseInt(clusterId);
        const cmdId = parseInt(commandId);

        // 通过 PairedNode 查找 ClusterClient 来调用命令
        let node = connectedNodes.get(nodeId.toString());
        if (!node) {
            node = await commissioningController.getNode(NodeId(BigInt(nodeId.toString())));
            if (!node.isConnected) {
                node.connect();
                if (!node.initialized) await waitWithTimeout(node.events.initialized, 15000, 'Node init timeout');
            }
            connectedNodes.set(nodeId.toString(), node);
        }

        const devices = node.getDevices();
        for (const device of devices) {
            if (device.number === epId) {
                const clusterClients = device.getClusterClients ? device.getClusterClients() : new Map();
                for (const [cId, cluster] of clusterClients) {
                    if (cId === clId) {
                        // 找到命令并调用
                        const commands = cluster.commands || {};
                        for (const [cmdName, cmd] of Object.entries(commands)) {
                            if (cmd?.requestId === cmdId || cmd?.id === cmdId) {
                                const result = await waitWithTimeout(cluster.invoke(cmd, commandFields), 15000, 'Device command invocation timeout');
                                console.log(`[Commissioner] Invoke success via ClusterClient: ${cmdName}, result=${JSON.stringify(result)}`);
                                return { success: true, result };
                            }
                        }
                    }
                }
            }
        }

        return { success: false, error: `Could not find command at ${epId}/${clId}/${cmdId}` };
    } catch (error) {
        console.error(`[Commissioner] Invoke command error:`, error);
        return { success: false, error: error.message || JSON.stringify(error) };
    }
}

/**
 * 订阅设备事件
 * 包括状态变化、属性变化、事件触发
 */
async function subscribeNode(nodeId, win) {
    if (!isInitialized || !commissioningController) {
        return { success: false, error: 'Commissioner not initialized' };
    }

    try {
        const { NodeId } = _matterTypes;
        const { NodeStates } = _matterJsDevice;

        let node = connectedNodes.get(nodeId.toString());
        if (!node) {
            node = await commissioningController.getNode(NodeId(BigInt(nodeId.toString())));
            if (!node.isConnected) {
                node.connect();
                if (!node.initialized) await waitWithTimeout(node.events.initialized, 15000, 'Node init timeout');
            }
            connectedNodes.set(nodeId.toString(), node);
        }

        // 状态变化监听
        node.events.stateChanged.on(state => {
            let stateStr = 'unknown';
            switch (state) {
                case NodeStates.Connected: stateStr = 'connected'; break;
                case NodeStates.Disconnected: stateStr = 'disconnected'; break;
                case NodeStates.Reconnecting: stateStr = 'reconnecting'; break;
                case NodeStates.WaitingForDeviceDiscovery: stateStr = 'waiting'; break;
            }

            console.log(`[Commissioner] Node ${nodeId} state: ${stateStr}`);
            if (win && !win.isDestroyed()) {
                win.webContents.send('commissioner:node-state-changed', {
                    nodeId: nodeId.toString(),
                    state: stateStr,
                });
            }
        });

        // 属性变化监听
        node.events.attributeChanged.on(({ path, value }) => {
            console.log(`[Commissioner] Attribute changed: ${nodeId}/${path.endpointId}/${path.clusterId}/${path.attributeName} = ${JSON.stringify(value)}`);
            if (win && !win.isDestroyed()) {
                win.webContents.send('commissioner:attribute-changed', {
                    nodeId: nodeId.toString(),
                    endpointId: path.endpointId,
                    clusterId: path.clusterId,
                    attributeName: path.attributeName,
                    value,
                });
            }
        });

        // 事件触发监听
        node.events.eventTriggered.on(({ path, events }) => {
            console.log(`[Commissioner] Event triggered: ${nodeId}/${path.endpointId}/${path.clusterId}/${path.eventName}`);
            if (win && !win.isDestroyed()) {
                win.webContents.send('commissioner:event-triggered', {
                    nodeId: nodeId.toString(),
                    endpointId: path.endpointId,
                    clusterId: path.clusterId,
                    eventName: path.eventName,
                    events,
                });
            }
        });

        // 结构变化监听
        node.events.structureChanged.on(() => {
            console.log(`[Commissioner] Node ${nodeId} structure changed`);
            if (win && !win.isDestroyed()) {
                win.webContents.send('commissioner:structure-changed', {
                    nodeId: nodeId.toString(),
                });
            }
        });

        console.log(`[Commissioner] Subscribed to events for node ${nodeId}`);
        return { success: true };
    } catch (error) {
        console.error(`[Commissioner] Subscribe error:`, error);
        return { success: false, error: error.message };
    }
}

/**
 * 删除/解配设备
 */
async function removeNode(nodeId) {
    if (!isInitialized || !commissioningController) {
        return { success: false, error: 'Commissioner not initialized' };
    }

    try {
        const { NodeId } = _matterTypes;

        console.log(`[Commissioner] Removing node ${nodeId}...`);

        // 先断开连接
        const node = connectedNodes.get(nodeId.toString());
        if (node) {
            try {
                await node.disconnect?.();
            } catch (e) {
                // ignore
            }
            connectedNodes.delete(nodeId.toString());
        }

        // 从 Controller 中移除
        await commissioningController.removeNode(NodeId(BigInt(nodeId.toString())), true);

        console.log(`[Commissioner] Node ${nodeId} removed`);
        return { success: true };
    } catch (error) {
        console.error(`[Commissioner] Remove node error:`, error);
        return { success: false, error: error.message };
    }
}

/**
 * 获取 Commissioner 状态
 */
function getStatus() {
    if (!isInitialized) {
        return {
            initialized: false,
            bleAvailable: false,
            connectedNodes: [],
            commissionedNodes: [],
        };
    }

    let commissionedNodes = [];
    try {
        commissionedNodes = commissioningController?.getCommissionedNodes()?.map(n => n.toString()) || [];
    } catch (e) {
        // ignore
    }

    return {
        initialized: true,
        bleAvailable,
        connectedNodes: Array.from(connectedNodes.keys()),
        commissionedNodes,
    };
}

function __getTestHooks() {
    return { commissioningController };
}


/**
 * 关闭 Commissioner
 */
async function shutdownCommissioner() {
    try {
        console.log('[Commissioner] Shutting down...');

        // 断开所有已连接节点
        for (const [nodeId, node] of connectedNodes) {
            try {
                await node.disconnect?.();
            } catch (e) {
                // ignore
            }
        }
        connectedNodes.clear();

        // 关闭 Controller
        if (commissioningController) {
            await commissioningController.close();
            commissioningController = null;
        }

        isInitialized = false;
        console.log('[Commissioner] Shutdown complete');
        return { success: true };
    } catch (error) {
        console.error('[Commissioner] Shutdown error:', error);
        isInitialized = false;
        commissioningController = null;
        return { success: false, error: error.message };
    }
}

/**
 * 导出存储 (备份 Commissioner Storage)
 */
async function exportStorage() {
    try {
        const { dialog } = require('electron');
        const fs = require('fs');
        const path = require('path');
        const AdmZip = require('adm-zip');
        const os = require('os');

        // 提示用户选择保存位置
        const { filePath } = await dialog.showSaveDialog({
            title: 'Export Matter Credentials',
            defaultPath: `matter-credentials-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`,
            filters: [
                { name: 'Zip Files', extensions: ['zip'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });

        if (!filePath) {
            return { success: false, error: 'Export cancelled' };
        }

        const zip = new AdmZip();

        // 存储目录: path.join(os.homedir(), '.iot-nexus-core', 'commissioner-storage')
        const storagePath = path.join(os.homedir(), '.iot-nexus-core', 'commissioner-storage');

        if (!fs.existsSync(storagePath)) {
            return { success: false, error: 'Storage directory does not exist' };
        }

        zip.addLocalFolder(storagePath);
        zip.writeZip(filePath);

        console.log(`[Commissioner] Storage exported to ${filePath}`);
        return { success: true, filePath };
    } catch (error) {
        console.error('[Commissioner] Export storage error:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 导入存储 (恢复 Commissioner Storage)
 */
async function importStorage() {
    try {
        const { dialog, app } = require('electron');
        const fs = require('fs');
        const path = require('path');
        const AdmZip = require('adm-zip');
        const os = require('os');

        // 如果已经初始化，需要确认是否重启并导入
        if (isInitialized) {
            const { response } = await dialog.showMessageBox({
                type: 'warning',
                title: 'Restart Required',
                message: 'Importing credentials requires the app to restart. Current connections will be lost.\n\nDo you want to continue?',
                buttons: ['Yes, Import & Restart', 'Cancel'],
                defaultId: 0,
                cancelId: 1
            });
            if (response !== 0) {
                return { success: false, error: 'Import cancelled' };
            }
        }

        const { filePaths } = await dialog.showOpenDialog({
            title: 'Import Matter Credentials',
            properties: ['openFile'],
            filters: [
                { name: 'Zip Files', extensions: ['zip'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });

        if (!filePaths || filePaths.length === 0) {
            return { success: false, error: 'Import cancelled' };
        }

        const zipFilePath = filePaths[0];
        const zip = new AdmZip(zipFilePath);

        const storagePath = path.join(os.homedir(), '.iot-nexus-core', 'commissioner-storage');

        // 先 shutdown
        if (isInitialized) {
            await shutdownCommissioner();
        }

        // 清空目录并解压
        if (fs.existsSync(storagePath)) {
            fs.rmSync(storagePath, { recursive: true, force: true });
        }

        fs.mkdirSync(storagePath, { recursive: true });
        zip.extractAllTo(storagePath, true);

        console.log(`[Commissioner] Storage imported from ${zipFilePath}`);

        // 重启应用
        app.relaunch();
        app.exit(0);

        return { success: true };
    } catch (error) {
        console.error('[Commissioner] Import storage error:', error);
        return { success: false, error: error.message };
    }
}

// ============================================================
// 模块导出
// ============================================================

module.exports = {
    initializeCommissioner,
    discoverDevices,
    stopDiscovery,
    commissionDevice,
    cancelCommissioning,
    connectNode,
    disconnectNode,
    getCommissionedNodes,
    getNodeStructure,
    readAttribute,
    writeAttribute,
    invokeCommand,
    subscribeNode,
    removeNode,
    getStatus,
    shutdownCommissioner,
    __getTestHooks,
    readAllNodeAttributes,
    exportStorage,
    importStorage,
};
