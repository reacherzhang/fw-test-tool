/**
 * Bonjour/mDNS 设备发现服务
 * 用于发现局域网中的 HAP 设备
 */

const Bonjour = require('bonjour-service').default;
const http = require('http');
const crypto = require('crypto');

let bonjour = null;
let browser = null;
let discoveredDevices = new Map();

// Matter 设备发现
let matterBrowser = null;
let discoveredMatterDevices = new Map();

// 设备加密密钥缓存
let deviceKeys = new Map();

/**
 * MD5 哈希函数
 */
function md5(str) {
    return crypto.createHash('md5').update(str).digest('hex');
}

/**
 * 生成消息 ID
 */
function generateMessageId() {
    const timestamp = Date.now().toString();
    return md5(timestamp);
}

/**
 * 生成消息头
 */
function generateHeader(namespace, method, fromUrl, session) {
    const messageId = generateMessageId();
    const timestamp = Math.floor(Date.now() / 1000);

    // 签名公式: md5(messageId + key + timestamp)
    const key = session && session.key ? session.key : '';
    const sign = md5(messageId + key + String(timestamp));

    return {
        messageId,
        payloadVersion: 1,
        namespace,
        method,
        triggerSrc: 'iot-test-tool',
        timestamp,
        from: fromUrl,
        sign
    };
}

/**
 * 发送 HTTP 请求到设备
 */
async function sendHttpRequest(ip, namespace, method, payload, session) {
    return new Promise((resolve, reject) => {
        const fromUrl = `http://${ip}/config`;
        const header = generateHeader(namespace, method, fromUrl, session);

        const message = JSON.stringify({
            header,
            payload
        });

        console.log(`[Discovery] Sending HTTP to ${ip}:80/config:`, message.substring(0, 200));

        const options = {
            hostname: ip,
            port: 80,
            path: '/config',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(message)
            },
            timeout: 5000
        };

        const req = http.request(options, (res) => {
            console.log(`[Discovery] HTTP Response Status: ${res.statusCode}`);
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                console.log(`[Discovery] Response received from ${ip}, length: ${data.length}`);
                if (res.statusCode !== 200) {
                    console.error(`[Discovery] HTTP Error Status: ${res.statusCode}`);
                }

                try {
                    const response = JSON.parse(data);
                    console.log(`[Discovery] Response from ${ip}:`, JSON.stringify(response).substring(0, 200));
                    resolve({ success: true, data: response });
                } catch (e) {
                    console.error('[Discovery] Invalid JSON response:', data);
                    resolve({ success: false, error: 'Invalid JSON response', raw: data });
                }
            });
        });

        req.on('error', (err) => {
            console.error(`[Discovery] HTTP error for ${ip}:`, err.message);
            resolve({ success: false, error: err.message });
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({ success: false, error: 'Request timeout' });
        });

        req.write(message);
        req.end();
    });
}

/**
 * 发送 HTTP 请求到设备 (带重试机制)
 * 失败时重试指定次数，全部失败后返回 { success: false, shouldFallbackToMqtt: true }
 * @param {string} ip - 设备 IP
 * @param {string} namespace - 命名空间
 * @param {string} method - 方法
 * @param {object} payload - 负载
 * @param {object} session - 会话信息
 * @param {number} maxRetries - 最大重试次数，默认 2
 * @returns {Promise<{success: boolean, data?: any, error?: string, shouldFallbackToMqtt?: boolean}>}
 */
async function sendHttpRequestWithRetry(ip, namespace, method, payload, session, maxRetries = 2) {
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            console.log(`[Discovery] HTTP retry ${attempt}/${maxRetries} for ${ip}...`);
            // 重试前等待一小段时间
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        const result = await sendHttpRequest(ip, namespace, method, payload, session);

        if (result.success) {
            return result;
        }

        lastError = result.error;
        console.log(`[Discovery] HTTP attempt ${attempt + 1} failed: ${lastError}`);
    }

    // 所有重试都失败了
    console.log(`[Discovery] HTTP failed after ${maxRetries + 1} attempts, should fallback to MQTT`);
    return {
        success: false,
        error: lastError,
        shouldFallbackToMqtt: true
    };
}

/**
 * 获取设备系统信息
 */
async function getDeviceSystemAll(ip, session) {
    return sendHttpRequest(ip, 'Appliance.System.All', 'GET', {}, session);
}

/**
 * 发送绑定配置 (旧版本，已废弃)
 * @deprecated 使用 bindDeviceWithEncryption 代替
 */
async function sendBindConfig(ip, session) {
    // 这个函数保留用于兼容性，但实际绑定应该使用 bindDeviceWithEncryption
    console.warn('[Discovery] sendBindConfig is deprecated, use bindDeviceWithEncryption instead');

    const payload = {
        key: {
            key: session?.key || '',
            userId: session?.uid || '',
            gateway: {
                redirect: 1,
                host: session?.mqttDomain || 'iot.meross.com',
                port: 443
            }
        }
    };

    return sendHttpRequest(ip, 'Appliance.Config.Key', 'SET', payload, session);
}

// ========== ECDHE 加密绑定相关函数 ==========

/**
 * AES-CBC-256 加密
 */
function aes256CbcEncrypt(key, iv, data) {
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv));
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    return encrypted;
}

/**
 * AES-CBC-256 解密
 */
function aes256CbcDecrypt(key, iv, encryptedData) {
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv));
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    return decrypted;
}

/**
 * 填充数据到 16 字节块
 */
function padToBlockSize(data, blockSize = 16) {
    const paddingLength = blockSize - (data.length % blockSize);
    const padded = Buffer.alloc(data.length + paddingLength);
    data.copy(padded);
    // 使用 \0 填充
    return padded;
}

/**
 * 获取设备能力列表
 */
async function getDeviceAbility(ip, session) {
    console.log(`[Discovery] Getting device ability from ${ip}...`);
    const result = await sendHttpRequest(ip, 'Appliance.System.Ability', 'GET', {}, session);

    if (!result.success) {
        return { success: false, error: result.error, supportsEncryption: false };
    }

    try {
        const data = result.data;
        if (data?.header?.method === 'GETACK') {
            const abilities = data.payload?.ability || {};
            const supportsEncryption = 'Appliance.Encrypt.Suite' in abilities;
            console.log(`[Discovery] Device ${ip} supports encryption: ${supportsEncryption}`);
            return { success: true, supportsEncryption, abilities };
        }
        return { success: false, error: 'Invalid response method', supportsEncryption: false };
    } catch (e) {
        console.error('[Discovery] Error parsing ability:', e);
        return { success: false, error: e.message, supportsEncryption: false };
    }
}

/**
 * 获取加密套件信息
 */
async function getEncryptSuite(ip, session) {
    console.log(`[Discovery] Getting encrypt suite from ${ip}...`);
    const result = await sendHttpRequest(ip, 'Appliance.Encrypt.Suite', 'GET', {}, session);

    if (!result.success) {
        return { success: false, error: result.error };
    }

    try {
        const data = result.data;
        if (data?.header?.method === 'GETACK') {
            const suite = data.payload?.suite || {};
            console.log(`[Discovery] Encrypt suite:`, suite);
            return {
                success: true,
                keyAgreement: suite.ka,        // e.g., 'ecdhe256'
                symmetricEncryption: suite.se, // e.g., 'aes256'
                digitalSignature: suite.ds     // e.g., 'hmac'
            };
        }
        return { success: false, error: 'Invalid response method' };
    } catch (e) {
        console.error('[Discovery] Error parsing encrypt suite:', e);
        return { success: false, error: e.message };
    }
}

/**
 * 执行 ECDHE 密钥交换
 */
async function performECDHEExchange(ip, session) {
    console.log(`[Discovery] Performing ECDHE key exchange with ${ip}...`);

    // 生成 ECDH 密钥对 (SECP256R1 / P-256)
    const ecdh = crypto.createECDH('prime256v1');
    const localPublicKey = ecdh.generateKeys();

    // 公钥需要是 65 字节的未压缩格式
    if (localPublicKey.length !== 65) {
        console.error('[Discovery] Generated public key is not 65 bytes:', localPublicKey.length);
    }

    // Base64 编码公钥
    const publicKeyBase64 = localPublicKey.toString('base64');
    console.log('[Discovery] Local public key (base64):', publicKeyBase64);

    // 发送公钥到设备
    const payload = {
        ecdhe: {
            step: 1,
            pubkey: publicKeyBase64
        }
    };

    const result = await sendHttpRequest(ip, 'Appliance.Encrypt.ECDHE', 'SET', payload, session);

    if (!result.success) {
        return { success: false, error: result.error };
    }

    try {
        const data = result.data;
        if (data?.header?.method === 'SETACK') {
            const peerPublicKeyBase64 = data.payload?.ecdhe?.pubkey;
            if (!peerPublicKeyBase64) {
                return { success: false, error: 'No peer public key in response' };
            }

            console.log('[Discovery] Peer public key (base64):', peerPublicKeyBase64);

            // 解码设备公钥
            const peerPublicKey = Buffer.from(peerPublicKeyBase64, 'base64');

            // 计算共享密钥
            const sharedSecret = ecdh.computeSecret(peerPublicKey);
            const sharedSecretHex = sharedSecret.toString('hex');

            console.log('[Discovery] Shared secret (hex):', sharedSecretHex);

            // 派生加密密钥: MD5(shared_secret_bytes)
            const encryptionKey = crypto.createHash('md5')
                .update(sharedSecret)
                .digest('hex');

            console.log('[Discovery] Encryption key (md5):', encryptionKey);

            return {
                success: true,
                sharedSecretHex,
                encryptionKey,  // 32 字符的 hex 字符串，用于 AES-256
                ecdh            // 保留 ECDH 对象以供后续使用
            };
        }
        return { success: false, error: 'Invalid response method: ' + data?.header?.method };
    } catch (e) {
        console.error('[Discovery] Error in ECDHE exchange:', e);
        return { success: false, error: e.message };
    }
}

/**
 * 发送加密请求
 */
async function sendEncryptedRequest(ip, header, payload, encryptionKey) {
    return new Promise((resolve, reject) => {
        const originalMessage = JSON.stringify({ header, payload });
        console.log('[Discovery] Original message:', originalMessage.substring(0, 200));

        // 填充到 16 字节块
        const paddedData = padToBlockSize(Buffer.from(originalMessage, 'utf8'));

        // IV 固定为 16 个 '0' 字符
        const iv = '0000000000000000';

        // 加密
        const encrypted = aes256CbcEncrypt(encryptionKey, iv, paddedData);
        const encryptedBase64 = encrypted.toString('base64');

        console.log('[Discovery] Encrypted message (base64):', encryptedBase64.substring(0, 100) + '...');

        const url = `http://${ip}/config`;

        const options = {
            hostname: ip,
            port: 80,
            path: '/config',
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain',
                'Content-Length': Buffer.byteLength(encryptedBase64)
            },
            timeout: 10000
        };

        const req = http.request(options, (res) => {
            console.log(`[Discovery] HTTP Response Status: ${res.statusCode}`);
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                console.log('[Discovery] Encrypted response received, length:', data.length);

                if (data.length === 0) {
                    console.error('[Discovery] Empty response received');
                    resolve({ success: false, error: 'Empty response', statusCode: res.statusCode });
                    return;
                }

                try {
                    // 尝试解密响应
                    const encryptedResponse = Buffer.from(data, 'base64');
                    const decrypted = aes256CbcDecrypt(encryptionKey, iv, encryptedResponse);
                    // 移除填充的 \0
                    const decryptedStr = decrypted.toString('utf8').replace(/\0+$/, '');
                    console.log('[Discovery] Decrypted response:', decryptedStr.substring(0, 200));

                    const response = JSON.parse(decryptedStr);
                    resolve({ success: true, data: response });
                } catch (e) {
                    console.log('[Discovery] Decryption failed, trying plain text parse...');
                    // 可能是明文响应
                    try {
                        const response = JSON.parse(data);
                        resolve({ success: true, data: response });
                    } catch (e2) {
                        console.error('[Discovery] Failed to parse response:', e.message);
                        resolve({ success: false, error: 'Failed to parse response', raw: data });
                    }
                }
            });
        });

        req.on('error', (err) => {
            console.error(`[Discovery] HTTP error:`, err.message);
            resolve({ success: false, error: err.message });
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({ success: false, error: 'Request timeout' });
        });

        req.write(encryptedBase64);
        req.end();
    });
}

/**
 * 绑定设备 - 完整的加密绑定流程
 */
async function bindDevice(ip, session) {
    console.log(`[Discovery] ========== Starting encrypted bind for ${ip} ==========`);

    if (!session || !session.key || !session.uid) {
        return { success: false, error: 'Invalid session: missing key or uid' };
    }

    try {
        // Step 1: 检查设备加密能力
        console.log('[Discovery] Step 1: Checking device ability...');
        const abilityResult = await getDeviceAbility(ip, session);
        if (!abilityResult.success) {
            return { success: false, error: 'Failed to get device ability: ' + abilityResult.error };
        }

        if (!abilityResult.supportsEncryption) {
            // 设备不支持加密，使用明文绑定
            console.log('[Discovery] Device does not support encryption, using plain text binding');
            return await bindDeviceWithoutEncryption(ip, session);
        }

        // Step 2: 获取加密套件
        console.log('[Discovery] Step 2: Getting encrypt suite...');
        const suiteResult = await getEncryptSuite(ip, session);
        if (!suiteResult.success) {
            return { success: false, error: 'Failed to get encrypt suite: ' + suiteResult.error };
        }

        if (suiteResult.keyAgreement !== 'ecdhe256') {
            return { success: false, error: 'Unsupported key agreement: ' + suiteResult.keyAgreement };
        }

        // Step 3: ECDHE 密钥交换
        console.log('[Discovery] Step 3: Performing ECDHE key exchange...');
        const ecdhResult = await performECDHEExchange(ip, session);
        if (!ecdhResult.success) {
            return { success: false, error: 'ECDHE exchange failed: ' + ecdhResult.error };
        }

        // Step 4: 发送加密的配置密钥
        console.log('[Discovery] Step 4: Sending encrypted config key...');
        const fromUrl = `http://${ip}/config`;
        const header = generateHeader('Appliance.Config.Key', 'SET', fromUrl, session);

        const keyPayload = {
            key: {
                key: session.key,
                userId: session.uid,
                gateway: {
                    redirect: 1,
                    host: session.mqttDomain || 'iot.meross.com',
                    port: 443
                }
            }
        };

        const bindResult = await sendEncryptedRequest(ip, header, keyPayload, ecdhResult.encryptionKey);

        if (!bindResult.success) {
            return { success: false, error: 'Failed to send config key: ' + bindResult.error };
        }

        const responseMethod = bindResult.data?.header?.method;
        if (responseMethod === 'SETACK') {
            console.log('[Discovery] ========== Bind successful! ==========');
            return { success: true, data: bindResult.data };
        } else {
            console.log('[Discovery] Bind failed, response method:', responseMethod);
            return { success: false, error: 'Bind failed: ' + responseMethod, data: bindResult.data };
        }

    } catch (error) {
        console.error('[Discovery] Bind error:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 绑定设备 - 非加密模式 (用于不支持加密的旧设备)
 */
async function bindDeviceWithoutEncryption(ip, session) {
    console.log(`[Discovery] Binding device without encryption at ${ip}...`);

    const payload = {
        key: {
            key: session.key,
            userId: session.uid,
            gateway: {
                redirect: 1,
                host: session.mqttDomain || 'iot.meross.com',
                port: 443
            }
        }
    };

    const result = await sendHttpRequest(ip, 'Appliance.Config.Key', 'SET', payload, session);

    if (result.success && result.data?.header?.method === 'SETACK') {
        return { success: true, data: result.data };
    } else {
        return { success: false, error: result.error || 'Bind failed', data: result.data };
    }
}

/**
 * 开始发现设备
 */
function startDiscovery(callback) {
    // 如果已有 browser，先停止
    if (browser) {
        browser.stop();
        browser = null;
    }

    console.log('[Discovery] Starting mDNS discovery for _hap._tcp...');

    // 复用现有的 bonjour 实例，或创建新的
    if (!bonjour) {
        bonjour = new Bonjour();
    }
    discoveredDevices.clear();

    browser = bonjour.find({ type: 'hap', protocol: 'tcp' }, (service) => {
        console.log('[Discovery] Found service:', service.name, service.addresses);

        // 获取 IPv4 地址
        const ipv4Addresses = (service.addresses || []).filter(addr => {
            // 过滤 IPv4 地址，排除 10.10.10.1
            const isIPv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
            const isExcluded = addr === '10.10.10.1';
            return isIPv4 && !isExcluded;
        });

        if (ipv4Addresses.length > 0) {
            const deviceInfo = {
                name: service.name,
                host: service.host,
                port: service.port,
                ipv4: ipv4Addresses[0],
                allAddresses: service.addresses,
                txt: service.txt || {},
                discoveredAt: new Date().toISOString()
            };

            // 使用 name 作为唯一标识
            discoveredDevices.set(service.name, deviceInfo);

            console.log(`[Discovery] Valid device found: ${service.name} @ ${ipv4Addresses[0]}`);

            if (callback) {
                callback('found', deviceInfo);
            }
        } else {
            console.log(`[Discovery] No valid IPv4 for ${service.name}, skipping`);
        }
    });

    // 监听服务下线
    browser.on('down', (service) => {
        console.log('[Discovery] Service down:', service.name);
        discoveredDevices.delete(service.name);
        if (callback) {
            callback('down', { name: service.name });
        }
    });

    return { success: true, message: 'Discovery started' };
}

/**
 * 停止发现
 */
function stopDiscovery() {
    console.log('[Discovery] Stopping mDNS discovery...');

    if (browser) {
        browser.stop();
        browser = null;
    }

    // 注意: 不在这里销毁 bonjour 实例，因为 matterBrowser 可能还在使用它
    // bonjour 实例的销毁由 stopAllDiscovery 统一管理

    return { success: true, message: 'Discovery stopped' };
}

/**
 * 获取已发现的设备列表
 */
function getDiscoveredDevices() {
    return Array.from(discoveredDevices.values());
}

/**
 * 查询设备绑定状态
 */
async function checkDeviceBindStatus(ip, session) {
    const result = await getDeviceSystemAll(ip, session);

    if (!result.success) {
        return { success: false, error: result.error, canBind: false };
    }

    try {
        const payload = result.data?.payload;
        const all = payload?.all || payload;
        const system = all?.system || {};
        const hardware = all?.hardware || {};
        const online = system?.online || {};

        // bindId 和 who 在 system.online 对象中
        const bindId = online.bindId || online.bindid || system.bindId || system.bindid || '';
        const who = online.who !== undefined ? online.who : system.who;

        // 判断是否可以绑定:
        // 1. bindId 为空
        // 2. 或者 bindId 不为空但 who = 2
        const canBind = !bindId || (bindId && who === 2);

        return {
            success: true,
            canBind,
            bindId,
            who,
            deviceInfo: {
                uuid: hardware.uuid || '',
                type: typeof hardware.type === 'string' ? hardware.type : (hardware.type?.type || hardware.type?.toString?.() || ''),
                version: typeof hardware.version === 'string' ? hardware.version : (hardware.version?.toString?.() || ''),
                mac: hardware.mac || '',
                firmware: typeof system.firmware === 'string'
                    ? system.firmware
                    : (system.firmware?.version || all?.firmware?.version || '')
            },
            raw: result.data
        };
    } catch (e) {
        console.error('[Discovery] Error parsing device info:', e);
        return { success: false, error: e.message, canBind: false };
    }
}

/**
 * 开始 Matter 设备发现 (_matterc._udp - 可配网的 Matter 设备)
 */
function startMatterDiscovery(callback) {
    if (!bonjour) {
        bonjour = new Bonjour();
    }

    // 如果已有 Matter 浏览器，先停止
    if (matterBrowser) {
        matterBrowser.stop();
        matterBrowser = null;
    }

    console.log('[Discovery] Starting mDNS discovery for Matter devices (_matter._tcp)...');
    discoveredMatterDevices.clear();

    // Matter 已配网设备使用 TCP (._matter._tcp)
    matterBrowser = bonjour.find({ type: 'matter', protocol: 'tcp' }, (service) => {
        console.log('[Discovery] Found Matter service:', service.name, service.addresses);

        // 获取 IPv4 地址 - 优先从 TXT 记录的 MIP4 获取
        const txt = service.txt || {};
        let ipv4 = txt.MIP4 || txt.mip4 || '';

        // 如果 TXT 没有 MIP4，从 addresses 获取
        if (!ipv4) {
            const ipv4Addresses = (service.addresses || []).filter(addr => {
                const isIPv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
                return isIPv4;
            });
            ipv4 = ipv4Addresses[0] || '';
        }

        if (ipv4) {
            // Matter TXT 记录字段说明 (已配网设备):
            // VP - Vendor ID + Product ID (格式: VID+PID，如 4933+45057)
            // MIP4 - IPv4 地址
            // MIP6 - IPv6 地址
            // 其他可能的字段根据设备而定

            const vendorProduct = txt.VP || txt.vp || '';
            const mip6 = txt.MIP6 || txt.mip6 || '';

            // 解析 Vendor ID 和 Product ID
            let vendorId = '';
            let productId = '';
            if (vendorProduct && vendorProduct.includes('+')) {
                const parts = vendorProduct.split('+');
                vendorId = parts[0];
                productId = parts[1] || '';
            }

            const matterDevice = {
                name: service.name,
                host: service.host,
                port: service.port || 5540,  // Matter 默认端口 5540
                ipv4: ipv4,
                ipv6: mip6,
                allAddresses: service.addresses,
                vendorId,
                productId,
                vendorProduct,
                txt,
                discoveredAt: new Date().toISOString(),
                isMatter: true  // 标记为 Matter 设备
            };

            // 使用 name 作为唯一标识
            const deviceKey = service.name;
            discoveredMatterDevices.set(deviceKey, matterDevice);

            console.log(`[Discovery] Matter device found: ${service.name} @ ${ipv4}:${matterDevice.port}, VP=${vendorProduct}`);

            if (callback) {
                callback('matter_found', matterDevice);
            }
        } else {
            console.log(`[Discovery] No valid IPv4 for Matter device ${service.name}, skipping`);
        }
    });

    // 监听服务下线
    matterBrowser.on('down', (service) => {
        console.log('[Discovery] Matter service down:', service.name);
        // 移除所有匹配的设备
        for (const [key, device] of discoveredMatterDevices) {
            if (device.name === service.name) {
                discoveredMatterDevices.delete(key);
            }
        }
        if (callback) {
            callback('matter_down', { name: service.name });
        }
    });

    return { success: true, message: 'Matter discovery started' };
}

/**
 * 停止 Matter 发现
 */
function stopMatterDiscovery() {
    console.log('[Discovery] Stopping Matter mDNS discovery...');

    if (matterBrowser) {
        matterBrowser.stop();
        matterBrowser = null;
    }

    return { success: true, message: 'Matter discovery stopped' };
}

/**
 * 获取已发现的 Matter 设备列表
 */
function getDiscoveredMatterDevices() {
    return Array.from(discoveredMatterDevices.values());
}

/**
 * 开始所有设备发现 (HAP + Matter)
 */
function startAllDiscovery(callback) {
    // 启动 HAP 发现
    startDiscovery((event, device) => {
        if (callback) {
            callback(event, device);
        }
    });

    // 启动 Matter 发现
    startMatterDiscovery((event, device) => {
        if (callback) {
            callback(event, device);
        }
    });

    return { success: true, message: 'All discovery started (HAP + Matter)' };
}

/**
 * 停止所有设备发现
 */
function stopAllDiscovery() {
    stopDiscovery();
    stopMatterDiscovery();

    // 如果 bonjour 实例不再被使用，销毁它
    if (!browser && !matterBrowser && bonjour) {
        bonjour.destroy();
        bonjour = null;
    }

    return { success: true, message: 'All discovery stopped' };
}

/**
 * 获取所有已发现的设备 (HAP + Matter)
 */
function getAllDiscoveredDevices() {
    const hapDevices = getDiscoveredDevices().map(d => ({ ...d, isMatter: false }));
    const matterDevices = getDiscoveredMatterDevices();
    return [...hapDevices, ...matterDevices];
}

/**
 * 发送 HTTP 请求到设备 (带重试机制)
 * 失败时重试指定次数，全部失败后返回 { success: false, shouldFallbackToMqtt: true }
 * @param {string} ip - 设备 IP
 * @param {string} namespace - 命名空间
 * @param {string} method - 方法
 * @param {object} payload - 负载
 * @param {object} session - 会话信息
 * @param {number} maxRetries - 最大重试次数，默认 2
 * @returns {Promise<{success: boolean, data?: any, error?: string, shouldFallbackToMqtt?: boolean}>}
 */
async function sendHttpRequestWithRetry(ip, namespace, method, payload, session, maxRetries = 2) {
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            console.log(`[Discovery] HTTP retry ${attempt}/${maxRetries} for ${ip}...`);
            // 重试前等待一小段时间
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        const result = await sendHttpRequest(ip, namespace, method, payload, session);

        if (result.success) {
            return result;
        }

        lastError = result.error;
        console.log(`[Discovery] HTTP attempt ${attempt + 1} failed: ${lastError}`);
    }

    // 所有重试都失败了
    console.log(`[Discovery] HTTP failed after ${maxRetries + 1} attempts, should fallback to MQTT`);
    return {
        success: false,
        error: lastError,
        shouldFallbackToMqtt: true
    };
}

// ========== 分步配网功能 ==========

/**
 * 初始化配网流程 (检查能力 + 密钥交换)
 */
async function initializeProvisioning(ip, session) {
    console.log(`[Provision] Initializing for ${ip}...`);

    // 1. Check ability
    // 尝试获取能力，如果失败，不立即放弃，而是尝试直接获取加密套件
    let abilityResult = await getDeviceAbility(ip, session);

    if (!abilityResult.success) {
        console.log('[Provision] Failed to get ability, attempting to check encryption suite directly...');
    } else if (!abilityResult.supportsEncryption) {
        console.log('[Provision] Device reports no encryption support, double checking with suite...');
    }

    // 2. Get suite (如果 ability 失败或说不支持，我们也尝试获取 suite，以防万一)
    const suiteResult = await getEncryptSuite(ip, session);

    if (suiteResult.success) {
        console.log('[Provision] Encryption suite detected, proceeding with ECDHE...');

        // 3. ECDHE Exchange
        const ecdhResult = await performECDHEExchange(ip, session);
        if (!ecdhResult.success) return { success: false, error: 'ECDHE failed: ' + ecdhResult.error };

        // 保存密钥
        deviceKeys.set(ip, ecdhResult.encryptionKey);
        console.log(`[Provision] Encryption key saved for ${ip}`);

        console.log('[Provision] Encryption initialized successfully');
        return { success: true, encrypted: true, message: 'Encryption initialized' };
    }

    // 如果 suite 也获取失败
    if (!abilityResult.success) {
        // ability 和 suite 都失败，可能是网络问题，也可能是不支持
        // 但为了兼容性，返回 success: true, encrypted: false，让后续步骤尝试明文
        console.log('[Provision] Both ability and suite checks failed, assuming no encryption');
        return { success: true, encrypted: false, message: 'Could not detect encryption support' };
    }

    if (!abilityResult.supportsEncryption) {
        return { success: true, encrypted: false, message: 'Device does not support encryption' };
    }

    return { success: false, error: 'Encryption supported but suite retrieval failed' };
}

/**
 * 生成 SetKey Payload
 */
function getSetKeyPayload(session) {
    return {
        key: {
            key: session.key,
            userId: session.uid,
            gateway: {
                redirect: 1,
                host: session.mqttDomain || 'iot.meross.com',
                port: 443
            }
        }
    };
}

/**
 * 通用发送配网请求 (自动处理加密)
 */
async function sendProvisionRequest(ip, namespace, method, payload, session) {
    const encryptionKey = deviceKeys.get(ip);

    if (encryptionKey) {
        console.log(`[Provision] Sending encrypted ${namespace} to ${ip} (Key found)`);
        const fromUrl = `http://${ip}/config`;
        const header = generateHeader(namespace, method, fromUrl, session);
        const result = await sendEncryptedRequest(ip, header, payload, encryptionKey);

        // 特殊处理 WiFi 配置命令：如果超时或连接重置，可能意味着设备已经重启连接 WiFi
        if (!result.success && namespace === 'Appliance.Config.Wifi') {
            const err = result.error || '';
            if (err === 'Request timeout' || err.includes('ECONNRESET') || err.includes('socket hang up')) {
                console.log('[Provision] WiFi config sent, assuming success despite network error (device likely rebooting)');
                return { success: true, message: 'WiFi config sent (device rebooting)' };
            }
        }

        return result;
    } else {
        console.log(`[Provision] Sending plain text ${namespace} to ${ip} (No key found)`);
        return await sendHttpRequestWithRetry(ip, namespace, method, payload, session, 0);
    }
}

/**
 * 设置时间
 */
async function sendSetTime(ip, session) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        time: {
            timestamp: now,
        }
    };
    return sendProvisionRequest(ip, 'Appliance.System.Time', 'SET', payload, session);
}

/**
 * 将数据填充到 16 字节的倍数（PKCS7-like，但使用 \0 填充）
 */
function padTo16(data) {
    const buf = Buffer.from(data, 'utf8');
    const paddingLength = 16 - (buf.length % 16);
    if (paddingLength === 16 && buf.length > 0) {
        return buf; // 已经是 16 的倍数
    }
    const padded = Buffer.alloc(buf.length + paddingLength);
    buf.copy(padded);
    // 使用 \0 填充
    return padded;
}

/**
 * 设置 WiFi
 * @param {string} ip - 设备 IP
 * @param {object} wifiConfig - WiFi 配置 { ssid, password, bssid, channel }
 * @param {object} session - 会话信息
 */
async function sendSetWifi(ip, wifiConfig, session) {
    const { ssid, password, bssid, channel } = wifiConfig;
    console.log('[Provision] sendSetWifi called with:', { ip, ssid, bssid, channel, password: password ? '***' : 'empty' });

    // 获取 ECDHE 协商的加密密钥（用于消息加密）
    const encryptionKey = deviceKeys.get(ip);
    if (!encryptionKey) {
        console.error('[Provision] No encryption key found for', ip);
        return { success: false, error: 'No encryption key found' };
    }

    // 获取设备信息用于计算 pskKey
    console.log('[Provision] Getting device info for pskKey calculation...');
    const systemAllResult = await getDeviceSystemAll(ip, session);
    if (!systemAllResult.success) {
        console.error('[Provision] Failed to get device system info:', systemAllResult.error);
        return { success: false, error: 'Failed to get device info: ' + systemAllResult.error };
    }

    // 从设备信息中提取 type, uuid, macAddress
    const hardware = systemAllResult.data?.payload?.all?.system?.hardware;
    if (!hardware) {
        console.error('[Provision] No hardware info in system response');
        return { success: false, error: 'No hardware info available' };
    }

    const deviceType = hardware.type || '';
    const deviceUuid = hardware.uuid || '';
    const deviceMac = hardware.macAddress || '';

    console.log('[Provision] Device info:', { type: deviceType, uuid: deviceUuid, macAddress: deviceMac });

    // 计算 pskKey = MD5(type + uuid + macAddress)
    const pskKeySource = deviceType + deviceUuid + deviceMac;
    const pskKey = md5(pskKeySource);

    console.log('[Provision] PSK key source:', pskKeySource);
    console.log('[Provision] PSK key (MD5):', pskKey);
    console.log('[Provision] ECDHE key (for message encryption):', encryptionKey);

    // Meross 要求 ssid 必须是 Base64 编码的
    const ssidBase64 = Buffer.from(ssid, 'utf8').toString('base64');

    // 密码加密：
    // 1. 密码填充到 16 字节的倍数
    // 2. 使用 AES-256-CBC 加密（key = pskKey 的 UTF-8 编码，IV = 16 个 '0'）
    // 3. 加密结果转 Base64
    const passwordPadded = padTo16(password || '');
    const iv = '0000000000000000';  // 16 个 '0' 字符

    // 详细调试日志
    console.log('[Provision] Password original:', password);
    console.log('[Provision] Password padded (hex):', passwordPadded.toString('hex'));
    console.log('[Provision] PSK key:', pskKey);
    console.log('[Provision] PSK key length:', Buffer.from(pskKey, 'utf8').length);

    const passwordEncrypted = aes256CbcEncrypt(pskKey, iv, passwordPadded);
    const passwordBase64 = passwordEncrypted.toString('base64');

    console.log('[Provision] Password encrypted (base64):', passwordBase64);
    console.log('[Provision] WiFi ssid (base64):', ssidBase64);

    const payload = {
        wifi: {
            ssid: ssidBase64,
            password: passwordBase64,
            encryption: 6,
            cipher: 3,
            bssid: bssid || '',
            channel: channel || 0
        }
    };

    console.log('[Provision] WiFi payload:', JSON.stringify(payload));

    // 使用 Appliance.Config.WifiX namespace
    return sendProvisionRequest(ip, 'Appliance.Config.WifiX', 'SET', payload, session);
}

module.exports = {
    // 辅助函数
    md5,
    generateMessageId,
    generateHeader,
    sendHttpRequest,
    getDeviceSystemAll,

    // 发现服务
    startDiscovery,
    stopDiscovery,
    getDiscoveredDevices,
    checkDeviceBindStatus,

    // 绑定服务
    bindDevice,

    // Matter 发现
    startMatterDiscovery,
    stopMatterDiscovery,
    getDiscoveredMatterDevices,

    // 统一发现
    startAllDiscovery,
    stopAllDiscovery,
    getAllDiscoveredDevices,

    // HTTP 通信 (带重试)
    sendHttpRequestWithRetry,

    // 分步配网
    initializeProvisioning,
    getSetKeyPayload,
    sendProvisionRequest,
    sendSetTime,
    sendSetWifi
};
