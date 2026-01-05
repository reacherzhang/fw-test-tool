
export enum DeviceStatus {
  ONLINE = 'ONLINE',
  OFFLINE = 'OFFLINE',
  MAINTENANCE = 'MAINTENANCE',
  ERROR = 'ERROR'
}

export enum Protocol {
  MQTT = 'MQTT',
  HTTP = 'HTTP',
  COAP = 'COAP',
  CUSTOM = 'CUSTOM',
  UNKNOWN = 'UNKNOWN',
  MATTER = 'MATTER'
}

export interface GlobalLogEntry {
  id: string;
  timestamp: string;
  type: 'HTTP' | 'MQTT' | 'SYSTEM' | 'CUSTOM' | 'MATTER' | 'DISCOVERY';
  direction: 'TX' | 'RX' | 'ERR' | 'SYS';
  label: string;
  detail: string;
}

export const IOT_CONSTANTS = {
  VENDOR: 'merossBeta',
  DEFAULT_MQTT_DOMAIN: 'mqtt.meross.com',
  DEFAULT_PORT: 443,
  APP_PRODUCT_KEY: '23x17ahWarFH6w29'
};

export const DEFAULT_CONNECTION_TYPES = ['WIFI', 'BLE', 'MATTER_WIFI', 'MATTER_THREAD', 'ZIGBEE', 'LORA'];
export const DEFAULT_DEVICE_TYPES = ['Sensor', 'Actuator', 'Gateway', 'Camera', 'Thermostat'];

export interface TelemetryPoint {
  timestamp: string;
  temperature: number;
  humidity: number;
  cpuLoad: number;
  voltage: number;
}

export interface SequenceStep {
  id: string;
  name: string;
  payload: string;
  delayMs: number;
}

export interface ApiHistoryEntry {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  requestBody: string;
  responseBody: string;
  status: number | string;
}

export interface CloudSession {
  uid: string;
  key: string;
  guid: string;
  udid: string;
  token: string;
  email: string;
  httpDomain: string;
  mqttDomain: string;
}

export interface Device {
  id: string;
  name: string;
  ip: string;
  type: string;
  status: DeviceStatus;
  protocol: Protocol;
  connectionType: string;
  lastSeen: string;
  firmwareVersion: string;
  hardwareVersion?: string;
  subType?: string;
  onlineStatusCode?: number; // 原始 onlineStatus 值
  telemetry: TelemetryPoint[];
  config: Record<string, any>;
  testSequence?: SequenceStep[];
  isBound: boolean;
  mqttTopic?: string;
  bindingToken?: string;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  direction: 'IN' | 'OUT';
  protocol: string;
  topic?: string;
  endpoint?: string;
  payload: string;
  status: 'SUCCESS' | 'PENDING' | 'ERROR';
}

export interface AnalysisReport {
  generatedAt: string;
  summary: string;
  anomalies: string[];
  recommendations: string[];
}

export interface MqttSessionConfig {
  host: string;
  port: number;
  clientId: string;
  username?: string;
  password?: string;
  appid?: string;  // 用于构建 from topic: /app/{uid}-{appid}/subscribe
  isConnected: boolean;
  retryCount: number;
  status?: 'CONNECTED' | 'DISCONNECTED' | 'CONNECTING' | 'ERROR';
}
