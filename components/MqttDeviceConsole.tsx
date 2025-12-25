
import React, { useState, useRef, useEffect } from 'react';
import { Send, Terminal, Trash2, Globe, Plus, Minus, RefreshCw, Code, List, ChevronDown, ChevronRight, Copy, Check } from 'lucide-react';
import { Device, GlobalLogEntry, CloudSession } from '../types';
import { md5 } from './AuthScreen';

interface MqttDeviceConsoleProps {
    device: Device;
    session: CloudSession;
    mqttConnected: boolean;
    appid?: string;  // 用于构建 from topic: /app/{uid}-{appid}/subscribe
    onLog?: (log: Omit<GlobalLogEntry, 'id' | 'timestamp'>) => void;
}

interface KeyValuePair {
    id: string;
    key: string;
    value: string;
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    children?: KeyValuePair[];
    expanded?: boolean;
}

interface MqttMessage {
    id: string;
    timestamp: string;
    direction: 'TX' | 'RX';
    topic: string;
    payload: string;
}

// 常用命名空间预设
const NAMESPACE_PRESETS = [
    { label: 'Get System All', value: 'Appliance.System.All', method: 'GET' },
    { label: 'Get Online Status', value: 'Appliance.System.Online', method: 'GET' },
    { label: 'Toggle Switch', value: 'Appliance.Control.ToggleX', method: 'SET' },
    { label: 'Get Firmware', value: 'Appliance.System.Firmware', method: 'GET' },
    { label: 'Get Hardware', value: 'Appliance.System.Hardware', method: 'GET' },
    { label: 'Get Ability', value: 'Appliance.System.Ability', method: 'GET' },
    { label: 'Get Time', value: 'Appliance.System.Time', method: 'GET' },
    { label: 'Get DNDMode', value: 'Appliance.System.DNDMode', method: 'GET' },
    { label: 'Get Electricity', value: 'Appliance.Control.Electricity', method: 'GET' },
    { label: 'Custom...', value: 'custom', method: 'GET' },
];

const METHODS = ['GET', 'SET', 'PUSH'];

export const MqttDeviceConsole: React.FC<MqttDeviceConsoleProps> = ({
    device, session, mqttConnected, appid, onLog
}) => {
    const [messages, setMessages] = useState<MqttMessage[]>([]);
    const [editMode, setEditMode] = useState<'json' | 'keyvalue'>('json');
    const [isSending, setIsSending] = useState(false);
    const [copied, setCopied] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);

    // Header 相关状态
    const [namespace, setNamespace] = useState('Appliance.System.All');
    const [customNamespace, setCustomNamespace] = useState('');
    const [method, setMethod] = useState('GET');

    // Payload 状态
    const [jsonPayload, setJsonPayload] = useState('{}');
    const [keyValuePairs, setKeyValuePairs] = useState<KeyValuePair[]>([
        { id: '1', key: '', value: '', type: 'string', expanded: true }
    ]);

    // 滚动到最新消息
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
        }
    }, [messages]);

    // 订阅用户 topic 以接收设备响应 (GETACK/SETACK)
    useEffect(() => {
        if (!mqttConnected || !session) return;

        // 正确的 topic 格式: /app/{uid}-{appid}/subscribe
        const userTopic = appid
            ? `/app/${session.uid}-${appid}/subscribe`
            : `/app/${session.uid}/subscribe`;

        // 订阅用户 topic
        const subscribe = async () => {
            try {
                await window.electronAPI?.mqttSubscribe({ topic: userTopic });
                onLog?.({
                    type: 'MQTT',
                    direction: 'SYS',
                    label: 'Subscribed to User Topic',
                    detail: `Topic: ${userTopic}`
                });
            } catch (err: any) {
                onLog?.({
                    type: 'MQTT',
                    direction: 'ERR',
                    label: 'Subscribe Failed',
                    detail: err.message
                });
            }
        };

        subscribe();
    }, [mqttConnected, session, onLog]);

    // 监听收到的消息 - 使用单独的 effect 避免重复订阅
    useEffect(() => {
        if (!mqttConnected || !session) return;

        const handleMessage = (data: { topic: string; message: string }) => {
            try {
                // 尝试解析为 JSON
                let parsed: any;
                try {
                    parsed = JSON.parse(data.message);
                } catch {
                    // 非 JSON 消息，直接显示
                    const newMessage: MqttMessage = {
                        id: Math.random().toString(36).substr(2, 9),
                        timestamp: new Date().toLocaleTimeString('en-GB', { hour12: false }),
                        direction: 'RX',
                        topic: data.topic,
                        payload: data.message
                    };
                    setMessages(prev => [...prev.slice(-49), newMessage]);
                    return;
                }

                // JSON 消息 - 添加到消息列表
                const newMessage: MqttMessage = {
                    id: Math.random().toString(36).substr(2, 9),
                    timestamp: new Date().toLocaleTimeString('en-GB', { hour12: false }),
                    direction: 'RX',
                    topic: data.topic,
                    payload: data.message
                };
                setMessages(prev => [...prev.slice(-49), newMessage]);

                // 记录到全局日志
                onLog?.({
                    type: 'MQTT',
                    direction: 'RX',
                    label: `MQTT Response <- ${parsed.header?.namespace || 'Message'}`,
                    detail: `[Topic]: ${data.topic}\n[Payload]:\n${JSON.stringify(parsed, null, 2)}`
                });
            } catch (e) {
                console.error('Error processing MQTT message:', e);
            }
        };

        // 注册消息处理器
        window.electronAPI?.onMqttMessage?.(handleMessage);

        // 不移除监听器，因为 App.tsx 中也有全局监听器
    }, [mqttConnected, session, onLog]);

    // 生成 messageId - 使用 md5(时间戳字符串) 或随机生成
    const generateMessageId = () => {
        // 使用当前时间戳（带小数的毫秒）生成 messageId
        const timestampMs = (Date.now() / 1000).toString(); // 例如: "1735099576.123"
        return md5(timestampMs).toLowerCase();
    };

    // 生成 MQTT 消息头
    const generateHeader = () => {
        const messageId = generateMessageId();
        // 使用秒级时间戳（10位整数），与 Python int(time.time()) 一致
        const timestamp = Math.floor(Date.now() / 1000);
        const actualNamespace = namespace === 'custom' ? customNamespace : namespace;

        // 签名公式: md5(messageId + key + timestamp_int)
        const md5Source = messageId + session.key + String(timestamp);
        const sign = md5(md5Source).toLowerCase();

        // from 字段格式: /app/{uid}-{appid}/subscribe
        const fromTopic = appid
            ? `/app/${session.uid}-${appid}/subscribe`
            : `/app/${session.uid}/subscribe`;

        return {
            messageId,
            payloadVersion: 1,
            namespace: actualNamespace,
            method,
            triggerSrc: 'iot-test-tool',
            timestamp,
            from: fromTopic,
            sign
        };
    };

    // Key-Value 转 JSON 对象
    const keyValueToObject = (pairs: KeyValuePair[]): Record<string, any> => {
        const result: Record<string, any> = {};

        for (const pair of pairs) {
            if (!pair.key.trim()) continue;

            let value: any;
            switch (pair.type) {
                case 'number':
                    value = Number(pair.value) || 0;
                    break;
                case 'boolean':
                    value = pair.value.toLowerCase() === 'true';
                    break;
                case 'object':
                    value = pair.children ? keyValueToObject(pair.children) : {};
                    break;
                case 'array':
                    try {
                        value = JSON.parse(pair.value || '[]');
                    } catch {
                        value = [];
                    }
                    break;
                default:
                    value = pair.value;
            }
            result[pair.key] = value;
        }

        return result;
    };

    // 获取当前 payload
    const getPayload = () => {
        if (editMode === 'json') {
            try {
                return JSON.parse(jsonPayload);
            } catch {
                return {};
            }
        } else {
            return keyValueToObject(keyValuePairs);
        }
    };

    // 添加 Key-Value 对
    const addKeyValuePair = (parentId?: string) => {
        const newPair: KeyValuePair = {
            id: Math.random().toString(36).substr(2, 9),
            key: '',
            value: '',
            type: 'string',
            expanded: true
        };

        if (!parentId) {
            setKeyValuePairs([...keyValuePairs, newPair]);
        } else {
            const updateChildren = (pairs: KeyValuePair[]): KeyValuePair[] => {
                return pairs.map(pair => {
                    if (pair.id === parentId) {
                        return {
                            ...pair,
                            children: [...(pair.children || []), newPair]
                        };
                    }
                    if (pair.children) {
                        return { ...pair, children: updateChildren(pair.children) };
                    }
                    return pair;
                });
            };
            setKeyValuePairs(updateChildren(keyValuePairs));
        }
    };

    // 删除 Key-Value 对
    const removeKeyValuePair = (id: string) => {
        const filterPairs = (pairs: KeyValuePair[]): KeyValuePair[] => {
            return pairs.filter(pair => pair.id !== id).map(pair => ({
                ...pair,
                children: pair.children ? filterPairs(pair.children) : undefined
            }));
        };
        setKeyValuePairs(filterPairs(keyValuePairs));
    };

    // 更新 Key-Value 对
    const updateKeyValuePair = (id: string, updates: Partial<KeyValuePair>) => {
        const updatePairs = (pairs: KeyValuePair[]): KeyValuePair[] => {
            return pairs.map(pair => {
                if (pair.id === id) {
                    const updated = { ...pair, ...updates };
                    // 如果类型改为 object，初始化 children
                    if (updates.type === 'object' && !pair.children) {
                        updated.children = [];
                    }
                    return updated;
                }
                if (pair.children) {
                    return { ...pair, children: updatePairs(pair.children) };
                }
                return pair;
            });
        };
        setKeyValuePairs(updatePairs(keyValuePairs));
    };

    // 发送 MQTT 消息
    const handleSend = async () => {
        if (!mqttConnected) {
            onLog?.({
                type: 'SYSTEM',
                direction: 'ERR',
                label: 'MQTT Not Connected',
                detail: 'Please establish MQTT connection first.'
            });
            return;
        }

        setIsSending(true);

        try {
            const header = generateHeader();
            const payload = getPayload();
            const topic = `/appliance/${device.id}/subscribe`;

            const fullMessage = {
                header,
                payload
            };

            const messageStr = JSON.stringify(fullMessage);

            // 记录日志
            onLog?.({
                type: 'MQTT',
                direction: 'TX',
                label: `MQTT Publish -> ${device.name}`,
                detail: `[Topic]: ${topic}\n[Message]:\n${JSON.stringify(fullMessage, null, 2)}`
            });

            // 通过 IPC 发送 MQTT 消息
            const result = await window.electronAPI?.mqttPublish({
                topic,
                message: messageStr
            });

            if (result?.success) {
                const newMessage: MqttMessage = {
                    id: Math.random().toString(36).substr(2, 9),
                    timestamp: new Date().toLocaleTimeString('en-GB', { hour12: false }),
                    direction: 'TX',
                    topic,
                    payload: messageStr
                };
                setMessages(prev => [...prev.slice(-49), newMessage]);

                onLog?.({
                    type: 'MQTT',
                    direction: 'SYS',
                    label: 'Message Published',
                    detail: `Successfully published to ${topic}`
                });
            }
        } catch (err: any) {
            onLog?.({
                type: 'MQTT',
                direction: 'ERR',
                label: 'Publish Failed',
                detail: err.message
            });
        } finally {
            setIsSending(false);
        }
    };

    // 复制完整消息
    const handleCopy = () => {
        const header = generateHeader();
        const payload = getPayload();
        const fullMessage = { header, payload };
        navigator.clipboard.writeText(JSON.stringify(fullMessage, null, 2));
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    // 渲染 Key-Value 编辑器（递归）
    const renderKeyValueEditor = (pairs: KeyValuePair[], depth = 0) => {
        return pairs.map((pair, index) => (
            <div key={pair.id} className={`${depth > 0 ? 'ml-6 border-l-2 border-slate-800 pl-4' : ''}`}>
                <div className="flex items-center gap-2 mb-2">
                    {pair.type === 'object' && (
                        <button
                            onClick={() => updateKeyValuePair(pair.id, { expanded: !pair.expanded })}
                            className="p-1 text-slate-500 hover:text-white transition-colors"
                        >
                            {pair.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                    )}

                    <input
                        type="text"
                        value={pair.key}
                        onChange={(e) => updateKeyValuePair(pair.id, { key: e.target.value })}
                        placeholder="Key"
                        className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white font-mono focus:border-indigo-500 outline-none"
                    />

                    <select
                        value={pair.type}
                        onChange={(e) => updateKeyValuePair(pair.id, { type: e.target.value as any })}
                        className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-2 text-xs text-slate-400 focus:border-indigo-500 outline-none"
                    >
                        <option value="string">String</option>
                        <option value="number">Number</option>
                        <option value="boolean">Boolean</option>
                        <option value="object">Object</option>
                        <option value="array">Array</option>
                    </select>

                    {pair.type !== 'object' && (
                        <input
                            type="text"
                            value={pair.value}
                            onChange={(e) => updateKeyValuePair(pair.id, { value: e.target.value })}
                            placeholder={pair.type === 'boolean' ? 'true/false' : 'Value'}
                            className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-indigo-300 font-mono focus:border-indigo-500 outline-none"
                        />
                    )}

                    {pair.type === 'object' && (
                        <button
                            onClick={() => addKeyValuePair(pair.id)}
                            className="p-2 text-emerald-500 hover:bg-emerald-500/10 rounded-lg transition-colors"
                            title="Add child property"
                        >
                            <Plus size={14} />
                        </button>
                    )}

                    <button
                        onClick={() => removeKeyValuePair(pair.id)}
                        className="p-2 text-red-500 hover:bg-red-500/10 rounded-lg transition-colors"
                    >
                        <Minus size={14} />
                    </button>
                </div>

                {pair.type === 'object' && pair.expanded && pair.children && (
                    <div className="mt-2">
                        {renderKeyValueEditor(pair.children, depth + 1)}
                    </div>
                )}
            </div>
        ));
    };

    return (
        <div className="flex flex-col bg-slate-900/60 rounded-2xl border border-slate-800 shadow-xl overflow-hidden backdrop-blur-xl">
            {/* Header */}
            <div className="bg-slate-950/40 px-4 py-3 border-b border-slate-800 flex justify-between items-center">
                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                        <Globe size={16} className="text-purple-400" />
                        <span className="text-xs font-black text-white uppercase tracking-widest">MQTT Console</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${mqttConnected ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
                        <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">
                            {mqttConnected ? 'Connected' : 'Disconnected'}
                        </span>
                    </div>
                </div>

                <button
                    onClick={() => setMessages([])}
                    className="p-3 hover:bg-red-500/10 rounded-2xl text-slate-500 hover:text-red-400 transition-all"
                >
                    <Trash2 size={18} />
                </button>
            </div>

            {/* Message Log */}
            <div ref={scrollRef} className="overflow-y-auto p-4 space-y-3 custom-scrollbar min-h-[120px] max-h-[150px]">
                {messages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-slate-700 opacity-50">
                        <Terminal size={48} className="mb-4" />
                        <p className="text-xs font-black uppercase tracking-widest">No messages yet</p>
                    </div>
                ) : (
                    messages.map((msg) => (
                        <div key={msg.id} className="animate-in slide-in-from-bottom-2 duration-300">
                            <div className="flex items-center gap-3 mb-2">
                                <span className={`text-[10px] font-black px-2 py-1 rounded ${msg.direction === 'TX'
                                    ? 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
                                    : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                    }`}>
                                    {msg.direction}
                                </span>
                                <span className="text-[10px] text-slate-600 font-mono">{msg.timestamp}</span>
                                <span className="text-[10px] text-slate-500 font-mono truncate">{msg.topic}</span>
                            </div>
                            <pre className="bg-slate-950/60 border border-slate-800 rounded-xl p-4 text-xs font-mono text-slate-300 overflow-x-auto">
                                {JSON.stringify(JSON.parse(msg.payload), null, 2)}
                            </pre>
                        </div>
                    ))
                )}
            </div>

            {/* Message Builder */}
            <div className="bg-slate-900/80 p-4 border-t border-slate-800 space-y-3">
                {/* Namespace & Method */}
                <div className="grid grid-cols-12 gap-4">
                    <div className="col-span-7">
                        <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-2 block">Namespace</label>
                        <div className="flex gap-2">
                            <select
                                value={namespace}
                                onChange={(e) => setNamespace(e.target.value)}
                                className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-xs text-white focus:border-indigo-500 outline-none"
                            >
                                {NAMESPACE_PRESETS.map(preset => (
                                    <option key={preset.value} value={preset.value}>{preset.label}</option>
                                ))}
                            </select>
                            {namespace === 'custom' && (
                                <input
                                    type="text"
                                    value={customNamespace}
                                    onChange={(e) => setCustomNamespace(e.target.value)}
                                    placeholder="Appliance.Control.xxx"
                                    className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-xs text-white font-mono focus:border-indigo-500 outline-none"
                                />
                            )}
                        </div>
                    </div>
                    <div className="col-span-3">
                        <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-2 block">Method</label>
                        <select
                            value={method}
                            onChange={(e) => setMethod(e.target.value)}
                            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-xs text-white focus:border-indigo-500 outline-none"
                        >
                            {METHODS.map(m => (
                                <option key={m} value={m}>{m}</option>
                            ))}
                        </select>
                    </div>
                    <div className="col-span-2">
                        <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-2 block">Topic</label>
                        <div className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-[10px] text-slate-500 font-mono truncate">
                            /appliance/{device.id.substring(0, 8)}...
                        </div>
                    </div>
                </div>

                {/* Edit Mode Toggle */}
                <div className="flex items-center justify-between">
                    <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800">
                        <button
                            onClick={() => setEditMode('json')}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${editMode === 'json' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-white'
                                }`}
                        >
                            <Code size={12} /> JSON
                        </button>
                        <button
                            onClick={() => setEditMode('keyvalue')}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${editMode === 'keyvalue' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-white'
                                }`}
                        >
                            <List size={12} /> Key-Value
                        </button>
                    </div>

                    <button
                        onClick={handleCopy}
                        className="flex items-center gap-2 px-4 py-2 text-[10px] font-black text-slate-500 hover:text-white transition-colors"
                    >
                        {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                        {copied ? 'Copied!' : 'Copy Message'}
                    </button>
                </div>

                {/* Payload Editor */}
                <div className="bg-slate-950/50 border border-slate-800 rounded-2xl p-4">
                    <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-3 block">Payload</label>

                    {editMode === 'json' ? (
                        <textarea
                            value={jsonPayload}
                            onChange={(e) => setJsonPayload(e.target.value)}
                            placeholder='{"channel": 0, "toggle": {"onoff": 1}}'
                            className="w-full h-20 bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs font-mono text-indigo-200 focus:border-indigo-500 outline-none resize-none"
                        />
                    ) : (
                        <div className="space-y-2 max-h-40 overflow-y-auto custom-scrollbar">
                            {renderKeyValueEditor(keyValuePairs)}
                            <button
                                onClick={() => addKeyValuePair()}
                                className="flex items-center gap-2 px-4 py-2 text-xs font-bold text-emerald-500 hover:bg-emerald-500/10 rounded-lg transition-colors"
                            >
                                <Plus size={14} /> Add Property
                            </button>
                        </div>
                    )}
                </div>

                <button
                    onClick={handleSend}
                    disabled={isSending || !mqttConnected}
                    className={`w-full py-3 rounded-xl font-black text-xs uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${mqttConnected
                        ? 'bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-500/20 active:scale-[0.98]'
                        : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                        }`}
                >
                    {isSending ? (
                        <>
                            <RefreshCw className="animate-spin" size={18} />
                            Sending...
                        </>
                    ) : (
                        <>
                            <Send size={18} />
                            Publish to Device
                        </>
                    )}
                </button>
            </div>
        </div>
    );
};
