
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, Zap, ShieldCheck, X, LayoutDashboard, Database, Settings, Plus, Cloud, Terminal, Trash2, ChevronRight, Share2, Activity, BrainCircuit, User, LogOut, Mail, Key, Globe, Hash } from 'lucide-react';
import { Device, DeviceStatus, Protocol, MqttSessionConfig, CloudSession, GlobalLogEntry, IOT_CONSTANTS, DEFAULT_DEVICE_TYPES, DEFAULT_CONNECTION_TYPES } from './types';
import { analyzeFleetHealth } from './services/geminiService';
import { DeviceMonitor } from './components/DeviceMonitor';
import { ProtocolConsole } from './components/ProtocolConsole';
import { DeviceConfiguration } from './components/DeviceConfiguration';
import { AddDeviceModal } from './components/AddDeviceModal';
import { ProtocolLab } from './components/ProtocolLab';
import { CloudApiLab } from './components/CloudApiLab';
import { AuthScreen, md5 } from './components/AuthScreen';
import { MqttSettings } from './components/MqttSettings';
import { MqttDeviceConsole } from './components/MqttDeviceConsole';
import { MatterConsole } from './components/MatterConsole';
import { MatterDashboard } from './components/MatterDashboard';
import DeviceDiscoveryModal from './components/DeviceDiscoveryModal';
import ErrorBoundary from './components/ErrorBoundary';


const App: React.FC = () => {
  const [session, setSession] = useState<CloudSession | null>(null);
  const [currentView, setCurrentView] = useState<'DASHBOARD' | 'LAB' | 'CLOUD_LAB' | 'MATTER' | 'SETTINGS' | 'DEVICE_DETAIL'>('DASHBOARD');
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isDiscoveryModalOpen, setIsDiscoveryModalOpen] = useState(false);
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const [isLogEnabled, setIsLogEnabled] = useState(false);
  const [isLogVisible, setIsLogVisible] = useState(false);
  const [globalLogs, setGlobalLogs] = useState<GlobalLogEntry[]>([]);
  const logScrollRef = useRef<HTMLDivElement>(null);

  const [isFleetAnalyzing, setIsFleetAnalyzing] = useState(false);
  const [fleetReport, setFleetReport] = useState<string | null>(null);

  const [mqttConfig, setMqttConfig] = useState<MqttSessionConfig>({
    host: IOT_CONSTANTS.DEFAULT_MQTT_DOMAIN,
    port: IOT_CONSTANTS.DEFAULT_PORT,
    clientId: '',
    username: '',
    password: '',
    isConnected: false,
    retryCount: 0,
    status: 'DISCONNECTED'
  });



  // 设备列表加载状态
  const [isDevicesLoading, setIsDevicesLoading] = useState(false);

  const recordGlobalLog = useCallback((log: Omit<GlobalLogEntry, 'id' | 'timestamp'>) => {
    const newEntry: GlobalLogEntry = {
      ...log,
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toLocaleTimeString('en-GB', { hour12: false })
    };
    setGlobalLogs(prev => [...prev.slice(-199), newEntry]);
  }, []);

  const handleMqttPublish = useCallback(async (topic: string, message: string) => {
    if (!window.electronAPI?.mqttPublish) {
      throw new Error('Electron API not available');
    }
    return window.electronAPI.mqttPublish({ topic, message });
  }, []);

  // 封装请求数据包（复用 AuthScreen 中的逻辑）
  const encapsulatePacket = useCallback((paramsValues: any, userKey?: string) => {
    const key = IOT_CONSTANTS.APP_PRODUCT_KEY;
    const nonce = session?.udid || 'B817C936-3F0F-4EEE-BC4D-6EFDEC79E2F9';
    const timestamp_int = Math.floor(Date.now() / 1000);

    // Python 风格 JSON 序列化
    const pythonJsonDumps = (obj: any) => {
      const compact = JSON.stringify(obj);
      return compact.replace(/(\"(?:\\\\.|[^\"])*\")|([,:])/g, (match, isString, isPunctuation) => {
        if (isString) return isString;
        return isPunctuation === ',' ? ', ' : ': ';
      });
    };

    const params_json = pythonJsonDumps(paramsValues);
    const params_b64_str = btoa(unescape(encodeURIComponent(params_json)));
    const md5_source = key + String(timestamp_int) + nonce + params_b64_str;
    const sign_md5 = md5(md5_source);

    return {
      nonce,
      sign: sign_md5,
      timestamp: timestamp_int,
      params: params_b64_str
    };
  }, [session]);

  // 向单个设备发送 MQTT 探测消息（带超时和重试）
  const probeDevice = useCallback(async (
    device: Device,
    currentSession: CloudSession,
    appid: string,
    retryCount = 0
  ): Promise<boolean> => {
    const TIMEOUT_MS = 5000; // 5秒超时
    const MAX_RETRIES = 1;

    try {
      // 生成消息 ID 和签名
      const timestampMs = (Date.now() / 1000).toString();
      const messageId = md5(timestampMs).toLowerCase();
      const timestamp = Math.floor(Date.now() / 1000);
      const sign = md5(messageId + currentSession.key + String(timestamp)).toLowerCase();

      // 构建 from topic
      const fromTopic = `/app/${currentSession.uid}-${appid}/subscribe`;

      const mqttMessage = {
        header: {
          messageId,
          payloadVersion: 1,
          namespace: 'Appliance.System.All',
          method: 'GET',
          triggerSrc: 'iot-test-tool',
          timestamp,
          from: fromTopic,
          sign
        },
        payload: {}
      };

      const topic = `/appliance/${device.id}/subscribe`;

      recordGlobalLog({
        type: 'MQTT',
        direction: 'TX',
        label: `Probe Device -> ${device.name}`,
        detail: `[Topic]: ${topic}\n[Retry]: ${retryCount}/${MAX_RETRIES}`
      });

      // 发送消息
      const result = await Promise.race([
        window.electronAPI?.mqttPublish({
          topic,
          message: JSON.stringify(mqttMessage)
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), TIMEOUT_MS)
        )
      ]);

      if (result && (result as any).success) {
        recordGlobalLog({
          type: 'MQTT',
          direction: 'SYS',
          label: `Probe Sent -> ${device.name}`,
          detail: `Successfully sent probe to ${topic}`
        });
        return true;
      }
      throw new Error('Publish failed');
    } catch (err: any) {
      if (retryCount < MAX_RETRIES) {
        recordGlobalLog({
          type: 'MQTT',
          direction: 'ERR',
          label: `Probe Failed -> ${device.name}`,
          detail: `${err.message}, retrying... (${retryCount + 1}/${MAX_RETRIES})`
        });
        // 等待 500ms 后重试
        await new Promise(r => setTimeout(r, 500));
        return probeDevice(device, currentSession, appid, retryCount + 1);
      }

      recordGlobalLog({
        type: 'MQTT',
        direction: 'ERR',
        label: `Probe Failed -> ${device.name}`,
        detail: `${err.message}, max retries reached`
      });
      return false;
    }
  }, [recordGlobalLog]);

  // 并发向所有设备发送探测消息
  const probeAllDevices = useCallback(async (devices: Device[], currentSession: CloudSession) => {
    // 等待 MQTT 连接就绪
    if (!mqttConfig.isConnected || !mqttConfig.appid) {
      recordGlobalLog({
        type: 'SYSTEM',
        direction: 'SYS',
        label: 'Device Probe Deferred',
        detail: 'Waiting for MQTT connection before probing devices...'
      });
      return;
    }

    recordGlobalLog({
      type: 'SYSTEM',
      direction: 'SYS',
      label: 'Probing All Devices',
      detail: `Starting parallel probe for ${devices.length} device(s)`
    });

    // 并发发送探测消息
    const results = await Promise.allSettled(
      devices.map(device => probeDevice(device, currentSession, mqttConfig.appid!))
    );

    const successCount = results.filter(r => r.status === 'fulfilled' && r.value).length;
    const failCount = devices.length - successCount;

    recordGlobalLog({
      type: 'SYSTEM',
      direction: 'SYS',
      label: 'Device Probe Complete',
      detail: `Success: ${successCount}, Failed: ${failCount}`
    });
  }, [mqttConfig.isConnected, mqttConfig.appid, probeDevice, recordGlobalLog]);

  // MQTT 连接就绪且有设备时，自动发起探测（System.All）以获取详细信息（如 IP）
  useEffect(() => {
    if (mqttConfig.isConnected && mqttConfig.appid && devices.length > 0 && session) {
      // 使用防抖或简单的标志位来避免过于频繁的探测可能更好，但这里直接调用
      // 检查是否已经探测过？或者每次连接都探测？
      // 为了简单起见，且 System.All 是轻量级请求，我们允许每次连接/设备列表更新时发送
      probeAllDevices(devices, session);
    }
  }, [mqttConfig.isConnected, mqttConfig.appid, devices.length, session, probeAllDevices]);

  // 获取设备列表
  const fetchDeviceList = useCallback(async (currentSession: CloudSession) => {
    if (!currentSession || currentSession.guid === 'PENDING') return;

    setIsDevicesLoading(true);

    try {
      const url = `https://${currentSession.httpDomain}/v1/Device/devList`;
      const packet = encapsulatePacket({});
      const bodyStr = new URLSearchParams(
        Object.entries(packet).map(([k, v]) => [k, String(v)])
      ).toString();

      const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${currentSession.token}`,
        'App-Gray-Id': '91522422430125',
        'AppLanguage': 'en',
        'AppType': 'iOS',
        'AppVersion': '3.38.6',
        'Vendor': 'merossBeta'
      };

      recordGlobalLog({
        type: 'HTTP',
        direction: 'TX',
        label: 'Fetch Device List -> [devList]',
        detail: `[URL]: ${url}\n[Method]: POST\n[Headers]: ${JSON.stringify(headers, null, 2)}\n[Body]: ${bodyStr}`
      });

      const resultObj = await window.electronAPI?.nativeRequest({
        url,
        method: 'POST',
        headers,
        body: bodyStr
      });

      const result = resultObj?.data;

      recordGlobalLog({
        type: 'HTTP',
        direction: result?.apiStatus === 0 ? 'RX' : 'ERR',
        label: `Device List Response <- Status: ${resultObj?.status}`,
        detail: `[Status]: ${resultObj?.status}\n[Body]:\n${JSON.stringify(result, null, 2)}`
      });

      if (result?.apiStatus === 0 && Array.isArray(result.data)) {
        // 将 API 返回的设备数据映射到 Device 类型
        const mappedDevices: Device[] = result.data.map((dev: any) => {
          const id = dev.uuid || dev.devUuid || dev.deviceUuid || Math.random().toString(36).substring(2, 9);
          console.log('[DeviceList] Mapped device:', dev.devName, 'ID:', id);
          return {
            id,
            name: dev.devName || dev.deviceName || 'Unknown Device',
            ip: dev.devIp || dev.localIp || '0.0.0.0',
            type: dev.deviceType || dev.devType || 'Unknown',
            status: dev.onlineStatus === 1 || dev.online === true ? DeviceStatus.ONLINE : DeviceStatus.OFFLINE,
            protocol: Protocol.MQTT,
            connectionType: dev.connectionType || 'WIFI',
            lastSeen: dev.lastActiveTime ? new Date(dev.lastActiveTime * 1000).toISOString() : new Date().toISOString(),
            firmwareVersion: dev.fmwareVersion || dev.firmwareVersion || 'N/A',
            telemetry: [],
            config: dev.channels || dev.digest || {},
            isBound: true,
            mqttTopic: `/appliance/${dev.uuid || dev.devUuid}/subscribe`,
            bindingToken: dev.bindToken || dev.token
          };
        });

        setDevices(mappedDevices);

        recordGlobalLog({
          type: 'SYSTEM',
          direction: 'SYS',
          label: 'Device List Loaded',
          detail: `Successfully loaded ${mappedDevices.length} device(s) from cloud`
        });

        // 如果有设备，自动选中第一个
        if (mappedDevices.length > 0 && !selectedDeviceId) {
          setSelectedDeviceId(mappedDevices[0].id);
        }

        // 通过 HTTP 请求每个设备的 Appliance.System.All 获取详细信息
        if (mappedDevices.length > 0) {
          fetchDeviceDetails(mappedDevices, currentSession);
        }
      }
    } catch (err: any) {
      recordGlobalLog({
        type: 'HTTP',
        direction: 'ERR',
        label: 'Device List Fetch Failed',
        detail: `[Error]: ${err.message}`
      });
    } finally {
      setIsDevicesLoading(false);
    }
  }, [encapsulatePacket, recordGlobalLog, selectedDeviceId]);

  // 获取设备详细信息 (Appliance.System.All via HTTP)
  const fetchDeviceDetails = useCallback(async (deviceList: Device[], currentSession: CloudSession) => {
    console.log('[App] Fetching device details for', deviceList.length, 'devices...');

    for (const device of deviceList) {
      if (!device.ip || device.ip === '0.0.0.0') {
        console.log(`[App] Skipping device ${device.name} - no valid IP`);
        continue;
      }

      try {
        const result = await window.electronAPI?.discoveryGetDeviceInfo({
          ip: device.ip,
          session: currentSession
        });

        if (result?.success && result.data) {
          const deviceData = result.data;
          console.log(`[App] Got details for ${device.name}:`, deviceData);

          // 更新设备信息
          setDevices(prev => prev.map(d => {
            if (d.id === device.id) {
              const firmware = deviceData.firmware;
              const system = deviceData.system;
              const hardware = deviceData.hardware;

              return {
                ...d,
                firmwareVersion: typeof firmware?.version === 'string'
                  ? firmware.version
                  : (d.firmwareVersion || 'N/A'),
                config: {
                  ...d.config,
                  systemInfo: {
                    hardware: hardware || {},
                    firmware: firmware || {},
                    online: system?.online || {}
                  }
                }
              };
            }
            return d;
          }));

          recordGlobalLog({
            type: 'HTTP',
            direction: 'RX',
            label: `Device Info: ${device.name}`,
            detail: `Got System.All from ${device.ip}`
          });
        } else {
          console.log(`[App] Failed to get details for ${device.name}:`, result?.error);
        }
      } catch (error: any) {
        console.error(`[App] Error fetching details for ${device.name}:`, error);
      }
    }
  }, [recordGlobalLog]);

  // 登录成功后（guid 获取完成后）自动拉取设备列表
  useEffect(() => {
    if (session && session.guid !== 'PENDING') {
      fetchDeviceList(session);
    }
  }, [session?.guid]); // 只在 guid 变化时触发

  // MQTT 连接成功后，自动探测所有设备
  useEffect(() => {
    if (mqttConfig.isConnected && mqttConfig.appid && session && devices.length > 0) {
      // 延迟 1 秒后开始探测，确保 MQTT 订阅已经完成
      const timer = setTimeout(() => {
        probeAllDevices(devices, session);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [mqttConfig.isConnected, mqttConfig.appid]); // 只在 MQTT 连接状态变化时触发

  const handleFleetHealthCheck = async () => {
    if (devices.length === 0) return;
    setIsFleetAnalyzing(true);
    try {
      const report = await analyzeFleetHealth(devices);
      setFleetReport(report);
    } catch (e) {
      setFleetReport("分析失败，请检查网络连接。");
    } finally {
      setIsFleetAnalyzing(false);
    }
  };

  // 登出账号
  const handleLogout = useCallback(async () => {
    if (!session) return;

    setIsLoggingOut(true);
    setIsAccountMenuOpen(false);

    try {
      // 先断开 MQTT 连接
      await window.electronAPI?.mqttDisconnect();

      // 调用登出 API
      const logoutUrl = `https://${session.httpDomain}/v1/Profile/logout`;
      const packet = encapsulatePacket({});

      recordGlobalLog({
        type: 'HTTP',
        direction: 'TX',
        label: 'Logout Request',
        detail: `[URL]: ${logoutUrl}`
      });

      const response = await window.electronAPI?.nativeRequest({
        url: logoutUrl,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${session.token}`
        },
        body: `params=${encodeURIComponent(packet.params)}&sign=${packet.sign}&timestamp=${packet.timestamp}&nonce=${packet.nonce}`
      });

      const result = response?.data ? JSON.parse(response.data) : null;

      recordGlobalLog({
        type: 'HTTP',
        direction: 'RX',
        label: 'Logout Response',
        detail: JSON.stringify(result, null, 2)
      });

      // 无论登出 API 是否成功，都清除本地 session
      setSession(null);
      setDevices([]);
      setSelectedDeviceId(null);
      setCurrentView('DASHBOARD');
      setMqttConfig({
        host: IOT_CONSTANTS.DEFAULT_MQTT_DOMAIN,
        port: IOT_CONSTANTS.DEFAULT_PORT,
        clientId: '',
        isConnected: false,
        retryCount: 0,
        status: 'DISCONNECTED'
      });
      setGlobalLogs([]);
      setFleetReport(null);

      recordGlobalLog({
        type: 'SYSTEM',
        direction: 'SYS',
        label: 'Logged Out',
        detail: 'Session cleared successfully'
      });

    } catch (err: any) {
      recordGlobalLog({
        type: 'HTTP',
        direction: 'ERR',
        label: 'Logout Failed',
        detail: err.message
      });
      // 即使 API 调用失败，也清除本地 session
      setSession(null);
      setDevices([]);
      setSelectedDeviceId(null);
    } finally {
      setIsLoggingOut(false);
    }
  }, [session, encapsulatePacket, recordGlobalLog]);


  // 取消/断开 MQTT 连接（通过 IPC 调用主进程）
  const cancelMqtt = useCallback(async () => {
    try {
      await window.electronAPI?.mqttDisconnect();
      setMqttConfig(prev => ({
        ...prev,
        isConnected: false,
        status: 'DISCONNECTED',
        retryCount: 0
      }));
      recordGlobalLog({ type: 'MQTT', direction: 'SYS', label: 'Connection Cancelled', detail: 'Operation aborted by user. Client resource released.' });
    } catch (err: any) {
      recordGlobalLog({ type: 'MQTT', direction: 'ERR', label: 'Disconnect Failed', detail: err.message });
    }
  }, [recordGlobalLog]);

  // 连接 MQTT（通过 IPC 调用主进程的原生 TCP/TLS 连接）
  const connectMqtt = useCallback(async (config: MqttSessionConfig, isManual: boolean = false) => {
    if (!session || session.guid === 'PENDING') return;
    if (mqttConfig.status === 'CONNECTING' && !isManual) return;

    // 检查 Electron API 是否可用
    if (!window.electronAPI?.mqttConnect) {
      recordGlobalLog({
        type: 'MQTT',
        direction: 'ERR',
        label: 'Environment Error',
        detail: 'Electron MQTT API not available. Please run in Electron environment.'
      });
      return;
    }

    const attemptNumber = isManual ? 1 : config.retryCount + 1;
    const brokerUrl = `mqtts://${config.host}:${config.port}`;

    setMqttConfig(prev => ({
      ...prev,
      status: 'CONNECTING',
      retryCount: attemptNumber
    }));

    // 记录连接请求日志
    recordGlobalLog({
      type: 'MQTT',
      direction: 'TX',
      label: `Native TLS Connect Attempt #${attemptNumber}`,
      detail: `[Broker URL]: ${brokerUrl}\n[ClientID]: ${config.clientId}\n[Username]: ${config.username}\n[Mode]: Electron Main Process (Native TCP/TLS)`
    });

    try {
      const result = await window.electronAPI.mqttConnect({
        host: config.host,
        port: config.port,
        clientId: config.clientId,
        username: config.username,
        password: config.password
      });

      if (result.success) {
        setMqttConfig(prev => ({ ...prev, isConnected: true, status: 'CONNECTED', retryCount: 0 }));
        recordGlobalLog({
          type: 'MQTT',
          direction: 'RX',
          label: 'SSL Link Active',
          detail: `Encrypted tunnel (TLS) established with ${config.host} via Electron main process`
        });
      }
    } catch (err: any) {
      const errorMessage = err.message || 'Unknown error';

      setMqttConfig(prev => {
        const currentRetry = prev.retryCount;
        if (currentRetry < 3) {
          recordGlobalLog({
            type: 'MQTT',
            direction: 'ERR',
            label: `Connection Failed (${currentRetry}/3)`,
            detail: errorMessage
          });
          // 2秒后自动重试
          setTimeout(() => {
            connectMqtt({ ...prev, retryCount: currentRetry }, false);
          }, 2000);
          return { ...prev, status: 'CONNECTING' };
        } else {
          recordGlobalLog({
            type: 'MQTT',
            direction: 'ERR',
            label: 'Connection Fatal',
            detail: `Retry limit reached. Reason: ${errorMessage}`
          });
          return { ...prev, isConnected: false, status: 'ERROR', retryCount: 3 };
        }
      });
    }
  }, [session, recordGlobalLog, mqttConfig.status]);

  // 监听主进程的 MQTT 事件（消息接收、断开连接）
  useEffect(() => {
    if (!window.electronAPI) return;

    // 监听 MQTT 消息
    window.electronAPI.onMqttMessage?.((data) => {
      try {
        const parsed = JSON.parse(data.message);
        recordGlobalLog({
          type: 'MQTT',
          direction: 'RX',
          label: `MQTT <- ${parsed.header?.namespace || 'Response'}`,
          detail: `[Topic]: ${data.topic}\n[Payload]:\n${JSON.stringify(parsed, null, 2)}`
        });

        // 自动更新设备 IP
        if (parsed.header?.namespace === 'Appliance.System.All' && parsed.header?.method === 'GETACK') {
          const innerIp = parsed.payload?.all?.system?.firmware?.innerIp;
          const deviceId = parsed.header?.uuid || data.topic.split('/')[2];

          if (innerIp && deviceId) {
            console.log(`[AutoIP] Received System.All GETACK. UUID: ${deviceId}, InnerIP: ${innerIp}`);
            setDevices(prev => {
              let hasChange = false;
              const newDevices = prev.map(d => {
                // 宽松匹配：忽略大小写
                if (d.id.toLowerCase() === deviceId.toLowerCase()) {
                  if (d.ip !== innerIp) {
                    console.log(`[AutoIP] Updating device ${d.name} (${d.id}) IP: ${d.ip} -> ${innerIp}`);
                    hasChange = true;
                    return { ...d, ip: innerIp };
                  } else {
                    console.log(`[AutoIP] Device ${d.name} IP already up to date.`);
                  }
                }
                return d;
              });

              if (!hasChange) {
                console.log(`[AutoIP] No matching device found for UUID: ${deviceId} in list:`, prev.map(d => d.id));
              }
              return hasChange ? newDevices : prev;
            });
          }
        }
      } catch {
        // 非 JSON 消息
        recordGlobalLog({
          type: 'MQTT',
          direction: 'RX',
          label: `MQTT <- Raw Message`,
          detail: `[Topic]: ${data.topic}\n[Message]: ${data.message}`
        });
      }
    });

    // 监听断开连接事件
    window.electronAPI.onMqttDisconnected?.(() => {
      setMqttConfig(prev => {
        if (prev.status === 'CONNECTED') {
          recordGlobalLog({
            type: 'MQTT',
            direction: 'SYS',
            label: 'Connection Lost',
            detail: 'MQTT connection was closed by server or network error'
          });
          return { ...prev, isConnected: false, status: 'DISCONNECTED' };
        }
        return prev;
      });
    });

    // 清理监听器
    return () => {
      window.electronAPI?.removeMqttListeners?.();
    };
  }, [recordGlobalLog]);

  // 登录成功后自动连接 MQTT
  useEffect(() => {
    if (session && session.guid !== 'PENDING' && !mqttConfig.isConnected && mqttConfig.status === 'DISCONNECTED' && mqttConfig.retryCount === 0) {
      const md5_old = md5(`${session.udid}${IOT_CONSTANTS.VENDOR}`).toLowerCase();
      const old_appid = `${session.guid}_${md5_old}`.substring(0, 32);
      const md5_new = md5(`${old_appid}${session.mqttDomain}`).toLowerCase();
      const final_appid = `${session.guid}_${md5_new}`.substring(0, 32);
      const client_id = `app:${final_appid}`;
      const mqttPassword = md5(`${session.uid}${session.key}`).toLowerCase();

      const newConfig: MqttSessionConfig = {
        host: session.mqttDomain,
        port: IOT_CONSTANTS.DEFAULT_PORT,
        clientId: client_id,
        username: session.uid,
        password: mqttPassword,
        appid: final_appid,  // 用于构建 from topic
        isConnected: false,
        retryCount: 0,
        status: 'DISCONNECTED'
      };
      setMqttConfig(newConfig);
      connectMqtt(newConfig, true);
    }
  }, [session, connectMqtt, mqttConfig.isConnected, mqttConfig.status, mqttConfig.retryCount]);

  const selectedDevice = devices.find(d => d.id === selectedDeviceId);

  // 临时禁用登录（开发模式）- 完成后改为 false
  const DEV_SKIP_AUTH = false;

  return (
    <div className="h-screen bg-slate-950 text-slate-200 flex flex-col font-sans relative overflow-hidden">
      {!session && !DEV_SKIP_AUTH ? (
        <AuthScreen
          onLoginSuccess={setSession}
          onLog={recordGlobalLog}
          isLogEnabled={isLogEnabled}
          onToggleLog={setIsLogEnabled}
          isLogVisible={isLogVisible}
          onToggleLogVisibility={() => setIsLogVisible(!isLogVisible)}
        />
      ) : (
        <div className="flex flex-col h-full overflow-hidden">
          <header className="flex-shrink-0 h-20 border-b border-slate-900/50 flex items-center justify-between px-6 bg-slate-950/50 backdrop-blur-3xl z-40">
            <div className="flex items-center gap-5">
              <div className="w-12 h-12 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-2xl shadow-indigo-600/20"><Database className="text-white" size={28} /></div>
              <div>
                <h1 className="text-2xl font-black text-white uppercase tracking-tighter italic">IoT Nexus</h1>
                <p className="text-[10px] text-slate-600 font-black uppercase tracking-[0.3em] mt-0.5">Enterprise Core Console</p>
              </div>
            </div>
            <nav className="flex items-center gap-3 bg-slate-900/40 p-1.5 rounded-[1.5rem] border border-slate-800">
              {currentView === 'DEVICE_DETAIL' ? (
                <button
                  onClick={() => { setCurrentView('DASHBOARD'); setSelectedDeviceId(null); }}
                  className="flex items-center gap-3 px-6 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest bg-slate-800 text-white"
                >
                  <ChevronRight size={16} className="rotate-180" /> Back to Dashboard
                </button>
              ) : (
                [
                  { id: 'DASHBOARD', label: 'Dashboard', icon: LayoutDashboard },
                  { id: 'MATTER', label: 'Matter', icon: Zap },
                  { id: 'LAB', label: 'TOOL', icon: RefreshCw },
                  { id: 'CLOUD_LAB', label: 'API', icon: Cloud },
                  { id: 'SETTINGS', label: 'Connectivity', icon: Settings }
                ].map(tab => (
                  <button key={tab.id} onClick={() => setCurrentView(tab.id as any)} className={`flex items-center gap-3 px-6 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all ${currentView === tab.id ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/10' : 'text-slate-500 hover:text-slate-300'}`}>
                    <tab.icon size={16} /> {tab.label}
                  </button>
                ))
              )}
            </nav>
            <div className="flex items-center gap-6">
              <button
                onClick={handleFleetHealthCheck}
                disabled={isFleetAnalyzing || devices.length === 0}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600/10 border border-indigo-500/20 rounded-xl text-[10px] font-black uppercase tracking-widest text-indigo-400 hover:bg-indigo-600 hover:text-white transition-all disabled:opacity-30"
              >
                {isFleetAnalyzing ? <RefreshCw className="animate-spin" size={14} /> : <BrainCircuit size={14} />}
                AI Insight
              </button>
              <button onClick={() => setIsLogVisible(!isLogVisible)} className={`flex items-center gap-3 px-5 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest border transition-all ${isLogVisible ? 'bg-emerald-600 border-emerald-500 text-white shadow-lg' : 'bg-slate-900 border-slate-800 text-slate-400'}`}><Terminal size={16} /> Matrix</button>

              {/* 账户图标和弹窗 */}
              <div className="relative">
                <button
                  onClick={() => setIsAccountMenuOpen(!isAccountMenuOpen)}
                  className="w-10 h-10 bg-indigo-600 hover:bg-indigo-500 rounded-full flex items-center justify-center transition-all shadow-lg shadow-indigo-600/20"
                >
                  <User size={20} className="text-white" />
                </button>

                {/* 账户信息弹窗 */}
                {isAccountMenuOpen && (
                  <>
                    {/* 点击外部关闭 */}
                    <div
                      className="fixed inset-0 z-[60]"
                      onClick={() => setIsAccountMenuOpen(false)}
                    />

                    <div className="absolute right-0 top-14 w-80 bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl z-[61] animate-in fade-in slide-in-from-top-2 duration-200 overflow-hidden">
                      {/* 账户头部 */}
                      <div className="p-4 bg-gradient-to-r from-indigo-600/20 to-purple-600/20 border-b border-slate-800">
                        <div className="flex items-center gap-3">
                          <div className="w-12 h-12 bg-indigo-600 rounded-full flex items-center justify-center">
                            <User size={24} className="text-white" />
                          </div>
                          <div>
                            <p className="text-white font-bold">{session?.email?.split('@')[0] || 'User'}</p>
                            <p className="text-slate-500 text-xs">{session?.email || 'No email'}</p>
                          </div>
                        </div>
                      </div>

                      {/* 账户信息列表 */}
                      <div className="p-3 space-y-1 max-h-[300px] overflow-y-auto custom-scrollbar">
                        <div className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-800/50">
                          <Hash size={14} className="text-slate-500" />
                          <div className="flex-1 min-w-0">
                            <p className="text-[9px] text-slate-500 uppercase font-bold">User ID</p>
                            <p className="text-xs text-white font-mono truncate">{session?.uid || 'N/A'}</p>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-800/50">
                          <Mail size={14} className="text-slate-500" />
                          <div className="flex-1 min-w-0">
                            <p className="text-[9px] text-slate-500 uppercase font-bold">Email</p>
                            <p className="text-xs text-white truncate">{session?.email || 'N/A'}</p>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-800/50">
                          <Key size={14} className="text-slate-500" />
                          <div className="flex-1 min-w-0">
                            <p className="text-[9px] text-slate-500 uppercase font-bold">Token</p>
                            <p className="text-xs text-white font-mono truncate">{session?.token?.substring(0, 24)}...</p>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-800/50">
                          <Globe size={14} className="text-slate-500" />
                          <div className="flex-1 min-w-0">
                            <p className="text-[9px] text-slate-500 uppercase font-bold">HTTP Domain</p>
                            <p className="text-xs text-white font-mono truncate">{session?.httpDomain || 'N/A'}</p>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-800/50">
                          <Cloud size={14} className="text-slate-500" />
                          <div className="flex-1 min-w-0">
                            <p className="text-[9px] text-slate-500 uppercase font-bold">MQTT Domain</p>
                            <p className="text-xs text-white font-mono truncate">{session?.mqttDomain || 'N/A'}</p>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-800/50">
                          <Hash size={14} className="text-slate-500" />
                          <div className="flex-1 min-w-0">
                            <p className="text-[9px] text-slate-500 uppercase font-bold">GUID</p>
                            <p className="text-xs text-white font-mono truncate">{session?.guid || 'N/A'}</p>
                          </div>
                        </div>
                      </div>

                      {/* 登出按钮 */}
                      <div className="p-3 border-t border-slate-800">
                        <button
                          onClick={handleLogout}
                          disabled={isLoggingOut}
                          className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-red-600/10 hover:bg-red-600 border border-red-500/20 hover:border-red-500 rounded-xl text-red-400 hover:text-white font-bold text-xs uppercase tracking-wider transition-all disabled:opacity-50"
                        >
                          {isLoggingOut ? (
                            <RefreshCw size={16} className="animate-spin" />
                          ) : (
                            <LogOut size={16} />
                          )}
                          {isLoggingOut ? 'Logging out...' : 'Log Out'}
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </header>

          <main className="flex-1 min-h-0 p-6 overflow-y-auto">
            {fleetReport && (
              <div className="mb-10 bg-indigo-600/10 border border-indigo-500/20 p-8 rounded-[3rem] animate-in zoom-in duration-300 relative overflow-hidden group">
                <div className="flex items-center gap-4 mb-4">
                  <BrainCircuit className="text-indigo-400" size={24} />
                  <h3 className="text-xs font-black text-indigo-300 uppercase tracking-widest">System Health Intelligence Report</h3>
                  <button onClick={() => setFleetReport(null)} className="ml-auto p-2 text-indigo-400 hover:text-white transition-colors"><X size={16} /></button>
                </div>
                <div className="text-sm text-slate-300 leading-relaxed font-medium selectable-text">
                  {fleetReport}
                </div>
                <div className="absolute -right-20 -bottom-20 w-64 h-64 bg-indigo-500/5 blur-[100px] group-hover:scale-110 transition-transform duration-1000" />
              </div>
            )}

            {currentView === 'DASHBOARD' && (
              <div className="space-y-8">
                {/* 添加设备按钮 */}
                <div className="flex justify-between items-center">
                  <div>
                    <h2 className="text-2xl font-black text-white uppercase tracking-tight">Device Fleet</h2>
                    <p className="text-slate-500 text-xs mt-1">Manage and monitor your connected devices</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => session && fetchDeviceList(session)}
                      disabled={isDevicesLoading}
                      className="px-4 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2 disabled:opacity-50"
                    >
                      <RefreshCw size={16} className={isDevicesLoading ? 'animate-spin' : ''} />
                      Refresh
                    </button>
                    <button onClick={() => setIsDiscoveryModalOpen(true)} className="px-5 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all shadow-xl shadow-emerald-600/20 flex items-center gap-2">
                      <Activity size={16} /> Scan Devices
                    </button>
                    <button onClick={() => setIsAddModalOpen(true)} className="px-5 py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all shadow-xl shadow-indigo-600/20 flex items-center gap-2">
                      <Plus size={16} /> Add New
                    </button>
                  </div>
                </div>

                {/* 设备网格 */}
                {isDevicesLoading ? (
                  <div className="flex flex-col items-center justify-center py-32">
                    <RefreshCw size={48} className="text-indigo-500 mb-4 animate-spin" />
                    <p className="text-xs font-black text-indigo-400 uppercase tracking-widest">Loading devices from cloud...</p>
                  </div>
                ) : devices.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-32 border-2 border-dashed border-slate-800 rounded-[3rem]">
                    <Activity size={64} className="text-slate-800 mb-6" />
                    <p className="text-sm font-black text-slate-700 uppercase tracking-widest">No devices found</p>
                    <p className="text-slate-600 text-xs mt-2">Add your first device to get started</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {devices.map(device => (
                      <button
                        key={device.id}
                        onClick={() => { setSelectedDeviceId(device.id); setCurrentView('DEVICE_DETAIL'); }}
                        className="group p-6 bg-slate-900/60 hover:bg-slate-900 border border-slate-800 hover:border-indigo-500/50 rounded-[2rem] text-left transition-all hover:shadow-2xl hover:shadow-indigo-600/10"
                      >
                        <div className="flex items-start justify-between mb-4">
                          <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${device.status === DeviceStatus.ONLINE ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>
                            <Zap size={24} />
                          </div>
                          <div className={`w-3 h-3 rounded-full ${device.status === DeviceStatus.ONLINE ? 'bg-emerald-500 shadow-lg shadow-emerald-500/50' : 'bg-slate-600'}`} />
                        </div>
                        <h3 className="text-lg font-black text-white uppercase tracking-tight mb-1 group-hover:text-indigo-400 transition-colors">{device.name}</h3>
                        <p className="text-slate-500 text-xs font-mono mb-3">{device.type || 'Unknown Type'}</p>
                        <div className="flex items-center gap-2">
                          <span className="text-[9px] font-black uppercase px-2 py-1 rounded-lg bg-slate-800 text-slate-400">{device.protocol}</span>
                          <span className={`text-[9px] font-black uppercase px-2 py-1 rounded-lg ${device.status === DeviceStatus.ONLINE ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>
                            {device.status === DeviceStatus.ONLINE ? 'Online' : 'Offline'}
                          </span>
                        </div>
                        <div className="mt-4 pt-4 border-t border-slate-800 flex items-center justify-between">
                          <span className="text-[10px] text-slate-600 font-mono">{device.id.substring(0, 12)}...</span>
                          <ChevronRight size={16} className="text-slate-600 group-hover:text-indigo-400 transition-colors" />
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 设备详情页面 */}
            {currentView === 'DEVICE_DETAIL' && selectedDevice && (
              <div className="space-y-8 animate-in fade-in slide-in-from-right-4 duration-300">
                {/* 设备标题栏 */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-6">
                    <div className={`w-16 h-16 rounded-2xl flex items-center justify-center ${selectedDevice.status === DeviceStatus.ONLINE ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>
                      <Zap size={32} />
                    </div>
                    <div>
                      <h2 className="text-2xl font-black text-white uppercase tracking-tight">{selectedDevice.name}</h2>
                      <p className="text-slate-500 text-xs font-mono mt-1">{selectedDevice.id}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className={`px-4 py-2 rounded-xl text-xs font-black uppercase ${selectedDevice.status === DeviceStatus.ONLINE ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-slate-800 text-slate-500 border border-slate-700'}`}>
                      {selectedDevice.status === DeviceStatus.ONLINE ? '● Online' : '○ Offline'}
                    </span>
                  </div>
                </div>

                {/* 设备监控面板 */}
                <DeviceMonitor
                  device={selectedDevice}
                  onGetOnlineStatus={async () => {
                    // 直接使用设备状态确定在线状态
                    return { status: selectedDevice.status === DeviceStatus.ONLINE ? 1 : 2 };
                  }}
                />

                {/* MQTT 控制台和配置 - 两列布局 */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                  <MqttDeviceConsole
                    device={selectedDevice}
                    session={session!}
                    mqttConnected={mqttConfig.isConnected}
                    appid={mqttConfig.appid}
                    onLog={recordGlobalLog}
                  />
                  <DeviceConfiguration device={selectedDevice} onUpdateConfig={() => { }} onUpdateSequence={() => { }} onUpdateNetwork={() => { }} />
                </div>
              </div>
            )}
            {currentView === 'LAB' && (
              <div className="h-full space-y-6">
                <ProtocolLab
                  onLog={recordGlobalLog}
                  devices={devices.map(d => ({ id: d.id, name: d.name, ip: d.ip }))}
                  mqttConnected={mqttConfig.isConnected}
                  onMqttPublish={handleMqttPublish}
                  appid={mqttConfig.appid}
                  session={session}
                  onHttpRequest={async (ip, payload) => {
                    if (!window.electronAPI?.nativeRequest) throw new Error('Electron API not available');
                    const res = await window.electronAPI.nativeRequest({
                      url: `http://${ip}/config`,
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: payload
                    });
                    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
                    return res.data;
                  }}
                />
              </div>
            )}
            {currentView === 'MATTER' && (
              <div className="space-y-6">
                <MatterDashboard onLog={recordGlobalLog} />
                <MatterConsole onLog={recordGlobalLog} />
              </div>
            )}
            {currentView === 'CLOUD_LAB' && <CloudApiLab session={session!} onLog={recordGlobalLog} />}
            {currentView === 'SETTINGS' && <MqttSettings config={mqttConfig} session={session!} onUpdate={setMqttConfig} onConnect={() => connectMqtt(mqttConfig, true)} onCancel={cancelMqtt} isLogEnabled={isLogEnabled} onToggleLog={setIsLogEnabled} onLog={recordGlobalLog} />}
          </main>
        </div>
      )}

      {/* Side Log Matrix */}
      <div className={`fixed top-0 right-0 bottom-0 w-[600px] bg-slate-950/98 border-l border-slate-800 backdrop-blur-3xl z-[100] transition-transform duration-500 flex flex-col shadow-2xl ${isLogVisible ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="p-8 border-b border-slate-800 flex justify-between items-center bg-slate-950/50">
          <h3 className="text-base font-black text-white uppercase tracking-widest">Protocol Matrix</h3>
          <div className="flex gap-2">
            <button onClick={() => setGlobalLogs([])} className="p-3 text-slate-500 hover:text-red-400 bg-slate-900 rounded-xl transition-all"><Trash2 size={20} /></button>
            <button onClick={() => setIsLogVisible(false)} className="p-3 text-slate-400 hover:text-white bg-slate-900 rounded-xl transition-all"><X size={20} /></button>
          </div>
        </div>
        <div ref={logScrollRef} className="flex-1 overflow-y-auto p-8 font-mono custom-scrollbar space-y-6 selectable-text">
          {globalLogs.slice().reverse().map(log => (
            <div key={log.id} className="border-b border-slate-900/50 pb-6 group">
              <div className="flex gap-3 mb-2 items-center">
                <span className="text-slate-600 font-bold text-xs">[{log.timestamp}]</span>
                <span className={`px-2 py-0.5 rounded text-[11px] font-black uppercase ${log.direction === 'TX' ? 'bg-blue-500/10 text-blue-400' : (log.direction === 'RX' ? 'bg-emerald-500/10 text-emerald-400' : (log.direction === 'ERR' ? 'bg-red-500/10 text-red-400' : 'bg-slate-500/10 text-slate-400'))}`}>{log.direction}</span>
                <span className="text-indigo-500 text-[11px] font-black uppercase tracking-widest">{log.type}</span>
              </div>
              <p className="text-slate-200 font-bold text-base mb-2 group-hover:text-indigo-400 transition-colors">{log.label}</p>
              <pre className="text-slate-500 text-sm leading-relaxed break-all whitespace-pre-wrap bg-slate-950 p-4 rounded-2xl border border-slate-900/50 shadow-inner group-hover:border-slate-700 transition-all">{log.detail}</pre>
            </div>
          ))}
        </div>
      </div>

      <AddDeviceModal isOpen={isAddModalOpen} onClose={() => setIsAddModalOpen(false)} onAdd={(d) => setDevices([...devices, { ...d, id: Math.random().toString(), status: DeviceStatus.ONLINE, telemetry: [] }])} deviceTypes={DEFAULT_DEVICE_TYPES} connectionTypes={DEFAULT_CONNECTION_TYPES} onUpdateDeviceTypes={() => { }} onUpdateConnectionTypes={() => { }} session={session} />

      {/* Device Discovery Modal */}
      <ErrorBoundary>
        <DeviceDiscoveryModal
          isOpen={isDiscoveryModalOpen}
          onClose={() => setIsDiscoveryModalOpen(false)}
          session={session}
          onLog={recordGlobalLog}
        />
      </ErrorBoundary>
    </div>
  );
};

export default App;
