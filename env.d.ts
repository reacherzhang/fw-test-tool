
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

    // Native HTTP Request
    nativeRequest: (args: { url: string; method?: string; headers?: Record<string, string>; body?: any }) => Promise<{ status: number; data: any }>;

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
  };
}
