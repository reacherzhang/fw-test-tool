
import { app, BrowserWindow, Menu, ipcMain, session } from 'electron';
import path from 'path';
import { exec } from 'child_process';
import fs from 'fs';
import os from 'os';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import mqtt from 'mqtt';
import { createRequire } from 'module';

// 使用 createRequire 导入 CommonJS 模块
const require = createRequire(import.meta.url);

// WiFi 模块
const wifi = require('node-wifi');
wifi.init({ iface: null });

// SerialPort 模块
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

// 串口实例管理
let serialPort = null;
let serialParser = null;

// MQTT 客户端实例（主进程持有）
let mqttClient = null;

// MySQL 服务
// 使用动态导入加载 ESM 模块
console.log('[Main] Attempting to load MySQL service...');
import('./services/mysqlService.js').then(async ({ registerDatabaseHandlers, initDatabase }) => {
  console.log('[Main] MySQL service loaded, registering handlers...');
  registerDatabaseHandlers();

  // 自动尝试连接数据库 (硬编码配置以确保生产环境可用)
  console.log('[Main] Auto-connecting to Audit Database...');
  const dbConfig = {
    host: '47.108.183.147',
    port: 3306,
    user: 'root',
    password: 's9yBmj3CraDpKLaGAN',
    database: 'iot_nexus_audit',
    connectTimeout: 10000
  };

  try {
    const result = await initDatabase(dbConfig);
    if (result.success) {
      console.log('[Main] ✅ Database auto-connection successful');
    } else {
      console.error('[Main] ❌ Database auto-connection failed:', result.error);
      // 可以在这里发送 IPC 通知给前端显示错误
    }
  } catch (e) {
    console.error('[Main] Database init exception:', e);
  }
}).catch(err => {
  console.error('[Main] Failed to load MySQL service:', err);
});

// 尝试自动连接数据库 (如果配置存在)
// 注意：这里需要一种方式获取配置，通常存在 config 文件或 store 中
// 暂时留空，由前端触发连接

// Matter Controller 状态
let matterInitialized = false;

// 在 ES 模块中手动定义 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 忽略自签名证书错误，解决测试环境 HTTPS 报错
app.commandLine.appendSwitch('ignore-certificate-errors');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#020617',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false,
      webSecurity: false,
      // 在 ESM 中 preload 路径必须指向绝对路径
      preload: path.join(__dirname, 'preload.js')
    }
  });

  Menu.setApplicationMenu(null);

  const isDev = !app.isPackaged;

  if (isDev) {
    win.loadURL('http://localhost:5173').catch(() => {
      win.loadFile('index.html');
    });

    // 开发模式：添加快捷键支持
    win.webContents.on('before-input-event', (event, input) => {
      // F5 刷新页面
      if (input.key === 'F5') {
        win.webContents.reload();
        event.preventDefault();
      }
      // F12 开发者工具
      if (input.key === 'F12') {
        win.webContents.toggleDevTools();
        event.preventDefault();
      }
      // Ctrl+R 刷新
      if (input.control && input.key.toLowerCase() === 'r') {
        win.webContents.reload();
        event.preventDefault();
      }
    });
  } else {
    // 生产环境下加载构建好的文件
    const indexPath = path.join(__dirname, 'dist', 'index.html');
    if (fs.existsSync(indexPath)) {
      win.loadFile(indexPath).catch(err => {
        console.error("Failed to load build product:", err);
      });
    } else {
      // 备选路径，防止某些打包工具路径结构不同
      win.loadFile(path.join(__dirname, 'index.html'));
    }
  }
}

// 通用的原生请求处理器，绕过所有浏览器层面的限制
// 支持自动跟随重定向
ipcMain.handle('http:request', async (event, { url, method, headers, body, followRedirects = true, maxRedirects = 5, timeout = 30000 }) => {
  const makeRequest = (requestUrl, redirectCount = 0) => {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(requestUrl);
      const protocol = parsedUrl.protocol === 'https:' ? https : http;
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: method || 'GET',
        headers: headers || {},
        rejectUnauthorized: false
      };

      console.log(`[HTTP] Request: ${options.method} ${requestUrl} (timeout: ${timeout}ms)`);

      const req = protocol.request(options, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => {
          // 处理重定向 (301, 302, 303, 307, 308)
          if (followRedirects && [301, 302, 303, 307, 308].includes(res.statusCode)) {
            if (redirectCount >= maxRedirects) {
              resolve({
                status: res.statusCode,
                data: null,
                text: responseBody,
                error: `Too many redirects (max: ${maxRedirects})`,
                headers: res.headers
              });
              return;
            }

            const redirectUrl = res.headers.location;
            if (redirectUrl) {
              // 处理相对 URL
              const absoluteUrl = redirectUrl.startsWith('http')
                ? redirectUrl
                : new URL(redirectUrl, requestUrl).href;

              console.log(`[HTTP] Redirect ${res.statusCode} -> ${absoluteUrl}`);

              // 递归跟随重定向
              makeRequest(absoluteUrl, redirectCount + 1)
                .then(resolve)
                .catch(reject);
              return;
            }
          }

          // 正常响应处理
          let data = null;
          try {
            data = JSON.parse(responseBody);
          } catch (e) {
            // 非 JSON 响应
          }

          resolve({
            status: res.statusCode,
            data: data,
            text: responseBody,
            headers: res.headers,
            finalUrl: requestUrl
          });
        });
      });

      req.on('error', (e) => {
        console.error(`[HTTP] Request error:`, e.message);
        reject(e);
      });

      // 设置超时
      req.setTimeout(timeout, () => {
        req.destroy();
        reject(new Error(`Request timeout (${timeout}ms)`));
      });

      if (body) {
        req.write(typeof body === 'string' ? body : JSON.stringify(body));
      }
      req.end();
    });
  };

  return makeRequest(url);
});

// ========== CONFLUENCE SSO LOGIN ==========
// 存储 Confluence session cookies
let confluenceCookies = {};

// 打开登录窗口，让用户手动登录 LDAP/SSO，完成后获取 cookies
ipcMain.handle('confluence:login', async (event, { baseUrl }) => {
  return new Promise((resolve) => {
    // 创建独立的登录窗口
    const loginWin = new BrowserWindow({
      width: 800,
      height: 700,
      parent: win,
      modal: true,
      title: 'Confluence 登录 (LDAP/SSO)',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // 使用独立的 session 分区
        partition: 'persist:confluence'
      }
    });

    // 加载 Confluence 页面 (会被重定向到 LDAP 登录)
    const targetUrl = `${baseUrl}/rest/api/user/current`;
    console.log(`[Confluence] Opening login window for: ${targetUrl}`);
    loginWin.loadURL(targetUrl);

    // 监听 URL 变化，检测登录成功
    loginWin.webContents.on('did-navigate', async (e, url) => {
      console.log(`[Confluence] Navigated to: ${url}`);

      // 如果回到了 Confluence 的 API 或页面，说明登录成功
      if (url.includes(baseUrl) && !url.includes('ldap.') && !url.includes('login')) {
        console.log('[Confluence] Login successful, capturing cookies...');

        // 获取 cookies
        const ses = session.fromPartition('persist:confluence');
        const cookies = await ses.cookies.get({ url: baseUrl });

        // 存储 cookies
        confluenceCookies[baseUrl] = cookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path
        }));

        const cookieNames = cookies.map(c => c.name).join(', ');
        console.log(`[Confluence] Captured ${cookies.length} cookies for ${baseUrl}: ${cookieNames}`);

        // 延迟关闭窗口，确保用户看到成功
        setTimeout(() => {
          loginWin.close();
          resolve({
            success: true,
            message: `登录成功！获取到 ${cookies.length} 个 cookies`,
            cookieCount: cookies.length
          });
        }, 500);
      }
    });

    // 用户关闭窗口
    loginWin.on('closed', () => {
      const hasCookies = confluenceCookies[baseUrl] && confluenceCookies[baseUrl].length > 0;
      if (!hasCookies) {
        resolve({
          success: false,
          message: '登录窗口已关闭，未获取到有效凭证'
        });
      }
    });
  });
});

// 获取存储的 Confluence cookies
ipcMain.handle('confluence:getCookies', async (event, { baseUrl }) => {
  const cookies = confluenceCookies[baseUrl] || [];
  return { success: true, cookies };
});

// 清除 Confluence cookies
ipcMain.handle('confluence:clearCookies', async (event, { baseUrl }) => {
  if (baseUrl) {
    delete confluenceCookies[baseUrl];
    // 也清除 Electron session 中的 cookies
    const ses = session.fromPartition('persist:confluence');
    const cookies = await ses.cookies.get({ url: baseUrl });
    for (const cookie of cookies) {
      await ses.cookies.remove(baseUrl, cookie.name);
    }
  } else {
    confluenceCookies = {};
  }
  return { success: true };
});

// 带 Cookie 的 HTTP 请求（用于 Confluence API 调用）
ipcMain.handle('http:requestWithCookies', async (event, { url, method, headers, body, cookies, timeout = 30000 }) => {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    // 构建 Cookie header
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: method || 'GET',
      headers: {
        ...headers,
        'Cookie': cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': parsedUrl.origin + '/',
        'Origin': parsedUrl.origin
      },
      rejectUnauthorized: false
    };

    console.log(`[HTTP+Cookie] Request: ${options.method} ${url} (timeout: ${timeout}ms)`);

    const req = protocol.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        let data = null;
        try {
          data = JSON.parse(responseBody);
        } catch (e) {
          // 非 JSON 响应
        }

        resolve({
          status: res.statusCode,
          data: data,
          text: responseBody,
          headers: res.headers
        });
      });
    });

    req.on('error', (e) => {
      console.error(`[HTTP+Cookie] Request error:`, e.message);
      reject(e);
    });

    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error(`Request timeout (${timeout}ms)`));
    });

    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
});

// ========== END CONFLUENCE SSO ==========

ipcMain.handle('bluetooth:scan', async () => {
  return new Promise((resolve) => {
    let cmd = 'powershell "Get-PnpDevice -Class Bluetooth -Status OK | Select-Object FriendlyName, InstanceId"';
    exec(cmd, { encoding: 'utf8' }, (error, stdout) => {
      const devices = [];
      if (!error) {
        stdout.split('\n').slice(3).forEach(line => {
          const parts = line.trim().split(/\s{2,}/);
          if (parts[0]) devices.push({ id: Math.random().toString(36).substr(2, 5), name: parts[0], rssi: -60, mac: parts[1] || '---' });
        });
      }
      resolve(devices);
    });
  });
});

// ========== MQTT 主进程连接管理 ==========

ipcMain.handle('mqtt:connect', async (event, { host, port, clientId, username, password }) => {
  return new Promise((resolve, reject) => {
    // 如果已有连接，先断开
    if (mqttClient) {
      mqttClient.end(true);
      mqttClient = null;
    }

    const brokerUrl = `mqtts://${host}:${port}`;

    const options = {
      clientId,
      username,
      password,
      clean: true,
      protocolVersion: 4,  // MQTT 3.1.1
      reconnectPeriod: 0,  // 禁用自动重连，由渲染进程控制
      connectTimeout: 15000,
      rejectUnauthorized: false,  // 允许自签名证书
      // TLS 配置
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.3',
    };

    console.log(`[MQTT] Connecting to ${brokerUrl} with clientId: ${clientId}`);

    mqttClient = mqtt.connect(brokerUrl, options);

    const connectTimeout = setTimeout(() => {
      if (mqttClient && !mqttClient.connected) {
        mqttClient.end(true);
        mqttClient = null;
        reject(new Error('Connection timeout - server did not respond'));
      }
    }, 20000);

    mqttClient.on('connect', () => {
      clearTimeout(connectTimeout);
      console.log('[MQTT] Connected successfully');
      resolve({ success: true, message: 'Connected' });
    });

    mqttClient.on('error', (err) => {
      clearTimeout(connectTimeout);
      console.error('[MQTT] Connection error:', err.message);
      reject(new Error(err.message));
    });

    mqttClient.on('close', () => {
      console.log('[MQTT] Connection closed');
      // 通知渲染进程连接已断开
      if (win && !win.isDestroyed()) {
        win.webContents.send('mqtt:disconnected');
      }
    });

    mqttClient.on('message', (topic, message) => {
      const msgStr = message.toString();
      console.log(`[MQTT] Message received on topic: ${topic}`);
      console.log(`[MQTT] Message content: ${msgStr.substring(0, 200)}...`);
      // 将收到的消息转发给渲染进程
      if (win && !win.isDestroyed()) {
        win.webContents.send('mqtt:message', { topic, message: msgStr });
        console.log('[MQTT] Message forwarded to renderer');
      }
    });
  });
});

ipcMain.handle('mqtt:disconnect', async () => {
  if (mqttClient) {
    mqttClient.end(true);
    mqttClient = null;
    console.log('[MQTT] Disconnected by user');
    return { success: true };
  }
  return { success: false, message: 'No active connection' };
});

ipcMain.handle('mqtt:subscribe', async (event, { topic }) => {
  if (!mqttClient || !mqttClient.connected) {
    throw new Error('MQTT client not connected');
  }
  return new Promise((resolve, reject) => {
    mqttClient.subscribe(topic, { qos: 0 }, (err) => {
      if (err) {
        reject(new Error(`Subscribe failed: ${err.message}`));
      } else {
        console.log(`[MQTT] Subscribed to: ${topic}`);
        resolve({ success: true, topic });
      }
    });
  });
});

ipcMain.handle('mqtt:publish', async (event, { topic, message }) => {
  if (!mqttClient || !mqttClient.connected) {
    throw new Error('MQTT client not connected');
  }
  return new Promise((resolve, reject) => {
    mqttClient.publish(topic, message, { qos: 0 }, (err) => {
      if (err) {
        reject(new Error(`Publish failed: ${err.message}`));
      } else {
        console.log(`[MQTT] Published to ${topic}: ${message.substring(0, 100)}...`);
        resolve({ success: true });
      }
    });
  });
});

ipcMain.handle('mqtt:status', async () => {
  return {
    connected: mqttClient ? mqttClient.connected : false
  };
});

// ========== END MQTT ==========

// ========== MATTER PROTOCOL ==========

// 延迟加载 Matter Controller (避免启动时加载失败)
let matterController = null;

async function getMatterController() {
  if (!matterController) {
    try {
      matterController = require('./matter-controller.cjs');
    } catch (error) {
      console.error('[Matter] Failed to load Matter Controller:', error);
      throw error;
    }
  }
  return matterController;
}

// 初始化 Matter Controller
ipcMain.handle('matter:init', async () => {
  try {
    const controller = await getMatterController();
    const result = await controller.initializeMatter(win);
    matterInitialized = result.success;
    return result;
  } catch (error) {
    console.error('[Matter] Init error:', error);
    return { success: false, error: error.message };
  }
});

// 发现 Matter 设备
ipcMain.handle('matter:discover', async (event, options = {}) => {
  try {
    if (!matterInitialized) {
      return { success: false, error: 'Matter Controller not initialized' };
    }
    const controller = await getMatterController();
    return await controller.discoverMatterDevices(win, options);
  } catch (error) {
    console.error('[Matter] Discover error:', error);
    return { success: false, error: error.message };
  }
});

// 停止扫描
ipcMain.handle('matter:stopScan', async () => {
  try {
    const controller = await getMatterController();
    return controller.stopScan();
  } catch (error) {
    console.error('[Matter] Stop scan error:', error);
    return { success: false, error: error.message };
  }
});

// 配网 Matter 设备
ipcMain.handle('matter:commission', async (event, { deviceId, setupCode, wifiCredentials }) => {
  try {
    if (!matterInitialized) {
      return { success: false, error: 'Matter Controller not initialized' };
    }
    const controller = await getMatterController();
    return await controller.commissionMatterDevice(win, deviceId, setupCode, wifiCredentials);
  } catch (error) {
    console.error('[Matter] Commission error:', error);
    return { success: false, error: error.message };
  }
});

// 读取 Matter 属性
ipcMain.handle('matter:read', async (event, { nodeId, endpointId, clusterId, attributeId }) => {
  try {
    if (!matterInitialized) {
      return { success: false, error: 'Matter Controller not initialized' };
    }
    const controller = await getMatterController();
    return await controller.readMatterAttribute(nodeId, endpointId, clusterId, attributeId);
  } catch (error) {
    console.error('[Matter] Read error:', error);
    return { success: false, error: error.message };
  }
});

// 写入 Matter 属性
ipcMain.handle('matter:write', async (event, { nodeId, endpointId, clusterId, attributeId, value }) => {
  try {
    if (!matterInitialized) {
      return { success: false, error: 'Matter Controller not initialized' };
    }
    const controller = await getMatterController();
    return await controller.writeMatterAttribute(nodeId, endpointId, clusterId, attributeId, value);
  } catch (error) {
    console.error('[Matter] Write error:', error);
    return { success: false, error: error.message };
  }
});

// 调用 Matter 命令
ipcMain.handle('matter:invoke', async (event, { nodeId, endpointId, clusterId, commandId, args }) => {
  try {
    if (!matterInitialized) {
      return { success: false, error: 'Matter Controller not initialized' };
    }
    const controller = await getMatterController();
    return await controller.invokeMatterCommand(nodeId, endpointId, clusterId, commandId, args);
  } catch (error) {
    console.error('[Matter] Invoke error:', error);
    return { success: false, error: error.message };
  }
});

// 获取已配网设备
ipcMain.handle('matter:devices', async () => {
  try {
    if (!matterInitialized) {
      return { success: false, error: 'Matter Controller not initialized' };
    }
    const controller = await getMatterController();
    return await controller.getCommissionedDevices();
  } catch (error) {
    console.error('[Matter] Get devices error:', error);
    return { success: false, error: error.message };
  }
});

// Matter 状态
ipcMain.handle('matter:status', async () => {
  return {
    initialized: matterInitialized
  };
});

// ========== SSH 远程配网 ==========

// 获取 SSH 配置
ipcMain.handle('matter:getSshConfig', async () => {
  try {
    const controller = await getMatterController();
    return controller.getSshConfig();
  } catch (error) {
    console.error('[Matter] Get SSH config error:', error);
    return { success: false, error: error.message };
  }
});

// 保存 SSH 配置
ipcMain.handle('matter:saveSshConfig', async (event, config) => {
  try {
    const controller = await getMatterController();
    return controller.saveSshConfig(config);
  } catch (error) {
    console.error('[Matter] Save SSH config error:', error);
    return { success: false, error: error.message };
  }
});

// 获取所有 SSH 配置
ipcMain.handle('matter:getSshConfigs', async () => {
  try {
    const controller = await getMatterController();
    return controller.getSshConfigs();
  } catch (error) {
    console.error('[Matter] Get SSH configs error:', error);
    return { success: false, error: error.message };
  }
});

// 添加 SSH 配置
ipcMain.handle('matter:addSshConfig', async (event, config) => {
  try {
    const controller = await getMatterController();
    return controller.addSshConfig(config);
  } catch (error) {
    console.error('[Matter] Add SSH config error:', error);
    return { success: false, error: error.message };
  }
});

// 删除 SSH 配置
ipcMain.handle('matter:deleteSshConfig', async (event, configId) => {
  try {
    const controller = await getMatterController();
    return controller.deleteSshConfig(configId);
  } catch (error) {
    console.error('[Matter] Delete SSH config error:', error);
    return { success: false, error: error.message };
  }
});

// 选择 SSH 配置
ipcMain.handle('matter:selectSshConfig', async (event, configId) => {
  try {
    const controller = await getMatterController();
    return controller.selectSshConfig(configId);
  } catch (error) {
    console.error('[Matter] Select SSH config error:', error);
    return { success: false, error: error.message };
  }
});

// 测试 SSH 连接
ipcMain.handle('matter:testSshConnection', async (event, config) => {
  try {
    const controller = await getMatterController();
    return await controller.testSshConnection(config);
  } catch (error) {
    console.error('[Matter] Test SSH error:', error);
    return { success: false, error: error.message };
  }
});

// 通过 SSH 远程配网
ipcMain.handle('matter:commissionViaSSH', async (event, { sshConfig, commissionParams }) => {
  try {
    const controller = await getMatterController();
    return await controller.commissionViaSSH(win, sshConfig, commissionParams);
  } catch (error) {
    console.error('[Matter] SSH commission error:', error);
    return { success: false, error: error.message };
  }
});

// 检查设备在线状态
ipcMain.handle('matter:checkDeviceOnline', async (event, { nodeId, sshConfig }) => {
  try {
    const controller = await getMatterController();
    return await controller.checkDeviceOnline(nodeId, sshConfig);
  } catch (error) {
    console.error('[Matter] Check device online error:', error);
    return { online: false, error: error.message };
  }
});

// 批量检查设备在线状态
ipcMain.handle('matter:checkDevicesOnline', async (event, { devices, sshConfig }) => {
  try {
    const controller = await getMatterController();
    const results = await controller.checkDevicesOnline(devices, sshConfig);
    // 将 Map 转换为对象
    const resultObj = {};
    results.forEach((value, key) => {
      resultObj[key] = value;
    });
    return { success: true, results: resultObj };
  } catch (error) {
    console.error('[Matter] Check devices online error:', error);
    return { success: false, error: error.message };
  }
});

// 读取设备结构 (Endpoints, Clusters, Attributes)
ipcMain.handle('matter:readDeviceStructure', async (event, { nodeId, sshConfig, forceRefresh }) => {
  try {
    const controller = await getMatterController();
    return await controller.readDeviceStructure(nodeId, sshConfig, forceRefresh);
  } catch (error) {
    console.error('[Matter] Read device structure error:', error);
    return { success: false, error: error.message };
  }
});

// 删除已配网设备
ipcMain.handle('matter:deleteDevice', async (event, { nodeId }) => {
  try {
    const controller = await getMatterController();
    return controller.deleteCommissionedDevice(nodeId);
  } catch (error) {
    console.error('[Matter] Delete device error:', error);
    return { success: false, error: error.message };
  }
});

// 更新设备名称
ipcMain.handle('matter:updateDeviceName', async (event, { nodeId, name }) => {
  try {
    const controller = await getMatterController();
    return controller.updateDeviceName(nodeId, name);
  } catch (error) {
    console.error('[Matter] Update device name error:', error);
    return { success: false, error: error.message };
  }
});

// 通用交互指令
ipcMain.handle('matter:executeGenericCommand', async (event, { params, sshConfig }) => {
  try {
    const controller = await getMatterController();
    return await controller.executeGenericCommand(params, sshConfig);
  } catch (error) {
    console.error('[Matter] Execute generic command error:', error);
    return { success: false, error: error.message };
  }
});

// 获取自定义 Cluster
ipcMain.handle('matter:getCustomClusters', async () => {
  try {
    const controller = await getMatterController();
    return controller.getCustomClusters();
  } catch (error) {
    console.error('[Matter] Get custom clusters error:', error);
    return { success: false, error: error.message };
  }
});

// 保存自定义 Cluster
ipcMain.handle('matter:saveCustomCluster', async (event, cluster) => {
  try {
    const controller = await getMatterController();
    return controller.saveCustomCluster(cluster);
  } catch (error) {
    console.error('[Matter] Save custom cluster error:', error);
    return { success: false, error: error.message };
  }
});

// 获取 chip-tool 支持的所有 clusters
ipcMain.handle('matter:getChipToolClusters', async (event, { sshConfig, forceRefresh }) => {
  try {
    const controller = await getMatterController();
    return await controller.getChipToolClusters(sshConfig, forceRefresh);
  } catch (error) {
    console.error('[Matter] Get chip-tool clusters error:', error);
    return { success: false, error: error.message };
  }
});

// 获取指定 cluster 的详细信息 (attributes, commands)
ipcMain.handle('matter:getClusterDetails', async (event, { sshConfig, clusterName }) => {
  try {
    const controller = await getMatterController();
    return await controller.getClusterDetails(sshConfig, clusterName);
  } catch (error) {
    console.error('[Matter] Get cluster details error:', error);
    return { success: false, error: error.message };
  }
});

// 清除 cluster 缓存
ipcMain.handle('matter:clearClusterCache', async () => {
  try {
    const controller = await getMatterController();
    return controller.clearClusterCache();
  } catch (error) {
    console.error('[Matter] Clear cluster cache error:', error);
    return { success: false, error: error.message };
  }
});

// 开始后台预加载 cluster 详情
ipcMain.handle('matter:startClusterDetailsPrefetch', async (event, { sshConfig }) => {
  try {
    const controller = await getMatterController();
    return await controller.prefetchClusterDetails(sshConfig);
  } catch (error) {
    console.error('[Matter] Start prefetch error:', error);
    return { success: false, error: error.message };
  }
});

// ========== END MATTER ==========

// ========== WIFI ==========

// 扫描 WiFi
ipcMain.handle('wifi:scan', async () => {
  try {
    const networks = await wifi.scan();
    // 过滤重复 SSID，只保留信号最强的
    const uniqueNetworks = {};
    networks.forEach(net => {
      if (!net.ssid) return;
      if (!uniqueNetworks[net.ssid] || net.quality > uniqueNetworks[net.ssid].quality) {
        uniqueNetworks[net.ssid] = net;
      }
    });

    // 转换为前端需要的格式
    return Object.values(uniqueNetworks).map(net => ({
      id: net.mac,
      name: net.ssid,
      rssi: net.signal_level, // node-wifi 返回 signal_level (dBm)
      mac: net.mac,
      security: net.security,
      channel: net.channel
    }));
  } catch (error) {
    console.error('[WiFi] Scan error:', error);
    return [];
  }
});

// 连接 WiFi
ipcMain.handle('wifi:connect', async (event, { ssid, password }) => {
  try {
    console.log(`[WiFi] Connecting to ${ssid}...`);
    await wifi.connect({ ssid, password: password || '' });
    console.log(`[WiFi] Connected to ${ssid}`);
    return true;
  } catch (error) {
    console.error(`[WiFi] Connect to ${ssid} error:`, error);
    return false;
  }
});

// ========== END WIFI ==========

// ========== DISCOVERY ==========
let discoveryService = null;
let discoveryCallback = null;

function getDiscoveryService() {
  if (!discoveryService) {
    discoveryService = require('./discovery-service.cjs');
  }
  return discoveryService;
}

// 开始发现设备 (HAP + Matter)
ipcMain.handle('discovery:start', async () => {
  try {
    const service = getDiscoveryService();

    // 设置回调，将发现事件发送到渲染进程
    discoveryCallback = (event, device) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('discovery:device', { event, device });
      }
    };

    return service.startAllDiscovery(discoveryCallback);
  } catch (error) {
    console.error('[Discovery] Start error:', error);
    return { success: false, error: error.message };
  }
});

// 停止发现
ipcMain.handle('discovery:stop', async () => {
  try {
    const service = getDiscoveryService();
    discoveryCallback = null;
    return service.stopAllDiscovery();
  } catch (error) {
    console.error('[Discovery] Stop error:', error);
    return { success: false, error: error.message };
  }
});

// 获取已发现的设备列表 (HAP + Matter)
ipcMain.handle('discovery:getDevices', async () => {
  try {
    const service = getDiscoveryService();
    return { success: true, devices: service.getAllDiscoveredDevices() };
  } catch (error) {
    console.error('[Discovery] Get devices error:', error);
    return { success: false, error: error.message };
  }
});

// 检查设备绑定状态 (仅 HAP 设备)
ipcMain.handle('discovery:checkBindStatus', async (event, { ip, session }) => {
  try {
    const service = getDiscoveryService();
    return await service.checkDeviceBindStatus(ip, session);
  } catch (error) {
    console.error('[Discovery] Check bind status error:', error);
    return { success: false, error: error.message, canBind: false };
  }
});

// 绑定设备 (仅 HAP 设备)
ipcMain.handle('discovery:bindDevice', async (event, { ip, session }) => {
  try {
    const service = getDiscoveryService();
    return await service.bindDevice(ip, session);
  } catch (error) {
    console.error('[Discovery] Bind device error:', error);
    return { success: false, error: error.message };
  }
});

// 通过 HTTP 获取设备详细信息 (Appliance.System.All)
ipcMain.handle('discovery:getDeviceInfo', async (event, { ip, session }) => {
  try {
    const service = getDiscoveryService();
    const result = await service.getDeviceSystemAll(ip, session);

    if (result.success && result.data?.payload) {
      const all = result.data.payload.all || result.data.payload;
      return {
        success: true,
        data: {
          system: all.system || {},
          hardware: all.hardware || {},
          firmware: all.firmware || {},
          digest: all.digest || {},
          raw: result.data
        }
      };
    }
    return { success: false, error: result.error || 'Failed to get device info' };
  } catch (error) {
    console.error('[Discovery] Get device info error:', error);
    return { success: false, error: error.message };
  }
});

// 向设备发送命令 (优先 HTTP，失败后提示使用 MQTT)
ipcMain.handle('device:sendCommand', async (event, { ip, namespace, method, payload, session }) => {
  try {
    const service = getDiscoveryService();
    const result = await service.sendHttpRequestWithRetry(ip, namespace, method, payload, session, 2);

    if (result.success) {
      return { success: true, data: result.data, via: 'http' };
    }

    if (result.shouldFallbackToMqtt) {
      console.log(`[Device] HTTP failed for ${ip}, frontend should use MQTT`);
      return {
        success: false,
        error: result.error,
        shouldFallbackToMqtt: true
      };
    }

    return { success: false, error: result.error };
  } catch (error) {
    console.error('[Device] Send command error:', error);
    return { success: false, error: error.message };
  }
});

// ========== SERIAL PORT ==========

// 获取可用串口列表
ipcMain.handle('serial:listPorts', async () => {
  try {
    const ports = await SerialPort.list();
    console.log('[Serial] Available ports:', ports);
    return {
      success: true,
      ports: ports.map(p => ({
        path: p.path,
        manufacturer: p.manufacturer || 'Unknown',
        vendorId: p.vendorId,
        productId: p.productId,
        serialNumber: p.serialNumber,
        pnpId: p.pnpId,
        friendlyName: p.friendlyName || p.path
      }))
    };
  } catch (error) {
    console.error('[Serial] List ports error:', error);
    return { success: false, error: error.message, ports: [] };
  }
});

// 连接串口
ipcMain.handle('serial:connect', async (event, { path, baudRate }) => {
  try {
    // 如果已有连接，先断开
    if (serialPort && serialPort.isOpen) {
      serialPort.close();
      serialPort = null;
      serialParser = null;
    }

    console.log(`[Serial] Connecting to ${path} at ${baudRate} baud`);

    serialPort = new SerialPort({
      path,
      baudRate: baudRate || 115200,
      autoOpen: false
    });

    // ANSI 转义序列过滤函数 - 移除终端颜色代码等控制字符
    const stripAnsi = (str) => {
      // 匹配所有 ANSI 转义序列
      // 包括: ESC[...m (颜色), ESC[...H (光标位置), ESC[...J (清屏) 等
      return str
        .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')  // 标准 ANSI 转义序列
        .replace(/\x1B\][^\x07]*\x07/g, '')     // OSC 序列
        .replace(/\x1B[PX^_].*?\x1B\\/g, '')    // DCS, SOS, PM, APC 序列
        .replace(/\x1B[@-Z\\-_]/g, '')          // 其他单字符转义
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''); // 其他控制字符
    };

    // 数据缓冲区，用于处理不完整的行
    let dataBuffer = '';
    let flushTimeout = null;

    // 刷新缓冲区函数 - 将不完整的行也发送出去
    const flushBuffer = () => {
      if (dataBuffer && win && !win.isDestroyed()) {
        const cleanLine = stripAnsi(dataBuffer);
        if (cleanLine.length > 0) {
          win.webContents.send('serial:data', {
            line: cleanLine,
            timestamp: Date.now(),
            type: 'line'
          });
        }
        dataBuffer = '';
      }
    };

    // 直接监听原始数据 - 实时模式，类似 SecureCRT
    serialPort.on('data', (data) => {
      const chunk = data.toString('utf8');
      console.log('[Serial] Raw data received:', data.length, 'bytes');

      // 清除之前的刷新定时器
      if (flushTimeout) {
        clearTimeout(flushTimeout);
        flushTimeout = null;
      }

      if (win && !win.isDestroyed()) {
        // 将数据添加到缓冲区
        dataBuffer += chunk;

        // 按行分割
        const lines = dataBuffer.split(/\r?\n/);

        // 最后一个元素可能是不完整的行，保留在缓冲区
        dataBuffer = lines.pop() || '';

        // 发送所有完整的行
        lines.forEach(line => {
          // 只移除 ANSI 码，保留缩进
          const cleanLine = stripAnsi(line);
          // 只有当行不为空（不仅仅是空白字符）或者我们想保留空行时才发送
          // 这里我们允许发送只包含空白的行，以保留格式
          if (cleanLine.length > 0) {
            win.webContents.send('serial:data', {
              line: cleanLine,
              timestamp: Date.now(),
              type: 'line'
            });
          }
        });

        // 如果缓冲区还有数据，设置定时器在 100ms 后刷新
        // 这样可以处理不以换行结尾的响应
        if (dataBuffer) {
          flushTimeout = setTimeout(flushBuffer, 100);
        }
      }
    });

    // 监听错误
    serialPort.on('error', (err) => {
      console.error('[Serial] Port error:', err.message);
      if (win && !win.isDestroyed()) {
        win.webContents.send('serial:error', { error: err.message });
      }
    });

    // 监听关闭
    serialPort.on('close', () => {
      console.log('[Serial] Port closed');
      if (win && !win.isDestroyed()) {
        win.webContents.send('serial:disconnected');
      }
    });

    // 打开串口
    return new Promise((resolve, reject) => {
      serialPort.open((err) => {
        if (err) {
          console.error('[Serial] Open error:', err.message);
          serialPort = null;
          serialParser = null;
          reject(new Error(err.message));
        } else {
          console.log('[Serial] Connected successfully');
          resolve({ success: true, path, baudRate });
        }
      });
    });
  } catch (error) {
    console.error('[Serial] Connect error:', error);
    return { success: false, error: error.message };
  }
});

// 断开串口
ipcMain.handle('serial:disconnect', async () => {
  try {
    if (serialPort && serialPort.isOpen) {
      return new Promise((resolve) => {
        serialPort.close((err) => {
          if (err) {
            console.error('[Serial] Close error:', err.message);
          }
          serialPort = null;
          serialParser = null;
          resolve({ success: true });
        });
      });
    }
    return { success: true, message: 'No active connection' };
  } catch (error) {
    console.error('[Serial] Disconnect error:', error);
    return { success: false, error: error.message };
  }
});

// 发送数据到串口
ipcMain.handle('serial:write', async (event, { data, addNewline }) => {
  try {
    if (!serialPort || !serialPort.isOpen) {
      throw new Error('Serial port not connected');
    }

    const toSend = addNewline !== false ? data + '\n' : data;

    return new Promise((resolve, reject) => {
      serialPort.write(toSend, (err) => {
        if (err) {
          console.error('[Serial] Write error:', err.message);
          reject(new Error(err.message));
        } else {
          serialPort.drain((drainErr) => {
            if (drainErr) {
              console.error('[Serial] Drain error:', drainErr.message);
            }
            console.log('[Serial] Data sent:', toSend.trim());
            resolve({ success: true });
          });
        }
      });
    });
  } catch (error) {
    console.error('[Serial] Write error:', error);
    return { success: false, error: error.message };
  }
});

// 获取串口状态
ipcMain.handle('serial:status', async () => {
  return {
    connected: serialPort ? serialPort.isOpen : false,
    path: serialPort ? serialPort.path : null,
    baudRate: serialPort ? serialPort.baudRate : null
  };
});

// ========== END SERIAL PORT ==========

// ========== PROVISIONING ==========

// 初始化配网 (检查能力 + 密钥交换)
ipcMain.handle('provision:init', async (event, { ip, session }) => {
  try {
    const service = getDiscoveryService();
    return await service.initializeProvisioning(ip, session);
  } catch (error) {
    console.error('[Provision] Init error:', error);
    return { success: false, error: error.message };
  }
});

// 获取 SetKey Payload
ipcMain.handle('provision:getKeyPayload', async (event, { session }) => {
  try {
    const service = getDiscoveryService();
    const payload = service.getSetKeyPayload(session);
    return { success: true, payload };
  } catch (error) {
    console.error('[Provision] Get Key Payload error:', error);
    return { success: false, error: error.message };
  }
});

// 发送通用配网请求
ipcMain.handle('provision:sendRequest', async (event, { ip, namespace, method, payload, session }) => {
  try {
    const service = getDiscoveryService();
    return await service.sendProvisionRequest(ip, namespace, method, payload, session);
  } catch (error) {
    console.error('[Provision] Send Request error:', error);
    return { success: false, error: error.message };
  }
});

// 设置时间
ipcMain.handle('provision:setTime', async (event, { ip, session }) => {
  try {
    const service = getDiscoveryService();
    return await service.sendSetTime(ip, session);
  } catch (error) {
    console.error('[Provision] Set Time error:', error);
    return { success: false, error: error.message };
  }
});

// 设置 WiFi
ipcMain.handle('provision:setWifi', async (event, { ip, wifiConfig, session }) => {
  console.log('=== WIFI HANDLER TRIGGERED ===');
  console.log('[IPC] provision:setWifi called', { ip, ssid: wifiConfig?.ssid, bssid: wifiConfig?.bssid, channel: wifiConfig?.channel });
  try {
    const service = getDiscoveryService();
    const result = await service.sendSetWifi(ip, wifiConfig, session);
    console.log('[IPC] provision:setWifi result', result);
    return result;
  } catch (error) {
    console.error('[Provision] Set Wifi error:', error);
    return { success: false, error: error.message };
  }
});

// ========== END PROVISIONING ==========

app.whenReady().then(createWindow);

app.on('window-all-closed', async () => {
  // 关闭 Matter Controller
  if (matterInitialized && matterController) {
    try {
      await matterController.shutdownMatter();
    } catch (e) {
      console.error('[Matter] Shutdown error:', e);
    }
  }

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
