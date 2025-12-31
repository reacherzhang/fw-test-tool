
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Wrench, Play, Square, Settings2, Zap, Terminal, Send, RefreshCw,
  Activity, Clock, CheckCircle, XCircle, Loader2, Trash2, Download,
  Cable, Radio, ArrowUpDown, AlertTriangle, Gauge, Timer, RotateCcw,
  Upload, Cloud, CloudOff, FileJson, Copy, Pause, List
} from 'lucide-react';
import { md5 } from './AuthScreen';
import { GlobalLogEntry, CloudSession } from '../types';

interface ToolboxProps {
  onLog?: (log: Omit<GlobalLogEntry, 'id' | 'timestamp'>) => void;
  mqttConnected?: boolean;
  devices?: { id: string; name: string; ip?: string }[];
  onMqttPublish?: (topic: string, message: string) => Promise<any>;
  onHttpRequest?: (ip: string, payload: any) => Promise<any>;
  appid?: string;
  session?: CloudSession | null;
}

// 预设协议模板
const PROTOCOL_TEMPLATES = [
  { id: 'toggle_on', name: '开机', namespace: 'Appliance.Control.ToggleX', method: 'SET', payload: { togglex: { channel: 0, onoff: 1 } } },
  { id: 'toggle_off', name: '关机', namespace: 'Appliance.Control.ToggleX', method: 'SET', payload: { togglex: { channel: 0, onoff: 0 } } },
  { id: 'system_all', name: '系统信息', namespace: 'Appliance.System.All', method: 'GET', payload: {} },
  { id: 'system_online', name: '在线状态', namespace: 'Appliance.System.Online', method: 'GET', payload: {} },
  { id: 'upgrade_check', name: '检查升级', namespace: 'Appliance.System.Firmware', method: 'GET', payload: {} },
];

type ToolTab = 'STRESS_TEST' | 'MOCK_FORWARD' | 'SERIAL_MONITOR';

interface StressTestConfig {
  type: 'TOGGLE' | 'UPGRADE' | 'CUSTOM';
  targetDevice: string;
  targetIp: string;
  interval: number; // ms
  count: number;
  templateIds: string[]; // Changed to array
  customPayload: string;
  useHttp: boolean; // 优先使用 HTTP
}

interface StressTestResult {
  total: number;
  success: number;
  failed: number;
  avgLatency: number;
  running: boolean;
  currentRound: number;
  logs: { time: string; status: 'success' | 'failed' | 'pending'; latency?: number; message?: string }[];
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

export const ProtocolLab: React.FC<ToolboxProps> = ({ onLog, mqttConnected, devices = [], onMqttPublish, onHttpRequest, appid = 'iot-test-tool', session }) => {
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
    useHttp: true
  });
  const [stressResult, setStressResult] = useState<StressTestResult>({
    total: 0, success: 0, failed: 0, avgLatency: 0, running: false, currentRound: 0, logs: []
  });
  const stressIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Mock Forward State
  const [mockMessages, setMockMessages] = useState<MockMessage[]>([
    { id: '1', topic: '/appliance/{uuid}/subscribe', payload: '{"header":{"namespace":"Appliance.System.All","method":"GETACK"}}', enabled: false }
  ]);
  const [newMockTopic, setNewMockTopic] = useState('');
  const [newMockPayload, setNewMockPayload] = useState('{}');

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
    const template = PROTOCOL_TEMPLATES.find(t => t.id === templateId);
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
  const startStressTest = useCallback(() => {
    if (stressResult.running) return;
    if (!stressConfig.targetDevice) {
      alert('请先选择目标设备');
      return;
    }
    if (!session) {
      alert('缺少会话信息，无法计算签名');
      return;
    }

    setStressResult({
      total: stressConfig.count,
      success: 0,
      failed: 0,
      avgLatency: 0,
      running: true,
      currentRound: 0,
      logs: []
    });

    let round = 0;
    const latencies: number[] = [];

    const runTest = async () => {
      if (round >= stressConfig.count) {
        stopStressTest();
        return;
      }

      round++;
      const startTime = Date.now();

      setStressResult(prev => ({
        ...prev,
        currentRound: round,
        logs: [{ time: new Date().toLocaleTimeString(), status: 'pending', message: `Round ${round} started...` }, ...prev.logs.slice(0, 99)]
      }));

      try {
        // Prepare Payload
        let requestPayload: any;

        // Determine which template to use for this round
        const useTemplates = stressConfig.templateIds.length > 0;

        if (useTemplates) {
          const templateId = stressConfig.templateIds[(round - 1) % stressConfig.templateIds.length];
          const template = PROTOCOL_TEMPLATES.find(t => t.id === templateId);
          if (!template) throw new Error(`Template ${templateId} not found`);

          requestPayload = {
            header: {
              namespace: template.namespace,
              method: template.method,
              // Dynamic fields will be injected below
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
            requestPayload = JSON.parse(stressConfig.customPayload);
          } catch (e) {
            throw new Error('Invalid JSON Payload');
          }
        }

        // Inject dynamic fields & Sign
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

        // 1. Try HTTP if enabled and IP is available
        if (stressConfig.useHttp && stressConfig.targetIp && onHttpRequest) {
          method = 'HTTP';
          try {
            await onHttpRequest(stressConfig.targetIp, requestPayload);
            success = true;
          } catch (e) {
            console.warn(`[Stress] HTTP failed, trying MQTT if available...`, e);
            // Fallback to MQTT will happen if success is still false
          }
        }

        // 2. Try MQTT if HTTP failed or disabled
        if (!success && onMqttPublish) {
          method = 'MQTT';
          const topic = `/appliance/${stressConfig.targetDevice}/subscribe`;
          await onMqttPublish(topic, JSON.stringify(requestPayload));
          success = true; // Assuming publish success means message sent
        }

        if (!success) {
          throw new Error('No available transport (HTTP/MQTT failed)');
        }

        const latency = Date.now() - startTime;
        latencies.push(latency);

        setStressResult(prev => ({
          ...prev,
          success: prev.success + 1,
          avgLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length,
          logs: [{
            time: new Date().toLocaleTimeString(),
            status: 'success',
            latency,
            message: `Round ${round} completed via ${method}`
          }, ...prev.logs.slice(0, 99)]
        }));

        onLog?.({
          type: 'CUSTOM',
          direction: 'TX',
          label: `Stress Test Round ${round}`,
          detail: `Method: ${method}\nLatency: ${latency}ms`
        });
      } catch (error: any) {
        setStressResult(prev => ({
          ...prev,
          failed: prev.failed + 1,
          logs: [{ time: new Date().toLocaleTimeString(), status: 'failed', message: `Round ${round} failed: ${error.message}` }, ...prev.logs.slice(0, 99)]
        }));
      }
    };

    stressIntervalRef.current = setInterval(runTest, stressConfig.interval);
    runTest();
  }, [stressConfig, stressResult.running, onLog, onHttpRequest, onMqttPublish, devices, appid]);

  const stopStressTest = useCallback(() => {
    if (stressIntervalRef.current) {
      clearInterval(stressIntervalRef.current);
      stressIntervalRef.current = null;
    }
    setStressResult(prev => ({ ...prev, running: false }));
  }, []);

  // Mock Forward Functions
  const addMockMessage = () => {
    if (!newMockTopic.trim()) return;
    setMockMessages(prev => [...prev, {
      id: Date.now().toString(),
      topic: newMockTopic,
      payload: newMockPayload,
      enabled: false
    }]);
    setNewMockTopic('');
    setNewMockPayload('{}');
  };

  const toggleMockMessage = (id: string) => {
    setMockMessages(prev => prev.map(m => m.id === id ? { ...m, enabled: !m.enabled } : m));
  };

  const deleteMockMessage = (id: string) => {
    setMockMessages(prev => prev.filter(m => m.id !== id));
  };

  const sendMockMessage = async (msg: MockMessage) => {
    onLog?.({
      type: 'CUSTOM',
      direction: 'TX',
      label: `Mock -> ${msg.topic}`,
      detail: msg.payload
    });
    // In real implementation, call onMqttPublish
  };

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

      {/* Content Area - 必须是 flex flex-col 才能将高度传递给子元素 */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col relative">
        {/* Stress Test Tab */}
        {activeTab === 'STRESS_TEST' && (
          <div className="grid grid-cols-12 gap-6 h-full animate-in fade-in duration-300">
            {/* Config Panel - Fixed Height Layout */}
            <div className="col-span-4 bg-slate-900/40 border border-slate-800 rounded-[2rem] p-6 flex flex-col h-full">
              <h3 className="text-sm font-black text-slate-400 uppercase tracking-wider mb-4 flex items-center gap-2 shrink-0">
                <Settings2 size={16} /> 测试配置
              </h3>

              <div className="flex-1 overflow-y-auto custom-scrollbar space-y-5 pr-2">
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

                      <label className="ml-auto flex items-center gap-2 cursor-pointer">
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

                {/* Protocol Template */}
                <div>
                  <label className="text-xs font-bold text-slate-500 uppercase mb-2 block">协议模板 (可多选)</label>
                  <div className="grid grid-cols-2 gap-2">
                    {PROTOCOL_TEMPLATES.map(t => {
                      const isSelected = stressConfig.templateIds.includes(t.id);
                      const index = stressConfig.templateIds.indexOf(t.id);
                      return (
                        <button
                          key={t.id}
                          onClick={() => toggleTemplate(t.id)}
                          className={`p-2 rounded-lg border text-left transition-all relative ${isSelected
                            ? 'bg-orange-600/20 border-orange-500 text-orange-300'
                            : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-600'
                            }`}
                        >
                          {isSelected && (
                            <div className="absolute top-1 right-1 w-4 h-4 bg-orange-500 rounded-full text-[10px] text-white flex items-center justify-center font-bold">
                              {index + 1}
                            </div>
                          )}
                          <div className="text-[10px] font-bold uppercase mb-0.5">{t.name}</div>
                          <div className="text-[9px] font-mono opacity-50 truncate">{t.namespace}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Interval & Count */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-bold text-slate-500 uppercase mb-2 block">间隔 (ms)</label>
                    <input
                      type="number"
                      value={stressConfig.interval}
                      onChange={e => setStressConfig(prev => ({ ...prev, interval: parseInt(e.target.value) || 1000 }))}
                      className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-3 text-sm text-white outline-none focus:border-orange-500"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-500 uppercase mb-2 block">次数</label>
                    <input
                      type="number"
                      value={stressConfig.count}
                      onChange={e => setStressConfig(prev => ({ ...prev, count: parseInt(e.target.value) || 10 }))}
                      className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-3 text-sm text-white outline-none focus:border-orange-500"
                    />
                  </div>
                </div>

                {/* Custom Payload */}
                <div className="flex-1 flex flex-col min-h-0">
                  <label className="text-xs font-bold text-slate-500 uppercase mb-2 block flex justify-between">
                    <span>请求报文 (Payload)</span>
                    <span className="text-[10px] text-slate-600">JSON Format</span>
                  </label>
                  <textarea
                    value={stressConfig.customPayload}
                    onChange={e => setStressConfig(prev => ({ ...prev, customPayload: e.target.value }))}
                    className="w-full h-40 bg-slate-900 border border-slate-800 rounded-xl p-3 text-xs text-orange-300 font-mono outline-none focus:border-orange-500 resize-none leading-relaxed"
                  />
                </div>
              </div>

              {/* Control Buttons - Fixed at bottom */}
              <div className="flex gap-3 mt-4 shrink-0 pt-4 border-t border-slate-800/50">
                <button
                  onClick={stressResult.running ? stopStressTest : startStressTest}
                  className={`flex-1 py-3.5 rounded-xl font-black text-sm uppercase tracking-wider flex items-center justify-center gap-2 transition-all ${stressResult.running
                    ? 'bg-red-600 hover:bg-red-500 text-white'
                    : 'bg-orange-600 hover:bg-orange-500 text-white shadow-lg shadow-orange-600/20'
                    }`}
                >
                  {stressResult.running ? <><Square size={16} /> 停止</> : <><Play size={16} /> 开始测试</>}
                </button>
                <button
                  onClick={() => setStressResult({ total: 0, success: 0, failed: 0, avgLatency: 0, running: false, currentRound: 0, logs: [] })}
                  className="px-4 py-3.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-xl transition-all"
                >
                  <RotateCcw size={18} />
                </button>
              </div>
            </div>

            {/* Results Panel */}
            <div className="col-span-8 flex flex-col gap-4">
              {/* Stats Cards */}
              <div className="grid grid-cols-4 gap-3">
                {[
                  { label: '总计', value: stressResult.total, icon: Activity, color: 'slate' },
                  { label: '成功', value: stressResult.success, icon: CheckCircle, color: 'emerald' },
                  { label: '失败', value: stressResult.failed, icon: XCircle, color: 'red' },
                  { label: '平均延迟', value: `${stressResult.avgLatency.toFixed(0)}ms`, icon: Timer, color: 'amber' },
                ].map((stat, i) => (
                  <div key={i} className={`bg-slate-900/40 border border-slate-800 rounded-xl p-4 flex items-center gap-3`}>
                    <div className={`p-2.5 bg-${stat.color}-500/10 rounded-lg text-${stat.color}-500`}>
                      <stat.icon size={20} />
                    </div>
                    <div>
                      <p className="text-xs font-bold text-slate-500 uppercase">{stat.label}</p>
                      <p className={`text-2xl font-black text-${stat.color}-400`}>{stat.value}</p>
                    </div>
                  </div>
                ))}
              </div>

              {/* Progress & Logs */}
              <div className="flex-1 bg-slate-900/40 border border-slate-800 rounded-[2rem] p-6 flex flex-col min-h-0">
                {/* Progress Bar */}
                {stressResult.running && (
                  <div className="mb-4">
                    <div className="flex justify-between text-xs text-slate-500 mb-1">
                      <span>进度: {stressResult.currentRound} / {stressResult.total}</span>
                      <span>{((stressResult.currentRound / stressResult.total) * 100).toFixed(0)}%</span>
                    </div>
                    <div className="h-2.5 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-orange-500 transition-all duration-300"
                        style={{ width: `${(stressResult.currentRound / stressResult.total) * 100}%` }}
                      />
                    </div>
                  </div>
                )}

                <h3 className="text-sm font-black text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                  <Terminal size={16} /> 测试日志
                </h3>
                <div className="flex-1 overflow-y-auto custom-scrollbar space-y-1.5 font-mono text-xs">
                  {stressResult.logs.map((log, i) => (
                    <div key={i} className="flex items-center gap-3 animate-in slide-in-from-left-2">
                      <span className="text-slate-600 shrink-0">[{log.time}]</span>
                      <span className={`shrink-0 ${log.status === 'success' ? 'text-emerald-500' :
                        log.status === 'failed' ? 'text-red-500' : 'text-amber-500'
                        }`}>
                        {log.status === 'success' ? '✓' : log.status === 'failed' ? '✗' : '●'}
                      </span>
                      <span className="text-slate-300">{log.message}</span>
                      {log.latency && <span className="text-slate-600">{log.latency}ms</span>}
                    </div>
                  ))}
                  {stressResult.logs.length === 0 && (
                    <div className="text-center text-slate-600 py-8 text-sm">暂无测试记录，点击"开始测试"启动压测</div>
                  )}
                </div>
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
                  <div key={msg.id} className="bg-slate-900/50 border border-slate-800 rounded-xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <code className="text-sm text-orange-400 font-mono truncate flex-1">{msg.topic}</code>
                      <div className="flex items-center gap-2 ml-4">
                        <button
                          onClick={() => sendMockMessage(msg)}
                          className="p-2 bg-orange-600/20 hover:bg-orange-600 text-orange-400 hover:text-white rounded-lg transition-all"
                          title="Send now"
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
      </div>
    </div>
  );
};
