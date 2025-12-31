/**
 * Matter Dashboard - 已配网设备管理界面
 * 独立于首页设备列表，专门用于 Matter 协议交互
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
    Zap, RefreshCw, Power, Settings, ChevronRight, ChevronDown,
    Plug, Lightbulb, Thermometer, Lock, Speaker, Tv, Fan,
    Loader2, Send, Eye, Edit3, Play, X, Plus, Wifi, Trash2, AlertTriangle,
    Terminal, Save, Search, ChevronUp, Copy
} from 'lucide-react';
import { GlobalLogEntry } from '../types';
import { MATTER_DEFINITIONS, ClusterDefinition } from '../utils/MatterDefinitions';

interface MatterDashboardProps {
    onLog?: (log: Omit<GlobalLogEntry, 'id' | 'timestamp'>) => void;
}

interface CommissionedDevice {
    nodeId: number;
    name: string;
    vendorId?: number;
    productId?: number;
    deviceType?: number;
    endpoints?: EndpointInfo[];
    online: boolean;
    lastSeen?: string;
}

interface EndpointInfo {
    id: number;
    deviceType?: number;
    clusters: ClusterInfo[];
}

interface ClusterInfo {
    id: number;
    name: string;
    attributes: AttributeInfo[];
    commands: CommandInfo[];
}

interface AttributeInfo {
    id: number;
    name: string;
    value?: any;
    writable: boolean;
}

interface CommandInfo {
    id: number;
    name: string;
    hasArgs: boolean;
}

// 常用 Cluster 定义
const KNOWN_CLUSTERS: Record<number, { name: string; attributes: AttributeInfo[]; commands: CommandInfo[] }> = {
    0x0003: {
        name: 'Identify',
        attributes: [{ id: 0, name: 'IdentifyTime', writable: true }],
        commands: [{ id: 0, name: 'Identify', hasArgs: true }]
    },
    0x0004: {
        name: 'Groups',
        attributes: [{ id: 0, name: 'NameSupport', writable: false }],
        commands: []
    },
    0x0005: {
        name: 'Scenes',
        attributes: [{ id: 0, name: 'SceneCount', writable: false }],
        commands: []
    },
    0x0006: {
        name: 'On/Off',
        attributes: [{ id: 0, name: 'OnOff', writable: false }],
        commands: [
            { id: 0, name: 'Off', hasArgs: false },
            { id: 1, name: 'On', hasArgs: false },
            { id: 2, name: 'Toggle', hasArgs: false }
        ]
    },
    0x0008: {
        name: 'Level Control',
        attributes: [
            { id: 0, name: 'CurrentLevel', writable: false },
            { id: 17, name: 'OnLevel', writable: true }
        ],
        commands: [
            { id: 0, name: 'MoveToLevel', hasArgs: true },
            { id: 4, name: 'MoveToLevelWithOnOff', hasArgs: true }
        ]
    },
    0x0028: {
        name: 'Basic Information',
        attributes: [
            { id: 1, name: 'VendorName', writable: false },
            { id: 2, name: 'VendorID', writable: false },
            { id: 3, name: 'ProductName', writable: false },
            { id: 4, name: 'ProductID', writable: false },
            { id: 5, name: 'NodeLabel', writable: true },
            { id: 7, name: 'HardwareVersion', writable: false },
            { id: 9, name: 'SoftwareVersion', writable: false }
        ],
        commands: []
    },
    0x0300: {
        name: 'Color Control',
        attributes: [
            { id: 0, name: 'CurrentHue', writable: false },
            { id: 1, name: 'CurrentSaturation', writable: false },
            { id: 3, name: 'CurrentX', writable: false },
            { id: 4, name: 'CurrentY', writable: false },
            { id: 7, name: 'ColorTemperatureMireds', writable: false }
        ],
        commands: [
            { id: 0, name: 'MoveToHue', hasArgs: true },
            { id: 7, name: 'MoveToColorTemperature', hasArgs: true }
        ]
    }
};

// 设备类型图标映射
const getDeviceIcon = (deviceType?: number) => {
    switch (deviceType) {
        case 0x0100: return Lightbulb;  // On/Off Light
        case 0x0101: return Lightbulb;  // Dimmable Light
        case 0x010A: return Plug;       // On/Off Plug
        case 0x010B: return Plug;       // Dimmable Plug
        case 0x0302: return Thermometer; // Temperature Sensor
        case 0x000A: return Lock;       // Door Lock
        case 0x000D: return Speaker;    // Speaker
        case 0x0023: return Tv;         // Video Player
        case 0x002B: return Fan;        // Fan
        default: return Plug;
    }
};

export const MatterDashboard: React.FC<MatterDashboardProps> = ({ onLog }) => {
    const [devices, setDevices] = useState<CommissionedDevice[]>([]);
    const [selectedDevice, setSelectedDevice] = useState<CommissionedDevice | null>(null);
    const [selectedEndpoint, setSelectedEndpoint] = useState<number>(0);
    const [expandedClusters, setExpandedClusters] = useState<Set<number>>(new Set([0x0006]));
    const [isLoading, setIsLoading] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [isCheckingOnline, setIsCheckingOnline] = useState(false);
    const [isReadingStructure, setIsReadingStructure] = useState(false);

    // Matter Controller 初始化状态
    const [matterInitialized, setMatterInitialized] = useState(false);
    const [isInitializing, setIsInitializing] = useState(false);

    // 设备结构缓存 { nodeId: { endpoints: [...] } }
    const [deviceStructures, setDeviceStructures] = useState<Record<number, EndpointInfo[]>>({});

    // 属性值缓存
    const [attributeValues, setAttributeValues] = useState<Record<string, any>>({});
    const [readingAttribute, setReadingAttribute] = useState<string | null>(null);

    // 命令执行状态
    const [executingCommand, setExecutingCommand] = useState<string | null>(null);
    const [commandArgs, setCommandArgs] = useState<string>('');

    // 删除确认状态
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);

    // 交互日志
    const [interactionLog, setInteractionLog] = useState<string[]>([]);

    // 添加日志
    const addLog = useCallback((message: string, type: 'info' | 'success' | 'error' = 'info') => {
        const timestamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
        const prefix = type === 'error' ? '✗' : type === 'success' ? '✓' : '→';
        setInteractionLog(prev => [...prev.slice(-49), `[${timestamp}] ${prefix} ${message}`]);
    }, []);

    // 初始化 Matter Controller
    const handleInitialize = useCallback(async () => {
        if (isInitializing || matterInitialized) return;

        setIsInitializing(true);
        addLog('Initializing Matter Controller...', 'info');

        try {
            const result = await window.electronAPI?.matterInit();
            if (result?.success) {
                setMatterInitialized(true);
                addLog('Matter Controller initialized successfully', 'success');
            } else {
                throw new Error(result?.error || 'Unknown error');
            }
        } catch (error: any) {
            addLog(`Matter Init Failed: ${error.message}`, 'error');
        } finally {
            setIsInitializing(false);
        }
    }, [isInitializing, matterInitialized, addLog]);

    // 检查设备在线状态
    const checkOnlineStatus = useCallback(async (silent = false) => {
        if (devices.length === 0) {
            if (!silent) addLog('No devices to check', 'info');
            return;
        }

        // 获取 SSH 配置
        const sshResult = await window.electronAPI?.matterGetSshConfig();
        if (!sshResult?.success || !sshResult.config) {
            if (!silent) addLog('No SSH config available. Please configure SSH in Matter Console first.', 'error');
            return;
        }

        setIsCheckingOnline(true);
        if (!silent) addLog('Checking device online status via chip-tool...', 'info');

        try {
            const result = await window.electronAPI?.matterCheckDevicesOnline({
                devices: devices.map(d => ({ nodeId: d.nodeId.toString() })),
                sshConfig: sshResult.config
            });

            if (result?.success && result.results) {
                // 更新设备在线状态
                let onlineCount = 0;
                setDevices(prev => prev.map(device => {
                    const status = result.results?.[device.nodeId.toString()];
                    if (status) {
                        if (status.online) onlineCount++;
                        // 只有状态改变时才记录日志，或者是手动触发时
                        if (!silent || device.online !== status.online) {
                            addLog(`Node ${device.nodeId}: ${status.online ? 'ONLINE' : 'OFFLINE'}${status.latency ? ` (${status.latency}ms)` : ''}`, status.online ? 'success' : 'info');
                        }
                        return { ...device, online: status.online };
                    }
                    return device;
                }));

                if (!silent) addLog(`Online check complete: ${onlineCount}/${devices.length} devices online`, 'success');
            } else {
                if (!silent) addLog(`Online check failed: ${result?.error || 'Unknown error'}`, 'error');
            }
        } catch (error: any) {
            if (!silent) addLog(`Failed to check online status: ${error.message}`, 'error');
        } finally {
            setIsCheckingOnline(false);
        }
    }, [devices, addLog]);

    // 自动轮询在线状态
    useEffect(() => {
        if (!matterInitialized || devices.length === 0) return;

        const intervalId = setInterval(() => {
            // 只有在没有进行其他操作时才轮询
            if (!isCheckingOnline && !isRefreshing && !isReadingStructure) {
                // console.log('[MatterDashboard] Auto-polling device status...');
                checkOnlineStatus(true);
            }
        }, 30000); // 每 30 秒轮询一次

        return () => clearInterval(intervalId);
    }, [matterInitialized, devices.length, isCheckingOnline, isRefreshing, isReadingStructure, checkOnlineStatus]);

    // 读取设备结构
    const readDeviceStructure = useCallback(async (nodeId: number, forceRefresh = true) => {
        // 获取 SSH 配置
        const sshResult = await window.electronAPI?.matterGetSshConfig();
        if (!sshResult?.success || !sshResult.config) {
            addLog('No SSH config available. Please configure SSH in Matter Console first.', 'error');
            return;
        }

        setIsReadingStructure(true);
        addLog(`Reading device structure for Node ${nodeId} (Refresh: ${forceRefresh})...`, 'info');

        try {
            const result = await window.electronAPI?.matterReadDeviceStructure({
                nodeId: nodeId.toString(),
                sshConfig: sshResult.config,
                forceRefresh
            });
            if (result?.success && result.endpoints) {
                // 缓存设备结构
                setDeviceStructures(prev => ({
                    ...prev,
                    [nodeId]: result.endpoints as EndpointInfo[]
                }));

                const clusterCount = result.endpoints.reduce((sum: number, ep: any) => sum + ep.clusters.length, 0);
                addLog(`Found ${result.endpoints.length} endpoints, ${clusterCount} clusters`, 'success');

                // 自动选择第一个非零 endpoint
                if (result.endpoints.length > 1) {
                    setSelectedEndpoint(result.endpoints[1].id);
                }
            } else {
                addLog(`Failed to read structure: ${result?.error || 'Unknown error'}`, 'error');
            }
        } catch (error: any) {
            addLog(`Failed to read device structure: ${error.message}`, 'error');
        } finally {
            setIsReadingStructure(false);
        }
    }, [addLog]);



    // 删除设备
    const handleDeleteDevice = useCallback(async () => {
        if (!selectedDevice) return;

        setIsDeleting(true);
        addLog(`Deleting device Node ${selectedDevice.nodeId}...`, 'info');

        try {
            const result = await window.electronAPI?.matterDeleteDevice(selectedDevice.nodeId);

            if (result?.success) {
                addLog(`Device Node ${selectedDevice.nodeId} deleted successfully`, 'success');
                // 从本地状态中移除设备
                setDevices(prev => prev.filter(d => d.nodeId !== selectedDevice.nodeId));
                // 清除选中状态
                setSelectedDevice(null);
                // 清除设备结构缓存
                setDeviceStructures(prev => {
                    const { [selectedDevice.nodeId]: _, ...rest } = prev;
                    return rest;
                });
                setShowDeleteConfirm(false);
            } else {
                addLog(`Failed to delete device: ${result?.error || 'Unknown error'}`, 'error');
            }
        } catch (error: any) {
            addLog(`Failed to delete device: ${error.message}`, 'error');
        } finally {
            setIsDeleting(false);
        }
    }, [selectedDevice, addLog]);

    // 加载已配网设备
    const loadDevices = useCallback(async () => {
        setIsRefreshing(true);
        try {
            // 从后端获取已配网设备列表
            const result = await window.electronAPI?.matterDevices();
            if (result?.success && result.devices) {
                const loadedDevices = result.devices.map((d: any) => ({
                    ...d,
                    nodeId: parseInt(d.nodeId) || d.nodeId,
                    // 不再硬编码 endpoints，让 Read Structure 动态读取
                    endpoints: []
                }));
                setDevices(loadedDevices);

                // 如果有设备且有 SSH 配置，自动尝试读取第一个设备的结构
                // 注：用户可以手动点击 "Read Structure" 按钮来刷新
            }
            addLog('Device list refreshed', 'info');
        } catch (error: any) {
            addLog(`Failed to load devices: ${error.message}`, 'error');
        } finally {
            setIsRefreshing(false);
        }
    }, [addLog]);

    // 初始化加载 - 检查 Matter 状态并自动初始化
    useEffect(() => {
        const initializeAndLoad = async () => {
            // 1. 检查 Matter Controller 状态
            const status = await window.electronAPI?.matterStatus();
            const isInit = status?.initialized || false;
            setMatterInitialized(isInit);

            // 2. 如果未初始化，自动初始化
            if (!isInit) {
                setIsInitializing(true);
                addLog('Auto-initializing Matter Controller...', 'info');
                try {
                    const result = await window.electronAPI?.matterInit();
                    if (result?.success) {
                        setMatterInitialized(true);
                        addLog('Matter Controller auto-initialized', 'success');
                    }
                } catch (error: any) {
                    addLog(`Auto-init failed: ${error.message}`, 'error');
                } finally {
                    setIsInitializing(false);
                }
            }

            // 3. 加载设备列表
            loadDevices();
        };

        initializeAndLoad();
    }, []); // 只在首次加载时执行

    // 监听配网完成事件，自动刷新设备列表
    useEffect(() => {
        const handleCommissioningProgress = (data: { stage: string }) => {
            if (data.stage === 'complete') {
                // 延迟刷新，等待设备保存完成
                setTimeout(() => {
                    loadDevices();
                    addLog('New device commissioned, refreshing list...', 'success');
                }, 1000);
            }
        };

        window.electronAPI?.onMatterCommissioningProgress?.(handleCommissioningProgress);
    }, [loadDevices, addLog]);

    // 读取属性
    const handleReadAttribute = async (clusterId: number, attributeId: number, attributeName: string) => {
        if (!selectedDevice) return;

        const key = `${selectedDevice.nodeId}-${selectedEndpoint}-${clusterId}-${attributeId}`;
        setReadingAttribute(key);
        addLog(`Reading ${attributeName} from Node ${selectedDevice.nodeId}, Endpoint ${selectedEndpoint}, Cluster 0x${clusterId.toString(16).padStart(4, '0')}`);

        try {
            const result = await window.electronAPI?.matterRead({
                nodeId: selectedDevice.nodeId.toString(),
                endpointId: selectedEndpoint,
                clusterId,
                attributeId
            });

            if (result?.success) {
                setAttributeValues(prev => ({ ...prev, [key]: result.value }));
                addLog(`${attributeName} = ${JSON.stringify(result.value)}`, 'success');
                onLog?.({
                    type: 'MATTER',
                    direction: 'RX',
                    label: `Read ${attributeName}`,
                    detail: `Node: ${selectedDevice.nodeId}, Value: ${JSON.stringify(result.value)}`
                });
            } else {
                throw new Error(result?.error || 'Read failed');
            }
        } catch (error: any) {
            addLog(`Failed to read ${attributeName}: ${error.message}`, 'error');
        } finally {
            setReadingAttribute(null);
        }
    };

    // 执行命令
    const handleExecuteCommand = async (clusterId: number, commandId: number, commandName: string) => {
        if (!selectedDevice) return;

        const key = `${clusterId}-${commandId}`;
        setExecutingCommand(key);
        addLog(`Executing ${commandName} on Node ${selectedDevice.nodeId}, Endpoint ${selectedEndpoint}`);

        try {
            const result = await window.electronAPI?.matterInvoke({
                nodeId: selectedDevice.nodeId.toString(),
                endpointId: selectedEndpoint,
                clusterId,
                commandId,
                args: commandArgs ? JSON.parse(commandArgs) : undefined
            });

            if (result?.success) {
                addLog(`${commandName} executed successfully`, 'success');
                onLog?.({
                    type: 'MATTER',
                    direction: 'TX',
                    label: `Command: ${commandName}`,
                    detail: `Node: ${selectedDevice.nodeId}, Result: ${JSON.stringify(result.result)}`
                });

                // 如果是 On/Off 命令，刷新 OnOff 属性
                if (clusterId === 0x0006) {
                    setTimeout(() => handleReadAttribute(0x0006, 0, 'OnOff'), 500);
                }
            } else {
                throw new Error(result?.error || 'Command failed');
            }
        } catch (error: any) {
            addLog(`Failed to execute ${commandName}: ${error.message}`, 'error');
        } finally {
            setExecutingCommand(null);
            setCommandArgs('');
        }
    };

    // 切换 Cluster 展开状态
    const toggleCluster = (clusterId: number) => {
        setExpandedClusters(prev => {
            const next = new Set(prev);
            if (next.has(clusterId)) {
                next.delete(clusterId);
            } else {
                next.add(clusterId);
            }
            return next;
        });
    };

    // 获取设备的 Cluster 列表 (优先使用动态读取的数据)
    const getDeviceClusters = (): ClusterInfo[] => {
        if (selectedDevice && deviceStructures[selectedDevice.nodeId]) {
            // 使用动态读取的数据
            const endpoints = deviceStructures[selectedDevice.nodeId];
            const endpoint = endpoints.find(ep => ep.id === selectedEndpoint);
            if (endpoint && endpoint.clusters.length > 0) {
                return endpoint.clusters;
            }
        }
        // 回退到预定义的 Cluster 列表
        return Object.entries(KNOWN_CLUSTERS).map(([id, info]) => ({
            id: parseInt(id),
            name: info.name,
            attributes: info.attributes,
            commands: info.commands
        }));
    };

    // 获取当前设备的 Endpoint 列表
    const getDeviceEndpoints = (): number[] => {
        if (selectedDevice && deviceStructures[selectedDevice.nodeId]) {
            return deviceStructures[selectedDevice.nodeId].map(ep => ep.id);
        }
        // 如果还没有读取设备结构，显示提示性的默认值
        return [0]; // 默认只显示 Endpoint 0，用户需要点击 Read Structure 获取完整列表
    };

    const DeviceIcon = selectedDevice ? getDeviceIcon(selectedDevice.deviceType) : Plug;

    return (
        <div className="bg-slate-900/60 rounded-2xl border border-slate-800 shadow-xl overflow-hidden backdrop-blur-xl">
            {/* Header */}
            <div className="bg-slate-950/40 px-4 py-3 border-b border-slate-800">
                <div className="flex justify-between items-center">
                    {/* 左侧：标题 + Matter 状态 */}
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2">
                            <Zap size={16} className="text-amber-400" />
                            <span className="text-xs font-black text-white uppercase tracking-widest">Matter Device Manager</span>
                        </div>

                        {/* Matter Controller 状态指示器 */}
                        <div className={`flex items-center gap-2 px-2.5 py-1 rounded-full ${matterInitialized
                            ? 'bg-emerald-500/10 border border-emerald-500/30'
                            : 'bg-red-500/10 border border-red-500/30'
                            }`}>
                            <div className={`w-2 h-2 rounded-full ${isInitializing
                                ? 'bg-amber-500 animate-pulse'
                                : matterInitialized
                                    ? 'bg-emerald-500'
                                    : 'bg-red-500'
                                }`} />
                            <span className={`text-[9px] font-bold uppercase tracking-wider ${matterInitialized ? 'text-emerald-400' : 'text-red-400'
                                }`}>
                                {isInitializing ? 'Initializing...' : matterInitialized ? 'Ready' : 'Not Init'}
                            </span>
                            {!matterInitialized && !isInitializing && (
                                <button
                                    onClick={handleInitialize}
                                    className="ml-1 px-1.5 py-0.5 bg-amber-600 hover:bg-amber-500 rounded text-[9px] font-bold text-white transition-all"
                                    title="Initialize Matter Controller"
                                >
                                    Init
                                </button>
                            )}
                        </div>

                        <span className="text-[9px] font-bold text-slate-500 bg-slate-800 px-2 py-1 rounded-full">
                            {devices.length} Device{devices.length !== 1 ? 's' : ''}
                        </span>
                    </div>

                    {/* 右侧：操作按钮 */}
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => checkOnlineStatus(false)}
                            disabled={isCheckingOnline || devices.length === 0 || !matterInitialized}
                            className="flex items-center gap-2 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-[10px] font-bold text-white transition-all disabled:opacity-50"
                            title={!matterInitialized ? "Initialize Matter Controller first" : "Check device online status via SSH"}
                        >
                            {isCheckingOnline ? <Loader2 size={12} className="animate-spin" /> : <Wifi size={12} />}
                            Check Online
                        </button>
                        <button
                            onClick={loadDevices}
                            disabled={isRefreshing}
                            className="flex items-center gap-2 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-[10px] font-bold text-white transition-all disabled:opacity-50"
                        >
                            <RefreshCw size={12} className={isRefreshing ? 'animate-spin' : ''} />
                            Refresh
                        </button>
                    </div>
                </div>
            </div>

            <div className="flex h-[600px]">
                {/* 设备侧边栏 */}
                <div className="w-56 border-r border-slate-800 bg-slate-950/30 overflow-y-auto">
                    <div className="p-3 border-b border-slate-800">
                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Commissioned Devices</span>
                    </div>

                    {devices.length === 0 ? (
                        <div className="p-4 text-center">
                            <Plug size={32} className="mx-auto mb-3 text-slate-600" />
                            <p className="text-xs text-slate-500">No devices commissioned yet</p>
                            <p className="text-[10px] text-slate-600 mt-1">Use Matter Console to add devices</p>
                        </div>
                    ) : (
                        <div className="p-2 space-y-2">
                            {devices.map(device => {
                                const Icon = getDeviceIcon(device.deviceType);
                                const isSelected = selectedDevice?.nodeId === device.nodeId;
                                const hasStructure = !!deviceStructures[device.nodeId];

                                return (
                                    <button
                                        key={device.nodeId}
                                        onClick={async () => {
                                            setSelectedDevice(device);
                                            // 如果有设备结构，选择第一个非零 endpoint
                                            if (deviceStructures[device.nodeId]?.length > 1) {
                                                setSelectedEndpoint(deviceStructures[device.nodeId][1].id);
                                            } else {
                                                setSelectedEndpoint(0);
                                            }
                                            // 如果还没有读取过设备结构，自动读取
                                            if (!hasStructure && !isReadingStructure) {
                                                readDeviceStructure(device.nodeId, false);
                                            }
                                        }}
                                        className={`w-full p-3 rounded-xl text-left transition-all ${isSelected
                                            ? 'bg-amber-600/20 border border-amber-500/50'
                                            : 'bg-slate-800/50 border border-slate-700 hover:border-slate-600'
                                            }`}
                                    >
                                        <div className="flex items-start gap-3">
                                            <div className={`p-2 rounded-lg ${isSelected ? 'bg-amber-500/20' : 'bg-slate-700/50'}`}>
                                                <Icon size={20} className={isSelected ? 'text-amber-400' : 'text-slate-400'} />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className={`text-sm font-bold truncate ${isSelected ? 'text-amber-400' : 'text-white'}`}>
                                                    {device.name || `Node ${device.nodeId}`}
                                                </p>
                                                <p className="text-[10px] text-slate-500 font-mono">
                                                    Node ID: {device.nodeId}
                                                </p>
                                                <div className="flex items-center gap-2 mt-1">
                                                    <div className="flex items-center gap-1">
                                                        <div className={`w-1.5 h-1.5 rounded-full ${device.online ? 'bg-emerald-500' : 'bg-slate-600'}`} />
                                                        <span className={`text-[9px] font-bold ${device.online ? 'text-emerald-400' : 'text-slate-500'}`}>
                                                            {device.online ? 'Online' : 'Offline'}
                                                        </span>
                                                    </div>
                                                    {hasStructure && (
                                                        <span className="text-[9px] font-bold text-indigo-400 bg-indigo-500/20 px-1.5 py-0.5 rounded">
                                                            {deviceStructures[device.nodeId].length} EPs
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* 主内容区 */}
                <div className="flex-1 flex flex-col overflow-hidden">
                    {selectedDevice ? (
                        <>
                            {/* 设备头部 */}
                            <div className="p-4 border-b border-slate-800 bg-slate-950/30">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-4">
                                        <div className="p-3 bg-amber-500/20 rounded-xl">
                                            <DeviceIcon size={32} className="text-amber-400" />
                                        </div>
                                        <div>
                                            <h2 className="text-lg font-bold text-white">
                                                {selectedDevice.name || `Matter Device`}
                                            </h2>
                                            <p className="text-sm text-slate-400 font-mono">
                                                Node ID: {selectedDevice.nodeId}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${selectedDevice.online ? 'bg-emerald-500/20' : 'bg-slate-700'}`}>
                                            <div className={`w-2 h-2 rounded-full ${selectedDevice.online ? 'bg-emerald-500 animate-pulse' : 'bg-slate-500'}`} />
                                            <span className={`text-xs font-bold ${selectedDevice.online ? 'text-emerald-400' : 'text-slate-400'}`}>
                                                {selectedDevice.online ? 'Online' : 'Offline'}
                                            </span>
                                        </div>
                                        <button
                                            onClick={() => setShowDeleteConfirm(true)}
                                            className="flex items-center gap-2 px-3 py-1.5 bg-red-600/20 hover:bg-red-600/40 border border-red-500/50 rounded-lg text-xs font-bold text-red-400 transition-all"
                                            title="Delete this device from the commissioned list"
                                        >
                                            <Trash2 size={14} />
                                            Delete
                                        </button>
                                    </div>
                                </div>

                                {/* 删除确认对话框 */}
                                {showDeleteConfirm && (
                                    <div className="mt-4 p-4 bg-red-950/50 border border-red-500/50 rounded-xl">
                                        <div className="flex items-start gap-3">
                                            <AlertTriangle size={24} className="text-red-400 flex-shrink-0" />
                                            <div className="flex-1">
                                                <h4 className="text-sm font-bold text-red-400">Confirm Delete Device</h4>
                                                <p className="text-xs text-slate-400 mt-1">
                                                    Are you sure you want to delete <strong className="text-white">{selectedDevice.name || `Node ${selectedDevice.nodeId}`}</strong>?
                                                    This action will remove the device from the commissioned list and cannot be undone.
                                                </p>
                                                <div className="flex gap-2 mt-3">
                                                    <button
                                                        onClick={handleDeleteDevice}
                                                        disabled={isDeleting}
                                                        className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-500 rounded-lg text-xs font-bold text-white transition-all disabled:opacity-50"
                                                    >
                                                        {isDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                                                        {isDeleting ? 'Deleting...' : 'Yes, Delete'}
                                                    </button>
                                                    <button
                                                        onClick={() => setShowDeleteConfirm(false)}
                                                        disabled={isDeleting}
                                                        className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-xs font-bold text-slate-300 transition-all disabled:opacity-50"
                                                    >
                                                        Cancel
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Endpoint 选择 + Read Structure */}
                            <div className="px-4 pb-4 flex items-center justify-between">
                                <div className="flex gap-2 items-center">
                                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Endpoint:</span>
                                    {getDeviceEndpoints().map(ep => (
                                        <button
                                            key={ep}
                                            onClick={() => setSelectedEndpoint(ep)}
                                            className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${selectedEndpoint === ep
                                                ? 'bg-indigo-600 text-white'
                                                : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                                                }`}
                                        >
                                            {ep}
                                        </button>
                                    ))}
                                </div>
                                <button
                                    onClick={() => readDeviceStructure(selectedDevice.nodeId, true)}
                                    disabled={isReadingStructure}
                                    className="flex items-center gap-2 px-3 py-1.5 bg-purple-600 hover:bg-purple-500 rounded-lg text-[10px] font-bold text-white transition-all disabled:opacity-50"
                                    title="Read device structure (Endpoints, Clusters, Attributes)"
                                >
                                    {isReadingStructure ? <Loader2 size={12} className="animate-spin" /> : <Settings size={12} />}
                                    Read Structure
                                </button>
                            </div>

                            {/* 交互控制台 - 占据全部剩余空间 */}
                            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                                <MatterInteractionConsole
                                    device={selectedDevice}
                                    endpoint={selectedEndpoint}
                                    onLog={addLog}
                                    onInteraction={(type, label, detail) => onLog?.({ type: 'MATTER', direction: type === 'tx' ? 'TX' : 'RX', label, detail })}
                                    interactionLog={interactionLog}
                                    onClearLog={() => setInteractionLog([])}
                                />
                            </div>
                        </>
                    ) : (
                        <div className="flex-1 flex items-center justify-center">
                            <div className="text-center">
                                <Plug size={48} className="mx-auto mb-4 text-slate-600" />
                                <p className="text-slate-400 font-medium">Select a device to view details</p>
                                <p className="text-sm text-slate-500 mt-1">or commission a new device using Matter Console</p>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

// --- Matter Interaction Console Component ---

interface InteractionConsoleProps {
    device: CommissionedDevice;
    endpoint: number;
    onLog: (message: string, type?: 'info' | 'success' | 'error') => void;
    onInteraction: (type: 'tx' | 'rx', label: string, detail: string) => void;
    interactionLog: string[];
    onClearLog: () => void;
}

const MatterInteractionConsole: React.FC<InteractionConsoleProps> = ({ device, endpoint, onLog, onInteraction, interactionLog, onClearLog }) => {
    const [activeTab, setActiveTab] = useState<'read' | 'write' | 'invoke'>('read');

    // Cluster Selection
    const [selectedClusterName, setSelectedClusterName] = useState<string>('onoff');
    const [customClusters, setCustomClusters] = useState<ClusterDefinition[]>([]);
    const [isAddingCluster, setIsAddingCluster] = useState(false);
    const [newClusterId, setNewClusterId] = useState('');
    const [newClusterName, setNewClusterName] = useState('');

    // chip-tool Clusters (从远程获取)
    const [chipToolClusters, setChipToolClusters] = useState<ChipToolCluster[]>([]);
    const [isLoadingClusters, setIsLoadingClusters] = useState(false);
    const [clustersCachedAt, setClustersCachedAt] = useState<string | null>(null);

    // 当前 cluster 的详细信息
    const [currentClusterDetails, setCurrentClusterDetails] = useState<{
        attributes: { name: string; displayName: string }[];
        commands: { name: string; displayName: string }[];
    }>({ attributes: [], commands: [] });
    const [isLoadingDetails, setIsLoadingDetails] = useState(false);

    // Attribute/Command Selection
    const [selectedAttributeName, setSelectedAttributeName] = useState<string>('');
    const [selectedCommandName, setSelectedCommandName] = useState<string>('');
    const [customId, setCustomId] = useState<string>(''); // For manual hex input

    // 模糊搜索
    const [clusterSearch, setClusterSearch] = useState('');
    const [attrSearch, setAttrSearch] = useState('');
    const [cmdSearch, setCmdSearch] = useState('');
    const [showClusterDropdown, setShowClusterDropdown] = useState(false);
    const [showAttrDropdown, setShowAttrDropdown] = useState(false);
    const [showCmdDropdown, setShowCmdDropdown] = useState(false);
    // 是否处于搜索模式（用于控制输入框显示）
    const [isClusterSearching, setIsClusterSearching] = useState(false);
    const [isAttrSearching, setIsAttrSearching] = useState(false);
    const [isCmdSearching, setIsCmdSearching] = useState(false);

    // Parameters
    const [writeValue, setWriteValue] = useState('');
    const [commandArgs, setCommandArgs] = useState('');

    // Execution State
    const [isExecuting, setIsExecuting] = useState(false);
    const [lastResult, setLastResult] = useState<string | null>(null);

    // Load custom clusters
    useEffect(() => {
        const loadCustomClusters = async () => {
            const result = await window.electronAPI?.matterGetCustomClusters();
            if (result?.success) {
                setCustomClusters(result.clusters);
            }
        };
        loadCustomClusters();
    }, []);

    // Load chip-tool clusters (with cache)
    useEffect(() => {
        loadChipToolClusters(false);
    }, []);

    const loadChipToolClusters = async (forceRefresh: boolean) => {
        setIsLoadingClusters(true);
        try {
            const sshResult = await window.electronAPI?.matterGetSshConfig();
            if (!sshResult?.success || !sshResult.config) {
                onLog('SSH config needed to fetch clusters', 'error');
                return;
            }

            const result = await window.electronAPI?.matterGetChipToolClusters({
                sshConfig: sshResult.config,
                forceRefresh
            });

            if (result?.success && result.clusters) {
                setChipToolClusters(result.clusters);
                setClustersCachedAt(result.cachedAt || null);
                onLog(`Loaded ${result.clusters.length} clusters ${result.fromCache ? '(cached)' : '(from chip-tool)'}`, 'success');

                // 启动后台预加载详情
                window.electronAPI?.matterStartClusterDetailsPrefetch({ sshConfig: sshResult.config })
                    .then(res => {
                        if (res?.success) {
                            console.log('[MatterDashboard] Background prefetch started');
                        }
                    });
            } else {
                onLog(`Failed to load clusters: ${result?.error}`, 'error');
            }
        } catch (error: any) {
            onLog(`Error loading clusters: ${error.message}`, 'error');
        } finally {
            setIsLoadingClusters(false);
        }
    };

    // Load cluster details when selection changes
    useEffect(() => {
        if (selectedClusterName) {
            loadClusterDetails(selectedClusterName);
        }
    }, [selectedClusterName]);

    const loadClusterDetails = async (clusterName: string) => {
        // 先尝试从本地定义获取
        const localCluster = Object.values(MATTER_DEFINITIONS).find(
            c => c.name.toLowerCase().replace(/[\s\/]/g, '') === clusterName.toLowerCase()
        );
        if (localCluster) {
            setCurrentClusterDetails({
                attributes: localCluster.attributes.map(a => ({ name: a.name, displayName: a.name })),
                commands: localCluster.commands.map(c => ({ name: c.name, displayName: c.name }))
            });
            return;
        }

        // 从远程获取
        setIsLoadingDetails(true);
        try {
            const sshResult = await window.electronAPI?.matterGetSshConfig();
            if (!sshResult?.success || !sshResult.config) return;

            const result = await window.electronAPI?.matterGetClusterDetails({
                sshConfig: sshResult.config,
                clusterName
            });

            if (result?.success) {
                setCurrentClusterDetails({
                    attributes: result.attributes || [],
                    commands: result.commands || []
                });
            }
        } catch (error: any) {
            console.error('Failed to load cluster details:', error);
        } finally {
            setIsLoadingDetails(false);
        }
    };

    // 筛选后的 clusters
    const filteredClusters = useMemo(() => {
        // 如果已经从 chip-tool 获取到了 clusters，使用它们
        // 否则只显示 basicinformation 作为默认选项
        const allClusters = chipToolClusters.length > 0
            ? chipToolClusters.map(c => ({ name: c.name, displayName: c.displayName, source: 'chip-tool' }))
            : [{ name: 'basicinformation', displayName: 'Basic Information', source: 'default' }];

        if (!clusterSearch) return allClusters;
        const search = clusterSearch.toLowerCase();
        return allClusters.filter(c =>
            c.name.toLowerCase().includes(search) ||
            c.displayName.toLowerCase().includes(search)
        );
    }, [chipToolClusters, clusterSearch]);

    // 当前选中的 cluster 显示名
    const currentClusterDisplay = useMemo(() => {
        const found = filteredClusters.find(c => c.name === selectedClusterName);
        return found?.displayName || selectedClusterName;
    }, [filteredClusters, selectedClusterName]);

    // 筛选后的 attributes
    const filteredAttributes = useMemo(() => {
        if (!attrSearch) return currentClusterDetails.attributes;
        const search = attrSearch.toLowerCase();
        return currentClusterDetails.attributes.filter(a =>
            a.name.toLowerCase().includes(search) ||
            a.displayName.toLowerCase().includes(search)
        );
    }, [currentClusterDetails.attributes, attrSearch]);

    // 筛选后的 commands
    const filteredCommands = useMemo(() => {
        if (!cmdSearch) return currentClusterDetails.commands;
        const search = cmdSearch.toLowerCase();
        return currentClusterDetails.commands.filter(c =>
            c.name.toLowerCase().includes(search) ||
            c.displayName.toLowerCase().includes(search)
        );
    }, [currentClusterDetails.commands, cmdSearch]);

    const handleExecute = async () => {
        setIsExecuting(true);
        setLastResult(null);

        // 获取 SSH 配置
        const sshResult = await window.electronAPI?.matterGetSshConfig();
        if (!sshResult?.success || !sshResult.config) {
            onLog('No SSH config available', 'error');
            setIsExecuting(false);
            return;
        }

        const params: any = {
            action: activeTab,
            nodeId: device.nodeId,
            endpointId: endpoint,
            // 使用 cluster 名称代替 ID
            clusterName: selectedClusterName,
        };

        if (activeTab === 'read' || activeTab === 'write') {
            // 使用 attribute 名称
            params.attributeName = customId || selectedAttributeName;
            if (activeTab === 'write') params.value = writeValue;
        } else {
            // 使用 command 名称
            params.commandName = customId || selectedCommandName;
            params.args = commandArgs ? commandArgs.split(',').map((s: string) => s.trim()) : [];
        }

        onLog(`Executing ${activeTab.toUpperCase()} on Node ${device.nodeId}...`, 'info');
        onInteraction('tx', `${activeTab.toUpperCase()} ${selectedClusterName}`, JSON.stringify(params));

        try {
            const result = await window.electronAPI?.matterExecuteGenericCommand({
                params,
                sshConfig: sshResult.config
            });

            if (result?.success) {
                setLastResult(result.output || '');
                onLog('Command executed successfully', 'success');
                onInteraction('rx', 'Success', result.output || '');
            } else {
                setLastResult(result?.output || result?.error || 'Unknown error');
                onLog(`Command failed: ${result?.error}`, 'error');
                onInteraction('rx', 'Error', result?.error || 'Unknown error');
            }
        } catch (error: any) {
            onLog(`Execution error: ${error.message}`, 'error');
        } finally {
            setIsExecuting(false);
        }
    };

    const handleSaveCustomCluster = async () => {
        if (!newClusterId || !newClusterName) return;
        const id = parseInt(newClusterId, 16);
        if (isNaN(id)) return;

        const newCluster: ClusterDefinition = {
            id,
            name: newClusterName,
            attributes: [],
            commands: []
        };

        const result = await window.electronAPI?.matterSaveCustomCluster(newCluster);
        if (result?.success) {
            setCustomClusters(result.clusters || []);
            setIsAddingCluster(false);
            setNewClusterId('');
            setNewClusterName('');
            onLog(`Custom cluster "${newClusterName}" saved`, 'success');
        }
    };

    return (
        <div className="flex h-full bg-slate-900/30">
            {/* 左侧：控制面板 */}
            <div className="w-80 flex-shrink-0 flex flex-col border-r border-slate-800 overflow-y-auto">
                {/* 1. Target Selection */}
                <div className="p-3 border-b border-slate-800">
                    <div className="mb-3">
                        <div className="flex items-center justify-between mb-1">
                            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Cluster</label>
                            <button
                                onClick={() => loadChipToolClusters(true)}
                                disabled={isLoadingClusters}
                                className="text-[9px] text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                                title={clustersCachedAt ? `Cached: ${clustersCachedAt}` : 'Refresh from chip-tool'}
                            >
                                {isLoadingClusters ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                                {isLoadingClusters ? 'Loading...' : 'Refresh'}
                            </button>
                        </div>
                        {/* Cluster Combobox with search */}
                        <div className="relative">
                            <input
                                type="text"
                                value={isClusterSearching ? clusterSearch : currentClusterDisplay}
                                onChange={(e) => {
                                    setClusterSearch(e.target.value);
                                    setIsClusterSearching(true);
                                    setShowClusterDropdown(true);
                                }}
                                onFocus={() => {
                                    setClusterSearch('');
                                    setIsClusterSearching(true);
                                    setShowClusterDropdown(true);
                                }}
                                onBlur={() => setTimeout(() => {
                                    setShowClusterDropdown(false);
                                    setIsClusterSearching(false);
                                }, 200)}
                                placeholder="Search cluster..."
                                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                            />
                            <Search size={12} className="absolute right-3 top-2.5 text-slate-400 pointer-events-none" />

                            {/* Dropdown */}
                            {showClusterDropdown && (
                                <div className="absolute z-50 w-full mt-1 max-h-48 overflow-y-auto bg-slate-800 border border-slate-700 rounded-lg shadow-lg">
                                    <div className="px-3 py-1 text-[9px] text-slate-500 border-b border-slate-700">
                                        {filteredClusters.length} cluster(s) available
                                    </div>
                                    {filteredClusters.length === 0 ? (
                                        <div className="px-3 py-2 text-xs text-slate-500">No clusters found</div>
                                    ) : (
                                        filteredClusters.slice(0, 100).map(c => (
                                            <button
                                                key={c.name}
                                                onClick={() => {
                                                    setSelectedClusterName(c.name);
                                                    setClusterSearch('');
                                                    setIsClusterSearching(false);
                                                    setShowClusterDropdown(false);
                                                }}
                                                className={`w-full px-3 py-1.5 text-left text-xs hover:bg-slate-700 ${c.name === selectedClusterName ? 'bg-indigo-600/30 text-indigo-300' : 'text-white'
                                                    }`}
                                            >
                                                {c.displayName}
                                                <span className="ml-1 text-slate-500">({c.name})</span>
                                            </button>
                                        ))
                                    )}
                                </div>
                            )}
                        </div>
                        <button
                            onClick={() => setIsAddingCluster(true)}
                            className="text-[10px] text-indigo-400 hover:text-indigo-300 mt-1 flex items-center gap-1"
                        >
                            <Plus size={10} /> Add Custom
                        </button>
                    </div>

                    {/* Add Custom Cluster Modal/Inline */}
                    {isAddingCluster && (
                        <div className="bg-slate-800 p-3 rounded-lg border border-slate-700 mb-3 animate-in fade-in slide-in-from-top-2">
                            <div className="flex gap-2 mb-2">
                                <input
                                    type="text"
                                    placeholder="Hex ID"
                                    value={newClusterId}
                                    onChange={e => setNewClusterId(e.target.value)}
                                    className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-white"
                                />
                                <input
                                    type="text"
                                    placeholder="Name"
                                    value={newClusterName}
                                    onChange={e => setNewClusterName(e.target.value)}
                                    className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-white"
                                />
                            </div>
                            <div className="flex justify-end gap-2">
                                <button onClick={() => setIsAddingCluster(false)} className="px-2 py-1 text-xs text-slate-400 hover:text-white">Cancel</button>
                                <button onClick={handleSaveCustomCluster} className="px-2 py-1 bg-indigo-600 rounded text-xs text-white hover:bg-indigo-500">Save</button>
                            </div>
                        </div>
                    )}
                </div>

                {/* 2. Action Tabs */}
                <div className="flex border-b border-slate-800">
                    {(['read', 'write', 'invoke'] as const).map(tab => (
                        <button
                            key={tab}
                            onClick={() => setActiveTab(tab)}
                            className={`flex-1 py-2.5 text-[10px] font-bold uppercase tracking-wider transition-all ${activeTab === tab
                                ? 'text-indigo-400 border-b-2 border-indigo-500 bg-indigo-500/5'
                                : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800/50'
                                }`}
                        >
                            {tab === 'invoke' ? 'Cmd' : tab}
                        </button>
                    ))}
                </div>

                {/* 3. Parameters */}
                <div className="p-3 flex-1 overflow-y-auto space-y-3">
                    {/* Attribute/Command Selector */}
                    <div>
                        <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1">
                            {activeTab === 'invoke' ? 'Command' : 'Attribute'}
                            {isLoadingDetails && <Loader2 size={10} className="inline ml-1 animate-spin" />}
                        </label>
                        <div className="flex gap-2">
                            <div className="relative flex-1">
                                <input
                                    type="text"
                                    value={activeTab === 'invoke'
                                        ? (cmdSearch || selectedCommandName || '')
                                        : (attrSearch || selectedAttributeName || '')}
                                    onChange={(e) => {
                                        if (activeTab === 'invoke') {
                                            setCmdSearch(e.target.value);
                                            setShowCmdDropdown(true);
                                        } else {
                                            setAttrSearch(e.target.value);
                                            setShowAttrDropdown(true);
                                        }
                                    }}
                                    onFocus={() => {
                                        if (activeTab === 'invoke') {
                                            setCmdSearch('');
                                            setShowCmdDropdown(true);
                                        } else {
                                            setAttrSearch('');
                                            setShowAttrDropdown(true);
                                        }
                                    }}
                                    onBlur={() => setTimeout(() => {
                                        setShowCmdDropdown(false);
                                        setShowAttrDropdown(false);
                                    }, 200)}
                                    placeholder={`Search ${activeTab === 'invoke' ? 'command' : 'attribute'}...`}
                                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                                    disabled={!!customId}
                                />
                                <Search size={12} className="absolute right-3 top-2.5 text-slate-400 pointer-events-none" />

                                {/* Attribute Dropdown */}
                                {showAttrDropdown && activeTab !== 'invoke' && (
                                    <div className="absolute z-50 w-full mt-1 max-h-40 overflow-y-auto bg-slate-800 border border-slate-700 rounded-lg shadow-lg">
                                        {filteredAttributes.length === 0 ? (
                                            <div className="px-3 py-2 text-xs text-slate-500">No attributes found</div>
                                        ) : (
                                            filteredAttributes.map(a => (
                                                <button
                                                    key={a.name}
                                                    onClick={() => {
                                                        setSelectedAttributeName(a.name);
                                                        setAttrSearch('');
                                                        setShowAttrDropdown(false);
                                                    }}
                                                    className={`w-full px-3 py-1.5 text-left text-xs hover:bg-slate-700 ${a.name === selectedAttributeName ? 'bg-indigo-600/30 text-indigo-300' : 'text-white'
                                                        }`}
                                                >
                                                    {a.displayName}
                                                </button>
                                            ))
                                        )}
                                    </div>
                                )}

                                {/* Command Dropdown */}
                                {showCmdDropdown && activeTab === 'invoke' && (
                                    <div className="absolute z-50 w-full mt-1 max-h-40 overflow-y-auto bg-slate-800 border border-slate-700 rounded-lg shadow-lg">
                                        {filteredCommands.length === 0 ? (
                                            <div className="px-3 py-2 text-xs text-slate-500">No commands found</div>
                                        ) : (
                                            filteredCommands.map(c => (
                                                <button
                                                    key={c.name}
                                                    onClick={() => {
                                                        setSelectedCommandName(c.name);
                                                        setCmdSearch('');
                                                        setShowCmdDropdown(false);
                                                    }}
                                                    className={`w-full px-3 py-1.5 text-left text-xs hover:bg-slate-700 ${c.name === selectedCommandName ? 'bg-indigo-600/30 text-indigo-300' : 'text-white'
                                                        }`}
                                                >
                                                    {c.displayName}
                                                </button>
                                            ))
                                        )}
                                    </div>
                                )}
                            </div>
                            <input
                                type="text"
                                placeholder="Custom"
                                value={customId}
                                onChange={e => setCustomId(e.target.value)}
                                className="w-16 bg-slate-800 border border-slate-700 rounded-lg px-2 py-2 text-xs text-white focus:border-indigo-500"
                                title="Enter custom attribute/command name"
                            />
                        </div>
                    </div>

                    {/* Write Value */}
                    {activeTab === 'write' && (
                        <div>
                            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1">Value</label>
                            <input
                                type="text"
                                value={writeValue}
                                onChange={e => setWriteValue(e.target.value)}
                                placeholder="Enter value..."
                                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:border-indigo-500"
                            />
                        </div>
                    )}

                    {/* Command Args */}
                    {activeTab === 'invoke' && (
                        <div>
                            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1">Args (comma sep.)</label>
                            <input
                                type="text"
                                value={commandArgs}
                                onChange={e => setCommandArgs(e.target.value)}
                                placeholder="arg1, arg2..."
                                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:border-indigo-500"
                            />
                        </div>
                    )}

                    {/* Execute Button */}
                    <button
                        onClick={handleExecute}
                        disabled={isExecuting}
                        className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-xs font-bold text-white transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-indigo-900/20"
                    >
                        {isExecuting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                        Execute
                    </button>
                </div>
            </div>

            {/* 右侧：Output + Log */}
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
                {/* Output 区域 - 占据大部分空间 */}
                <div className="flex-1 flex flex-col p-4 overflow-hidden">
                    <div className="flex items-center justify-between mb-2">
                        <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Output</label>
                        <div className="flex items-center gap-2">
                            {lastResult && (
                                <>
                                    <button
                                        onClick={() => {
                                            navigator.clipboard.writeText(lastResult);
                                            onLog('Output copied to clipboard', 'success');
                                        }}
                                        className="text-[10px] text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                                        title="Copy to clipboard"
                                    >
                                        <Copy size={10} />
                                        Copy
                                    </button>
                                    <button
                                        onClick={() => setLastResult(null)}
                                        className="text-[10px] text-slate-500 hover:text-red-400"
                                    >
                                        Clear
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                    <div className="flex-1 bg-slate-950 rounded-lg p-4 border border-slate-800 overflow-y-auto select-text cursor-text">
                        {lastResult ? (
                            <pre className="text-xs font-mono text-slate-300 whitespace-pre-wrap break-all leading-relaxed select-text">
                                {lastResult}
                            </pre>
                        ) : (
                            <div className="flex items-center justify-center h-full text-slate-600 text-xs">
                                <span>Execute a command to see output...</span>
                            </div>
                        )}
                    </div>
                </div>

                {/* Interaction Log - 底部可折叠面板 */}
                <div className="h-28 border-t border-slate-800 bg-slate-950/50 flex-shrink-0">
                    <div className="px-3 py-1.5 border-b border-slate-800 flex justify-between items-center">
                        <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Interaction Log</span>
                        <div className="flex items-center gap-2">
                            {interactionLog.length > 0 && (
                                <button
                                    onClick={() => {
                                        navigator.clipboard.writeText(interactionLog.join('\n'));
                                        onLog('Log copied to clipboard', 'success');
                                    }}
                                    className="text-[9px] text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                                    title="Copy all logs"
                                >
                                    <Copy size={9} />
                                    Copy
                                </button>
                            )}
                            <button
                                onClick={onClearLog}
                                className="text-[9px] text-slate-500 hover:text-red-400"
                            >
                                Clear
                            </button>
                        </div>
                    </div>
                    <div className="h-[calc(100%-28px)] overflow-y-auto p-2 font-mono text-[9px] text-slate-400 space-y-0.5 select-text cursor-text">
                        {interactionLog.map((log, i) => (
                            <div key={i} className={`select-text ${log.includes('✗') ? 'text-red-400' : log.includes('✓') ? 'text-emerald-400' : ''}`}>
                                {log}
                            </div>
                        ))}
                        {interactionLog.length === 0 && (
                            <span className="text-slate-600">No interactions yet...</span>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
