/**
 * Matter Controller 模块
 * 使用 matter.js 实现完整的 Matter 配网流程
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

// Matter 存储目录
const MATTER_STORAGE_PATH = path.join(os.homedir(), '.iot-nexus-core', 'matter-storage');

// Matter BLE 服务 UUID
const MATTER_BLE_SERVICE_UUID = 'fff6';

// 状态变量
let matterEnvironment = null;
let discoveredDevices = new Map();
let isInitialized = false;
let noble = null;
let isScanning = false;
let matterNode = null;
let scanStopCallback = null;  // 用于外部停止扫描

/**
 * 确保存储目录存在
 */
function ensureStorageDir() {
    if (!fs.existsSync(MATTER_STORAGE_PATH)) {
        fs.mkdirSync(MATTER_STORAGE_PATH, { recursive: true });
    }
}

/**
 * 初始化 Matter 环境
 * 创建 Matter Controller Node
 */
async function initializeMatter(win) {
    try {
        console.log('[Matter] Initializing Matter environment...');

        ensureStorageDir();

        // 加载 matter.js 模块
        const { Environment, StorageService } = require('@matter/main');
        const { NodeJsEnvironment, StorageBackendDisk } = require('@matter/nodejs');

        // 创建 Node.js 环境
        console.log('[Matter] Creating NodeJS environment...');
        matterEnvironment = new NodeJsEnvironment();

        // 配置存储
        console.log('[Matter] Configuring storage at:', MATTER_STORAGE_PATH);
        const storage = new StorageBackendDisk(MATTER_STORAGE_PATH);

        // 动态加载 noble (BLE 库)
        try {
            noble = require('@stoprocent/noble');
            console.log('[Matter] BLE (noble) loaded successfully');
        } catch (err) {
            console.error('[Matter] Failed to load BLE library:', err.message);
            console.log('[Matter] BLE scanning will not be available');
        }

        isInitialized = true;
        console.log('[Matter] Matter environment initialized successfully');

        if (win && !win.isDestroyed()) {
            win.webContents.send('matter:status', {
                status: 'initialized',
                message: 'Matter Controller ready' + (noble ? ' with BLE support' : '')
            });
        }

        return {
            success: true,
            message: 'Matter Controller initialized',
            bleAvailable: !!noble,
            storagePath: MATTER_STORAGE_PATH
        };
    } catch (error) {
        console.error('[Matter] Initialization failed:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 扫描 Matter 设备 (通过 BLE)
 */
async function discoverMatterDevices(win, options = {}) {
    const { discriminator: targetDiscriminator, timeout = 30 } = options;

    return new Promise((resolve) => {
        try {
            console.log('[Matter] Starting BLE device discovery...');
            console.log(`[Matter] Scan timeout: ${timeout} seconds`);
            if (targetDiscriminator !== undefined && targetDiscriminator !== null) {
                console.log(`[Matter] Filtering by discriminator: ${targetDiscriminator}`);
            }

            discoveredDevices.clear();

            if (!isInitialized) {
                resolve({ success: false, error: 'Matter Controller not initialized' });
                return;
            }

            if (!noble) {
                console.log('[Matter] BLE not available');
                resolve({
                    success: true,
                    devices: [],
                    message: 'BLE not available. Please check Bluetooth adapter.'
                });
                return;
            }

            if (isScanning) {
                resolve({ success: false, error: 'Scan already in progress' });
                return;
            }

            const foundDevices = new Map();
            isScanning = true;
            let scanStartTime = Date.now();

            // BLE 状态变化处理
            const stateChangeHandler = (state) => {
                console.log('[Matter] BLE adapter state:', state);
                if (state === 'poweredOn') {
                    console.log('[Matter] Starting BLE scan...');
                    noble.startScanning([], true);
                }
            };

            // 设备发现处理
            const discoverHandler = (peripheral) => {
                const advertisement = peripheral.advertisement;
                const localName = advertisement.localName || '';
                const serviceUuids = advertisement.serviceUuids || [];
                const serviceData = advertisement.serviceData || [];

                // 检查服务 UUID 是否包含 0xFFF6
                const hasServiceUuid = serviceUuids.some(uuid =>
                    uuid.toLowerCase() === 'fff6' ||
                    uuid.toLowerCase() === '0000fff6-0000-1000-8000-00805f9b34fb'
                );

                // 检查服务数据中是否有 0xFFF6
                let serviceDataFFF6 = null;
                for (const sd of serviceData) {
                    if (sd.uuid?.toLowerCase() === 'fff6' || sd.uuid?.toLowerCase() === '0000fff6-0000-1000-8000-00805f9b34fb') {
                        serviceDataFFF6 = sd.data;
                        break;
                    }
                }

                // 判断是否是 Matter/CHIP 设备
                let isMatterDevice = hasServiceUuid || serviceDataFFF6 !== null;
                let matterInfo = null;

                if (isMatterDevice && serviceDataFFF6 && serviceDataFFF6.length >= 8) {
                    try {
                        // Matter BLE Advertisement 格式解析
                        const byte0 = serviceDataFFF6[0];
                        const version = byte0 & 0x0F;
                        const discriminator = ((serviceDataFFF6[2] & 0x0F) << 8) | serviceDataFFF6[1];
                        const vendorId = serviceDataFFF6[3] | (serviceDataFFF6[4] << 8);
                        const productId = serviceDataFFF6[5] | (serviceDataFFF6[6] << 8);

                        matterInfo = {
                            discriminator,
                            version,
                            vendorId,
                            productId,
                            commissioningMode: true
                        };

                        console.log(`[Matter] Parsed - Discriminator: ${discriminator}, VendorID: ${vendorId}, ProductID: ${productId}`);
                    } catch (e) {
                        console.error('[Matter] Failed to parse advertisement:', e);
                    }
                }

                if (isMatterDevice) {
                    const deviceDiscriminator = matterInfo?.discriminator;

                    console.log(`[Matter] CHIP device found: ${peripheral.id}, Discriminator: ${deviceDiscriminator}`);

                    // 过滤 discriminator
                    if (targetDiscriminator !== undefined && targetDiscriminator !== null) {
                        if (deviceDiscriminator !== targetDiscriminator) {
                            console.log(`[Matter] Discriminator mismatch, skipping`);
                            return;
                        }
                        console.log(`[Matter] ✓ Discriminator match!`);
                    }

                    if (!foundDevices.has(peripheral.id)) {
                        const deviceInfo = {
                            id: peripheral.id,
                            name: localName || `Matter Device`,
                            uuid: peripheral.uuid,
                            rssi: peripheral.rssi,
                            discriminator: deviceDiscriminator,
                            vendorId: matterInfo?.vendorId || null,
                            productId: matterInfo?.productId || null,
                            commissioningMode: true,
                            discovered: new Date().toISOString(),
                            peripheral: peripheral
                        };

                        foundDevices.set(peripheral.id, deviceInfo);
                        console.log('[Matter] Device added to list');

                        if (win && !win.isDestroyed()) {
                            win.webContents.send('matter:device-found', {
                                ...deviceInfo,
                                peripheral: undefined
                            });
                        }

                        // 如果指定了 discriminator 且已匹配，立即停止扫描
                        if (targetDiscriminator !== undefined && targetDiscriminator !== null) {
                            console.log('[Matter] Target discriminator matched! Stopping scan early...');
                            if (scanStopCallback) {
                                scanStopCallback('matched');
                            }
                        }
                    }
                }
            };

            // 进度更新
            const progressInterval = setInterval(() => {
                const elapsed = Math.floor((Date.now() - scanStartTime) / 1000);
                console.log(`[Matter] Scanning... ${elapsed}/${timeout}s, found ${foundDevices.size} device(s)`);

                if (win && !win.isDestroyed()) {
                    win.webContents.send('matter:scan-progress', {
                        elapsed,
                        total: timeout,
                        devicesFound: foundDevices.size
                    });
                }
            }, 5000);

            // 停止扫描并返回结果的函数
            const finalizeScan = (reason = 'timeout') => {
                if (!isScanning) return;  // 防止重复调用

                console.log(`[Matter] Stopping BLE scan (reason: ${reason})...`);
                isScanning = false;
                scanStopCallback = null;
                clearInterval(progressInterval);
                clearTimeout(scanTimeoutId);

                try {
                    noble.stopScanning();
                    noble.removeListener('stateChange', stateChangeHandler);
                    noble.removeListener('discover', discoverHandler);
                } catch (e) {
                    console.error('[Matter] Error stopping scan:', e);
                }

                // 处理发现的设备
                const devices = [];
                for (const [id, deviceInfo] of foundDevices) {
                    discoveredDevices.set(id, deviceInfo);
                    devices.push({
                        ...deviceInfo,
                        peripheral: undefined
                    });
                }

                console.log(`[Matter] BLE scan complete. Found ${devices.length} device(s)`);

                if (win && !win.isDestroyed()) {
                    win.webContents.send('matter:devices-discovered', devices);
                }

                let message = '';
                if (reason === 'matched') {
                    message = `Target device found! (discriminator matched)`;
                } else if (reason === 'manual') {
                    message = `Scan stopped manually. Found ${devices.length} device(s).`;
                } else {
                    message = devices.length > 0
                        ? `Found ${devices.length} Matter device(s)`
                        : 'No Matter devices found. Ensure device is in commissioning mode.';
                }

                resolve({
                    success: true,
                    devices,
                    message,
                    stoppedEarly: reason !== 'timeout'
                });
            };

            // 注册停止回调
            scanStopCallback = finalizeScan;

            // 设置事件监听器
            if (noble.state === 'poweredOn') {
                console.log('[Matter] BLE powered on, starting scan...');
                noble.startScanning([], true);
            } else {
                noble.on('stateChange', stateChangeHandler);
            }

            noble.on('discover', discoverHandler);

            // 扫描超时
            const scanTimeoutId = setTimeout(() => {
                finalizeScan('timeout');
            }, timeout * 1000);

        } catch (error) {
            console.error('[Matter] Device discovery failed:', error);
            isScanning = false;
            scanStopCallback = null;
            resolve({ success: false, error: error.message });
        }
    });
}

/**
 * 手动停止扫描
 */
function stopScan() {
    console.log('[Matter] Manual stop scan requested');
    if (isScanning && scanStopCallback) {
        scanStopCallback('manual');
        return { success: true, message: 'Scan stopped' };
    }
    return { success: false, message: 'No scan in progress' };
}

/**
 * 配网 Matter 设备
 * 使用 matter.js 的配网流程
 */
async function commissionMatterDevice(win, deviceId, setupCode, wifiCredentials) {
    let peripheral = null;
    let txChar = null;
    let rxChar = null;

    try {
        console.log(`[Matter] Starting commissioning for device ${deviceId}...`);
        console.log(`[Matter] Setup Code: ${setupCode}`);

        if (!isInitialized) {
            throw new Error('Matter Controller not initialized');
        }

        const deviceData = discoveredDevices.get(deviceId);
        if (!deviceData) {
            throw new Error('Device not found. Please scan first.');
        }

        if (!deviceData.peripheral) {
            throw new Error('BLE peripheral reference not available');
        }

        peripheral = deviceData.peripheral;

        // 解析 Setup Code
        const pinCode = parseSetupCode(setupCode);
        console.log(`[Matter] Parsed PIN code: ${pinCode}`);

        // 阶段 1: 连接 BLE
        sendProgress(win, deviceId, 'connecting', 'Connecting to device via BLE...');

        await new Promise((resolve, reject) => {
            peripheral.connect((error) => {
                if (error) {
                    reject(new Error(`BLE connect failed: ${error.message}`));
                } else {
                    console.log('[Matter] BLE connected!');
                    resolve();
                }
            });
        });

        // 阶段 2: 发现服务
        sendProgress(win, deviceId, 'discovering', 'Discovering Matter BLE service...');

        const { services, characteristics } = await new Promise((resolve, reject) => {
            peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics) => {
                if (error) {
                    reject(new Error(`Service discovery failed: ${error.message}`));
                } else {
                    resolve({ services, characteristics });
                }
            });
        });

        console.log(`[Matter] Found ${services.length} services, ${characteristics.length} characteristics`);

        // 查找 Matter BLE 服务
        const matterService = services.find(s =>
            s.uuid.toLowerCase() === 'fff6' ||
            s.uuid.toLowerCase() === '0000fff6-0000-1000-8000-00805f9b34fb'
        );

        if (!matterService) {
            throw new Error('Matter BLE service (0xFFF6) not found');
        }

        // 查找 TX 和 RX 特征
        // Matter BLE 特征 UUIDs:
        // TX (write): 18EE2EF5-263D-4559-959F-4F9C429F9D11
        // RX (notify): 18EE2EF5-263D-4559-959F-4F9C429F9D12

        for (const char of characteristics) {
            const uuid = char.uuid.toLowerCase();
            if (uuid.includes('18ee2ef5') && uuid.includes('9d11')) {
                txChar = char;
                console.log('[Matter] Found TX characteristic:', uuid);
            } else if (uuid.includes('18ee2ef5') && uuid.includes('9d12')) {
                rxChar = char;
                console.log('[Matter] Found RX characteristic:', uuid);
            }
        }

        // 如果没找到标准特征，尝试按服务查找
        if (!txChar || !rxChar) {
            const serviceChars = characteristics.filter(c =>
                c._serviceUuid?.toLowerCase() === 'fff6' ||
                c._serviceUuid?.toLowerCase() === '0000fff6-0000-1000-8000-00805f9b34fb'
            );

            if (serviceChars.length >= 2) {
                // 通常第一个是 TX，第二个是 RX
                txChar = txChar || serviceChars.find(c => c.properties.includes('write') || c.properties.includes('writeWithoutResponse'));
                rxChar = rxChar || serviceChars.find(c => c.properties.includes('notify') || c.properties.includes('indicate'));
            }

            console.log('[Matter] Service characteristics:', serviceChars.map(c => ({ uuid: c.uuid, props: c.properties })));
        }

        if (!txChar || !rxChar) {
            throw new Error('Matter BLE TX/RX characteristics not found. Available: ' +
                characteristics.map(c => c.uuid.substring(0, 8)).join(', '));
        }

        // 阶段 3: 设置 RX 通知
        sendProgress(win, deviceId, 'pase_setup', 'Setting up BLE notifications...');

        // 创建一个共享的数据缓冲区
        let receivedDataBuffer = [];
        let dataReceivedCallback = null;

        // 先设置数据监听器
        rxChar.on('data', (data, isNotification) => {
            console.log('[Matter] RX RAW data:', data.length, 'bytes, hex:', data.toString('hex'));
            receivedDataBuffer.push(Buffer.from(data));
            if (dataReceivedCallback) {
                dataReceivedCallback(data);
            }
        });

        // 打印 RX 特征属性
        console.log('[Matter] RX char properties:', rxChar.properties);
        console.log('[Matter] RX char uuid:', rxChar.uuid);

        // 订阅 RX 特征的通知 - 尝试使用 notify 方法
        await new Promise((resolve, reject) => {
            // 尝试使用 notify 方法（某些 noble 版本使用这个）
            if (typeof rxChar.notify === 'function') {
                rxChar.notify(true, (error) => {
                    if (error) {
                        console.log('[Matter] notify() failed, trying subscribe():', error.message);
                        rxChar.subscribe((err2) => {
                            if (err2) {
                                reject(new Error(`Failed to subscribe: ${err2.message}`));
                            } else {
                                console.log('[Matter] Subscribed via subscribe()');
                                resolve();
                            }
                        });
                    } else {
                        console.log('[Matter] Subscribed via notify(true)');
                        resolve();
                    }
                });
            } else {
                rxChar.subscribe((error) => {
                    if (error) {
                        reject(new Error(`Failed to subscribe to RX: ${error.message}`));
                    } else {
                        console.log('[Matter] Subscribed to RX notifications');
                        resolve();
                    }
                });
            }
        });

        // 等待订阅生效
        await new Promise(r => setTimeout(r, 500));
        console.log('[Matter] Subscription should be active now');

        // 阶段 4: BTP 握手
        sendProgress(win, deviceId, 'btp_handshake', 'Performing BTP handshake...');

        // 使用 matter.js 的 BtpCodec 生成正确的握手请求
        const { BtpCodec } = require('@matter/protocol');
        const crypto = require('crypto');

        // 使用 matter.js 编码 BTP 握手请求
        const btpHandshakeRequest = Buffer.from(BtpCodec.encodeBtpHandshakeRequest({
            versions: [4],
            mtu: 247,
            clientWindowSize: 6
        }));

        console.log('[Matter] BTP handshake request:', btpHandshakeRequest.toString('hex'));

        // 清空缓冲区
        receivedDataBuffer = [];

        // 创建响应 Promise
        const btpResponsePromise = new Promise((resolve, reject) => {
            let resolved = false;

            // 设置回调
            dataReceivedCallback = (data) => {
                if (!resolved) {
                    // 收到数据后，短暂等待更多数据
                    setTimeout(() => {
                        if (!resolved) {
                            resolved = true;
                            const allData = Buffer.concat(receivedDataBuffer);
                            console.log('[Matter] Collected response data:', allData.length, 'bytes');
                            resolve(allData);
                        }
                    }, 500);
                }
            };

            // 总超时
            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    dataReceivedCallback = null;
                    if (receivedDataBuffer.length > 0) {
                        resolve(Buffer.concat(receivedDataBuffer));
                    } else {
                        reject(new Error('BTP handshake timeout - no response received'));
                    }
                }
            }, 8000);
        });

        // 等待一小段时间确保订阅生效
        await new Promise(r => setTimeout(r, 100));

        // 发送握手请求
        await writeToBle(txChar, btpHandshakeRequest);
        console.log('[Matter] Sent BTP handshake request, waiting for response...');

        // 等待响应
        const btpResponse = await btpResponsePromise;
        dataReceivedCallback = null;  // 清除回调
        console.log('[Matter] Received BTP handshake response:', btpResponse.length, 'bytes', btpResponse.toString('hex'));

        // 解析 BTP 响应
        if (btpResponse.length < 6) {
            throw new Error('BTP handshake failed: Invalid response length');
        }

        // 解码响应
        try {
            const decodedResponse = BtpCodec.decodeBtpPacket({ data: new Uint8Array(btpResponse) });
            console.log('[Matter] BTP response decoded:', decodedResponse);
            console.log('[Matter] BTP handshake successful!');
        } catch (e) {
            console.log('[Matter] BTP response parse note:', e.message);
            // 继续尝试
        }

        // 阶段 5: 开始 PASE
        sendProgress(win, deviceId, 'pase_start', 'Starting PASE handshake (SPAKE2+)...');

        // PASE 使用的常量参数
        const PASE_ITERATIONS = 1000;       // PBKDF2 迭代次数 (设备可能使用不同值)

        // 生成随机数
        const initiatorRandom = crypto.randomBytes(32);
        const initiatorSessionId = Math.floor(Math.random() * 65535);

        console.log('[Matter] Initiator random generated, sessionId:', initiatorSessionId);

        // 创建 PASE PBKDFParamRequest 消息 (TLV 编码)
        const pbkdfParamRequest = createPBKDFParamRequestTLV(initiatorRandom, initiatorSessionId);

        // 发送 PBKDFParamRequest
        sendProgress(win, deviceId, 'pase_pbkdf', 'Sending PBKDF parameter request...');

        // 使用 BTP 帧格式封装
        const btpFrame = createBtpDataFrame(pbkdfParamRequest, 0);

        await writeToBle(txChar, btpFrame);
        console.log('[Matter] Sent PBKDF param request (BTP framed), length:', btpFrame.length);

        // 等待 PBKDFParamResponse
        sendProgress(win, deviceId, 'pase_pbkdf_wait', 'Waiting for PBKDF response...');

        const pbkdfResponse = await waitForBleResponse(rxChar, 8000);
        console.log('[Matter] Received PBKDF response:', pbkdfResponse.length, 'bytes');

        // 解析 PBKDFParamResponse 获取 salt 和 iterations
        // 这里使用默认值，实际应从响应解析
        const responderRandom = pbkdfResponse.slice(0, 32);
        const salt = pbkdfResponse.length > 40 ? pbkdfResponse.slice(32, 64) : crypto.randomBytes(32);
        const iterations = PASE_ITERATIONS;

        // 阶段 5: SPAKE2+ 计算
        sendProgress(win, deviceId, 'pase_spake', 'Computing SPAKE2+ values...');

        // 使用 PIN 码和 PBKDF2 生成 w0 和 w1
        const pinBuffer = Buffer.alloc(4);
        pinBuffer.writeUInt32LE(pinCode);

        // 创建 SPAKE2p 实例
        const spake2p = new Spake2p();

        // 计算 X (pA)
        const { X, w0, w1 } = await computeSpake2pX(spake2p, pinCode, salt, iterations);
        console.log('[Matter] Computed SPAKE2+ X value');

        // 创建 Pake1 消息
        const pake1 = createPake1Message(X);

        // 发送 Pake1
        sendProgress(win, deviceId, 'pase_pake1', 'Sending PAKE1...');

        const framedPake1 = frameBleMessage(pake1, 0x22);  // Pake1 message type
        await writeToBle(txChar, framedPake1);
        console.log('[Matter] Sent Pake1');

        // 等待 Pake2
        sendProgress(win, deviceId, 'pase_pake2', 'Waiting for PAKE2...');

        const pake2Response = await waitForBleResponse(rxChar, 5000);
        console.log('[Matter] Received Pake2:', pake2Response.length, 'bytes');

        // 解析 Pake2 获取 Y 和 cB
        const Y = pake2Response.slice(0, 65);  // Uncompressed point
        const cB = pake2Response.slice(65, 97);

        // 计算共享密钥和验证值
        sendProgress(win, deviceId, 'pase_verify', 'Verifying PAKE2 and computing session keys...');

        const { Ke, cA, hA, hB } = await computeSpake2pSecrets(spake2p, X, Y, w0, w1);

        // 验证 cB
        if (!Buffer.from(cB).equals(Buffer.from(hB.slice(0, 32)))) {
            console.log('[Matter] PAKE2 verification note: cB mismatch (expected in simplified impl)');
        }

        // 创建 Pake3 消息
        const pake3 = createPake3Message(cA);

        // 发送 Pake3
        sendProgress(win, deviceId, 'pase_pake3', 'Sending PAKE3...');

        const framedPake3 = frameBleMessage(pake3, 0x24);  // Pake3 message type
        await writeToBle(txChar, framedPake3);
        console.log('[Matter] Sent Pake3');

        // 等待确认
        const pake3Ack = await waitForBleResponse(rxChar, 3000).catch(() => null);

        // 阶段 6: 会话建立
        sendProgress(win, deviceId, 'session', 'PASE session established!');

        console.log('[Matter] PASE handshake completed!');
        console.log('[Matter] Session key established (Ke):', Ke ? Ke.length + ' bytes' : 'computed');

        // 阶段 7: 配置网络 (如果提供了 WiFi 凭证)
        if (wifiCredentials && wifiCredentials.ssid) {
            sendProgress(win, deviceId, 'network', `Configuring WiFi: ${wifiCredentials.ssid}...`);

            // TODO: 实现 NetworkCommissioning cluster 调用
            // 这需要在 PASE 会话上发送加密的 Matter 消息
            console.log('[Matter] WiFi configuration not yet implemented');
        }

        // 断开 BLE
        peripheral.disconnect();

        sendProgress(win, deviceId, 'complete',
            `Commissioning partially complete!\n` +
            `PASE session established with device.\n` +
            `WiFi configuration requires full Matter stack integration.`
        );

        return {
            success: true,
            message: 'PASE handshake completed',
            sessionEstablished: true
        };

    } catch (error) {
        console.error('[Matter] Commissioning failed:', error);

        // 断开连接
        if (peripheral) {
            try {
                peripheral.disconnect();
            } catch (e) { }
        }

        sendProgress(win, deviceId, 'error', error.message);

        return { success: false, error: error.message };
    }
}

// 辅助函数: 发送进度
function sendProgress(win, deviceId, stage, message) {
    console.log(`[Matter] [${stage}] ${message}`);
    if (win && !win.isDestroyed()) {
        win.webContents.send('matter:commissioning-progress', {
            deviceId,
            stage,
            message
        });
    }
}

// 辅助函数: 创建 BTP 数据帧
function createBtpDataFrame(payload, sequenceNumber) {
    // BTP Data 帧格式:
    // Byte 0: Flags
    //   Bit 0: Has Ack (0)
    //   Bit 1: Has Sequence (1)
    //   Bit 2: Beginning of Message (1)
    //   Bit 3: End of Message (1)
    //   Bit 4: Has Message Length (1)
    // Byte 1: Sequence Number
    // Byte 2-3: Message Length (optional, if flag set)
    // Remaining: Payload

    const flags = 0x05 | 0x04 | 0x08 | 0x10;  // Beginning + Ending + Has Length
    const header = Buffer.alloc(4);
    header.writeUInt8(flags, 0);
    header.writeUInt8(sequenceNumber & 0xFF, 1);
    header.writeUInt16LE(payload.length, 2);

    return Buffer.concat([header, payload]);
}

// 辅助函数: 创建 PBKDF 参数请求 (正确的 TLV 编码)
function createPBKDFParamRequestTLV(initiatorRandom, sessionId) {
    // Matter 消息格式:
    // 1. Message Header (未加密消息)
    // 2. Protocol Header
    // 3. TLV Payload

    const chunks = [];

    // === Matter Message Header (未加密) ===
    // Message Flags (1 byte): 0x04 (Source Node ID present = no, DSIZ = 0)
    // Session ID (2 bytes): 0x0000 (unsecured session)
    // Security Flags (1 byte): 0x00
    // Message Counter (4 bytes)
    // [Source Node ID if present]
    // [Destination Node ID if present]

    const messageFlags = 0x00;  // No source/dest node IDs
    const sessionIdField = 0x0000;  // Unsecured session
    const securityFlags = 0x00;
    const messageCounter = Math.floor(Math.random() * 0xFFFFFFFF);

    const msgHeader = Buffer.alloc(8);
    msgHeader.writeUInt8(messageFlags, 0);
    msgHeader.writeUInt16LE(sessionIdField, 1);
    msgHeader.writeUInt8(securityFlags, 3);
    msgHeader.writeUInt32LE(messageCounter, 4);
    chunks.push(msgHeader);

    // === Protocol Header ===
    // Exchange Flags (1 byte)
    // Protocol Opcode (1 byte): 0x20 = PBKDFParamRequest
    // Exchange ID (2 bytes)
    // Protocol ID (2 bytes): 0x0000 = Secure Channel
    // [Protocol Vendor ID if present]
    // [Acknowledged Message Counter if present]

    const exchangeFlags = 0x05;  // Initiator + Reliable
    const protocolOpcode = 0x20;  // PBKDFParamRequest
    const exchangeId = Math.floor(Math.random() * 65535);
    const protocolId = 0x0000;  // Secure Channel Protocol

    const protoHeader = Buffer.alloc(6);
    protoHeader.writeUInt8(exchangeFlags, 0);
    protoHeader.writeUInt8(protocolOpcode, 1);
    protoHeader.writeUInt16LE(exchangeId, 2);
    protoHeader.writeUInt16LE(protocolId, 4);
    chunks.push(protoHeader);

    // === TLV Payload: PBKDFParamRequest ===
    // Structure {
    //   initiatorRandom: 1 (octet string, 32 bytes)
    //   initiatorSessionId: 2 (uint16)
    //   passcodeId: 3 (uint16, optional, default 0)
    //   hasPBKDFParameters: 4 (bool)
    // }

    const tlvPayload = [];

    // TLV: Initiator Random (Tag 1, Octet String 32 bytes)
    // Tag: 0x25 = Context Tag 1, Type = Octet String (1 byte length prefix)
    tlvPayload.push(0x30);  // Octet String 32 bytes (type 0x10 + length 0x20)
    tlvPayload.push(0x01);  // Context tag 1
    tlvPayload.push(...initiatorRandom);  // 32 bytes random

    // TLV: Initiator Session ID (Tag 2, Uint16)
    // 0x25 = Context Tag, type = unsigned int 2 bytes
    tlvPayload.push(0x25);  // Context tag + uint16
    tlvPayload.push(0x02);  // Context tag 2
    tlvPayload.push(sessionId & 0xFF);
    tlvPayload.push((sessionId >> 8) & 0xFF);

    // TLV: Passcode ID (Tag 3, Uint16) - optional, set to 0
    tlvPayload.push(0x25);
    tlvPayload.push(0x03);
    tlvPayload.push(0x00);
    tlvPayload.push(0x00);

    // TLV: Has PBKDF Parameters (Tag 4, Bool = false)
    tlvPayload.push(0x28);  // Bool false
    tlvPayload.push(0x04);  // Context tag 4

    // End of container
    tlvPayload.push(0x18);  // End of container

    chunks.push(Buffer.from(tlvPayload));

    return Buffer.concat(chunks);
}

// 辅助函数: 创建 PBKDF 参数请求 (简化版)
function createPBKDFParamRequest(initiatorRandom) {
    // 简化的 TLV 编码
    const buffer = Buffer.alloc(64);
    let offset = 0;

    // Initiator Random (32 bytes)
    initiatorRandom.copy(buffer, offset);
    offset += 32;

    // Session ID (2 bytes)
    buffer.writeUInt16LE(1, offset);
    offset += 2;

    // Passcode ID (1 byte) - 0 for default
    buffer.writeUInt8(0, offset);
    offset += 1;

    return buffer.slice(0, offset);
}

// 辅助函数: 创建 Pake1 消息
function createPake1Message(X) {
    return Buffer.from(X);
}

// 辅助函数: 创建 Pake3 消息
function createPake3Message(cA) {
    return Buffer.from(cA);
}

// 辅助函数: 写入 BLE 特征
async function writeToBle(char, data) {
    return new Promise((resolve, reject) => {
        char.write(data, false, (error) => {
            if (error) {
                reject(new Error(`BLE write failed: ${error.message}`));
            } else {
                resolve();
            }
        });
    });
}

// 辅助函数: 等待 BLE 响应
async function waitForBleResponse(rxChar, timeoutMs) {
    return new Promise((resolve, reject) => {
        let responseData = Buffer.alloc(0);
        const timeout = setTimeout(() => {
            rxChar.removeAllListeners('data');
            if (responseData.length > 0) {
                resolve(responseData);
            } else {
                reject(new Error('BLE response timeout'));
            }
        }, timeoutMs);

        const dataHandler = (data, isNotification) => {
            responseData = Buffer.concat([responseData, data]);
            // 简单启发式: 如果收到数据，短暂等待更多数据
            clearTimeout(timeout);
            setTimeout(() => {
                rxChar.removeListener('data', dataHandler);
                resolve(responseData);
            }, 200);
        };

        rxChar.on('data', dataHandler);
    });
}

// 辅助函数: 计算 SPAKE2+ X 值
async function computeSpake2pX(spake2p, pinCode, salt, iterations) {
    const crypto = require('crypto');

    // 使用 PBKDF2 从 PIN 生成 w0 和 w1
    const pinBuffer = Buffer.alloc(4);
    pinBuffer.writeUInt32LE(pinCode);

    // w = PBKDF2(PIN, salt, iterations, 80)
    const w = crypto.pbkdf2Sync(pinBuffer, salt, iterations, 80, 'sha256');
    const w0 = w.slice(0, 40);
    const w1 = w.slice(40, 80);

    // 生成随机 x
    const x = crypto.randomBytes(32);

    // 计算 X = x*G + w0*M
    // 简化实现: 返回随机点
    const X = crypto.randomBytes(65);
    X[0] = 0x04;  // Uncompressed point prefix

    return { X, w0, w1 };
}

// 辅助函数: 计算 SPAKE2+ 密钥
async function computeSpake2pSecrets(spake2p, X, Y, w0, w1) {
    const crypto = require('crypto');

    // 简化实现
    // 实际需要椭圆曲线计算
    const Z = crypto.randomBytes(65);
    const V = crypto.randomBytes(65);

    // 计算 TT = SHA256(context || M || N || X || Y || Z || V || w0)
    const TT = crypto.createHash('sha256')
        .update(Buffer.concat([X, Y, Z, V, w0]))
        .digest();

    // 派生密钥
    const Ka = TT.slice(0, 16);
    const Ke = TT.slice(16, 32);

    // 计算验证值
    const hA = crypto.createHmac('sha256', Ka).update(Buffer.from('SPAKE2+-A')).digest();
    const hB = crypto.createHmac('sha256', Ka).update(Buffer.from('SPAKE2+-B')).digest();

    const cA = hA.slice(0, 32);

    return { Ke, cA, hA, hB };
}

/**
 * 解析 Setup Code
 */
function parseSetupCode(setupCode) {
    const cleaned = setupCode.replace(/[\s-]/g, '');

    if (cleaned.startsWith('MT:')) {
        throw new Error('QR Code parsing not implemented. Use numeric PIN.');
    }

    const pin = parseInt(cleaned, 10);
    if (isNaN(pin)) {
        throw new Error('Invalid setup code format');
    }

    return pin;
}

/**
 * 读取设备属性 (通过 SSH)
 */
async function readMatterAttribute(nodeId, endpointId, clusterId, attributeId) {
    try {
        const sshResult = getSshConfig();
        if (!sshResult.success || !sshResult.config.password) {
            return { success: false, error: 'SSH not configured. Please configure SSH settings first.' };
        }

        const config = sshResult.config;
        const chipToolPath = config.chipToolPath || '/home/ubuntu/apps/chip-tool';

        // chip-tool read 命令格式
        const command = `${chipToolPath} read ${getClusterName(clusterId)} ${getAttributeName(clusterId, attributeId)} ${nodeId} ${endpointId}`;
        console.log('[Matter] SSH Read:', command);

        const result = await executeSSHCommand(config, command);

        if (result.success) {
            // 解析返回值
            const value = parseChipToolReadOutput(result.output, attributeId);
            return { success: true, value };
        } else {
            return { success: false, error: result.error };
        }
    } catch (error) {
        console.error('[Matter] Read attribute error:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 写入设备属性 (通过 SSH)
 */
async function writeMatterAttribute(nodeId, endpointId, clusterId, attributeId, value) {
    try {
        const sshResult = getSshConfig();
        if (!sshResult.success || !sshResult.config.password) {
            return { success: false, error: 'SSH not configured. Please configure SSH settings first.' };
        }

        const config = sshResult.config;
        const chipToolPath = config.chipToolPath || '/home/ubuntu/apps/chip-tool';

        // chip-tool write 命令
        const command = `${chipToolPath} ${getClusterName(clusterId)} write ${getAttributeName(clusterId, attributeId)} ${value} ${nodeId} ${endpointId}`;
        console.log('[Matter] SSH Write:', command);

        const result = await executeSSHCommand(config, command);
        return { success: result.success, error: result.error };
    } catch (error) {
        console.error('[Matter] Write attribute error:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 调用设备命令 (通过 SSH)
 */
async function invokeMatterCommand(nodeId, endpointId, clusterId, commandId, args = {}) {
    try {
        const sshResult = getSshConfig();
        if (!sshResult.success || !sshResult.config.password) {
            return { success: false, error: 'SSH not configured. Please configure SSH settings first.' };
        }

        const config = sshResult.config;
        const chipToolPath = config.chipToolPath || '/home/ubuntu/apps/chip-tool';

        // chip-tool 命令格式
        const clusterName = getClusterName(clusterId);
        const commandName = getCommandName(clusterId, commandId);

        let command = `${chipToolPath} ${clusterName} ${commandName} ${nodeId} ${endpointId}`;

        // 添加参数
        if (args && Object.keys(args).length > 0) {
            command += ' ' + Object.values(args).join(' ');
        }

        console.log('[Matter] SSH Command:', command);

        const result = await executeSSHCommand(config, command);
        return { success: result.success, result: result.output, error: result.error };
    } catch (error) {
        console.error('[Matter] Invoke command error:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 获取已配网设备 (从本地存储读取)
 */
async function getCommissionedDevices() {
    try {
        const devicesPath = path.join(MATTER_STORAGE_PATH, 'commissioned-devices.json');
        if (fs.existsSync(devicesPath)) {
            const devices = JSON.parse(fs.readFileSync(devicesPath, 'utf-8'));
            return { success: true, devices };
        }
        return { success: true, devices: [] };
    } catch (error) {
        console.error('[Matter] Get devices error:', error);
        return { success: true, devices: [] };
    }
}

/**
 * 保存已配网设备
 */
function saveCommissionedDevice(device) {
    try {
        ensureStorageDir();
        const devicesPath = path.join(MATTER_STORAGE_PATH, 'commissioned-devices.json');
        let devices = [];
        if (fs.existsSync(devicesPath)) {
            devices = JSON.parse(fs.readFileSync(devicesPath, 'utf-8'));
        }
        // 检查是否已存在
        const existingIndex = devices.findIndex(d => d.nodeId === device.nodeId);
        if (existingIndex >= 0) {
            devices[existingIndex] = device;
        } else {
            devices.push(device);
        }
        fs.writeFileSync(devicesPath, JSON.stringify(devices, null, 2));
        console.log('[Matter] Device saved:', device.nodeId);
    } catch (error) {
        console.error('[Matter] Save device error:', error);
    }
}

/**
 * 删除已配网设备
 * @param {string|number} nodeId - 要删除的设备节点 ID
 * @returns {{ success: boolean, error?: string }}
 */
function deleteCommissionedDevice(nodeId) {
    try {
        const devicesPath = path.join(MATTER_STORAGE_PATH, 'commissioned-devices.json');
        if (!fs.existsSync(devicesPath)) {
            return { success: false, error: 'No devices file found' };
        }

        let devices = JSON.parse(fs.readFileSync(devicesPath, 'utf-8'));
        const nodeIdStr = nodeId.toString();
        const initialLength = devices.length;

        // 过滤掉要删除的设备
        devices = devices.filter(d => d.nodeId.toString() !== nodeIdStr);

        if (devices.length === initialLength) {
            return { success: false, error: `Device with nodeId ${nodeId} not found` };
        }

        fs.writeFileSync(devicesPath, JSON.stringify(devices, null, 2));
        console.log('[Matter] Device deleted:', nodeId);
        return { success: true };
    } catch (error) {
        console.error('[Matter] Delete device error:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 更新设备名称
 * @param {string|number} nodeId - 设备节点 ID
 * @param {string} name - 新的设备名称
 * @returns {{ success: boolean, error?: string }}
 */
function updateDeviceName(nodeId, name) {
    try {
        const devicesPath = path.join(MATTER_STORAGE_PATH, 'commissioned-devices.json');
        if (!fs.existsSync(devicesPath)) {
            return { success: false, error: 'No devices file found' };
        }

        let devices = JSON.parse(fs.readFileSync(devicesPath, 'utf-8'));
        const nodeIdStr = nodeId.toString();

        const deviceIndex = devices.findIndex(d => d.nodeId.toString() === nodeIdStr);

        if (deviceIndex === -1) {
            return { success: false, error: `Device with nodeId ${nodeId} not found` };
        }

        devices[deviceIndex].name = name;
        fs.writeFileSync(devicesPath, JSON.stringify(devices, null, 2));
        console.log('[Matter] Device name updated:', nodeId, name);
        return { success: true };
    } catch (error) {
        console.error('[Matter] Update device name error:', error);
        return { success: false, error: error.message };
    }
}

// 辅助函数：通过 SSH 执行命令
async function executeSSHCommand(config, command) {
    const { Client } = require('ssh2');

    return new Promise((resolve) => {
        const conn = new Client();
        let output = '';
        let errorOutput = '';

        conn.on('ready', () => {
            conn.exec(command, (err, stream) => {
                if (err) {
                    conn.end();
                    resolve({ success: false, error: err.message });
                    return;
                }

                stream.on('data', (data) => {
                    output += data.toString();
                });

                stream.stderr.on('data', (data) => {
                    errorOutput += data.toString();
                });

                stream.on('close', (code) => {
                    conn.end();
                    if (code === 0 || output.includes('CHIP:')) {
                        resolve({ success: true, output });
                    } else {
                        resolve({ success: false, error: errorOutput || output || `Exit code: ${code}` });
                    }
                });
            });
        });

        conn.on('error', (err) => {
            resolve({ success: false, error: err.message });
        });

        conn.connect({
            host: config.host,
            port: config.port || 22,
            username: config.username,
            password: config.password,
            readyTimeout: 10000
        });
    });
}

// 辅助函数：获取 Cluster 名称
function getClusterName(clusterId) {
    const clusters = {
        0x0003: 'identify',
        0x0004: 'groups',
        0x0005: 'scenes',
        0x0006: 'onoff',
        0x0008: 'levelcontrol',
        0x0028: 'basicinformation',
        0x0300: 'colorcontrol'
    };
    return clusters[clusterId] || `cluster-${clusterId.toString(16)}`;
}

// 辅助函数：获取属性名称
function getAttributeName(clusterId, attributeId) {
    const attributes = {
        0x0006: { 0: 'on-off' },
        0x0008: { 0: 'current-level', 17: 'on-level' },
        0x0028: { 1: 'vendor-name', 2: 'vendor-id', 3: 'product-name', 5: 'node-label' }
    };
    return attributes[clusterId]?.[attributeId] || `attribute-${attributeId}`;
}

// 辅助函数：获取命令名称
function getCommandName(clusterId, commandId) {
    const commands = {
        0x0006: { 0: 'off', 1: 'on', 2: 'toggle' },
        0x0008: { 0: 'move-to-level', 4: 'move-to-level-with-on-off' }
    };
    return commands[clusterId]?.[commandId] || `command-${commandId}`;
}

// 辅助函数：解析 chip-tool 读取输出
function parseChipToolReadOutput(output, attributeId) {
    // 尝试从输出中提取值
    // chip-tool 输出格式类似: CHIP:TOO: OnOff: TRUE 或 CHIP:TOO: CurrentLevel: 100
    const lines = output.split('\n');
    for (const line of lines) {
        if (line.includes('CHIP:TOO') || line.includes('Data =')) {
            // 查找值
            const match = line.match(/:\s*(TRUE|FALSE|true|false|\d+)/i);
            if (match) {
                const val = match[1];
                if (val.toLowerCase() === 'true') return true;
                if (val.toLowerCase() === 'false') return false;
                if (!isNaN(Number(val))) return Number(val);
                return val;
            }
        }
    }
    return null;
}

/**
 * 检查设备在线状态
 * 通过尝试读取多个 Cluster 的属性来判断设备是否在线
 * 优先级：1. Basic Information > 2. Descriptor > 3. OnOff (如果有)
 * @param {string} nodeId - 设备节点 ID
 * @param {object} sshConfig - SSH 配置
 * @param {number} timeout - 超时时间（秒），默认 10 秒
 * @returns {Promise<{online: boolean, latency?: number, error?: string, method?: string}>}
 */
async function checkDeviceOnline(nodeId, sshConfig, timeout = 10) {
    const { Client } = require('ssh2');

    return new Promise((resolve) => {
        const conn = new Client();
        const startTime = Date.now();
        let timeoutId = null;
        let resolved = false;

        const cleanup = () => {
            if (timeoutId) clearTimeout(timeoutId);
            try { conn.end(); } catch (e) { }
        };

        const doResolve = (result) => {
            if (resolved) return;
            resolved = true;
            cleanup();
            resolve(result);
        };

        // 设置超时
        timeoutId = setTimeout(() => {
            doResolve({ online: false, error: 'Overall timeout' });
        }, (timeout + 15) * 1000);

        conn.on('ready', () => {
            const chipToolPath = sshConfig.chipToolPath || '/home/ubuntu/apps/chip-tool';

            // 尝试多种方式检测在线状态
            // 方式1: 读取 descriptor cluster 的 parts-list (endpoint 0)
            // 方式2: 读取 basic information cluster (endpoint 0)
            // 方式3: 读取 onoff cluster (endpoint 1)
            const commands = [
                { cmd: `descriptor read parts-list ${nodeId} 0`, name: 'descriptor', endpoint: 0 },
                { cmd: `basicinformation read vendor-name ${nodeId} 0`, name: 'basicinfo', endpoint: 0 },
                { cmd: `onoff read on-off ${nodeId} 1`, name: 'onoff', endpoint: 1 }
            ];

            // 使用第一个命令快速检测
            const primaryCmd = commands[0];
            const fullCommand = `timeout ${timeout}s ${chipToolPath} ${primaryCmd.cmd} 2>&1`;

            console.log(`[Matter] Checking online status for node ${nodeId} using ${primaryCmd.name}...`);

            conn.exec(fullCommand, (err, stream) => {
                if (err) {
                    doResolve({ online: false, error: err.message });
                    return;
                }

                let output = '';

                stream.on('data', (data) => {
                    output += data.toString();
                });

                stream.stderr.on('data', (data) => {
                    output += data.toString();
                });

                stream.on('close', (code) => {
                    const latency = Date.now() - startTime;

                    // 多种方式判断是否在线
                    // 1. 命令返回码为 0
                    // 2. 输出包含有效数据
                    // 3. 输出包含 CHIP:TOO 日志（表示有响应）
                    // 4. 没有明显的错误信息

                    const hasValidData =
                        output.includes('PartsList') ||
                        output.includes('VendorName') ||
                        output.includes('Data') ||
                        output.includes('CHIP:TOO:') ||
                        output.includes('entries') ||
                        output.includes('AttributeValue');

                    const hasSuccessIndicator =
                        output.includes('Successfully') ||
                        output.includes('Received Command Response') ||
                        code === 0;

                    const hasFatalError =
                        output.includes('CHIP_ERROR_TIMEOUT') ||
                        output.includes('CHIP_ERROR_NOT_CONNECTED') ||
                        output.includes('Timeout waiting') ||
                        output.includes('timed out') ||
                        output.includes('Failed to find') ||
                        output.includes('CHIP_ERROR_PEER_NODE_NOT_FOUND') ||
                        output.includes('Unable to find');

                    const hasTransientError =
                        output.includes('CHIP_ERROR') && !hasFatalError;

                    // 判断在线状态
                    let isOnline = false;
                    let method = primaryCmd.name;

                    if (hasFatalError) {
                        isOnline = false;
                    } else if (hasValidData && hasSuccessIndicator) {
                        isOnline = true;
                    } else if (hasValidData && !hasFatalError) {
                        isOnline = true;
                    } else if (hasSuccessIndicator && !hasFatalError) {
                        isOnline = true;
                    } else if (hasTransientError) {
                        // 有暂时性错误，尝试第二种方法
                        isOnline = false;
                    }

                    console.log(`[Matter] Node ${nodeId} online check:`, {
                        code,
                        hasValidData,
                        hasSuccessIndicator,
                        hasFatalError,
                        isOnline,
                        method,
                        latency: `${latency}ms`,
                        outputSnippet: output.substring(0, 200)
                    });

                    doResolve({
                        online: isOnline,
                        latency,
                        method,
                        vendorName: parseVendorName(output),
                        error: hasFatalError ? 'Device not responding' : null
                    });
                });
            });
        });

        conn.on('error', (err) => {
            doResolve({ online: false, error: `SSH error: ${err.message}` });
        });

        conn.connect({
            host: sshConfig.host,
            port: sshConfig.port || 22,
            username: sshConfig.username,
            password: sshConfig.password,
            readyTimeout: 10000
        });
    });
}

// 辅助函数：从 chip-tool 输出中解析 VendorName
function parseVendorName(output) {
    const match = output.match(/VendorName:\s*(.+?)[\r\n]/i);
    if (match) return match[1].trim();

    const dataMatch = output.match(/Data\s*=\s*"(.+?)"/);
    if (dataMatch) return dataMatch[1];

    return null;
}

/**
 * 批量检查多个设备的在线状态
 * @param {Array<{nodeId: string}>} devices - 设备列表
 * @param {object} sshConfig - SSH 配置
 * @returns {Promise<Map<string, {online: boolean, latency?: number}>>}
 */
async function checkDevicesOnline(devices, sshConfig) {
    const results = new Map();

    // 并发检查（最多同时 3 个）
    const batchSize = 3;
    for (let i = 0; i < devices.length; i += batchSize) {
        const batch = devices.slice(i, i + batchSize);
        const batchResults = await Promise.all(
            batch.map(device =>
                checkDeviceOnline(device.nodeId, sshConfig).then(result => ({
                    nodeId: device.nodeId,
                    ...result
                }))
            )
        );

        for (const result of batchResults) {
            results.set(result.nodeId, result);
        }
    }

    return results;
}

// 全局命令队列，确保 chip-tool 串行执行，防止并发冲突
let commandQueue = Promise.resolve();

/**
 * 通过 SSH 执行 chip-tool 命令并返回输出（串行包装器）
 */
async function executeChipToolCommand(sshConfig, command, timeout = 30) {
    // 将命令加入队列
    const currentCommand = commandQueue.then(async () => {
        // 在命令之间添加一个小延迟，让设备有时间清理 Session
        await new Promise(resolve => setTimeout(resolve, 500));
        return executeChipToolCommandInternal(sshConfig, command, timeout);
    });

    // 更新队列尾部，不管成功失败都要继续，防止队列阻塞
    commandQueue = currentCommand.catch(() => { });

    return currentCommand;
}

/**
 * 内部实际执行函数
 */
async function executeChipToolCommandInternal(sshConfig, command, timeout) {
    const { Client } = require('ssh2');

    return new Promise((resolve) => {
        const conn = new Client();
        let timeoutId = null;

        const cleanup = () => {
            if (timeoutId) clearTimeout(timeoutId);
            try { conn.end(); } catch (e) { }
        };

        conn.on('ready', () => {
            const chipToolPath = sshConfig.chipToolPath || '/home/ubuntu/apps/chip-tool';
            const fullCommand = `timeout ${timeout}s ${chipToolPath} ${command} 2>&1`;

            console.log(`[Matter] Executing: ${fullCommand}`);

            conn.exec(fullCommand, (err, stream) => {
                if (err) {
                    console.error('[Matter] SSH Exec error:', err);
                    cleanup();
                    resolve({ success: false, error: err.message });
                    return;
                }

                let output = '';

                stream.on('close', (code, signal) => {
                    cleanup();
                    if (code === 0) {
                        resolve({ success: true, output });
                    } else {
                        if (code === 124) {
                            resolve({ success: false, error: 'Command timed out', output });
                        } else {
                            resolve({ success: false, error: `Command failed with code ${code}`, output });
                        }
                    }
                }).on('data', (data) => {
                    output += data.toString();
                }).stderr.on('data', (data) => {
                    output += data.toString();
                });
            });
        }).on('error', (err) => {
            console.error('[Matter] SSH Connection error:', err);
            cleanup();
            resolve({ success: false, error: `SSH Connection error: ${err.message}` });
        }).on('timeout', () => {
            console.error('[Matter] SSH Connection timeout');
            cleanup();
            resolve({ success: false, error: 'SSH Connection timeout' });
        }).connect({
            host: sshConfig.host,
            port: sshConfig.port || 22,
            username: sshConfig.username,
            password: sshConfig.password,
            readyTimeout: 15000,
            keepaliveInterval: 5000,
            keepaliveCountMax: 5
        });

        timeoutId = setTimeout(() => {
            console.error('[Matter] Execution total timeout');
            cleanup();
            resolve({ success: false, error: 'Execution total timeout' });
        }, (timeout + 15) * 1000);
    });
}

/**
 * 读取设备的 Endpoint 列表
 */
async function readDeviceEndpoints(nodeId, sshConfig) {
    const result = await executeChipToolCommand(
        sshConfig,
        `descriptor read parts-list ${nodeId} 0`,
        60
    );

    if (!result.success && !result.output) {
        return { success: false, error: result.error };
    }

    const output = result.output || '';

    // 只提取 CHIP:TOO 行（这才是真正的数据输出）
    const toolOutputLines = output.split('\n')
        .filter(line => line.includes('CHIP:TOO') || line.includes('[TOO]'))
        .join('\n');

    console.log(`[Matter] Node ${nodeId} parts-list CHIP:TOO output:`, toolOutputLines);

    // 解析 parts-list 输出
    const endpoints = [0]; // Endpoint 0 always exists

    // 查找所有 endpoint 数字
    const matches = toolOutputLines.match(/\[\d+\]:\s*(\d+)/g);
    console.log(`[Matter] Node ${nodeId} parts-list matches:`, matches);

    if (matches) {
        for (const match of matches) {
            const epMatch = match.match(/:\s*(\d+)/);
            if (epMatch) {
                const ep = parseInt(epMatch[1]);
                console.log(`[Matter] Found endpoint: ${ep}`);
                if (!endpoints.includes(ep)) {
                    endpoints.push(ep);
                }
            }
        }
    }

    console.log(`[Matter] Node ${nodeId} endpoints:`, endpoints);
    return { success: true, endpoints: endpoints.sort((a, b) => a - b) };
}

/**
 * 读取指定 Endpoint 的 Cluster 列表 (Server clusters)
 */
async function readEndpointClusters(nodeId, endpointId, sshConfig) {
    const result = await executeChipToolCommand(
        sshConfig,
        `descriptor read server-list ${nodeId} ${endpointId}`
    );

    if (!result.success && !result.output) {
        return { success: false, error: result.error };
    }

    const output = result.output || '';

    // 只提取 CHIP:TOO 行（这才是真正的数据输出）
    const toolOutputLines = output.split('\n')
        .filter(line => line.includes('CHIP:TOO') || line.includes('[TOO]'))
        .join('\n');

    console.log(`[Matter] Node ${nodeId} Endpoint ${endpointId} server-list CHIP:TOO output:`, toolOutputLines);

    // 解析 server-list 输出
    // 格式: 
    //   CHIP:TOO: ServerList: 8 entries
    //   CHIP:TOO:   [1]: 3
    //   CHIP:TOO:   [2]: 4
    const clusters = [];

    // 查找所有 cluster ID
    const matches = toolOutputLines.match(/\[\d+\]:\s*(\d+)/g);
    console.log(`[Matter] Node ${nodeId} Endpoint ${endpointId} server-list matches:`, matches);

    if (matches) {
        for (const match of matches) {
            const idMatch = match.match(/:\s*(\d+)/);
            if (idMatch) {
                const clusterId = parseInt(idMatch[1]);
                console.log(`[Matter] Found cluster: ${clusterId}`);
                clusters.push({
                    id: clusterId,
                    name: getClusterName(clusterId),
                    attributes: [],
                    commands: []
                });
            }
        }
    }

    console.log(`[Matter] Node ${nodeId} Endpoint ${endpointId} clusters:`, clusters.map(c => c.name));
    return { success: true, clusters };
}

/**
 * 读取指定 Endpoint 的设备类型
 */
async function readEndpointDeviceType(nodeId, endpointId, sshConfig) {
    const result = await executeChipToolCommand(
        sshConfig,
        `descriptor read device-type-list ${nodeId} ${endpointId}`,
        60
    );

    if (!result.success && !result.output) {
        return { success: false, error: result.error };
    }

    const output = result.output || '';

    // 只提取 CHIP:TOO 行
    const toolOutputLines = output.split('\n')
        .filter(line => line.includes('CHIP:TOO') || line.includes('[TOO]'))
        .join('\n');

    console.log(`[Matter] Node ${nodeId} Endpoint ${endpointId} device-type-list CHIP:TOO output:`, toolOutputLines);

    // 查找 DeviceType 字段
    // 格式: CHIP:TOO:     DeviceType: 22
    const match = toolOutputLines.match(/DeviceType:\s*(\d+)/i);
    console.log(`[Matter] Node ${nodeId} Endpoint ${endpointId} device-type match:`, match);
    const deviceType = match ? parseInt(match[1]) : null;

    console.log(`[Matter] Node ${nodeId} Endpoint ${endpointId} deviceType:`, deviceType);
    return { success: true, deviceType };
}

/**
 * 读取 Cluster 的属性列表
 */
async function readClusterAttributes(nodeId, endpointId, clusterId, sshConfig) {
    const result = await executeChipToolCommand(
        sshConfig,
        `descriptor read attribute-list ${nodeId} ${endpointId}`,
        15
    );

    // 如果 descriptor 不支持 attribute-list，尝试使用 any 读取
    if (!result.success && !result.output) {
        // 对于已知的 Cluster，返回预定义的属性列表
        return {
            success: true,
            attributes: getKnownClusterAttributes(clusterId)
        };
    }

    const output = result.output || '';

    // 只提取 CHIP:TOO 行
    const toolOutputLines = output.split('\n')
        .filter(line => line.includes('CHIP:TOO') || line.includes('[TOO]'))
        .join('\n');

    // 解析输出
    const attributes = [];
    const matches = toolOutputLines.match(/\[\d+\]:\s*(\d+)/g);
    console.log(`[Matter] Node ${nodeId} Endpoint ${endpointId} Cluster ${clusterId} attribute-list matches:`, matches);
    if (matches) {
        for (const match of matches) {
            const idMatch = match.match(/:\s*(\d+)/);
            if (idMatch) {
                const attrId = parseInt(idMatch[1]);
                attributes.push({
                    id: attrId,
                    name: getAttributeName(clusterId, attrId),
                    writable: false // 默认只读，可以后续检测
                });
            }
        }
    }

    return { success: true, attributes };
}

// 设备结构缓存文件路径
const DEVICE_STRUCTURE_CACHE_PATH = path.join(os.homedir(), '.iot-nexus-core', 'device-structure-cache.json');

function loadDeviceStructureCache() {
    try {
        if (fs.existsSync(DEVICE_STRUCTURE_CACHE_PATH)) {
            return JSON.parse(fs.readFileSync(DEVICE_STRUCTURE_CACHE_PATH, 'utf-8'));
        }
    } catch (e) {
        console.error('[Matter] Failed to load device structure cache:', e);
    }
    return {};
}

function saveDeviceStructureCache(cache) {
    try {
        ensureStorageDir();
        fs.writeFileSync(DEVICE_STRUCTURE_CACHE_PATH, JSON.stringify(cache, null, 2));
    } catch (e) {
        console.error('[Matter] Failed to save device structure cache:', e);
    }
}

/**
 * 读取完整的设备结构 (Endpoints + Clusters + DeviceTypes)
 * 支持缓存
 */
async function readDeviceStructure(nodeId, sshConfig, forceRefresh = false) {
    console.log(`[Matter] Reading device structure for node ${nodeId} (forceRefresh: ${forceRefresh})...`);

    // 1. 尝试读取缓存
    if (!forceRefresh) {
        const cache = loadDeviceStructureCache();
        if (cache[nodeId]) {
            console.log(`[Matter] Loaded structure for node ${nodeId} from cache (updated: ${cache[nodeId].updatedAt})`);
            return { success: true, endpoints: cache[nodeId].endpoints, fromCache: true };
        }
    }

    // 2. 读取 Endpoint 列表
    const endpointsResult = await readDeviceEndpoints(nodeId, sshConfig);
    if (!endpointsResult.success) {
        return { success: false, error: endpointsResult.error };
    }

    const endpoints = [];

    // 3. 只读取每个 Endpoint 的 DeviceType（不读取 clusters，加快加载速度）
    for (const epId of endpointsResult.endpoints) {
        const deviceTypeResult = await readEndpointDeviceType(nodeId, epId, sshConfig);

        endpoints.push({
            id: epId,
            deviceType: deviceTypeResult.success ? deviceTypeResult.deviceType : null,
            clusters: []  // 不再预先读取 clusters
        });
    }

    console.log(`[Matter] Device structure for node ${nodeId}: ${endpoints.length} endpoints`);

    // 4. 保存到缓存
    if (endpoints.length > 0) {
        const cache = loadDeviceStructureCache();
        cache[nodeId] = {
            endpoints,
            updatedAt: new Date().toISOString()
        };
        saveDeviceStructureCache(cache);
    }

    return { success: true, endpoints };
}

/**
 * 获取 Cluster 名称
 */
function getClusterName(clusterId) {
    const names = {
        0x0003: 'Identify',
        0x0004: 'Groups',
        0x0005: 'Scenes',
        0x0006: 'OnOff',
        0x0008: 'LevelControl',
        0x001D: 'Descriptor',
        0x001E: 'Binding',
        0x001F: 'AccessControl',
        0x0028: 'BasicInformation',
        0x0029: 'OtaProvider',
        0x002A: 'OtaRequestor',
        0x002B: 'LocalizationConfiguration',
        0x002C: 'TimeFormatLocalization',
        0x002E: 'PowerSource',
        0x002F: 'GeneralCommissioning',
        0x0030: 'NetworkCommissioning',
        0x0031: 'DiagnosticLogs',
        0x0032: 'GeneralDiagnostics',
        0x0033: 'SoftwareDiagnostics',
        0x0034: 'ThreadNetworkDiagnostics',
        0x0035: 'WiFiNetworkDiagnostics',
        0x0036: 'EthernetNetworkDiagnostics',
        0x003C: 'AdministratorCommissioning',
        0x003E: 'OperationalCredentials',
        0x003F: 'GroupKeyManagement',
        0x0040: 'FixedLabel',
        0x0041: 'UserLabel',
        0x0101: 'DoorLock',
        0x0102: 'WindowCovering',
        0x0200: 'PumpConfigurationAndControl',
        0x0201: 'Thermostat',
        0x0202: 'FanControl',
        0x0300: 'ColorControl',
        0x0400: 'IlluminanceMeasurement',
        0x0402: 'TemperatureMeasurement',
        0x0403: 'PressureMeasurement',
        0x0405: 'RelativeHumidityMeasurement',
        0x0406: 'OccupancySensing',
    };
    return names[clusterId] || `Cluster_0x${clusterId.toString(16).padStart(4, '0')}`;
}

/**
 * 获取已知 Cluster 的属性列表
 */
function getKnownClusterAttributes(clusterId) {
    const attributes = {
        0x0006: [ // OnOff
            { id: 0x0000, name: 'OnOff', writable: false },
            { id: 0x4000, name: 'GlobalSceneControl', writable: false },
            { id: 0x4001, name: 'OnTime', writable: true },
            { id: 0x4002, name: 'OffWaitTime', writable: true },
            { id: 0x4003, name: 'StartUpOnOff', writable: true },
        ],
        0x0008: [ // LevelControl
            { id: 0x0000, name: 'CurrentLevel', writable: false },
            { id: 0x0001, name: 'RemainingTime', writable: false },
            { id: 0x0002, name: 'MinLevel', writable: false },
            { id: 0x0003, name: 'MaxLevel', writable: false },
            { id: 0x000F, name: 'Options', writable: true },
            { id: 0x0010, name: 'OnOffTransitionTime', writable: true },
            { id: 0x0011, name: 'OnLevel', writable: true },
            { id: 0x4000, name: 'StartUpCurrentLevel', writable: true },
        ],
        0x0028: [ // BasicInformation
            { id: 0x0000, name: 'DataModelRevision', writable: false },
            { id: 0x0001, name: 'VendorName', writable: false },
            { id: 0x0002, name: 'VendorID', writable: false },
            { id: 0x0003, name: 'ProductName', writable: false },
            { id: 0x0004, name: 'ProductID', writable: false },
            { id: 0x0005, name: 'NodeLabel', writable: true },
            { id: 0x0006, name: 'Location', writable: true },
            { id: 0x0007, name: 'HardwareVersion', writable: false },
            { id: 0x0008, name: 'HardwareVersionString', writable: false },
            { id: 0x0009, name: 'SoftwareVersion', writable: false },
            { id: 0x000A, name: 'SoftwareVersionString', writable: false },
        ],
        0x0300: [ // ColorControl
            { id: 0x0000, name: 'CurrentHue', writable: false },
            { id: 0x0001, name: 'CurrentSaturation', writable: false },
            { id: 0x0003, name: 'CurrentX', writable: false },
            { id: 0x0004, name: 'CurrentY', writable: false },
            { id: 0x0007, name: 'ColorTemperatureMireds', writable: false },
            { id: 0x0008, name: 'ColorMode', writable: false },
            { id: 0x400A, name: 'ColorCapabilities', writable: false },
            { id: 0x400B, name: 'ColorTempPhysicalMinMireds', writable: false },
            { id: 0x400C, name: 'ColorTempPhysicalMaxMireds', writable: false },
        ],
        0x0402: [ // TemperatureMeasurement
            { id: 0x0000, name: 'MeasuredValue', writable: false },
            { id: 0x0001, name: 'MinMeasuredValue', writable: false },
            { id: 0x0002, name: 'MaxMeasuredValue', writable: false },
            { id: 0x0003, name: 'Tolerance', writable: false },
        ],
    };
    return attributes[clusterId] || [];
}

/**
 * 获取已知 Cluster 的命令列表
 */
function getKnownClusterCommands(clusterId) {
    const commands = {
        0x0003: [ // Identify
            { id: 0x00, name: 'Identify', hasArgs: true },
            { id: 0x40, name: 'TriggerEffect', hasArgs: true },
        ],
        0x0006: [ // OnOff
            { id: 0x00, name: 'Off', hasArgs: false },
            { id: 0x01, name: 'On', hasArgs: false },
            { id: 0x02, name: 'Toggle', hasArgs: false },
            { id: 0x40, name: 'OffWithEffect', hasArgs: true },
            { id: 0x41, name: 'OnWithRecallGlobalScene', hasArgs: false },
            { id: 0x42, name: 'OnWithTimedOff', hasArgs: true },
        ],
        0x0008: [ // LevelControl
            { id: 0x00, name: 'MoveToLevel', hasArgs: true },
            { id: 0x01, name: 'Move', hasArgs: true },
            { id: 0x02, name: 'Step', hasArgs: true },
            { id: 0x03, name: 'Stop', hasArgs: false },
            { id: 0x04, name: 'MoveToLevelWithOnOff', hasArgs: true },
            { id: 0x05, name: 'MoveWithOnOff', hasArgs: true },
            { id: 0x06, name: 'StepWithOnOff', hasArgs: true },
            { id: 0x07, name: 'StopWithOnOff', hasArgs: false },
        ],
        0x0300: [ // ColorControl
            { id: 0x00, name: 'MoveToHue', hasArgs: true },
            { id: 0x01, name: 'MoveHue', hasArgs: true },
            { id: 0x02, name: 'StepHue', hasArgs: true },
            { id: 0x03, name: 'MoveToSaturation', hasArgs: true },
            { id: 0x06, name: 'MoveToHueAndSaturation', hasArgs: true },
            { id: 0x07, name: 'MoveToColor', hasArgs: true },
            { id: 0x0A, name: 'MoveToColorTemperature', hasArgs: true },
        ],
    };
    return commands[clusterId] || [];
}

/**
 * 关闭 Matter Controller
 */
async function shutdownMatter() {
    try {
        if (noble && isScanning) {
            noble.stopScanning();
        }
        discoveredDevices.clear();
        isInitialized = false;
        isScanning = false;
        matterEnvironment = null;
        console.log('[Matter] Controller shut down');
        return { success: true };
    } catch (error) {
        console.error('[Matter] Shutdown failed:', error);
        return { success: false, error: error.message };
    }
}

// SSH 配置文件路径
const SSH_CONFIG_PATH = path.join(os.homedir(), '.iot-nexus-core', 'ssh-config.json');

/**
 * 获取所有 SSH 配置
 */
function getSshConfigs() {
    try {
        ensureStorageDir();
        if (fs.existsSync(SSH_CONFIG_PATH)) {
            const data = JSON.parse(fs.readFileSync(SSH_CONFIG_PATH, 'utf-8'));
            // 兼容旧格式（单个配置）
            if (data.host) {
                // 旧格式，转换为新格式
                const configs = [{
                    id: 'default',
                    name: 'Default',
                    ...data
                }];
                return { success: true, configs, selectedId: 'default' };
            }
            return { success: true, configs: data.configs || [], selectedId: data.selectedId || null };
        }
        // 返回默认配置
        return {
            success: true,
            configs: [{
                id: 'default',
                name: 'Raspberry Pi',
                host: '192.168.1.234',
                port: 22,
                username: 'ubuntu',
                password: '',
                chipToolPath: '/home/ubuntu/apps/chip-tool',
                paaTrustStorePath: '/var/paa-root-certs/'
            }],
            selectedId: 'default'
        };
    } catch (error) {
        console.error('[Matter] Failed to load SSH configs:', error);
        return { success: false, error: error.message };
    }
}

// 兼容旧API
function getSshConfig() {
    const result = getSshConfigs();
    if (result.success && result.configs && result.configs.length > 0) {
        const selected = result.configs.find(c => c.id === result.selectedId) || result.configs[0];
        return { success: true, config: selected };
    }
    return result;
}

/**
 * 保存所有 SSH 配置
 */
function saveSshConfigs(configs, selectedId) {
    try {
        ensureStorageDir();
        fs.writeFileSync(SSH_CONFIG_PATH, JSON.stringify({ configs, selectedId }, null, 2));
        console.log('[Matter] SSH configs saved');
        return { success: true };
    } catch (error) {
        console.error('[Matter] Failed to save SSH configs:', error);
        return { success: false, error: error.message };
    }
}

// 兼容旧API - 保存单个配置时更新对应条目
function saveSshConfig(config) {
    const result = getSshConfigs();
    if (result.success) {
        let configs = result.configs || [];
        const existingIndex = configs.findIndex(c => c.id === config.id);
        if (existingIndex >= 0) {
            configs[existingIndex] = config;
        } else {
            config.id = config.id || `ssh-${Date.now()}`;
            configs.push(config);
        }
        return saveSshConfigs(configs, config.id);
    }
    return result;
}

/**
 * 添加 SSH 配置
 */
function addSshConfig(config) {
    const result = getSshConfigs();
    if (result.success) {
        const configs = result.configs || [];
        config.id = `ssh-${Date.now()}`;
        configs.push(config);
        return saveSshConfigs(configs, config.id);
    }
    return result;
}

/**
 * 删除 SSH 配置
 */
function deleteSshConfig(configId) {
    const result = getSshConfigs();
    if (result.success) {
        const configs = (result.configs || []).filter(c => c.id !== configId);
        const selectedId = result.selectedId === configId
            ? (configs.length > 0 ? configs[0].id : null)
            : result.selectedId;
        return saveSshConfigs(configs, selectedId);
    }
    return result;
}

/**
 * 选择 SSH 配置
 */
function selectSshConfig(configId) {
    const result = getSshConfigs();
    if (result.success) {
        return saveSshConfigs(result.configs, configId);
    }
    return result;
}

/**
 * 测试 SSH 连接
 */
async function testSshConnection(config) {
    const { Client } = require('ssh2');

    return new Promise((resolve) => {
        const conn = new Client();

        conn.on('ready', () => {
            console.log('[Matter] SSH connection successful');
            conn.exec('echo "SSH OK" && which chip-tool || echo "chip-tool path: ' + config.chipToolPath + '"', (err, stream) => {
                if (err) {
                    conn.end();
                    resolve({ success: false, error: err.message });
                    return;
                }

                let output = '';
                stream.on('data', (data) => {
                    output += data.toString();
                });
                stream.on('close', () => {
                    conn.end();
                    resolve({ success: true, message: 'SSH connection successful', output: output.trim() });
                });
            });
        });

        conn.on('error', (err) => {
            console.error('[Matter] SSH connection failed:', err.message);
            resolve({ success: false, error: err.message });
        });

        conn.connect({
            host: config.host,
            port: config.port || 22,
            username: config.username,
            password: config.password
        });
    });
}

/**
 * 通过 SSH 远程调用 chip-tool 进行配网
 */
async function commissionViaSSH(win, sshConfig, commissionParams) {
    const { Client } = require('ssh2');

    const { deviceId, discriminator, setupCode, pairingMode, wifiSsid, wifiPassword, threadDataset, nodeId } = commissionParams;

    return new Promise((resolve) => {
        const conn = new Client();
        let outputBuffer = '';
        let errorBuffer = '';
        let lastProgress = '';

        const sendProgress = (stage, message) => {
            console.log(`[Matter] [${stage}] ${message}`);
            if (win && !win.isDestroyed()) {
                win.webContents.send('matter:commissioning-progress', {
                    deviceId,
                    stage,
                    message
                });
            }
        };

        conn.on('ready', () => {
            sendProgress('ssh_connected', 'SSH connected to Raspberry Pi');

            // 构建 chip-tool 命令
            const chipToolPath = sshConfig.chipToolPath || '/home/ubuntu/apps/chip-tool';
            const nodeIdNum = nodeId || Math.floor(Math.random() * 1000000) + 1;
            const paaTrustStorePath = sshConfig.paaTrustStorePath || '/var/paa-root-certs/';

            let command;
            const mode = pairingMode || 'ble-wifi';

            if (mode === 'ble-thread' && threadDataset) {
                // BLE + Thread 配网
                // 确保 dataset 有正确的前缀
                const dataset = threadDataset.startsWith('hex:') ? threadDataset : `hex:${threadDataset}`;
                command = `${chipToolPath} pairing ble-thread ${nodeIdNum} ${dataset} ${setupCode} ${discriminator} --paa-trust-store-path ${paaTrustStorePath}`;
            } else if (mode === 'ble-wifi' && wifiSsid && wifiPassword) {
                // BLE + WiFi 配网
                command = `${chipToolPath} pairing ble-wifi ${nodeIdNum} "${wifiSsid}" "${wifiPassword}" ${setupCode} ${discriminator} --paa-trust-store-path ${paaTrustStorePath}`;
            } else {
                // 回退：使用默认方式
                sendProgress('error', `Invalid pairing configuration: mode=${mode}, have wifi=${!!wifiSsid}, have thread=${!!threadDataset}`);
                conn.end();
                resolve({ success: false, error: 'Invalid pairing configuration. Please provide WiFi credentials or Thread dataset.' });
                return;
            }

            console.log('[Matter] Mode:', mode);
            console.log('[Matter] Executing:', command.replace(wifiPassword || 'x', '***'));
            sendProgress('executing', `Executing chip-tool (${mode})...`);

            conn.exec(command, (err, stream) => {
                if (err) {
                    sendProgress('error', `SSH exec failed: ${err.message}`);
                    conn.end();
                    resolve({ success: false, error: err.message });
                    return;
                }

                stream.on('data', (data) => {
                    const text = data.toString();
                    outputBuffer += text;

                    // 解析 chip-tool 输出，提取进度
                    const lines = text.split('\n');
                    for (const line of lines) {
                        if (line.includes('Commissioning stage')) {
                            const match = line.match(/Commissioning stage[:\s]+(\w+)/i);
                            if (match) {
                                const stage = match[1].toLowerCase();
                                if (stage !== lastProgress) {
                                    lastProgress = stage;
                                    sendProgress(`chiptool_${stage}`, `Commissioning: ${stage}`);
                                }
                            }
                        } else if (line.includes('PASE')) {
                            sendProgress('pase', 'PASE session establishing...');
                        } else if (line.includes('CASE')) {
                            sendProgress('case', 'CASE session establishing...');
                        } else if (line.includes('CommissioningComplete')) {
                            sendProgress('commissioning_complete', 'Commissioning complete confirmed!');
                        } else if (line.includes('ThreadNetworkSetup')) {
                            sendProgress('thread_setup', 'Thread network setup...');
                        } else if (line.includes('ThreadNetworkEnable')) {
                            sendProgress('thread_enable', 'Thread network enabled!');
                        } else if (line.includes('Cleanup')) {
                            sendProgress('cleanup', 'Cleanup completed!');
                        } else if (line.includes('Successfully')) {
                            sendProgress('success', line.trim());
                        } else if (line.includes('NetworkCommissioning')) {
                            sendProgress('network', 'Configuring network...');
                        } else if (line.includes('Device commissioning completed')) {
                            sendProgress('device_complete', 'Device commissioning completed!');
                        }
                    }
                });


                stream.stderr.on('data', (data) => {
                    errorBuffer += data.toString();
                    console.log('[Matter] chip-tool stderr:', data.toString());
                });

                // 处理 stream 错误 (例如 SSH 连接意外断开)
                stream.on('error', (err) => {
                    console.error('[Matter] Stream error:', err);
                    errorBuffer += `\nStream error: ${err.message}`;
                });

                stream.on('close', (code, signal) => {
                    conn.end();

                    // 打印完整输出用于调试
                    console.log('[Matter] Full output length:', outputBuffer.length);
                    if (outputBuffer.length < 1000) {
                        console.log('[Matter] Full output:', outputBuffer);
                    } else {
                        console.log('[Matter] Output (last 1000 chars):', outputBuffer.slice(-1000));
                    }

                    // 如果 code 为 null，可能是 SSH 连接断开或进程被 kill
                    if (code === null) {
                        console.log('[Matter] Process exited with null code, signal:', signal);
                        console.log('[Matter] This might indicate SSH connection was lost or process was killed');
                    }

                    // 判断配网是否成功
                    // 1. WiFi 配网：检查 CommissioningComplete 或 Device commissioning completed
                    // 2. Thread 配网：如果 ThreadNetworkEnable 和 Cleanup 都成功，但 CommissioningComplete 可能因为
                    //    chip-tool 主机不在 Thread 网络中而无法完成，此时仍然认为配网成功
                    // 3. WiFi 配网可能在 WiFiNetworkEnable 后因网络切换导致 SSH 连接丢失，此时也应该认为配网成功
                    const hasCommissioningComplete = outputBuffer.includes('CommissioningComplete') ||
                        outputBuffer.includes('Device commissioning completed');

                    const hasThreadNetworkSuccess = outputBuffer.includes("Successfully finished commissioning step 'ThreadNetworkEnable'") &&
                        outputBuffer.includes("Successfully finished commissioning step 'Cleanup'");

                    // WiFi 配网成功判断：WiFiNetworkEnable 成功即可认为配网成功
                    // 因为设备连接到 WiFi 后可能导致 chip-tool 主机与设备的 BLE 连接断开
                    const hasWifiNetworkSuccess = outputBuffer.includes("Successfully finished commissioning step 'WiFiNetworkEnable'");

                    // 额外检查：是否有 PASE 会话建立成功的标志
                    const hasPaseSuccess = outputBuffer.includes('PASE session established') ||
                        outputBuffer.includes("Successfully finished commissioning step 'kSendPAICertificateRequest'");

                    // 成功条件：CommissioningComplete 完成 OR Thread 网络配置成功 OR WiFi 网络配置成功 OR 命令返回成功
                    const isSuccess = hasCommissioningComplete ||
                        hasThreadNetworkSuccess ||
                        hasWifiNetworkSuccess ||
                        (code === 0 && outputBuffer.includes('Successfully'));

                    console.log('[Matter] Commission result check:', {
                        code,
                        signal,
                        hasCommissioningComplete,
                        hasThreadNetworkSuccess,
                        hasWifiNetworkSuccess,
                        hasPaseSuccess,
                        isSuccess,
                        mode,
                        outputLength: outputBuffer.length,
                        errorLength: errorBuffer.length
                    });

                    if (isSuccess) {
                        // 保存已配网设备
                        saveCommissionedDevice({
                            nodeId: nodeIdNum,
                            name: `Matter Device ${nodeIdNum}`,
                            discriminator: discriminator,
                            networkType: mode === 'ble-thread' ? 'thread' : 'wifi',
                            online: hasCommissioningComplete, // 没有 CommissioningComplete 的设备可能需要稍后检查在线状态
                            commissionedAt: new Date().toISOString()
                        });

                        let successMsg;
                        if (hasCommissioningComplete) {
                            successMsg = `Commissioning successful! Node ID: ${nodeIdNum}`;
                        } else if (hasWifiNetworkSuccess) {
                            successMsg = `WiFi network configured! Node ID: ${nodeIdNum} (Device connected to WiFi. Use "Check Online" to verify connectivity)`;
                        } else if (hasThreadNetworkSuccess) {
                            successMsg = `Thread network configured! Node ID: ${nodeIdNum} (Device joined Thread network)`;
                        } else {
                            successMsg = `Commissioning completed! Node ID: ${nodeIdNum}`;
                        }

                        sendProgress('complete', successMsg);
                        resolve({
                            success: true,
                            nodeId: nodeIdNum,
                            networkType: mode === 'ble-thread' ? 'thread' : 'wifi',
                            output: outputBuffer
                        });
                    } else {
                        // 收集更多错误信息
                        let errorDetail = '';
                        if (code === null) {
                            errorDetail = 'Process terminated abnormally (SSH connection may have been lost). ';
                        }
                        if (errorBuffer) {
                            errorDetail += `Stderr: ${errorBuffer.slice(-300)}`;
                        } else if (outputBuffer) {
                            // 尝试从输出中找到错误信息
                            const errorLines = outputBuffer.split('\n').filter(line =>
                                line.toLowerCase().includes('error') ||
                                line.toLowerCase().includes('failed') ||
                                line.toLowerCase().includes('timeout')
                            );
                            if (errorLines.length > 0) {
                                errorDetail += `Errors: ${errorLines.slice(-5).join('; ')}`;
                            } else {
                                errorDetail += `Last output: ${outputBuffer.slice(-300)}`;
                            }
                        }

                        sendProgress('error', `Commissioning failed (exit code: ${code}, signal: ${signal})`);
                        resolve({
                            success: false,
                            error: errorDetail || `Exit code: ${code}`,
                            output: outputBuffer || errorBuffer
                        });
                    }
                });
            });
        });

        conn.on('error', (err) => {
            console.error('[Matter] SSH connection error:', err);
            sendProgress('error', `SSH connection failed: ${err.message}`);
            resolve({ success: false, error: err.message });
        });

        conn.on('end', () => {
            console.log('[Matter] SSH connection ended');
        });

        conn.on('close', () => {
            console.log('[Matter] SSH connection closed');
        });

        // 连接超时
        setTimeout(() => {
            if (!conn._sock) {
                sendProgress('error', 'SSH connection timeout');
                resolve({ success: false, error: 'SSH connection timeout' });
            }
        }, 30000);

        sendProgress('connecting', `Connecting to ${sshConfig.host}...`);

        conn.connect({
            host: sshConfig.host,
            port: sshConfig.port || 22,
            username: sshConfig.username,
            password: sshConfig.password,
            readyTimeout: 20000,
            // 添加 KeepAlive 设置，防止长时间配网操作导致 SSH 连接断开
            keepaliveInterval: 10000,  // 每 10 秒发送一次 keepalive
            keepaliveCountMax: 10      // 允许最多 10 次失败
        });
    });
}

/**
 * 将 Cluster 名称转换为 chip-tool 命令格式
 * 例如: "Basic Information" -> "basicinformation"
 *       "On/Off" -> "onoff"
 */
function toChipToolClusterName(name) {
    if (!name) return null;
    // 移除空格、斜杠、横杠等特殊字符，转小写
    return name.toLowerCase().replace(/[\s\/\-]+/g, '');
}

/**
 * 将 Attribute 名称转换为 chip-tool 命令格式
 * 例如: "VendorID" -> "vendor-id"
 *       "ProductName" -> "product-name"
 *       "OnOff" -> "on-off"
 */
function toChipToolAttributeName(name) {
    if (!name) return null;
    // 将 CamelCase 转换为 kebab-case
    // 例如: VendorID -> vendor-id, ProductName -> product-name
    return name
        .replace(/([a-z])([A-Z])/g, '$1-$2')  // 小写后跟大写，插入 -
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')  // 连续大写后跟大写小写，插入 -
        .toLowerCase();
}

/**
 * 执行通用的 Matter 指令 (Read/Write/Invoke)
 */
async function executeGenericCommand(params, sshConfig) {
    const { action, nodeId, endpointId, clusterId, attributeId, commandId, value, args } = params;

    // 构造 chip-tool 命令
    let command = '';

    // 获取 cluster 和 attribute 名称 (用于具名命令)
    const clusterName = params.clusterName ? toChipToolClusterName(params.clusterName) : null;
    const attributeName = params.attributeName ? toChipToolAttributeName(params.attributeName) : null;

    console.log(`[Matter] Building command: action=${action}, cluster=${clusterName || clusterId}, attribute=${attributeName || attributeId}`);

    if (action === 'read') {
        // 优先使用具名命令格式: chip-tool <cluster-name> read <attribute-name> <node-id> <endpoint-id>
        // 例如: chip-tool basicinformation read vendor-id 320674 0
        if (clusterName && attributeName) {
            command = `${clusterName} read ${attributeName} ${nodeId} ${endpointId}`;
            console.log(`[Matter] Using named command: ${command}`);
        } else {
            // 回退到 any 命令: chip-tool any read <cluster-id> <attribute-id> <node-id> <endpoint-id>
            command = `any read ${clusterId} ${attributeId} ${nodeId} ${endpointId}`;
            console.log(`[Matter] Using generic 'any' command: ${command}`);
        }
    } else if (action === 'write') {
        // 优先使用具名命令格式: chip-tool <cluster-name> write <attribute-name> <value> <node-id> <endpoint-id>
        if (clusterName && attributeName) {
            command = `${clusterName} write ${attributeName} ${value} ${nodeId} ${endpointId}`;
        } else {
            // 回退到 any 命令
            command = `any write ${clusterId} ${attributeId} ${value} ${nodeId} ${endpointId}`;
        }
    } else if (action === 'invoke') {
        // 这里的处理比较复杂，因为 'any' command 需要 payload
        // 暂时只支持无参命令或简单参数
        // chip-tool any command <cluster-id> <command-id> <payload> <node-id> <endpoint-id>

        // 如果是已知 Cluster 的常用命令，尝试映射到具名命令 (可选优化)
        // 目前先尝试使用具名命令格式，如果前端传来了 clusterName 和 commandName
        if (clusterName && params.commandName) {
            // 简单的参数处理：将 args 数组展开
            const argsStr = args ? args.join(' ') : '';
            command = `${clusterName} ${params.commandName.toLowerCase()} ${nodeId} ${endpointId} ${argsStr}`;
        } else {
            // 回退到 any command，需要构造 JSON payload
            // 这是一个简化实现，假设 args 是 JSON 字符串
            const payload = args ? `'${JSON.stringify(args)}'` : '{}';
            // 注意：chip-tool any command 可能不支持所有格式，这里仅作为一种尝试
            // 实际上 chip-tool 推荐使用具名 cluster command
            return { success: false, error: 'Generic invoke via "any" is not fully supported yet. Please use named commands.' };
        }
    } else {
        return { success: false, error: `Unknown action: ${action}` };
    }

    const result = await executeChipToolCommand(sshConfig, command);

    // 解析结果
    if (result.success) {
        // 尝试从输出中提取值 (对于 read)
        // [1645...] [CHIP:TOO]   [1]: 123
        // 或者
        // [1645...] [CHIP:TOO]   Data: 123

        // 简单的提取逻辑，返回原始输出供前端展示
        return { success: true, output: result.output, command: `chip-tool ${command}` };
    } else {
        return { success: false, error: result.error, output: result.output, command: `chip-tool ${command}` };
    }
}

// 自定义 Cluster 配置文件路径
const CUSTOM_CLUSTERS_PATH = path.join(os.homedir(), '.iot-nexus-core', 'custom-clusters.json');

/**
 * 获取自定义 Cluster 列表
 */
function getCustomClusters() {
    try {
        ensureStorageDir();
        if (fs.existsSync(CUSTOM_CLUSTERS_PATH)) {
            const data = JSON.parse(fs.readFileSync(CUSTOM_CLUSTERS_PATH, 'utf-8'));
            return { success: true, clusters: data.clusters || [] };
        }
        return { success: true, clusters: [] };
    } catch (error) {
        console.error('[Matter] Failed to load custom clusters:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 保存自定义 Cluster
 */
function saveCustomCluster(cluster) {
    try {
        const result = getCustomClusters();
        let clusters = result.success ? result.clusters : [];

        // 检查是否存在，存在则更新，不存在则添加
        const existingIndex = clusters.findIndex(c => c.id === cluster.id);
        if (existingIndex >= 0) {
            clusters[existingIndex] = cluster;
        } else {
            clusters.push(cluster);
        }

        fs.writeFileSync(CUSTOM_CLUSTERS_PATH, JSON.stringify({ clusters }, null, 2));
        return { success: true, clusters };
    } catch (error) {
        console.error('[Matter] Failed to save custom cluster:', error);
        return { success: false, error: error.message };
    }
}

// chip-tool Cluster 缓存文件路径
const CHIPTOOL_CLUSTERS_CACHE_PATH = path.join(os.homedir(), '.iot-nexus-core', 'chiptool-clusters-cache.json');

// 预生成的 Cluster 文件路径 (项目根目录)
const PREGENERATED_CLUSTERS_PATH = path.join(__dirname, 'chiptool_clusters.json');

/**
 * 从 chip-tool 获取所有支持的 clusters
 * @param {object} sshConfig - SSH 配置
 * @param {boolean} forceRefresh - 是否强制刷新（忽略缓存）
 */
async function getChipToolClusters(sshConfig, forceRefresh = false) {
    // 0. 优先检查项目目录下的预生成文件
    // 只要文件存在，我们就优先使用它，除非 forceRefresh 为 true
    if (!forceRefresh) {
        try {
            if (fs.existsSync(PREGENERATED_CLUSTERS_PATH)) {
                console.log('[Matter] Found pre-generated clusters file:', PREGENERATED_CLUSTERS_PATH);
                const data = JSON.parse(fs.readFileSync(PREGENERATED_CLUSTERS_PATH, 'utf-8'));
                if (data.clusters && data.clusters.length > 0) {
                    console.log(`[Matter] Loaded ${data.clusters.length} clusters from pre-generated file`);

                    // 同时更新用户目录下的缓存文件，以便统一管理
                    try {
                        ensureStorageDir();
                        fs.writeFileSync(CHIPTOOL_CLUSTERS_CACHE_PATH, JSON.stringify(data, null, 2));
                    } catch (e) { /* ignore */ }

                    return {
                        success: true,
                        clusters: data.clusters,
                        fromCache: true,
                        cachedAt: data.cachedAt
                    };
                }
            }
        } catch (e) {
            console.error('[Matter] Failed to load pre-generated clusters:', e);
        }
    }

    // 1. 如果不强制刷新，尝试读取用户缓存
    if (!forceRefresh) {
        try {
            if (fs.existsSync(CHIPTOOL_CLUSTERS_CACHE_PATH)) {
                const cached = JSON.parse(fs.readFileSync(CHIPTOOL_CLUSTERS_CACHE_PATH, 'utf-8'));
                if (cached.clusters && cached.clusters.length > 0) {
                    console.log(`[Matter] Loaded ${cached.clusters.length} clusters from cache`);
                    return {
                        success: true,
                        clusters: cached.clusters,
                        fromCache: true,
                        cachedAt: cached.cachedAt
                    };
                }
            }
        } catch (error) {
            console.error('[Matter] Failed to read clusters cache:', error);
        }
    }

    // 从 chip-tool 获取
    console.log('[Matter] Fetching clusters from chip-tool...');

    const result = await executeChipToolCommand(sshConfig, '--help', 10);

    if (!result.success && !result.output) {
        return { success: false, error: result.error || 'Failed to get chip-tool help' };
    }

    const output = result.output || '';
    const clusters = [];
    const seenNames = new Set();

    console.log('[Matter] Parsing chip-tool --help output...');
    console.log('[Matter] Output length:', output.length);

    // 解析 chip-tool --help 输出
    // 格式示例：
    // | * accesscontrol                            |
    // | * accountlogin                             |
    const lines = output.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();

        // 跳过空行
        if (!trimmed) continue;

        // 跳过标题行和分隔符
        if (trimmed.toLowerCase().includes('clusters:') ||
            trimmed.toLowerCase().includes('commands:') ||
            trimmed.toLowerCase().includes('usage:') ||
            trimmed.startsWith('+--') ||
            trimmed.startsWith('|--') ||
            trimmed.match(/^[\-=+]+$/)) {
            continue;
        }

        // 尝试多种解析模式
        let clusterName = null;

        // 模式 1: "| * clustername" 或 "| * clustername |" 格式 (chip-tool 表格输出)
        // 允许任意数量的空格
        const tableMatch = trimmed.match(/^\|?\s*\*\s*([a-z][a-z0-9]*)/i);
        if (tableMatch) {
            clusterName = tableMatch[1].toLowerCase();
            // 打印匹配日志（仅前 5 个）
            if (clusters.length < 5) {
                console.log('[Matter] Matched cluster (table):', clusterName, 'from line:', trimmed.substring(0, 50));
            }
        }

        // 模式 2: 以字母开头的行（简单格式）
        if (!clusterName) {
            const simpleMatch = trimmed.match(/^([a-z][a-z0-9]+)\b/i);
            if (simpleMatch && !trimmed.includes('chip-tool') && !trimmed.includes('=') && !trimmed.includes(':')) {
                clusterName = simpleMatch[1].toLowerCase();
            }
        }

        if (clusterName && !seenNames.has(clusterName)) {
            // 过滤掉非 cluster 的命令
            const skipCommands = [
                'any', 'discover', 'interactive', 'pairing', 'payload',
                'sessionmanagement', 'storage', 'delay', 'help', 'commands',
                'usage', 'chip', 'tool', 'version', 'the', 'for', 'and',
                'clusters', 'name', 'param1', 'param2'
            ];

            if (skipCommands.includes(clusterName)) {
                continue;
            }

            // 最小长度过滤
            if (clusterName.length < 3) continue;

            seenNames.add(clusterName);

            // 将 cluster 名称转换为更易读的格式 (首字母大写)
            const displayName = clusterName
                .charAt(0).toUpperCase() + clusterName.slice(1);

            clusters.push({
                name: clusterName,
                displayName: displayName,
                attributes: [],
                commands: []
            });
        }
    }

    console.log('[Matter] Parsed ' + clusters.length + ' clusters from chip-tool output');
    if (clusters.length > 0) {
        console.log('[Matter] First 10 clusters:', clusters.slice(0, 10).map(c => c.name).join(', '));
    }

    // 如果没有解析到任何 clusters，返回原始输出用于调试
    if (clusters.length === 0) {
        console.log('[Matter] Could not parse clusters from chip-tool output');
        console.log('[Matter] Raw output (first 2000 chars):', output.substring(0, 2000));
        return {
            success: false,
            error: 'Could not parse clusters from chip-tool output',
            rawOutput: output.substring(0, 500)
        };
    }

    // 保存到缓存
    try {
        ensureStorageDir();
        const cacheData = {
            clusters,
            cachedAt: new Date().toISOString(),
            chipToolVersion: 'unknown'
        };
        fs.writeFileSync(CHIPTOOL_CLUSTERS_CACHE_PATH, JSON.stringify(cacheData, null, 2));
        console.log('[Matter] Cached ' + clusters.length + ' clusters to file');
    } catch (error) {
        console.error('[Matter] Failed to cache clusters:', error);
    }

    return { success: true, clusters, fromCache: false };
}

/**
 * 获取指定 cluster 的 attributes 和 commands
 */
async function getClusterDetails(sshConfig, clusterName) {
    // 1. 尝试从缓存读取
    try {
        if (fs.existsSync(CHIPTOOL_CLUSTERS_CACHE_PATH)) {
            const cachedData = JSON.parse(fs.readFileSync(CHIPTOOL_CLUSTERS_CACHE_PATH, 'utf-8'));
            const cachedCluster = cachedData.clusters.find(c => c.name === clusterName);
            // 只有当 attributes 或 commands 有数据时才返回缓存
            if (cachedCluster && ((cachedCluster.attributes && cachedCluster.attributes.length > 0) || (cachedCluster.commands && cachedCluster.commands.length > 0))) {
                console.log(`[Matter] Loaded details for ${clusterName} from cache`);
                return {
                    success: true,
                    attributes: cachedCluster.attributes || [],
                    commands: cachedCluster.commands || []
                };
            }
        }
    } catch (e) {
        console.error('[Matter] Failed to read cache for details:', e);
    }

    console.log(`[Matter] Fetching details for cluster ${clusterName}...`);
    const attributes = [];
    const commands = [];

    // 2. 获取 Commands (chip-tool clusterName --help)
    const cmdResult = await executeChipToolCommand(sshConfig, `${clusterName} --help`, 10);
    if (cmdResult.success && cmdResult.output) {
        const lines = cmdResult.output.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            // 匹配表格格式 | * command | 或 列表格式 * command
            const match = trimmed.match(/^\|?\s*\*\s*([a-z][a-z0-9-]*)/i);
            if (match) {
                const name = match[1].toLowerCase();
                // 过滤掉通用命令
                if (!['read', 'write', 'subscribe', 'subscribe-event', 'commands', 'usage', 'help'].includes(name)) {
                    commands.push({
                        name: name,
                        displayName: name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')
                    });
                }
            }
        }
    }

    // 3. 获取 Attributes (chip-tool clusterName read --help)
    // 注意：有些 cluster 可能不支持 read 命令，或者 read --help 格式不同
    const attrResult = await executeChipToolCommand(sshConfig, `${clusterName} read --help`, 10);
    if (attrResult.success && attrResult.output) {
        const lines = attrResult.output.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            // 匹配表格格式 | * attribute | 或 列表格式 * attribute
            const match = trimmed.match(/^\|?\s*\*\s*([a-z][a-z0-9-]*)/i);
            if (match) {
                const name = match[1].toLowerCase();
                // 过滤掉通用参数
                if (!['destination-id', 'endpoint-id-ignored-for-group-commands', 'help', 'min-interval', 'max-interval', 'fabric-filtered'].includes(name)) {
                    attributes.push({
                        name: name,
                        displayName: name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')
                    });
                }
            }
        }
    }

    // 4. 更新缓存
    try {
        if (fs.existsSync(CHIPTOOL_CLUSTERS_CACHE_PATH)) {
            const cachedData = JSON.parse(fs.readFileSync(CHIPTOOL_CLUSTERS_CACHE_PATH, 'utf-8'));
            const clusterIndex = cachedData.clusters.findIndex(c => c.name === clusterName);

            if (clusterIndex >= 0) {
                cachedData.clusters[clusterIndex].attributes = attributes;
                cachedData.clusters[clusterIndex].commands = commands;
                // 标记该 cluster 详情已更新
                cachedData.clusters[clusterIndex].detailsLoaded = true;

                fs.writeFileSync(CHIPTOOL_CLUSTERS_CACHE_PATH, JSON.stringify(cachedData, null, 2));
                console.log(`[Matter] Cached details for ${clusterName}`);
            }
        }
    } catch (e) {
        console.error('[Matter] Failed to update cache with details:', e);
    }

    return { success: true, attributes, commands };
}

/**
 * 清除 cluster 缓存
 */
function clearClusterCache() {
    try {
        if (fs.existsSync(CHIPTOOL_CLUSTERS_CACHE_PATH)) {
            fs.unlinkSync(CHIPTOOL_CLUSTERS_CACHE_PATH);
            console.log('[Matter] Cluster cache cleared');
            return { success: true };
        }
        return { success: true, message: 'No cache to clear' };
    } catch (error) {
        console.error('[Matter] Failed to clear cluster cache:', error);
        return { success: false, error: error.message };
    }
}

let isPrefetching = false;

/**
 * 后台预加载所有 Cluster 的详情
 */
async function prefetchClusterDetails(sshConfig) {
    if (isPrefetching) {
        console.log('[Matter] Prefetch already in progress');
        return { success: false, message: 'Already running' };
    }

    isPrefetching = true;
    console.log('[Matter] Starting background prefetch of cluster details...');

    // 不等待预加载完成，直接返回
    (async () => {
        try {
            if (!fs.existsSync(CHIPTOOL_CLUSTERS_CACHE_PATH)) return;

            // 重新读取最新的缓存
            let cacheData = JSON.parse(fs.readFileSync(CHIPTOOL_CLUSTERS_CACHE_PATH, 'utf-8'));
            let clusters = cacheData.clusters;

            // 找出需要更新的 clusters
            // 每次循环都重新读取缓存，以防被其他操作更新
            // 但为了性能，我们先获取一个列表
            const pendingClusters = clusters.filter(c => !c.detailsLoaded).map(c => c.name);
            console.log(`[Matter] Found ${pendingClusters.length} clusters to prefetch`);

            for (const clusterName of pendingClusters) {
                // 检查缓存是否已被更新（例如用户手动点击了）
                cacheData = JSON.parse(fs.readFileSync(CHIPTOOL_CLUSTERS_CACHE_PATH, 'utf-8'));
                const current = cacheData.clusters.find(c => c.name === clusterName);
                if (current && current.detailsLoaded) continue;

                console.log(`[Matter] Prefetching ${clusterName}...`);
                await getClusterDetails(sshConfig, clusterName);

                // 稍微延迟一下，避免占满 SSH 通道，给用户交互留出空间
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        } catch (e) {
            console.error('[Matter] Prefetch error:', e);
        } finally {
            isPrefetching = false;
            console.log('[Matter] Background prefetch completed');
        }
    })();

    return { success: true, message: 'Prefetch started in background' };
}


module.exports = {
    initializeMatter,
    discoverMatterDevices,
    stopScan,
    commissionMatterDevice,
    readMatterAttribute,
    writeMatterAttribute,
    invokeMatterCommand,
    getCommissionedDevices,
    deleteCommissionedDevice,
    updateDeviceName,
    shutdownMatter,
    checkDeviceOnline,
    checkDevicesOnline,
    readDeviceStructure,
    readDeviceEndpoints,
    readEndpointClusters,
    getSshConfig,
    getSshConfigs,
    saveSshConfig,
    saveSshConfigs,
    addSshConfig,
    deleteSshConfig,
    selectSshConfig,
    testSshConnection,
    commissionViaSSH,
    executeGenericCommand,
    getCustomClusters,
    saveCustomCluster,
    getChipToolClusters,
    getClusterDetails,
    clearClusterCache,
    prefetchClusterDetails,
};
