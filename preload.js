
const { contextBridge, ipcRenderer } = require('electron');

// 存储回调函数
let mqttMessageCallbacks = [];
let mqttDisconnectedCallbacks = [];

// 设置一次性的底层监听器
ipcRenderer.on('mqtt:message', (event, data) => {
  console.log('[Preload] MQTT message received:', data.topic);
  mqttMessageCallbacks.forEach(cb => {
    try {
      cb(data);
    } catch (e) {
      console.error('[Preload] Error in mqtt message callback:', e);
    }
  });
});

ipcRenderer.on('mqtt:disconnected', () => {
  console.log('[Preload] MQTT disconnected');
  mqttDisconnectedCallbacks.forEach(cb => {
    try {
      cb();
    } catch (e) {
      console.error('[Preload] Error in mqtt disconnected callback:', e);
    }
  });
});

contextBridge.exposeInMainWorld('electronAPI', {
  scanWifi: () => ipcRenderer.invoke('wifi:scan'),
  scanBluetooth: () => ipcRenderer.invoke('bluetooth:scan'),
  connectWifi: (args) => ipcRenderer.invoke('wifi:connect', args),
  // 原生请求通道
  nativeRequest: (args) => ipcRenderer.invoke('http:request', args),

  // ===== MQTT IPC 接口 =====
  mqttConnect: (args) => ipcRenderer.invoke('mqtt:connect', args),
  mqttDisconnect: () => ipcRenderer.invoke('mqtt:disconnect'),
  mqttSubscribe: (args) => ipcRenderer.invoke('mqtt:subscribe', args),
  mqttPublish: (args) => ipcRenderer.invoke('mqtt:publish', args),
  mqttStatus: () => ipcRenderer.invoke('mqtt:status'),

  // MQTT 事件监听（添加回调，支持多个监听器）
  onMqttMessage: (callback) => {
    console.log('[Preload] Adding MQTT message callback');
    mqttMessageCallbacks.push(callback);
  },
  onMqttDisconnected: (callback) => {
    console.log('[Preload] Adding MQTT disconnected callback');
    mqttDisconnectedCallbacks.push(callback);
  },

  // 清理监听器（清空回调列表）
  removeMqttListeners: () => {
    console.log('[Preload] Removing all MQTT callbacks');
    mqttMessageCallbacks = [];
    mqttDisconnectedCallbacks = [];
  }
});
