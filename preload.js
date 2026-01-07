
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
  nativeRequestWithCookies: (args) => ipcRenderer.invoke('http:requestWithCookies', args),

  // ===== Confluence SSO Login =====
  confluenceLogin: (args) => ipcRenderer.invoke('confluence:login', args),
  confluenceGetCookies: (args) => ipcRenderer.invoke('confluence:getCookies', args),
  confluenceClearCookies: (args) => ipcRenderer.invoke('confluence:clearCookies', args),

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
  },

  // ===== MATTER IPC 接口 =====
  matterInit: () => ipcRenderer.invoke('matter:init'),
  matterDiscover: (options) => ipcRenderer.invoke('matter:discover', options),
  matterStopScan: () => ipcRenderer.invoke('matter:stopScan'),
  matterCommission: (args) => ipcRenderer.invoke('matter:commission', args),
  matterRead: (args) => ipcRenderer.invoke('matter:read', args),
  matterWrite: (args) => ipcRenderer.invoke('matter:write', args),
  matterInvoke: (args) => ipcRenderer.invoke('matter:invoke', args),
  matterDevices: () => ipcRenderer.invoke('matter:devices'),
  matterStatus: () => ipcRenderer.invoke('matter:status'),

  // SSH 远程配网 - 多配置管理
  matterGetSshConfig: () => ipcRenderer.invoke('matter:getSshConfig'),
  matterGetSshConfigs: () => ipcRenderer.invoke('matter:getSshConfigs'),
  matterSaveSshConfig: (config) => ipcRenderer.invoke('matter:saveSshConfig', config),
  matterAddSshConfig: (config) => ipcRenderer.invoke('matter:addSshConfig', config),
  matterDeleteSshConfig: (configId) => ipcRenderer.invoke('matter:deleteSshConfig', configId),
  matterSelectSshConfig: (configId) => ipcRenderer.invoke('matter:selectSshConfig', configId),
  matterTestSshConnection: (config) => ipcRenderer.invoke('matter:testSshConnection', config),
  matterCommissionViaSSH: (args) => ipcRenderer.invoke('matter:commissionViaSSH', args),

  // 设备在线检测
  matterCheckDeviceOnline: (args) => ipcRenderer.invoke('matter:checkDeviceOnline', args),
  matterCheckDevicesOnline: (args) => ipcRenderer.invoke('matter:checkDevicesOnline', args),

  // 设备结构读取
  matterReadDeviceStructure: (args) => ipcRenderer.invoke('matter:readDeviceStructure', args),

  // 删除已配网设备
  matterDeleteDevice: (nodeId) => ipcRenderer.invoke('matter:deleteDevice', { nodeId }),

  // 更新设备名称
  matterUpdateDeviceName: (nodeId, name) => ipcRenderer.invoke('matter:updateDeviceName', { nodeId, name }),

  // 通用交互指令
  matterExecuteGenericCommand: (args) => ipcRenderer.invoke('matter:executeGenericCommand', args),

  // 自定义 Cluster 管理
  matterGetCustomClusters: () => ipcRenderer.invoke('matter:getCustomClusters'),
  matterSaveCustomCluster: (cluster) => ipcRenderer.invoke('matter:saveCustomCluster', cluster),

  // chip-tool Cluster 列表 (支持缓存)
  matterGetChipToolClusters: (args) => ipcRenderer.invoke('matter:getChipToolClusters', args),
  matterGetClusterDetails: (args) => ipcRenderer.invoke('matter:getClusterDetails', args),
  matterClearClusterCache: () => ipcRenderer.invoke('matter:clearClusterCache'),
  matterStartClusterDetailsPrefetch: (args) => ipcRenderer.invoke('matter:startClusterDetailsPrefetch', args),

  // Matter 事件监听
  onMatterStatus: (callback) => {
    ipcRenderer.on('matter:status', (event, data) => callback(data));
  },
  onMatterDevicesDiscovered: (callback) => {
    ipcRenderer.on('matter:devices-discovered', (event, data) => callback(data));
  },
  onMatterCommissioningProgress: (callback) => {
    ipcRenderer.on('matter:commissioning-progress', (event, data) => callback(data));
  },

  // ========== Discovery API ==========
  discoveryStart: () => ipcRenderer.invoke('discovery:start'),
  discoveryStop: () => ipcRenderer.invoke('discovery:stop'),
  discoveryGetDevices: () => ipcRenderer.invoke('discovery:getDevices'),
  discoveryCheckBindStatus: (args) => ipcRenderer.invoke('discovery:checkBindStatus', args),
  discoveryBindDevice: (args) => ipcRenderer.invoke('discovery:bindDevice', args),
  discoveryGetDeviceInfo: (args) => ipcRenderer.invoke('discovery:getDeviceInfo', args),

  // Discovery 事件监听
  onDiscoveryDevice: (callback) => {
    // 先移除旧的监听器，防止重复注册累积
    ipcRenderer.removeAllListeners('discovery:device');
    ipcRenderer.on('discovery:device', (event, data) => callback(data));
  },
  removeDiscoveryDeviceListener: () => {
    ipcRenderer.removeAllListeners('discovery:device');
  },

  // ========== Device Communication API ==========
  // 向设备发送命令 (优先 HTTP，失败后返回 shouldFallbackToMqtt)
  deviceSendCommand: (args) => ipcRenderer.invoke('device:sendCommand', args),

  // ========== Provisioning API ==========
  provisionInit: (args) => ipcRenderer.invoke('provision:init', args),
  provisionGetKeyPayload: (args) => ipcRenderer.invoke('provision:getKeyPayload', args),
  provisionSendRequest: (args) => ipcRenderer.invoke('provision:sendRequest', args),
  provisionSetTime: (args) => ipcRenderer.invoke('provision:setTime', args),
  provisionSetWifi: (args) => ipcRenderer.invoke('provision:setWifi', args),

  // ========== Serial Port API ==========
  serialListPorts: () => ipcRenderer.invoke('serial:listPorts'),
  serialConnect: (args) => ipcRenderer.invoke('serial:connect', args),
  serialDisconnect: () => ipcRenderer.invoke('serial:disconnect'),
  serialWrite: (args) => ipcRenderer.invoke('serial:write', args),
  serialStatus: () => ipcRenderer.invoke('serial:status'),

  // 串口事件监听
  onSerialData: (callback) => {
    ipcRenderer.removeAllListeners('serial:data');
    ipcRenderer.on('serial:data', (event, data) => callback(data));
  },
  onSerialRawData: (callback) => {
    ipcRenderer.removeAllListeners('serial:rawData');
    ipcRenderer.on('serial:rawData', (event, data) => callback(data));
  },
  onSerialError: (callback) => {
    ipcRenderer.removeAllListeners('serial:error');
    ipcRenderer.on('serial:error', (event, data) => callback(data));
  },
  onSerialDisconnected: (callback) => {
    ipcRenderer.removeAllListeners('serial:disconnected');
    ipcRenderer.on('serial:disconnected', () => callback());
  },
  removeSerialListeners: () => {
    ipcRenderer.removeAllListeners('serial:data');
    ipcRenderer.removeAllListeners('serial:rawData');
    ipcRenderer.removeAllListeners('serial:error');
    ipcRenderer.removeAllListeners('serial:disconnected');
  },
});
