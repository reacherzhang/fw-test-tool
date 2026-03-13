
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Wrench, Play, Square, Settings2, Zap, Terminal, Send, RefreshCw,
  Activity, Clock, CheckCircle, XCircle, Loader2, Trash2, Download,
  Cable, Radio, ArrowUpDown, AlertTriangle, Gauge, Timer, RotateCcw,
  Upload, Cloud, CloudOff, FileJson, Copy, Pause, List, Plus
} from 'lucide-react';
import { md5 } from './AuthScreen';
import { GlobalLogEntry, CloudSession } from '../types';
import { QAAutoTaskRunner } from './QAAutoTaskRunner';

interface ToolboxProps {
  onLog?: (log: Omit<GlobalLogEntry, 'id' | 'timestamp'>) => void;
  mqttConnected?: boolean;
  devices?: { id: string; name: string; ip?: string }[];
  onMqttPublish?: (topic: string, message: string) => Promise<any>;
  onHttpRequest?: (ip: string, payload: any) => Promise<any>;
  appid?: string;
  session?: CloudSession | null;
  qaServerUrl?: string;
  qaUser?: string;
  qaToken?: string;
}

interface ProtocolTemplate {
  id: string;
  name: string;
  namespace: string;
  method: string;
  payload: any;
  isCustom?: boolean;
  specialTest?: 'msgid_replay' | 'msgid_format'; // 特殊测试类型
}

// 预设协议模板
const INITIAL_TEMPLATES: ProtocolTemplate[] = [
  { id: 'toggle_on', name: '开机', namespace: 'Appliance.Control.ToggleX', method: 'SET', payload: { togglex: { channel: 0, onoff: 1 } } },
  { id: 'toggle_off', name: '关机', namespace: 'Appliance.Control.ToggleX', method: 'SET', payload: { togglex: { channel: 0, onoff: 0 } } },
  { id: 'anti_replay', name: '协议防重放', namespace: 'Appliance.System.All', method: 'GET', payload: {} },
  { id: 'msgid_replay', name: 'MessageId防重放', namespace: 'Appliance.System.All', method: 'GET', payload: {}, specialTest: 'msgid_replay' },
  { id: 'msgid_format', name: 'MessageId格式', namespace: 'Appliance.System.All', method: 'GET', payload: {}, specialTest: 'msgid_format' },
];

type ToolTab = 'STRESS_TEST' | 'MOCK_FORWARD' | 'SERIAL_MONITOR' | 'QA_AUTO_TASK';

interface StressTestConfig {
  type: 'TOGGLE' | 'UPGRADE' | 'CUSTOM';
  targetDevice: string;
  targetIp: string;
  interval: number; // ms
  count: number;
  templateIds: string[]; // Changed to array
  customPayload: string;
  useHttp: boolean; // 优先使用 HTTP
  mode: 'linear' | 'concurrent'; // 压测模式
}

interface StressTask {
  id: string;
  deviceId: string;
  deviceName: string;
  config: StressTestConfig;
  status: 'RUNNING' | 'COMPLETED' | 'STOPPED';
  progress: {
    current: number;
    total: number;
    success: number;
    failed: number;
    avgLatency: number;
  };
  logs: { time: string; status: 'success' | 'failed' | 'pending'; latency?: number; message?: string; payload?: string }[];
  startTime: number;
}

interface MockMessage {
  id: string;
  topic: string;
  payload: string;
  enabled: boolean;
  interval?: number;
}

interface SerialLog {
  time: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' | 'TX';
  content: string;
}

interface AvailablePort {
  path: string;
  manufacturer: string;
  friendlyName: string;
}

export const ProtocolLab: React.FC<ToolboxProps> = ({ onLog, mqttConnected, devices = [], onMqttPublish, onHttpRequest, appid = 'iot-test-tool', session, qaServerUrl, qaUser, qaToken }) => {
  const [activeTab, setActiveTab] = useState<ToolTab>('STRESS_TEST');

  // Stress Test State
  const [stressConfig, setStressConfig] = useState<StressTestConfig>({
    type: 'CUSTOM',
    targetDevice: '',
    targetIp: '',
    interval: 1000,
    count: 10,
    templateIds: [],
    customPayload: JSON.stringify({
      header: { namespace: 'Appliance.Control.ToggleX', method: 'SET' },
      payload: { togglex: { channel: 0, onoff: 1 } }
    }, null, 2),
    useHttp: true,
    mode: 'linear'
  });

  // 获取当前用户的模板存储 key
  const getTemplateStorageKey = () => {
    const uid = session?.uid || 'anonymous';
    return `custom_templates_${uid}`;
  };

  // Template State - 预设模板 + 自定义模板（与账户关联）
  const [templates, setTemplates] = useState<ProtocolTemplate[]>(INITIAL_TEMPLATES);

  // 当 session 变化时，重新加载该用户的自定义模板
  useEffect(() => {
    const storageKey = getTemplateStorageKey();
    const savedCustom = localStorage.getItem(storageKey);
    const customTemplates: ProtocolTemplate[] = savedCustom ? JSON.parse(savedCustom) : [];
    // 合并：预设模板 + 该用户的自定义模板
    setTemplates([...INITIAL_TEMPLATES, ...customTemplates.filter(t => t.isCustom)]);
  }, [session?.uid]);

  // Persist only custom templates (与账户关联)
  useEffect(() => {
    // 只在有 session 时保存
    if (!session?.uid) return;
    const storageKey = getTemplateStorageKey();
    const customOnly = templates.filter(t => t.isCustom);
    localStorage.setItem(storageKey, JSON.stringify(customOnly));
  }, [templates, session?.uid]);

  // Multi-task Stress Test State
  const [tasks, setTasks] = useState<StressTask[]>([]);
  const taskControllers = useRef<Map<string, { stop: () => void }>>(new Map());

  // Template Management
  const addTemplate = (name: string, payloadStr: string) => {
    try {
      const payloadObj = JSON.parse(payloadStr);
      const newTemplate: ProtocolTemplate = {
        id: `custom_${Date.now()}`,
        name: name || 'Custom Template',
        namespace: payloadObj.header?.namespace || 'Unknown',
        method: payloadObj.header?.method || 'UNKNOWN',
        payload: payloadObj.payload || {},
        isCustom: true
      };
      setTemplates(prev => [...prev, newTemplate]);
    } catch (e) {
      alert('Invalid JSON Payload');
    }
  };

  const deleteTemplate = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('确定要删除这个模板吗？')) {
      setTemplates(prev => prev.filter(t => t.id !== id));
      // 如果当前选中了这个模板，取消选中
      setStressConfig(prev => ({
        ...prev,
        templateIds: prev.templateIds.filter(tid => tid !== id)
      }));
    }
  };

  // Template Management State
  const [showNameInput, setShowNameInput] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [templateInputMode, setTemplateInputMode] = useState<'json' | 'keyvalue'>('keyvalue');

  // Key-Value 输入结构
  interface KeyValueEntry {
    id: string;
    key: string;
    value: string;
    type: 'string' | 'number' | 'boolean' | 'object';
  }
  const [kvNamespace, setKvNamespace] = useState('Appliance.Control.ToggleX');
  const [kvMethod, setKvMethod] = useState<'GET' | 'SET'>('SET');
  const [kvEntries, setKvEntries] = useState<KeyValueEntry[]>([
    { id: '1', key: 'togglex.channel', value: '0', type: 'number' },
    { id: '2', key: 'togglex.onoff', value: '1', type: 'number' },
  ]);

  // Key-Value 转 JSON
  const kvToJson = useCallback(() => {
    const payload: any = {};
    kvEntries.forEach(entry => {
      const keys = entry.key.split('.');
      let current = payload;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!current[keys[i]]) current[keys[i]] = {};
        current = current[keys[i]];
      }
      const lastKey = keys[keys.length - 1];
      if (entry.type === 'number') {
        current[lastKey] = parseFloat(entry.value) || 0;
      } else if (entry.type === 'boolean') {
        current[lastKey] = entry.value === 'true';
      } else if (entry.type === 'object') {
        try { current[lastKey] = JSON.parse(entry.value); } catch { current[lastKey] = {}; }
      } else {
        current[lastKey] = entry.value;
      }
    });
    return JSON.stringify({
      header: { namespace: kvNamespace, method: kvMethod },
      payload
    }, null, 2);
  }, [kvEntries, kvNamespace, kvMethod]);

  // 添加 KV 条目
  const addKvEntry = () => {
    setKvEntries(prev => [...prev, { id: Date.now().toString(), key: '', value: '', type: 'string' }]);
  };

  // 删除 KV 条目
  const removeKvEntry = (id: string) => {
    setKvEntries(prev => prev.filter(e => e.id !== id));
  };

  // 更新 KV 条目
  const updateKvEntry = (id: string, field: 'key' | 'value' | 'type', val: string) => {
    setKvEntries(prev => prev.map(e => e.id === id ? { ...e, [field]: val } : e));
  };

  // Mock Forward State
  const [mockMessages, setMockMessages] = useState<MockMessage[]>([
    { id: '1', topic: '/appliance/{uuid}/subscribe', payload: '{"header":{"namespace":"Appliance.System.All","method":"GETACK"}}', enabled: false }
  ]);
  const [newMockTopic, setNewMockTopic] = useState('');
  const [newMockPayload, setNewMockPayload] = useState('{}');
  const [newMockInterval, setNewMockInterval] = useState(1000); // 默认 1000ms

  // Mock Forward Functions
  const addMockMessage = () => {
    if (!newMockTopic.trim()) return;
    setMockMessages(prev => [...prev, {
      id: Date.now().toString(),
      topic: newMockTopic,
      payload: newMockPayload,
      enabled: false,
      interval: newMockInterval
    }]);
    setNewMockTopic('');
    setNewMockPayload('{}');
    setNewMockInterval(1000);
  };

  const toggleMockMessage = (id: string) => {
    setMockMessages(prev => prev.map(m => m.id === id ? { ...m, enabled: !m.enabled } : m));
  };

  const deleteMockMessage = (id: string) => {
    setMockMessages(prev => prev.filter(m => m.id !== id));
  };

  const sendMockMessage = async (msg: MockMessage) => {
    if (!onMqttPublish) {
      alert('MQTT Client not available');
      return;
    }

    try {
      // 尝试解析 payload 以确保它是有效的 JSON
      const payloadObj = JSON.parse(msg.payload);
      // 注入动态字段 (MessageId, Timestamp, Sign)
      if (payloadObj.header) {
        const timestamp = Math.floor(Date.now() / 1000);
        const messageId = md5(crypto.randomUUID()).toLowerCase();
        payloadObj.header.messageId = messageId;
        payloadObj.header.timestamp = timestamp;
        if (session?.key) {
          payloadObj.header.sign = md5(messageId + session.key + String(timestamp)).toLowerCase();
        }
      }

      const finalPayload = JSON.stringify(payloadObj);

      onLog?.({
        type: 'CUSTOM',
        direction: 'TX',
        label: `Mock -> ${msg.topic}`,
        detail: finalPayload
      });

      await onMqttPublish(msg.topic, finalPayload);
    } catch (e: any) {
      console.error('Mock send failed:', e);
      onLog?.({
        type: 'CUSTOM',
        direction: 'ERR',
        label: `Mock Failed -> ${msg.topic}`,
        detail: e.message
      });
    }
  };

  // 处理 Mock 消息的自动发送
  useEffect(() => {
    const timers: NodeJS.Timeout[] = [];

    mockMessages.forEach(msg => {
      if (msg.enabled && msg.interval && msg.interval > 0) {
        const timer = setInterval(() => {
          sendMockMessage(msg);
        }, msg.interval);
        timers.push(timer);
      }
    });

    return () => {
      timers.forEach(clearInterval);
    };
  }, [mockMessages, onMqttPublish, session]); // 依赖项包含 mockMessages，当启用状态改变时会重新设置定时器

  // Serial Monitor State
  const [serialPort, setSerialPort] = useState('');
  const [serialBaudRate, setSerialBaudRate] = useState(115200);
  const [serialConnected, setSerialConnected] = useState(false);
  const [serialLogs, setSerialLogs] = useState<SerialLog[]>([]);
  const [serialFilter, setSerialFilter] = useState('');
  const [serialPaused, setSerialPaused] = useState(false);
  const [availablePorts, setAvailablePorts] = useState<AvailablePort[]>([]);
  const [loadingPorts, setLoadingPorts] = useState(false);
  const [serialInput, setSerialInput] = useState('');
  const [serialConnecting, setSerialConnecting] = useState(false);
  const [localEcho, setLocalEcho] = useState(false); // 本地回显开关，默认关闭
  const [lineEnding, setLineEnding] = useState<'LF' | 'CRLF' | 'CR' | 'NONE'>('CR'); // 行尾符，默认 CR
  const [commandHistory, setCommandHistory] = useState<string[]>([]); // 命令历史
  const [historyIndex, setHistoryIndex] = useState(-1); // 历史索引
  const serialLogsRef = useRef<HTMLDivElement>(null);
  const serialInputRef = useRef<HTMLInputElement>(null);
  const scrollBottomRef = useRef<HTMLDivElement>(null); // 用于滚动到底部的锚点

  // Auto-scroll serial logs - 更可靠的滚动方式
  useEffect(() => {
    if (!serialPaused && scrollBottomRef.current) {
      // 使用 requestAnimationFrame 确保 DOM 更新后再滚动
      requestAnimationFrame(() => {
        scrollBottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
      });
    }
  }, [serialLogs, serialPaused]);

  // Update target IP when device changes
  useEffect(() => {
    if (stressConfig.targetDevice) {
      const dev = devices.find(d => d.id === stressConfig.targetDevice);
      if (dev && dev.ip) {
        setStressConfig(prev => ({ ...prev, targetIp: dev.ip || '' }));
      }
    }
  }, [stressConfig.targetDevice, devices]);

  // Apply Template
  const applyTemplate = (templateId: string) => {
    const template = templates.find(t => t.id === templateId);
    if (template) {
      setStressConfig(prev => ({
        ...prev,
        templateIds: [templateId], // When applying a single template, clear others
        customPayload: JSON.stringify({
          header: {
            namespace: template.namespace,
            method: template.method,
            messageId: '', // Will be generated at runtime
            timestamp: 0,  // Will be generated at runtime
            from: `/app/${appid}/subscribe`
          },
          payload: template.payload
        }, null, 2)
      }));
    }
  };

  // Toggle Template
  const toggleTemplate = (templateId: string) => {
    setStressConfig(prev => {
      const exists = prev.templateIds.includes(templateId);
      const newIds = exists
        ? prev.templateIds.filter(id => id !== templateId)
        : [...prev.templateIds, templateId];

      return { ...prev, templateIds: newIds };
    });
  };

  // Stress Test Functions
  const stopStressTest = (taskId: string) => {
    const controller = taskControllers.current.get(taskId);
    if (controller) {
      controller.stop();
      taskControllers.current.delete(taskId);
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'STOPPED' } : t));
    }
  };

  const startStressTest = useCallback(() => {
    if (!stressConfig.targetDevice) {
      alert('请先选择目标设备');
      return;
    }
    if (!session) {
      alert('缺少会话信息，无法计算签名');
      return;
    }

    // 检测是否是特殊测试
    let specialTestType: 'msgid_replay' | 'msgid_format' | undefined;
    if (stressConfig.templateIds.length === 1) {
      const template = templates.find(t => t.id === stressConfig.templateIds[0]);
      specialTestType = template?.specialTest;
    }

    // Create new task
    const device = devices.find(d => d.id === stressConfig.targetDevice);
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const configSnapshot = { ...stressConfig };

    // 对于特殊测试，强制设置次数
    if (specialTestType === 'msgid_replay') {
      configSnapshot.count = 22;
    } else if (specialTestType === 'msgid_format') {
      configSnapshot.count = 7;
    }

    const newTask: StressTask = {
      id: taskId,
      deviceId: configSnapshot.targetDevice,
      deviceName: device?.name || 'Unknown Device',
      config: configSnapshot,
      status: 'RUNNING',
      progress: { current: 0, total: configSnapshot.count, success: 0, failed: 0, avgLatency: 0 },
      logs: [],
      startTime: Date.now()
    };

    setTasks(prev => [newTask, ...prev]);

    let round = 0;
    const latencies: number[] = [];
    let isStopped = false;

    // 用于 msgid_replay 测试：记录前 20 条的 messageId
    const messageIdHistory: string[] = [];

    // 并发模式处理
    if (configSnapshot.mode === 'concurrent') {
      const runConcurrent = async () => {
        const promises = [];
        for (let i = 1; i <= configSnapshot.count; i++) {
          if (isStopped) break;
          const currentRound = i;

          promises.push((async () => {
            const startTime = Date.now();

            // Initial pending log
            setTasks(prev => prev.map(t => {
              if (t.id !== taskId) return t;
              return {
                ...t,
                progress: { ...t.progress, current: Math.max(t.progress.current, currentRound) },
                logs: [{ time: new Date().toLocaleTimeString(), status: 'pending', message: `Round ${currentRound} started (Concurrent)...` }, ...t.logs.slice(0, 49)]
              };
            }));

            try {
              let requestPayload: any;
              const useTemplates = configSnapshot.templateIds.length > 0;

              if (useTemplates) {
                const templateId = configSnapshot.templateIds[(currentRound - 1) % configSnapshot.templateIds.length];
                const template = templates.find(t => t.id === templateId);
                if (!template) throw new Error(`Template ${templateId} not found`);

                requestPayload = {
                  header: {
                    namespace: template.namespace,
                    method: template.method,
                    messageId: '',
                    timestamp: 0,
                    sign: '',
                    triggerSrc: 'iot-test-tool',
                    from: `/app/${appid}/subscribe`
                  },
                  payload: template.payload
                };
              } else {
                try {
                  requestPayload = JSON.parse(configSnapshot.customPayload);
                } catch (e) {
                  throw new Error('Invalid JSON Payload');
                }
              }

              const timestamp = Math.floor(Date.now() / 1000);
              const messageId = md5(crypto.randomUUID()).toLowerCase();
              const sign = md5(messageId + session.key + String(timestamp)).toLowerCase();

              requestPayload.header.messageId = messageId;
              requestPayload.header.timestamp = timestamp;
              requestPayload.header.sign = sign;
              requestPayload.header.triggerSrc = 'iot-test-tool';
              if (!requestPayload.header.from) {
                requestPayload.header.from = `/app/${appid}/subscribe`;
              }

              let success = false;
              let method = 'UNKNOWN';

              if (configSnapshot.useHttp && configSnapshot.targetIp && onHttpRequest) {
                method = 'HTTP';
                try {
                  await onHttpRequest(configSnapshot.targetIp, requestPayload);
                  success = true;
                } catch (e) {
                  console.warn(`[Stress] HTTP failed, trying MQTT if available...`, e);
                }
              }

              if (!success && onMqttPublish) {
                method = 'MQTT';
                const topic = `/appliance/${configSnapshot.targetDevice}/subscribe`;
                await onMqttPublish(topic, JSON.stringify(requestPayload));
                success = true;
              }

              if (!success) {
                throw new Error('No available transport (HTTP/MQTT failed)');
              }

              const latency = Date.now() - startTime;
              latencies.push(latency);

              setTasks(prev => prev.map(t => {
                if (t.id !== taskId) return t;
                return {
                  ...t,
                  progress: {
                    ...t.progress,
                    success: t.progress.success + 1,
                    avgLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length
                  },
                  logs: [{
                    time: new Date().toLocaleTimeString(),
                    status: 'success',
                    latency,
                    message: `Round ${currentRound} success via ${method} [MsgId: ${messageId.substring(0, 8)}...]`,
                    payload: JSON.stringify(requestPayload, null, 2)
                  }, ...t.logs.slice(0, 49)]
                };
              }));

            } catch (err: any) {
              setTasks(prev => prev.map(t => {
                if (t.id !== taskId) return t;
                return {
                  ...t,
                  progress: { ...t.progress, failed: t.progress.failed + 1 },
                  logs: [{
                    time: new Date().toLocaleTimeString(),
                    status: 'failed',
                    message: err.message
                  }, ...t.logs.slice(0, 49)]
                };
              }));
            }
          })());
        }

        // Wait for all concurrent requests to finish
        await Promise.allSettled(promises);

        if (!isStopped) {
          setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'COMPLETED' } : t));
          taskControllers.current.delete(taskId);
        }
      };

      runConcurrent();
      taskControllers.current.set(taskId, { stop: () => { isStopped = true; } });
      return;
    }

    // 现有的线性执行逻辑
    const runTest = async () => {
      if (isStopped) return;

      if (round >= configSnapshot.count) {
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'COMPLETED' } : t));
        taskControllers.current.delete(taskId);
        return;
      }

      round++;
      const startTime = Date.now();

      // Update task progress (pending)
      setTasks(prev => prev.map(t => {
        if (t.id !== taskId) return t;
        return {
          ...t,
          progress: { ...t.progress, current: round },
          logs: [{ time: new Date().toLocaleTimeString(), status: 'pending', message: `Round ${round} started...` }, ...t.logs.slice(0, 49)]
        };
      }));

      try {
        // Prepare Payload
        let requestPayload: any;
        const useTemplates = configSnapshot.templateIds.length > 0;

        if (useTemplates) {
          const templateId = configSnapshot.templateIds[(round - 1) % configSnapshot.templateIds.length];
          const template = templates.find(t => t.id === templateId);
          if (!template) throw new Error(`Template ${templateId} not found`);

          requestPayload = {
            header: {
              namespace: template.namespace,
              method: template.method,
              messageId: '',
              timestamp: 0,
              sign: '',
              triggerSrc: 'iot-test-tool',
              from: `/app/${appid}/subscribe`
            },
            payload: template.payload
          };
        } else {
          try {
            requestPayload = JSON.parse(configSnapshot.customPayload);
          } catch (e) {
            throw new Error('Invalid JSON Payload');
          }
        }

        // Inject dynamic fields & Sign
        const timestamp = Math.floor(Date.now() / 1000);
        let messageId: string;
        let testNote = '';

        // 特殊测试：MessageId 防重放
        if (specialTestType === 'msgid_replay') {
          if (round <= 20) {
            // 前 20 条：生成唯一的 messageId
            messageId = md5(crypto.randomUUID()).toLowerCase();
            messageIdHistory.push(messageId);
            testNote = `(正常ID #${round})`;
          } else if (round === 21) {
            // 第 21 条：复用第 1 条的 messageId（应该被拒绝，因为还在缓存中）
            messageId = messageIdHistory[0];
            testNote = `(重放ID #1 - 预期失败)`;
          } else {
            // 第 22 条：也复用第 1 条的 messageId（应该成功，因为已被挤出缓存）
            messageId = messageIdHistory[0];
            testNote = `(重放ID #1 - 预期成功)`;
          }
        } else if (specialTestType === 'msgid_format') {
          // 特殊测试：MessageId 格式验证
          const baseId = md5(crypto.randomUUID()); // 32位原始ID
          switch (round) {
            case 1:
              // 32位小写字符串 - 正常格式
              messageId = baseId.toLowerCase();
              testNote = '(32位小写 - 正常)';
              break;
            case 2:
              // 32位大写字符串
              messageId = baseId.toUpperCase();
              testNote = '(32位大写)';
              break;
            case 3:
              // 32位包含特殊字符
              messageId = baseId.substring(0, 16) + '*#@!$%^&' + baseId.substring(24);
              testNote = '(含特殊字符)';
              break;
            case 4:
              // 32位空格字符串
              messageId = '                                '; // 32个空格
              testNote = '(32位空格)';
              break;
            case 5:
              // 31位小写字符串
              messageId = baseId.toLowerCase().substring(0, 31);
              testNote = '(31位 - 长度不足)';
              break;
            case 6:
              // 33位小写字符串
              messageId = baseId.toLowerCase() + 'x';
              testNote = '(33位 - 长度超出)';
              break;
            case 7:
              // 空字符串
              messageId = '';
              testNote = '(空字符串)';
              break;
            default:
              messageId = baseId.toLowerCase();
              testNote = '(额外测试)';
          }
        } else {
          // 普通测试：每次生成新的 messageId
          messageId = md5(crypto.randomUUID()).toLowerCase();
        }

        const sign = md5(messageId + session.key + String(timestamp)).toLowerCase();

        requestPayload.header.messageId = messageId;
        requestPayload.header.timestamp = timestamp;
        requestPayload.header.sign = sign;
        requestPayload.header.triggerSrc = 'iot-test-tool';
        if (!requestPayload.header.from) {
          requestPayload.header.from = `/app/${appid}/subscribe`;
        }

        let success = false;
        let method = 'UNKNOWN';

        // 1. Try HTTP if enabled and IP is available
        if (configSnapshot.useHttp && configSnapshot.targetIp && onHttpRequest) {
          method = 'HTTP';
          try {
            await onHttpRequest(configSnapshot.targetIp, requestPayload);
            success = true;
          } catch (e) {
            console.warn(`[Stress] HTTP failed, trying MQTT if available...`, e);
          }
        }

        // 2. Try MQTT if HTTP failed or disabled
        if (!success && onMqttPublish) {
          method = 'MQTT';
          const topic = `/appliance/${configSnapshot.targetDevice}/subscribe`;
          await onMqttPublish(topic, JSON.stringify(requestPayload));
          success = true;
        }

        if (!success) {
          throw new Error('No available transport (HTTP/MQTT failed)');
        }

        const latency = Date.now() - startTime;
        latencies.push(latency);

        // Update task progress (success)
        setTasks(prev => prev.map(t => {
          if (t.id !== taskId) return t;
          return {
            ...t,
            progress: {
              ...t.progress,
              success: t.progress.success + 1,
              avgLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length
            },
            logs: [{
              time: new Date().toLocaleTimeString(),
              status: 'success',
              latency,
              message: `Round ${round} ${testNote} via ${method} [MsgId: ${messageId.substring(0, 8)}...]`,
              payload: JSON.stringify(requestPayload, null, 2)
            }, ...t.logs.slice(0, 49)]
          };
        }));

      } catch (err: any) {
        // Update task progress (failed)
        setTasks(prev => prev.map(t => {
          if (t.id !== taskId) return t;
          return {
            ...t,
            progress: { ...t.progress, failed: t.progress.failed + 1 },
            logs: [{
              time: new Date().toLocaleTimeString(),
              status: 'failed',
              message: err.message
            }, ...t.logs.slice(0, 49)]
          };
        }));
      }

      // Schedule next round
      if (!isStopped && round < configSnapshot.count) {
        const timer = setTimeout(runTest, configSnapshot.interval);
        taskControllers.current.set(taskId, { stop: () => { isStopped = true; clearTimeout(timer); } });
      } else if (round >= configSnapshot.count) {
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'COMPLETED' } : t));
        taskControllers.current.delete(taskId);
      }
    };

    // Start first round
    runTest();
    taskControllers.current.set(taskId, { stop: () => { isStopped = true; } });

  }, [stressConfig, session, devices, onMqttPublish, onHttpRequest, appid, templates]);

  // Serial Monitor Functions
  const refreshPorts = async () => {
    setLoadingPorts(true);
    try {
      // 添加人为延迟以便用户感知到刷新
      const [result] = await Promise.all([
        window.electronAPI?.serialListPorts(),
        new Promise(resolve => setTimeout(resolve, 500))
      ]);

      if (result?.success && result.ports) {
        setAvailablePorts(result.ports.map(p => ({
          path: p.path,
          manufacturer: p.manufacturer,
          friendlyName: p.friendlyName || p.path
        })));
        // 自动选择第一个端口
        if (result.ports.length > 0 && !serialPort) {
          setSerialPort(result.ports[0].path);
        }
      } else {
        console.error('[Serial] Failed to list ports:', result?.error);
        setAvailablePorts([]);
      }
    } catch (e) {
      console.error('[Serial] Error listing ports:', e);
      setAvailablePorts([]);
    } finally {
      setLoadingPorts(false);
    }
  };

  // 页面加载时刷新串口列表
  useEffect(() => {
    if (activeTab === 'SERIAL_MONITOR') {
      refreshPorts();
    }
  }, [activeTab]);

  // 设置串口数据监听
  useEffect(() => {
    const handleSerialData = (data: { line: string; timestamp: number; type?: string }) => {
      if (!serialPaused) {
        // 根据内容自动判断日志级别
        let level: SerialLog['level'] = 'INFO';
        const content = data.line;
        if (content.includes('[E]') || content.includes('ERROR') || content.includes('Error')) {
          level = 'ERROR';
        } else if (content.includes('[W]') || content.includes('WARN') || content.includes('Warning')) {
          level = 'WARN';
        } else if (content.includes('[D]') || content.includes('DEBUG') || content.includes('DBG')) {
          level = 'DEBUG';
        }

        const time = new Date(data.timestamp).toLocaleTimeString();
        setSerialLogs(prev => [...prev.slice(-999), { time, level, content }]);
      }
    };

    // 处理原始数据（不带换行符的实时数据）
    const handleSerialRawData = (data: { data: string; timestamp: number }) => {
      if (!serialPaused && data.data.trim()) {
        const time = new Date(data.timestamp).toLocaleTimeString();
        // 使用 'INFO' 级别显示原始数据，带特殊标记
        setSerialLogs(prev => [...prev.slice(-999), {
          time,
          level: 'INFO',
          content: data.data.trim()
        }]);
      }
    };

    const handleSerialError = (data: { error: string }) => {
      setSerialLogs(prev => [...prev.slice(-999), {
        time: new Date().toLocaleTimeString(),
        level: 'ERROR',
        content: `[SERIAL ERROR] ${data.error}`
      }]);
    };

    const handleSerialDisconnected = () => {
      setSerialConnected(false);
      setSerialLogs(prev => [...prev.slice(-999), {
        time: new Date().toLocaleTimeString(),
        level: 'WARN',
        content: '[SERIAL] Port disconnected'
      }]);
      onLog?.({ type: 'CUSTOM', direction: 'SYS', label: 'Serial Disconnected', detail: '' });
    };

    window.electronAPI?.onSerialData?.(handleSerialData);
    window.electronAPI?.onSerialRawData?.(handleSerialRawData);
    window.electronAPI?.onSerialError?.(handleSerialError);
    window.electronAPI?.onSerialDisconnected?.(handleSerialDisconnected);

    return () => {
      window.electronAPI?.removeSerialListeners?.();
    };
  }, [serialPaused, onLog]);

  const connectSerial = async () => {
    if (!serialPort) {
      alert('请先选择串口');
      return;
    }

    setSerialConnecting(true);
    try {
      const result = await window.electronAPI?.serialConnect({ path: serialPort, baudRate: serialBaudRate });
      if (result?.success) {
        setSerialConnected(true);
        setSerialLogs(prev => [...prev.slice(-999), {
          time: new Date().toLocaleTimeString(),
          level: 'INFO',
          content: `[SERIAL] Connected to ${serialPort} @ ${serialBaudRate} baud`
        }]);
        onLog?.({ type: 'CUSTOM', direction: 'SYS', label: 'Serial Connected', detail: `Port: ${serialPort}, Baud: ${serialBaudRate}` });
      } else {
        alert(`连接失败: ${result?.error || 'Unknown error'}`);
      }
    } catch (e: any) {
      alert(`连接失败: ${e.message}`);
    } finally {
      setSerialConnecting(false);
    }
  };

  const disconnectSerial = async () => {
    try {
      await window.electronAPI?.serialDisconnect();
      setSerialConnected(false);
      setSerialLogs(prev => [...prev.slice(-999), {
        time: new Date().toLocaleTimeString(),
        level: 'INFO',
        content: '[SERIAL] Disconnected'
      }]);
      onLog?.({ type: 'CUSTOM', direction: 'SYS', label: 'Serial Disconnected', detail: '' });
    } catch (e: any) {
      console.error('[Serial] Disconnect error:', e);
    }
  };

  const sendSerialCommand = async () => {
    if (!serialConnected) return;

    const cmd = serialInput; // 不 trim，保留原始输入

    // 根据行尾符设置构建发送数据
    let suffix = '';
    switch (lineEnding) {
      case 'LF': suffix = '\n'; break;
      case 'CRLF': suffix = '\r\n'; break;
      case 'CR': suffix = '\r'; break;
      case 'NONE': suffix = ''; break;
    }
    const dataToSend = cmd + suffix;

    // 如果是空输入且没有行尾符，则不发送
    if (!dataToSend) return;

    try {
      // 直接发送完整数据，不使用 addNewline
      const result = await window.electronAPI?.serialWrite({ data: dataToSend, addNewline: false });
      if (result?.success) {
        // 只有非空命令才添加到历史
        if (cmd.trim()) {
          setCommandHistory(prev => {
            const newHistory = [cmd.trim(), ...prev.filter(c => c !== cmd.trim()).slice(0, 49)];
            return newHistory;
          });
        }
        setHistoryIndex(-1);

        // 本地回显（如果开启）
        if (localEcho) {
          const displayCmd = cmd.trim() || '(空行)';
          setSerialLogs(prev => [...prev.slice(-999), {
            time: new Date().toLocaleTimeString(),
            level: 'TX',
            content: `>>> ${displayCmd}`
          }]);
        }

        setSerialInput('');
        serialInputRef.current?.focus();
      } else {
        // 发送失败也显示在日志中
        setSerialLogs(prev => [...prev.slice(-999), {
          time: new Date().toLocaleTimeString(),
          level: 'ERROR',
          content: `[TX FAILED] ${cmd} - ${result?.error || 'Unknown error'}`
        }]);
      }
    } catch (e: any) {
      setSerialLogs(prev => [...prev.slice(-999), {
        time: new Date().toLocaleTimeString(),
        level: 'ERROR',
        content: `[TX ERROR] ${cmd} - ${e.message}`
      }]);
    }
  };

  const handleSerialKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendSerialCommand();
    } else if (e.key === 'ArrowUp') {
      // 上一条历史命令
      e.preventDefault();
      if (commandHistory.length > 0) {
        const newIndex = Math.min(historyIndex + 1, commandHistory.length - 1);
        setHistoryIndex(newIndex);
        setSerialInput(commandHistory[newIndex]);
      }
    } else if (e.key === 'ArrowDown') {
      // 下一条历史命令
      e.preventDefault();
      if (historyIndex > 0) {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setSerialInput(commandHistory[newIndex]);
      } else if (historyIndex === 0) {
        setHistoryIndex(-1);
        setSerialInput('');
      }
    }
  };

  const clearSerialLogs = () => setSerialLogs([]);

  const exportSerialLogs = () => {
    const content = serialLogs.map(l => `[${l.time}] [${l.level}] ${l.content}`).join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `serial_logs_${Date.now()}.txt`;
    a.click();
  };

  // JSON 格式化函数 - 检测并格式化 JSON 内容
  const formatLogContent = (content: string): { isJson: boolean; formatted: string } => {
    // 尝试检测是否为 JSON
    const trimmed = content.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed);
        const formatted = JSON.stringify(parsed, null, 2);
        return { isJson: true, formatted };
      } catch {
        // 不是有效的 JSON，返回原始内容
      }
    }
    return { isJson: false, formatted: content };
  };

  const filteredSerialLogs = serialFilter
    ? serialLogs.filter(l => l.content.toLowerCase().includes(serialFilter.toLowerCase()) || l.level.includes(serialFilter.toUpperCase()))
    : serialLogs;

  const tabs = [
    { id: 'STRESS_TEST' as ToolTab, label: '压力测试', icon: Gauge, desc: 'Stress Test' },
    { id: 'MOCK_FORWARD' as ToolTab, label: 'Mock转发', icon: Cloud, desc: 'Mock Forward' },
    { id: 'SERIAL_MONITOR' as ToolTab, label: '串口监控', icon: Terminal, desc: 'Serial Monitor' },
    { id: 'QA_AUTO_TASK' as ToolTab, label: '自动化任务(QA)', icon: Play, desc: 'QA Automated Task Runner' },
  ];

  return (
    <div className="max-w-[1600px] mx-auto h-full flex flex-col gap-6 animate-in fade-in duration-500 overflow-hidden">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="bg-gradient-to-br from-orange-600 to-amber-600 p-4 rounded-2xl text-white shadow-lg">
            <Wrench size={28} />
          </div>
          <div>
            <h2 className="text-3xl font-black text-white uppercase tracking-tight">
              工具箱 <span className="text-orange-500 font-mono text-base ml-2">TOOLBOX</span>
            </h2>
            <p className="text-slate-500 text-xs font-black uppercase tracking-[0.2em] mt-1">
              压力测试 · Mock转发 · 串口监控
            </p>
          </div>
        </div>

        {/* Tab Switcher */}
        <div className="flex bg-slate-900/50 p-2 rounded-2xl border border-slate-800">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-5 py-3 rounded-xl flex items-center gap-2 transition-all ${activeTab === tab.id
                ? 'bg-orange-600 text-white shadow-lg'
                : 'text-slate-500 hover:text-slate-300'
                }`}
            >
              <tab.icon size={18} />
              <span className="text-sm font-black uppercase tracking-wide">{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 min-h-0 overflow-auto relative">
        {/* Stress Test Tab */}
        {activeTab === 'STRESS_TEST' && (
          <div className="grid grid-cols-12 gap-6 animate-in fade-in duration-300 min-h-full">
            {/* Config Panel - Scrollable Content */}
            <div className="col-span-4 bg-slate-900/40 border border-slate-800 rounded-[2rem] p-6">
              <h3 className="text-sm font-black text-slate-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                <Settings2 size={16} /> 测试配置
              </h3>

              <div className="space-y-5">
                {/* Target Device */}
                <div>
                  <label className="text-xs font-bold text-slate-500 uppercase mb-2 block">目标设备</label>
                  <select
                    value={stressConfig.targetDevice}
                    onChange={e => setStressConfig(prev => ({ ...prev, targetDevice: e.target.value }))}
                    className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-3 text-sm text-white outline-none focus:border-orange-500"
                  >
                    <option value="">选择设备...</option>
                    {devices.map(d => <option key={d.id} value={d.id}>{d.name} {d.ip ? `(${d.ip})` : ''}</option>)}
                  </select>
                  {stressConfig.targetDevice && (
                    <div className="mt-2 flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${stressConfig.targetIp ? 'bg-emerald-500' : 'bg-slate-600'}`} />
                      <span className="text-[10px] text-slate-500 font-mono">{stressConfig.targetIp || 'No IP detected'}</span>

                      <label className="ml-auto flex items-center gap-2 cursor-pointer border-r border-slate-700 pr-3">
                        <input
                          type="checkbox"
                          checked={stressConfig.mode === 'concurrent'}
                          onChange={e => setStressConfig(prev => ({ ...prev, mode: e.target.checked ? 'concurrent' : 'linear' }))}
                          className="accent-cyan-500"
                        />
                        <span className="text-[10px] font-bold text-slate-400 uppercase">并发执行</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={stressConfig.useHttp}
                          onChange={e => setStressConfig(prev => ({ ...prev, useHttp: e.target.checked }))}
                          className="accent-orange-500"
                        />
                        <span className="text-[10px] font-bold text-slate-400 uppercase">优先 HTTP</span>
                      </label>
                    </div>
                  )}
                </div>

                {/* Execution Parameters - Compact Inline */}
                <div className="flex items-center gap-4 bg-slate-800/30 rounded-xl px-4 py-3 border border-slate-700/50">
                  <div className="flex items-center gap-2 flex-1">
                    <Timer size={14} className="text-cyan-500 shrink-0" />
                    <span className="text-[10px] font-bold text-slate-500 uppercase whitespace-nowrap">间隔</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={stressConfig.interval}
                      onChange={e => {
                        const val = e.target.value.replace(/\D/g, '');
                        setStressConfig(prev => ({ ...prev, interval: parseInt(val) || 0 }));
                      }}
                      className="w-20 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-white text-center outline-none focus:border-cyan-500 transition-colors font-mono"
                    />
                    <span className="text-[10px] text-slate-500">ms</span>
                  </div>
                  <div className="w-px h-6 bg-slate-700" />
                  <div className="flex items-center gap-2 flex-1">
                    <RotateCcw size={14} className="text-violet-500 shrink-0" />
                    <span className="text-[10px] font-bold text-slate-500 uppercase whitespace-nowrap">次数</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={stressConfig.count}
                      onChange={e => {
                        const val = e.target.value.replace(/\D/g, '');
                        setStressConfig(prev => ({ ...prev, count: parseInt(val) || 0 }));
                      }}
                      className="w-20 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-white text-center outline-none focus:border-violet-500 transition-colors font-mono"
                    />
                    <span className="text-[10px] text-slate-500">次</span>
                  </div>
                </div>

                {/* Protocol Templates Section - Auto height, scrollable parent */}
                <div className="bg-slate-800/30 rounded-xl border border-slate-700/50 overflow-hidden">
                  {/* Header */}
                  <div className="px-4 py-3 border-b border-slate-700/50 flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-2">
                      <FileJson size={14} className="text-orange-500" />
                      <span className="text-xs font-bold text-slate-400 uppercase">协议模板</span>
                      {stressConfig.templateIds.length > 0 && (
                        <span className="text-[10px] text-orange-400 bg-orange-500/20 px-2 py-0.5 rounded-full">
                          已选 {stressConfig.templateIds.length} 个
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => {
                        setShowNameInput(!showNameInput);
                        setNewTemplateName('');
                        if (!showNameInput) {
                          setStressConfig(prev => ({
                            ...prev,
                            customPayload: JSON.stringify({
                              header: { namespace: 'Appliance.Control.ToggleX', method: 'SET' },
                              payload: { togglex: { channel: 0, onoff: 1 } }
                            }, null, 2)
                          }));
                        }
                      }}
                      className={`text-[10px] font-bold uppercase flex items-center gap-1.5 px-2 py-1 rounded-lg transition-all ${showNameInput
                        ? 'text-orange-400 bg-orange-500/20'
                        : 'text-slate-500 hover:text-orange-400 hover:bg-slate-700/50'
                        }`}
                    >
                      {showNameInput ? <XCircle size={12} /> : <Zap size={12} />}
                      {showNameInput ? '取消' : '新建模板'}
                    </button>
                  </div>

                  {/* Content Area - No internal scroll, let parent scroll */}
                  <div className="p-3">
                    {/* New Template Form - Enhanced */}
                    {showNameInput && (
                      <div className="mb-4 p-4 rounded-xl bg-slate-900/80 border border-orange-500/50 animate-in slide-in-from-top-2 duration-200">
                        {/* Header with Mode Toggle */}
                        <div className="flex items-center justify-between mb-4">
                          <div className="flex items-center gap-2">
                            <Zap size={16} className="text-orange-500" />
                            <span className="text-sm font-bold text-orange-400 uppercase">创建自定义模板</span>
                          </div>
                          <div className="flex bg-slate-800 rounded-lg p-0.5">
                            <button
                              onClick={() => setTemplateInputMode('keyvalue')}
                              className={`px-3 py-1 text-[10px] font-bold uppercase rounded-md transition-all ${templateInputMode === 'keyvalue'
                                ? 'bg-orange-600 text-white'
                                : 'text-slate-400 hover:text-white'
                                }`}
                            >
                              Key-Value
                            </button>
                            <button
                              onClick={() => setTemplateInputMode('json')}
                              className={`px-3 py-1 text-[10px] font-bold uppercase rounded-md transition-all ${templateInputMode === 'json'
                                ? 'bg-orange-600 text-white'
                                : 'text-slate-400 hover:text-white'
                                }`}
                            >
                              JSON
                            </button>
                          </div>
                        </div>

                        {/* Template Name */}
                        <input
                          type="text"
                          value={newTemplateName}
                          onChange={e => setNewTemplateName(e.target.value)}
                          placeholder="模板名称（如：开灯、设置温度等）"
                          className="w-full bg-slate-800 text-sm text-white px-3 py-2.5 rounded-lg outline-none border border-slate-700 focus:border-orange-500 mb-3"
                          autoFocus
                        />

                        {templateInputMode === 'keyvalue' ? (
                          /* Key-Value Mode */
                          <div className="space-y-3">
                            {/* Namespace & Method */}
                            <div className="grid grid-cols-3 gap-2">
                              <div className="col-span-2">
                                <label className="text-[10px] font-bold text-slate-500 uppercase mb-1 block">Namespace</label>
                                <input
                                  type="text"
                                  value={kvNamespace}
                                  onChange={e => setKvNamespace(e.target.value)}
                                  placeholder="Appliance.Control.ToggleX"
                                  className="w-full bg-slate-800 text-xs text-cyan-300 font-mono px-2 py-2 rounded-lg outline-none border border-slate-700 focus:border-cyan-500"
                                />
                              </div>
                              <div>
                                <label className="text-[10px] font-bold text-slate-500 uppercase mb-1 block">Method</label>
                                <select
                                  value={kvMethod}
                                  onChange={e => setKvMethod(e.target.value as 'GET' | 'SET')}
                                  className="w-full bg-slate-800 text-xs text-white px-2 py-2 rounded-lg outline-none border border-slate-700 focus:border-orange-500"
                                >
                                  <option value="SET">SET</option>
                                  <option value="GET">GET</option>
                                </select>
                              </div>
                            </div>

                            {/* Payload Entries */}
                            <div>
                              <label className="text-[10px] font-bold text-slate-500 uppercase mb-2 flex items-center justify-between">
                                <span>Payload 字段</span>
                                <span className="text-slate-600 font-normal normal-case">支持嵌套：parent.child.key</span>
                              </label>
                              <div className="space-y-2 max-h-40 overflow-y-auto custom-scrollbar pr-1">
                                {kvEntries.map((entry, idx) => (
                                  <div key={entry.id} className="flex items-center gap-2 group">
                                    <input
                                      type="text"
                                      value={entry.key}
                                      onChange={e => updateKvEntry(entry.id, 'key', e.target.value)}
                                      placeholder="key（如：togglex.onoff）"
                                      className="flex-1 bg-slate-800 text-xs text-violet-300 font-mono px-2 py-1.5 rounded-lg outline-none border border-slate-700 focus:border-violet-500"
                                    />
                                    <select
                                      value={entry.type}
                                      onChange={e => updateKvEntry(entry.id, 'type', e.target.value)}
                                      className="w-20 bg-slate-800 text-[10px] text-slate-400 px-1 py-1.5 rounded-lg outline-none border border-slate-700"
                                    >
                                      <option value="string">String</option>
                                      <option value="number">Number</option>
                                      <option value="boolean">Boolean</option>
                                      <option value="object">Object</option>
                                    </select>
                                    <input
                                      type="text"
                                      value={entry.value}
                                      onChange={e => updateKvEntry(entry.id, 'value', e.target.value)}
                                      placeholder={entry.type === 'boolean' ? 'true/false' : 'value'}
                                      className="w-24 bg-slate-800 text-xs text-emerald-300 font-mono px-2 py-1.5 rounded-lg outline-none border border-slate-700 focus:border-emerald-500"
                                    />
                                    <button
                                      onClick={() => removeKvEntry(entry.id)}
                                      className="p-1 text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </div>
                                ))}
                              </div>
                              <button
                                onClick={addKvEntry}
                                className="mt-2 w-full py-1.5 border border-dashed border-slate-600 text-slate-500 hover:border-orange-500 hover:text-orange-400 text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-1"
                              >
                                <Plus size={12} /> 添加字段
                              </button>
                            </div>

                            {/* Preview */}
                            <div>
                              <label className="text-[10px] font-bold text-slate-500 uppercase mb-1 block">JSON 预览</label>
                              <pre className="w-full h-20 bg-slate-950 border border-slate-700 rounded-lg p-2 text-[10px] text-orange-300/70 font-mono overflow-auto custom-scrollbar">
                                {kvToJson()}
                              </pre>
                            </div>
                          </div>
                        ) : (
                          /* JSON Mode */
                          <div>
                            <label className="text-[10px] font-bold text-slate-500 uppercase mb-1 block">JSON 报文</label>
                            <textarea
                              value={stressConfig.customPayload}
                              onChange={e => setStressConfig(prev => ({ ...prev, customPayload: e.target.value }))}
                              placeholder='{\n  "header": { "namespace": "...", "method": "SET" },\n  "payload": { ... }\n}'
                              className="w-full h-48 bg-slate-800 border border-slate-700 rounded-lg p-3 text-xs text-orange-300 font-mono outline-none focus:border-orange-500 resize-none leading-relaxed"
                            />
                          </div>
                        )}

                        {/* Actions */}
                        <div className="flex gap-2 mt-4">
                          <button
                            onClick={() => {
                              if (!newTemplateName) {
                                alert('请输入模板名称');
                                return;
                              }
                              try {
                                const jsonStr = templateInputMode === 'keyvalue' ? kvToJson() : stressConfig.customPayload;
                                JSON.parse(jsonStr); // Validate
                                addTemplate(newTemplateName, jsonStr);
                                setShowNameInput(false);
                                setNewTemplateName('');
                              } catch (e) {
                                alert('JSON 格式错误，请检查语法');
                              }
                            }}
                            className="flex-1 bg-orange-600 hover:bg-orange-500 text-white text-xs py-2.5 rounded-lg font-bold transition-colors flex items-center justify-center gap-1.5"
                          >
                            <CheckCircle size={14} />
                            保存模板
                          </button>
                          <button
                            onClick={() => {
                              setShowNameInput(false);
                              setNewTemplateName('');
                            }}
                            className="px-5 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs py-2.5 rounded-lg transition-colors"
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Preset Templates */}
                    <div className="mb-3">
                      <div className="text-[10px] font-bold text-slate-600 uppercase mb-2 flex items-center gap-1">
                        <List size={10} />
                        预设模板
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {templates.filter(t => !t.isCustom).map(t => {
                          const isSelected = stressConfig.templateIds.includes(t.id);
                          const index = stressConfig.templateIds.indexOf(t.id);
                          return (
                            <button
                              key={t.id}
                              onClick={() => toggleTemplate(t.id)}
                              className={`relative px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${isSelected
                                ? 'bg-orange-600 text-white shadow-lg shadow-orange-500/20'
                                : 'bg-slate-900 text-slate-400 hover:bg-slate-800 hover:text-slate-300 border border-slate-700'
                                }`}
                            >
                              {isSelected && (
                                <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-white text-orange-600 rounded-full text-[10px] flex items-center justify-center font-black shadow">
                                  {index + 1}
                                </span>
                              )}
                              {t.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Custom Templates */}
                    {templates.filter(t => t.isCustom).length > 0 && (
                      <div>
                        <div className="text-[10px] font-bold text-slate-600 uppercase mb-2 flex items-center gap-1">
                          <Zap size={10} />
                          自定义模板
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {templates.filter(t => t.isCustom).map(t => {
                            const isSelected = stressConfig.templateIds.includes(t.id);
                            const index = stressConfig.templateIds.indexOf(t.id);
                            return (
                              <div key={t.id} className="relative group">
                                <button
                                  onClick={() => toggleTemplate(t.id)}
                                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${isSelected
                                    ? 'bg-violet-600 text-white shadow-lg shadow-violet-500/20'
                                    : 'bg-slate-900 text-slate-400 hover:bg-slate-800 hover:text-slate-300 border border-slate-700'
                                    }`}
                                >
                                  {isSelected && (
                                    <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-white text-violet-600 rounded-full text-[10px] flex items-center justify-center font-black shadow">
                                      {index + 1}
                                    </span>
                                  )}
                                  {t.name}
                                </button>
                                <button
                                  onClick={(e) => deleteTemplate(t.id, e)}
                                  className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-lg z-10"
                                  title="删除模板"
                                >
                                  <XCircle size={10} />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Selected Template Preview */}
                    {stressConfig.templateIds.length > 0 && !showNameInput && (
                      <div className="mt-4 pt-3 border-t border-slate-700/50">
                        <div className="text-[10px] font-bold text-slate-600 uppercase mb-2 flex flex-col gap-1">
                          <div className="flex items-center justify-between">
                            <span className="flex items-center gap-1">
                              <Activity size={10} />
                              执行序列预览
                            </span>
                            <span className="text-slate-500 font-normal normal-case">
                              {stressConfig.count} 次 / 每次间隔 {stressConfig.interval}ms ({stressConfig.mode === 'concurrent' ? '并发执行' : '线性流转'})
                            </span>
                          </div>
                          <span className="text-slate-500 font-normal normal-case text-[9px]">
                            注：{stressConfig.mode === 'concurrent' ? '程序将在尽可能短的时间内同时发出去所有请求。' : '程序将根据设定次数进行线性排队发送，达到指定间隔后执行下一次发送。'}
                          </span>
                        </div>
                        <div className="flex flex-col gap-2">
                          <div className="flex items-center gap-1 flex-wrap mb-2">
                            {Array.from({ length: Math.min(stressConfig.count, 10) }).map((_, i) => {
                              const templateId = stressConfig.templateIds[i % stressConfig.templateIds.length];
                              const template = templates.find(t => t.id === templateId);
                              const isPreset = template && !template.isCustom;
                              return (
                                <div
                                  key={i}
                                  className={`px-2 py-0.5 rounded text-[9px] font-bold ${isPreset
                                    ? 'bg-orange-600/20 text-orange-400'
                                    : 'bg-violet-600/20 text-violet-400'
                                    }`}
                                >
                                  {i + 1}. {template?.name}
                                </div>
                              );
                            })}
                            {stressConfig.count > 10 && (
                              <span className="text-[10px] text-slate-500">...共 {stressConfig.count} 次</span>
                            )}
                          </div>
                          <div className="bg-slate-950/50 border border-slate-800 rounded-lg p-2 max-h-40 overflow-y-auto custom-scrollbar">
                            <div className="text-[9px] text-slate-500 mb-1">循环报文样例内容：</div>
                            {stressConfig.templateIds.map((tid, idx) => {
                              const temp = templates.find(t => t.id === tid);
                              if (!temp) return null;
                              return (
                                <div key={tid} className="mb-2 last:mb-0">
                                  <div className="text-[10px] font-mono text-cyan-400 mb-0.5">[{idx + 1}] {temp.namespace} ({temp.method})</div>
                                  <pre className="text-[9px] font-mono text-slate-300 ml-4 border-l-2 border-slate-700 pl-2">
                                    {JSON.stringify(temp.payload, null, 2)}
                                  </pre>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Control Buttons - Inside scroll area */}
                <div className="flex gap-3 pt-4">
                  <button
                    onClick={startStressTest}
                    className="flex-1 py-3.5 rounded-xl font-black text-sm uppercase tracking-wider flex items-center justify-center gap-2 transition-all bg-orange-600 hover:bg-orange-500 text-white shadow-lg shadow-orange-600/20"
                  >
                    <Play size={16} /> 开始测试
                  </button>
                </div>
              </div>
            </div>

            {/* Tasks List Panel */}
            <div className="col-span-8 flex flex-col gap-4">
              <div className="flex items-center justify-between shrink-0">
                <h3 className="text-sm font-black text-slate-400 uppercase tracking-wider flex items-center gap-2">
                  <Activity size={16} /> 活跃任务 ({tasks.length})
                </h3>
                {tasks.length > 0 && (
                  <button onClick={() => setTasks([])} className="text-xs text-slate-500 hover:text-red-400 flex items-center gap-1">
                    <Trash2 size={12} /> 清空列表
                  </button>
                )}
              </div>

              <div className="space-y-4">
                {tasks.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-64 border-2 border-dashed border-slate-800 rounded-[2rem] text-slate-600">
                    <Activity size={48} className="mb-4 opacity-20" />
                    <p className="text-sm font-bold">暂无运行中的任务</p>
                    <p className="text-xs mt-1">在左侧配置并启动压测任务</p>
                  </div>
                ) : (
                  tasks.map(task => (
                    <div key={task.id} className="bg-slate-900/40 border border-slate-800 rounded-2xl p-5 animate-in slide-in-from-right-4">
                      {/* Task Header */}
                      <div className="flex items-start justify-between mb-4">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <h4 className="text-lg font-black text-white">{task.deviceName}</h4>
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${task.status === 'RUNNING' ? 'bg-emerald-500/10 text-emerald-400 animate-pulse' :
                              task.status === 'COMPLETED' ? 'bg-slate-700 text-slate-300' :
                                'bg-red-500/10 text-red-400'
                              }`}>
                              {task.status}
                            </span>
                          </div>
                          <p className="text-xs text-slate-500 font-mono">ID: {task.id.split('_')[2]} · Interval: {task.config.interval}ms · Count: {task.config.count}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          {task.status === 'RUNNING' && (
                            <button
                              onClick={() => stopStressTest(task.id)}
                              className="p-2 bg-red-600/10 hover:bg-red-600 text-red-500 hover:text-white rounded-lg transition-colors"
                              title="停止任务"
                            >
                              <Square size={16} />
                            </button>
                          )}
                          {task.status !== 'RUNNING' && (
                            <button
                              onClick={() => setTasks(prev => prev.filter(t => t.id !== task.id))}
                              className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white rounded-lg transition-colors"
                              title="移除任务"
                            >
                              <XCircle size={16} />
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Progress Bar */}
                      <div className="mb-4">
                        <div className="flex justify-between text-xs text-slate-500 mb-1">
                          <span>进度: {task.progress.current} / {task.progress.total}</span>
                          <span>{((task.progress.current / task.progress.total) * 100).toFixed(0)}%</span>
                        </div>
                        <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full transition-all duration-300 ${task.status === 'RUNNING' ? 'bg-orange-500' : 'bg-slate-500'}`}
                            style={{ width: `${(task.progress.current / task.progress.total) * 100}%` }}
                          />
                        </div>
                      </div>

                      {/* Stats Grid */}
                      <div className="grid grid-cols-3 gap-3 mb-4">
                        <div className="bg-slate-950/50 rounded-xl p-3 flex items-center gap-3">
                          <CheckCircle size={16} className="text-emerald-500" />
                          <div>
                            <div className="text-[10px] text-slate-500 uppercase font-bold">Success</div>
                            <div className="text-lg font-black text-emerald-400">{task.progress.success}</div>
                          </div>
                        </div>
                        <div className="bg-slate-950/50 rounded-xl p-3 flex items-center gap-3">
                          <XCircle size={16} className="text-red-500" />
                          <div>
                            <div className="text-[10px] text-slate-500 uppercase font-bold">Failed</div>
                            <div className="text-lg font-black text-red-400">{task.progress.failed}</div>
                          </div>
                        </div>
                        <div className="bg-slate-950/50 rounded-xl p-3 flex items-center gap-3">
                          <Timer size={16} className="text-amber-500" />
                          <div>
                            <div className="text-[10px] text-slate-500 uppercase font-bold">Avg Latency</div>
                            <div className="text-lg font-black text-amber-400">{task.progress.avgLatency.toFixed(0)}ms</div>
                          </div>
                        </div>
                      </div>

                      {/* Latest Log */}
                      <div className="bg-slate-950 rounded-xl p-3 font-mono text-xs text-slate-400 max-h-64 overflow-y-auto custom-scrollbar">
                        {task.logs.slice(0, 10).map((log, i) => (
                          <div key={i} className="mb-2 last:mb-0 border-b border-slate-800/50 pb-2 last:border-0 last:pb-0">
                            <div className="flex gap-2 items-start">
                              <span className="text-slate-600 flex-shrink-0">[{log.time}]</span>
                              <span className={`flex-shrink-0 ${log.status === 'success' ? 'text-emerald-500' : log.status === 'failed' ? 'text-red-500' : 'text-amber-500'}`}>
                                {log.status === 'success' ? '✓' : log.status === 'failed' ? '✗' : '●'}
                              </span>
                              <span className="break-all">{log.message}</span>
                            </div>
                            {log.payload && (
                              <details className="mt-1 ml-[4.5rem]">
                                <summary className="text-[9px] text-slate-500 cursor-pointer hover:text-slate-300 transition-colors select-none">
                                  查看实际发送报文 (Click to expand)
                                </summary>
                                <pre className="mt-1 bg-slate-900 border border-slate-800 rounded p-2 text-[10px] text-indigo-300 overflow-x-auto">
                                  {log.payload}
                                </pre>
                              </details>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* Mock Forward Tab */}
        {activeTab === 'MOCK_FORWARD' && (
          <div className="grid grid-cols-12 gap-6 h-full animate-in fade-in duration-300">
            {/* Add New Mock */}
            <div className="col-span-4 bg-slate-900/40 border border-slate-800 rounded-[2rem] p-6 flex flex-col">
              <h3 className="text-sm font-black text-slate-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                <Send size={16} /> 添加 Mock 消息
              </h3>

              <div className="space-y-4 flex-1">
                <div>
                  <label className="text-xs font-bold text-slate-500 uppercase mb-2 block">Topic</label>
                  <input
                    value={newMockTopic}
                    onChange={e => setNewMockTopic(e.target.value)}
                    placeholder="/appliance/{uuid}/subscribe"
                    className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-3 text-sm text-white outline-none focus:border-orange-500 placeholder:text-slate-600"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-slate-500 uppercase mb-2 block">Payload (JSON)</label>
                  <textarea
                    value={newMockPayload}
                    onChange={e => setNewMockPayload(e.target.value)}
                    placeholder='{"header": {...}, "payload": {...}}'
                    className="w-full h-40 bg-slate-900 border border-slate-800 rounded-xl p-3 text-xs text-orange-300 font-mono outline-none focus:border-orange-500 resize-none placeholder:text-slate-700"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-slate-500 uppercase mb-2 block">自动发送间隔 (ms)</label>
                  <input
                    type="number"
                    value={newMockInterval}
                    onChange={e => setNewMockInterval(Number(e.target.value))}
                    className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-3 text-sm text-white outline-none focus:border-orange-500 placeholder:text-slate-600"
                  />
                </div>
              </div>

              <button
                onClick={addMockMessage}
                disabled={!newMockTopic.trim()}
                className="w-full py-3.5 bg-orange-600 hover:bg-orange-500 disabled:bg-slate-800 disabled:text-slate-600 text-white rounded-xl font-black text-sm uppercase tracking-wider mt-4 flex items-center justify-center gap-2 transition-all"
              >
                <Send size={16} /> 添加消息
              </button>
            </div>

            {/* Mock Messages List */}
            <div className="col-span-8 bg-slate-900/40 border border-slate-800 rounded-[2rem] p-6 flex flex-col min-h-0">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-sm font-black text-slate-400 uppercase tracking-wider flex items-center gap-2">
                  <Cloud size={16} /> Mock 消息列表
                </h3>
                <div className="flex items-center gap-2">
                  <div className={`w-2.5 h-2.5 rounded-full ${mqttConnected ? 'bg-emerald-500' : 'bg-red-500'}`} />
                  <span className="text-xs text-slate-500">{mqttConnected ? 'MQTT Connected' : 'MQTT Disconnected'}</span>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto custom-scrollbar space-y-3">
                {mockMessages.map(msg => (
                  <div key={msg.id} className={`bg-slate-900/50 border ${msg.enabled ? 'border-orange-500/50' : 'border-slate-800'} rounded-xl p-4 transition-all`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <button
                          onClick={() => toggleMockMessage(msg.id)}
                          className={`w-10 h-5 rounded-full relative transition-colors ${msg.enabled ? 'bg-orange-500' : 'bg-slate-700'}`}
                        >
                          <div className={`absolute top-1 w-3 h-3 rounded-full bg-white transition-transform ${msg.enabled ? 'left-6' : 'left-1'}`} />
                        </button>
                        <div className="flex flex-col min-w-0">
                          <code className="text-sm text-orange-400 font-mono truncate">{msg.topic}</code>
                          <span className="text-[10px] text-slate-500 font-mono">Interval: {msg.interval}ms {msg.enabled ? '(Running)' : '(Stopped)'}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 ml-4">
                        <button
                          onClick={() => sendMockMessage(msg)}
                          className="p-2 bg-orange-600/20 hover:bg-orange-600 text-orange-400 hover:text-white rounded-lg transition-all"
                          title="Send once"
                        >
                          <Send size={14} />
                        </button>
                        <button
                          onClick={() => navigator.clipboard.writeText(msg.payload)}
                          className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-lg transition-all"
                          title="Copy payload"
                        >
                          <Copy size={14} />
                        </button>
                        <button
                          onClick={() => deleteMockMessage(msg.id)}
                          className="p-2 bg-red-500/20 hover:bg-red-600 text-red-400 hover:text-white rounded-lg transition-all"
                          title="Delete"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                    <pre className="text-xs text-slate-500 font-mono bg-slate-950/50 rounded-lg p-3 overflow-x-auto max-h-24">
                      {msg.payload}
                    </pre>
                  </div>
                ))}
                {mockMessages.length === 0 && (
                  <div className="text-center text-slate-600 py-12 text-sm">暂无 Mock 消息，请在左侧添加</div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Serial Monitor Tab */}
        {activeTab === 'SERIAL_MONITOR' && (
          <div className="flex-1 flex flex-col gap-2 animate-in fade-in duration-300 overflow-hidden">
            {/* Controls - Auto Height */}
            <div className="shrink-0 bg-slate-900/40 border border-slate-800 rounded-xl p-2 flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <Cable size={16} className="text-slate-500" />
                <select
                  value={serialPort}
                  onChange={e => setSerialPort(e.target.value)}
                  disabled={serialConnected || loadingPorts}
                  className="w-56 bg-slate-900 border border-slate-800 rounded-lg px-2 py-1.5 text-sm text-white outline-none focus:border-orange-500 disabled:opacity-50"
                >
                  <option value="">选择串口...</option>
                  {availablePorts.map(p => (
                    <option key={p.path} value={p.path}>
                      {p.friendlyName || p.path}
                    </option>
                  ))}
                </select>
                <button
                  onClick={refreshPorts}
                  disabled={serialConnected || loadingPorts}
                  className="p-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-400 rounded-lg transition-all"
                  title="刷新端口列表"
                >
                  <RefreshCw size={14} className={loadingPorts ? 'animate-spin' : ''} />
                </button>
              </div>

              <select
                value={serialBaudRate}
                onChange={e => setSerialBaudRate(parseInt(e.target.value))}
                disabled={serialConnected}
                className="bg-slate-900 border border-slate-800 rounded-lg px-2 py-1.5 text-sm text-white outline-none focus:border-orange-500 disabled:opacity-50"
              >
                {[9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map(rate => (
                  <option key={rate} value={rate}>{rate} baud</option>
                ))}
              </select>

              <button
                onClick={serialConnected ? disconnectSerial : connectSerial}
                disabled={serialConnecting || (!serialConnected && !serialPort)}
                className={`px-4 py-1.5 rounded-lg font-bold text-sm uppercase transition-all flex items-center gap-2 disabled:opacity-50 ${serialConnected
                  ? 'bg-red-600 hover:bg-red-500 text-white'
                  : 'bg-orange-600 hover:bg-orange-500 text-white'
                  }`}
              >
                {serialConnecting ? (
                  <><Loader2 size={14} className="animate-spin" /> 连接中</>
                ) : serialConnected ? (
                  <><Square size={14} /> 断开</>
                ) : (
                  <><Play size={14} /> 连接</>
                )}
              </button>

              <div className="flex items-center gap-1">
                <div className={`w-2 h-2 rounded-full ${serialConnected ? 'bg-emerald-500 animate-pulse' : 'bg-slate-600'}`} />
                <span className="text-xs text-slate-500">{serialConnected ? '已连接' : '未连接'}</span>
              </div>

              <div className="flex-1" />

              <input
                value={serialFilter}
                onChange={e => setSerialFilter(e.target.value)}
                placeholder="过滤..."
                className="w-32 bg-slate-900 border border-slate-800 rounded-lg px-2 py-1.5 text-sm text-white outline-none focus:border-orange-500"
              />

              <button
                onClick={() => setSerialPaused(!serialPaused)}
                className={`p-2 rounded-lg transition-all ${serialPaused ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}
                title={serialPaused ? 'Resume' : 'Pause'}
              >
                {serialPaused ? <Play size={14} /> : <Pause size={14} />}
              </button>

              <button onClick={clearSerialLogs} className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-lg" title="Clear">
                <Trash2 size={14} />
              </button>

              <button onClick={exportSerialLogs} className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-lg" title="Export">
                <Download size={14} />
              </button>
            </div>

            {/* Logs Wrapper - Flex 1 to take remaining space */}
            <div className="flex-1 min-h-0 relative bg-slate-950 border border-slate-800 rounded-xl overflow-hidden">
              {/* Scrollable Content - Absolute fill */}
              <div
                ref={serialLogsRef}
                className="absolute inset-0 overflow-y-auto custom-scrollbar p-2 font-mono text-xs select-text cursor-text"
              >
                {filteredSerialLogs.map((log, i) => {
                  const { isJson, formatted } = formatLogContent(log.content);
                  return (
                    <div key={i} className={`flex gap-2 hover:bg-slate-900/50 px-1 py-0.5 rounded ${log.level === 'TX' ? 'bg-indigo-900/20' : ''}`}>
                      <span className="text-slate-600 shrink-0 select-text self-start">[{log.time}]</span>
                      <span className={`shrink-0 w-12 font-bold select-text self-start ${log.level === 'ERROR' ? 'text-red-500' :
                        log.level === 'WARN' ? 'text-amber-500' :
                          log.level === 'DEBUG' ? 'text-purple-500' :
                            log.level === 'TX' ? 'text-indigo-400' : 'text-slate-500'
                        }`}>[{log.level}]</span>
                      <pre className={`select-text whitespace-pre-wrap break-all m-0 font-mono ${isJson
                        ? (log.level === 'TX' ? 'text-indigo-300' : 'text-emerald-400')
                        : (log.level === 'TX' ? 'text-indigo-300' : 'text-slate-300')
                        }`}>
                        {formatted}
                      </pre>
                    </div>
                  );
                })}
                {filteredSerialLogs.length === 0 && (
                  <div className="text-center text-slate-600 py-8 text-sm">
                    {serialConnected ? '等待数据...' : availablePorts.length === 0 ? '未检测到串口设备' : '请先选择串口并连接'}
                  </div>
                )}
                <div ref={scrollBottomRef} />
              </div>
            </div>

            {/* Input Area - Auto Height */}
            <div className="shrink-0 bg-slate-900/40 border border-slate-800 rounded-xl p-2 flex items-center gap-2">
              <Terminal size={14} className="text-slate-500 shrink-0" />
              <input
                ref={serialInputRef}
                value={serialInput}
                onChange={e => setSerialInput(e.target.value)}
                onKeyDown={handleSerialKeyDown}
                disabled={!serialConnected}
                placeholder={serialConnected ? '输入命令 (Enter发送)' : '请先连接串口'}
                className="flex-1 bg-slate-900 border border-slate-800 rounded-lg px-2 py-1.5 text-sm text-white font-mono outline-none focus:border-orange-500 disabled:opacity-50 placeholder:text-slate-600"
              />

              <label className="flex items-center gap-1 cursor-pointer select-none">
                <input type="checkbox" checked={localEcho} onChange={e => setLocalEcho(e.target.checked)} className="accent-indigo-500 w-3 h-3" />
                <span className="text-xs text-slate-400">回显</span>
              </label>

              <select
                value={lineEnding}
                onChange={e => setLineEnding(e.target.value as 'LF' | 'CRLF' | 'CR' | 'NONE')}
                className="bg-slate-900 border border-slate-800 rounded-lg px-1 py-1 text-xs text-slate-400 outline-none"
              >
                <option value="LF">LF</option>
                <option value="CRLF">CRLF</option>
                <option value="CR">CR</option>
                <option value="NONE">None</option>
              </select>

              <button
                onClick={sendSerialCommand}
                disabled={!serialConnected}
                className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 text-white rounded-lg font-bold text-xs uppercase transition-all flex items-center gap-1"
              >
                <Send size={12} />
                发送
              </button>
            </div>
          </div>
        )}

        {/* QA Auto Task Runner Tab */}
        {activeTab === 'QA_AUTO_TASK' && (
          <div className="h-full animate-in fade-in duration-300">
            <QAAutoTaskRunner
              onLog={onLog}
              devices={devices}
              mqttConnected={mqttConnected}
              onMqttPublish={onMqttPublish}
              onHttpRequest={onHttpRequest}
              session={session}
              appid={appid}
              qaServerUrl={qaServerUrl}
              qaUser={qaUser}
              qaToken={qaToken}
            />
          </div>
        )}
      </div>
    </div>
  );
};
