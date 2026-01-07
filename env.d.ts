
declare module 'mqtt' {
  const mqtt: any;
  export default mqtt;
  export const connect: any;
}

interface Window {
  mqtt: any;
  Buffer: any;
  process: any;
  electronAPI?: {
    // WiFi & Bluetooth
    scanWifi: () => Promise<any[]>;
    scanBluetooth: () => Promise<any[]>;
    connectWifi: (args: { ssid: string, password?: string }) => Promise<boolean>;

    // Native HTTP Request (支持自动重定向)
    nativeRequest: (args: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: any;
      followRedirects?: boolean;  // 是否自动跟随重定向，默认 true
      maxRedirects?: number;      // 最大重定向次数，默认 5
    }) => Promise<{
      status: number;
      data: any;
      text?: string;              // 原始响应文本
      headers?: Record<string, string>;  // 响应头
      finalUrl?: string;          // 最终 URL（重定向后）
      error?: string;
    }>;

    // Confluence SSO Login
    confluenceLogin: (args: { baseUrl: string }) => Promise<{ success: boolean; message: string; cookieCount?: number }>;
    confluenceGetCookies: (args: { baseUrl: string }) => Promise<{ success: boolean; cookies: any[] }>;
    confluenceClearCookies: (args: { baseUrl: string }) => Promise<{ success: boolean }>;
    nativeRequestWithCookies: (args: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: any;
      cookies: any[];
    }) => Promise<{ status: number; data: any; text?: string; headers?: any }>;

    // MQTT IPC 接口
    mqttConnect: (args: { host: string; port: number; clientId: string; username?: string; password?: string }) => Promise<{ success: boolean; message?: string }>;
    mqttDisconnect: () => Promise<{ success: boolean }>;
    mqttSubscribe: (args: { topic: string }) => Promise<{ success: boolean; topic: string }>;
    mqttPublish: (args: { topic: string; message: string }) => Promise<{ success: boolean }>;
    mqttStatus: () => Promise<{ connected: boolean }>;

    // MQTT 事件监听
    onMqttMessage: (callback: (data: { topic: string; message: string }) => void) => void;
    onMqttDisconnected: (callback: () => void) => void;
    removeMqttListeners: () => void;

    // Matter IPC 接口
    matterInit: () => Promise<{ success: boolean; error?: string; message?: string; bleAvailable?: boolean }>;
    matterDiscover: (options?: { discriminator?: number; timeout?: number }) => Promise<{ success: boolean; devices?: MatterDiscoveredDevice[]; error?: string; message?: string; stoppedEarly?: boolean }>;
    matterStopScan: () => Promise<{ success: boolean; message?: string }>;
    matterCommission: (args: { deviceId: string; setupCode: string; wifiCredentials?: { ssid: string; password: string } }) => Promise<{ success: boolean; nodeId?: string; error?: string }>;
    matterRead: (args: { nodeId: string; endpointId: number; clusterId: number; attributeId: number }) => Promise<{ success: boolean; value?: any; error?: string }>;
    matterWrite: (args: { nodeId: string; endpointId: number; clusterId: number; attributeId: number; value: any }) => Promise<{ success: boolean; error?: string }>;
    matterInvoke: (args: { nodeId: string; endpointId: number; clusterId: number; commandId: number; args?: any }) => Promise<{ success: boolean; result?: any; error?: string }>;
    matterDevices: () => Promise<{ success: boolean; devices?: MatterCommissionedDevice[]; error?: string }>;
    matterStatus: () => Promise<{ initialized: boolean }>;

    // Matter 事件监听
    onMatterStatus: (callback: (data: { status: string; message: string }) => void) => void;
    onMatterDevicesDiscovered: (callback: (devices: MatterDiscoveredDevice[]) => void) => void;
    onMatterCommissioningProgress: (callback: (data: { deviceId: string; stage: string; message: string; nodeId?: string }) => void) => void;

    // SSH 远程配网 - 多配置管理
    matterGetSshConfig: () => Promise<{ success: boolean; config?: SshConfig; error?: string }>;
    matterGetSshConfigs: () => Promise<{ success: boolean; configs?: SshConfig[]; selectedId?: string | null; error?: string }>;
    matterSaveSshConfig: (config: SshConfig) => Promise<{ success: boolean; error?: string }>;
    matterAddSshConfig: (config: SshConfig) => Promise<{ success: boolean; error?: string }>;
    matterDeleteSshConfig: (configId: string) => Promise<{ success: boolean; error?: string }>;
    matterSelectSshConfig: (configId: string) => Promise<{ success: boolean; error?: string }>;
    matterTestSshConnection: (config: SshConfig) => Promise<{ success: boolean; message?: string; output?: string; error?: string }>;
    matterCommissionViaSSH: (args: { sshConfig: SshConfig; commissionParams: CommissionParams }) => Promise<{ success: boolean; nodeId?: number; output?: string; error?: string }>;

    // 设备在线检测
    matterCheckDeviceOnline: (args: { nodeId: string; sshConfig: SshConfig }) => Promise<{ online: boolean; latency?: number; vendorName?: string; error?: string }>;
    matterCheckDevicesOnline: (args: { devices: { nodeId: string }[]; sshConfig: SshConfig }) => Promise<{ success: boolean; results?: Record<string, { online: boolean; latency?: number; error?: string }>; error?: string }>;

    // 设备结构读取
    matterReadDeviceStructure: (args: { nodeId: string; sshConfig: SshConfig; forceRefresh?: boolean }) => Promise<{
      success: boolean;
      endpoints?: Array<{
        id: number;
        deviceType: number | null;
        clusters: Array<{
          id: number;
          name: string;
          attributes: Array<{ id: number; name: string; writable: boolean }>;
          commands: Array<{ id: number; name: string; hasArgs: boolean }>;
        }>;
      }>;
      error?: string;
    }>;

    // 删除已配网设备
    matterDeleteDevice: (nodeId: string | number) => Promise<{ success: boolean; error?: string }>;

    // 更新设备名称
    matterUpdateDeviceName: (nodeId: string | number, name: string) => Promise<{ success: boolean; error?: string }>;

    // 通用交互指令
    matterExecuteGenericCommand: (args: { params: any; sshConfig: SshConfig }) => Promise<{ success: boolean; output?: string; error?: string; command?: string }>;

    // 自定义 Cluster 管理
    matterGetCustomClusters: () => Promise<{ success: boolean; clusters: ClusterDefinition[]; error?: string }>;
    matterSaveCustomCluster: (cluster: ClusterDefinition) => Promise<{ success: boolean; clusters?: ClusterDefinition[]; error?: string }>;

    // chip-tool Cluster 列表 (支持缓存)
    matterGetChipToolClusters: (args: { sshConfig: SshConfig; forceRefresh?: boolean }) => Promise<{
      success: boolean;
      clusters?: ChipToolCluster[];
      fromCache?: boolean;
      cachedAt?: string;
      error?: string;
    }>;
    matterGetClusterDetails: (args: { sshConfig: SshConfig; clusterName: string }) => Promise<{
      success: boolean;
      attributes?: { name: string; displayName: string }[];
      commands?: { name: string; displayName: string }[];
      error?: string;
    }>;
    matterClearClusterCache: () => Promise<{ success: boolean; error?: string }>;
    matterStartClusterDetailsPrefetch: (args: { sshConfig: SshConfig }) => Promise<{ success: boolean; message?: string; error?: string }>;

    // ========== Discovery API ==========
    discoveryStart: () => Promise<{ success: boolean; message?: string; error?: string }>;
    discoveryStop: () => Promise<{ success: boolean; message?: string; error?: string }>;
    discoveryGetDevices: () => Promise<{ success: boolean; devices?: DiscoveredDevice[]; error?: string }>;
    discoveryCheckBindStatus: (args: { ip: string; session: CloudSession }) => Promise<{
      success: boolean;
      canBind: boolean;
      bindId?: string;
      who?: number;
      deviceInfo?: {
        uuid?: string;
        type?: string;
        version?: string;
        mac?: string;
        firmware?: string;
      };
      error?: string;
    }>;
    discoveryBindDevice: (args: { ip: string; session: CloudSession }) => Promise<{ success: boolean; data?: any; error?: string }>;
    discoveryGetDeviceInfo: (args: { ip: string; session: CloudSession }) => Promise<{
      success: boolean;
      data?: {
        system?: any;
        hardware?: any;
        firmware?: any;
        digest?: any;
        raw?: any;
      };
      error?: string;
    }>;

    // Discovery 事件监听
    onDiscoveryDevice: (callback: (data: { event: string; device: DiscoveredDevice }) => void) => void;
    removeDiscoveryDeviceListener: () => void;

    // ========== Device Communication API ==========
    // 向设备发送命令 (优先 HTTP，失败后返回 shouldFallbackToMqtt)
    deviceSendCommand: (args: {
      ip: string;
      namespace: string;
      method: string;
      payload: any;
      session: CloudSession
    }) => Promise<{
      success: boolean;
      data?: any;
      error?: string;
      via?: 'http' | 'mqtt';
      shouldFallbackToMqtt?: boolean;
    }>;

    // ========== Provisioning API ==========
    provisionInit: (args: { ip: string; session: CloudSession }) => Promise<{ success: boolean; encrypted?: boolean; message?: string; error?: string }>;
    provisionGetKeyPayload: (args: { session: CloudSession }) => Promise<{ success: boolean; payload?: any; error?: string }>;
    provisionSendRequest: (args: { ip: string; namespace: string; method: string; payload: any; session: CloudSession }) => Promise<{ success: boolean; data?: any; error?: string }>;
    provisionSetTime: (args: { ip: string; session: CloudSession }) => Promise<{ success: boolean; data?: any; error?: string }>;
    provisionSetWifi: (args: { ip: string; wifiConfig: { ssid: string; password?: string; bssid?: string; channel?: number }; session: CloudSession }) => Promise<{ success: boolean; data?: any; error?: string }>;

    // ========== Serial Port API ==========
    serialListPorts: () => Promise<{ success: boolean; ports: SerialPortInfo[]; error?: string }>;
    serialConnect: (args: { path: string; baudRate: number }) => Promise<{ success: boolean; path?: string; baudRate?: number; error?: string }>;
    serialDisconnect: () => Promise<{ success: boolean; error?: string }>;
    serialWrite: (args: { data: string; addNewline?: boolean }) => Promise<{ success: boolean; error?: string }>;
    serialStatus: () => Promise<{ connected: boolean; path: string | null; baudRate: number | null }>;

    // 串口事件监听
    onSerialData: (callback: (data: { line: string; timestamp: number; type?: string }) => void) => void;
    onSerialRawData: (callback: (data: { data: string; timestamp: number }) => void) => void;
    onSerialError: (callback: (data: { error: string }) => void) => void;
    onSerialDisconnected: (callback: () => void) => void;
    removeSerialListeners: () => void;
  };
}

// mDNS 发现的设备类型
interface DiscoveredDevice {
  name: string;
  host: string;
  port: number;
  ipv4: string;
  allAddresses?: string[];
  txt?: Record<string, string>;
  discoveredAt?: string;
  // 绑定状态检查后填充
  canBind?: boolean;
  bindId?: string;
  who?: number;
  deviceInfo?: {
    uuid?: string;
    type?: string;
    version?: string;
    mac?: string;
    firmware?: string;
  };
  checkStatus?: 'pending' | 'checking' | 'done' | 'error';
  checkError?: string;
}

// Matter 设备类型
interface MatterDiscoveredDevice {
  id: string;
  name: string;
  discriminator: number;
  vendorId?: string;
  productId?: string;
  deviceType?: number;
  pairingHint?: number;
  pairingInstruction?: string;
  commissioningMode?: number;
  addresses: string[];
  port?: number;
  discovered: string;
}

interface MatterCommissionedDevice {
  nodeId: string;
  name: string;
  endpoints: number[];
  online: boolean;
}

// SSH 配置
interface SshConfig {
  id?: string;
  name?: string;
  host: string;
  port: number;
  username: string;
  password: string;
  chipToolPath: string;
  paaTrustStorePath?: string;
}

// 配网参数
interface CommissionParams {
  deviceId: string;
  discriminator: number;
  setupCode: string;
  pairingMode?: 'ble-wifi' | 'ble-thread';
  wifiSsid?: string;
  wifiPassword?: string;
  threadDataset?: string;
  nodeId?: number;
}

interface ClusterDefinition {
  id: number;
  name: string;
  attributes: any[];
  commands: any[];
}

interface ChipToolCluster {
  name: string;
  displayName: string;
  attributes: { name: string; displayName: string }[];
  commands: { name: string; displayName: string }[];
}

// 串口信息
interface SerialPortInfo {
  path: string;
  manufacturer: string;
  vendorId?: string;
  productId?: string;
  serialNumber?: string;
  pnpId?: string;
  friendlyName: string;
}
