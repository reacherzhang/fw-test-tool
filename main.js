
import { app, BrowserWindow, Menu, ipcMain } from 'electron';
import path from 'path';
import { exec } from 'child_process';
import fs from 'fs';
import os from 'os';
import https from 'https';
import { fileURLToPath } from 'url';
import mqtt from 'mqtt';

// MQTT 客户端实例（主进程持有）
let mqttClient = null;

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
ipcMain.handle('http:request', async (event, { url, method, headers, body }) => {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: method || 'POST',
      headers: headers || {},
      rejectUnauthorized: false
    };

    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(responseBody);
          resolve({ status: res.statusCode, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, data: responseBody });
        }
      });
    });

    req.on('error', (e) => {
      reject(e);
    });

    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
});

// Wi-Fi 扫描
ipcMain.handle('wifi:scan', async () => {
  return new Promise((resolve) => {
    let cmd = process.platform === 'win32'
      ? 'chcp 65001 > nul && netsh wlan show networks mode=Bssid'
      : 'nmcli -t -f SSID,SIGNAL,BSSID dev wifi';

    exec(cmd, { encoding: 'utf8' }, (error, stdout) => {
      if (error) { resolve([]); return; }
      const results = [];
      const lines = stdout.split('\n');
      if (process.platform === 'win32') {
        let current = null;
        lines.forEach(line => {
          const t = line.trim();
          const ssid = t.match(/SSID \d+ : (.*)/);
          if (ssid) {
            if (current) results.push(current);
            current = { id: Math.random().toString(36).substr(2, 5), name: ssid[1].trim(), rssi: -100, mac: '---' };
          } else if (current) {
            const sig = t.match(/(Signal|信号)\s*:\s*(\d+)%/i);
            if (sig) current.rssi = Math.floor((parseInt(sig[2]) / 2) - 100);
            const bssid = t.match(/BSSID \d+ : (.*)/);
            if (bssid) current.mac = bssid[1].trim().toUpperCase();
          }
        });
        if (current) results.push(current);
      }
      resolve(results);
    });
  });
});

// 核心功能：真实的系统级连接
ipcMain.handle('wifi:connect', async (event, { ssid, password }) => {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      exec(`nmcli dev wifi connect "${ssid}" password "${password || ''}"`, (err) => {
        err ? reject(err) : resolve(true);
      });
      return;
    }

    const profileName = `Nexus_Temp_${Date.now()}`;
    const profileXml = `
      <?xml version="1.0"?>
      <WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
        <name>${ssid}</name>
        <SSIDConfig>
          <SSID>
            <name>${ssid}</name>
          </SSID>
        </SSIDConfig>
        <connectionType>ESS</connectionType>
        <connectionMode>manual</connectionMode>
        <MSM>
          <security>
            <authEncryption>
              <authentication>${password ? 'WPA2PSK' : 'open'}</authentication>
              <encryption>${password ? 'AES' : 'none'}</encryption>
              <useOneX>false</useOneX>
            </authEncryption>
            ${password ? `<sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>${password}</keyMaterial></sharedKey>` : ''}
          </security>
        </MSM>
      </WLANProfile>
    `.trim();

    const tempPath = path.join(os.tmpdir(), `${profileName}.xml`);
    fs.writeFileSync(tempPath, profileXml);

    const connectCmd = `chcp 65001 > nul && netsh wlan add profile filename="${tempPath}" && netsh wlan connect name="${ssid}" ssid="${ssid}"`;

    exec(connectCmd, (err) => {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      if (err) {
        reject(err);
      } else {
        setTimeout(() => resolve(true), 3000);
      }
    });
  });
});

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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
