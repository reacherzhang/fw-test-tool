import React, { useState, useEffect, useCallback } from 'react';
import {
    X, Search, Wifi, WifiOff, Plus, Loader2, RefreshCw,
    CheckCircle, XCircle, AlertCircle, Radio, Zap
} from 'lucide-react';
import { CloudSession } from '../types';

interface DeviceDiscoveryModalProps {
    isOpen: boolean;
    onClose: () => void;
    session: CloudSession | null;
    onLog?: (log: { type: 'MATTER' | 'HTTP' | 'MQTT' | 'SYSTEM' | 'CUSTOM' | 'DISCOVERY'; direction: 'TX' | 'RX' | 'ERR' | 'SYS'; label: string; detail: string }) => void;
    onMatterCommission?: (device: DiscoveredDeviceState) => void;
}

interface DiscoveredDeviceState {
    name: string;
    host: string;
    port: number;
    ipv4: string;
    ipv6?: string;
    allAddresses?: string[];
    txt?: Record<string, string>;
    discoveredAt?: string;
    // HAP 设备字段
    checkStatus: 'pending' | 'checking' | 'done' | 'error' | 'skip';
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
    checkError?: string;
    bindStatus?: 'idle' | 'binding' | 'success' | 'error';
    bindError?: string;
    // Matter 设备字段
    isMatter?: boolean;
    discriminator?: string;
    vendorId?: string;
    productId?: string;
    commissioningMode?: string;
    deviceType?: string;
    pairingHint?: string;
    pairingInstruction?: string;
}

const DeviceDiscoveryModal: React.FC<DeviceDiscoveryModalProps> = ({
    isOpen,
    onClose,
    session,
    onLog,
    onMatterCommission
}) => {
    const [isScanning, setIsScanning] = useState(false);
    const [devices, setDevices] = useState<DiscoveredDeviceState[]>([]);
    const [scanDuration, setScanDuration] = useState(0);

    // 使用 ref 存储 onLog，避免因为 onLog 引用变化导致 addLog 不稳定
    const onLogRef = React.useRef(onLog);
    React.useEffect(() => {
        onLogRef.current = onLog;
    }, [onLog]);

    // 添加日志 - 使用稳定的引用
    const addLog = useCallback((direction: 'TX' | 'RX' | 'ERR' | 'SYS', label: string, detail: string) => {
        onLogRef.current?.({ type: 'DISCOVERY', direction, label, detail });
    }, []); // 空依赖，函数引用永远稳定

    // 开始扫描
    const startScan = useCallback(async () => {
        setIsScanning(true);
        setDevices([]);
        setScanDuration(0);
        addLog('SYS', 'Discovery Started', 'Scanning for HAP and Matter devices...');

        try {
            await window.electronAPI?.discoveryStart();
        } catch (error: any) {
            addLog('ERR', 'Discovery Error', error.message);
            setIsScanning(false);
        }
    }, [addLog]);

    // 停止扫描
    const stopScan = useCallback(async () => {
        setIsScanning(false);
        addLog('SYS', 'Discovery Stopped', `Found ${devices.length} devices`);

        try {
            await window.electronAPI?.discoveryStop();
        } catch (error: any) {
            addLog('ERR', 'Stop Error', error.message);
        }
    }, [devices.length, addLog]);

    // 检查设备绑定状态
    const checkDeviceBindStatus = useCallback(async (device: DiscoveredDeviceState) => {
        setDevices(prev => prev.map(d =>
            d.ipv4 === device.ipv4 ? { ...d, checkStatus: 'checking' } : d
        ));

        addLog('TX', 'Check Bind Status', `Querying ${device.ipv4}...`);

        try {
            const result = await window.electronAPI?.discoveryCheckBindStatus({
                ip: device.ipv4,
                session
            });

            if (result?.success) {
                addLog('RX', 'Bind Status Response', `canBind: ${result.canBind}, bindId: ${result.bindId || 'empty'}, who: ${result.who}`);

                setDevices(prev => prev.map(d =>
                    d.ipv4 === device.ipv4 ? {
                        ...d,
                        checkStatus: 'done',
                        canBind: result.canBind,
                        bindId: result.bindId,
                        who: result.who,
                        deviceInfo: result.deviceInfo
                    } : d
                ));
            } else {
                const errorMsg = typeof result?.error === 'object' ? JSON.stringify(result.error) : String(result?.error || 'Unknown error');
                addLog('ERR', 'Check Failed', errorMsg);

                setDevices(prev => prev.map(d =>
                    d.ipv4 === device.ipv4 ? {
                        ...d,
                        checkStatus: 'error',
                        checkError: errorMsg
                    } : d
                ));
            }
        } catch (error: any) {
            const errorMsg = typeof error === 'object' ? (error.message || JSON.stringify(error)) : String(error);
            addLog('ERR', 'Check Error', errorMsg);

            setDevices(prev => prev.map(d =>
                d.ipv4 === device.ipv4 ? {
                    ...d,
                    checkStatus: 'error',
                    checkError: errorMsg
                } : d
            ));
        }
    }, [session, addLog]);

    // 绑定设备
    const bindDevice = useCallback(async (device: DiscoveredDeviceState) => {
        setDevices(prev => prev.map(d =>
            d.ipv4 === device.ipv4 ? { ...d, bindStatus: 'binding' } : d
        ));

        addLog('TX', 'Bind Device', `Sending config to ${device.ipv4}...`);

        try {
            const result = await window.electronAPI?.discoveryBindDevice({
                ip: device.ipv4,
                session
            });

            if (result?.success) {
                addLog('RX', 'Bind Success', `Device ${device.name} bound successfully`);

                setDevices(prev => prev.map(d =>
                    d.ipv4 === device.ipv4 ? {
                        ...d,
                        bindStatus: 'success',
                        canBind: false
                    } : d
                ));
            } else {
                addLog('ERR', 'Bind Failed', result?.error || 'Unknown error');

                setDevices(prev => prev.map(d =>
                    d.ipv4 === device.ipv4 ? {
                        ...d,
                        bindStatus: 'error',
                        bindError: result?.error
                    } : d
                ));
            }
        } catch (error: any) {
            addLog('ERR', 'Bind Error', error.message);

            setDevices(prev => prev.map(d =>
                d.ipv4 === device.ipv4 ? {
                    ...d,
                    bindStatus: 'error',
                    bindError: typeof error === 'object' ? (error.message || JSON.stringify(error)) : String(error)
                } : d
            ));
        }
    }, [session, addLog]);

    // 监听发现事件
    useEffect(() => {
        if (!isOpen) return;

        const handleDeviceEvent = (data: { event: string; device: any }) => {
            console.log('[DeviceDiscoveryModal] Received device event:', data.event, data.device);
            if (data.event === 'found' || data.event === 'matter_found') {
                const isMatter = data.event === 'matter_found';
                const newDevice: DiscoveredDeviceState = {
                    ...data.device,
                    checkStatus: isMatter ? 'skip' : 'pending',
                    bindStatus: 'idle',
                    isMatter
                };

                setDevices(prev => {
                    // 避免重复
                    const exists = prev.find(d =>
                        isMatter ? d.name === newDevice.name : d.ipv4 === newDevice.ipv4
                    );
                    if (exists) {
                        return prev;
                    }
                    return [...prev, newDevice];
                });

                addLog('RX', `${isMatter ? 'Matter' : 'HAP'} Device Found`, `${data.device.name} @ ${data.device.ipv4}`);
            } else if (data.event === 'down' || data.event === 'matter_down') {
                setDevices(prev => prev.filter(d => d.name !== data.device.name));
                addLog('SYS', `${data.event.startsWith('matter') ? 'Matter' : 'HAP'} Device Offline`, data.device.name);
            }
        };

        window.electronAPI?.onDiscoveryDevice(handleDeviceEvent);

        return () => {
            window.electronAPI?.removeDiscoveryDeviceListener();
        };
    }, [isOpen, addLog]);

    // 扫描计时器
    useEffect(() => {
        if (!isScanning) return;

        const timer = setInterval(() => {
            setScanDuration(prev => prev + 1);
        }, 1000);

        return () => clearInterval(timer);
    }, [isScanning]);

    // 打开时自动开始扫描
    useEffect(() => {
        if (isOpen) {
            startScan();
        } else {
            stopScan();
        }
    }, [isOpen]);

    // 发现设备后自动检查绑定状态
    useEffect(() => {
        devices.forEach(device => {
            if (device.checkStatus === 'pending' && !device.isMatter) {
                checkDeviceBindStatus(device);
            }
        });
    }, [devices, checkDeviceBindStatus]);

    if (!isOpen) return null;

    // Debug log
    console.log('[DeviceDiscoveryModal] Rendering, devices:', devices.length, 'isScanning:', isScanning);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-2xl bg-slate-900 rounded-2xl border border-slate-700 shadow-2xl overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700 bg-slate-950/50">
                    <div className="flex items-center gap-3">
                        <div className={`p-2 rounded-lg ${isScanning ? 'bg-emerald-500/20' : 'bg-slate-700'}`}>
                            <Radio size={20} className={isScanning ? 'text-emerald-400 animate-pulse' : 'text-slate-400'} />
                        </div>
                        <div>
                            <h2 className="text-lg font-bold text-white">Device Discovery</h2>
                            <p className="text-xs text-slate-400">
                                {isScanning ? `Scanning... ${scanDuration}s` : 'Scan for devices on your network'}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={isScanning ? stopScan : startScan}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-all ${isScanning
                                ? 'bg-red-600 hover:bg-red-500 text-white'
                                : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                                }`}
                        >
                            {isScanning ? (
                                <>
                                    <Loader2 size={16} className="animate-spin" />
                                    Stop Scan
                                </>
                            ) : (
                                <>
                                    <Search size={16} />
                                    Start Scan
                                </>
                            )}
                        </button>
                        <button
                            onClick={onClose}
                            className="p-2 hover:bg-slate-700 rounded-lg transition-colors"
                        >
                            <X size={20} className="text-slate-400" />
                        </button>
                    </div>
                </div>

                {/* Device List */}
                <div className="p-4 max-h-[60vh] overflow-y-auto">
                    {devices.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-16 text-center">
                            {isScanning ? (
                                <>
                                    <Loader2 size={48} className="text-indigo-400 animate-spin mb-4" />
                                    <p className="text-slate-400">Searching for devices...</p>
                                    <p className="text-xs text-slate-500 mt-1">Make sure your devices are powered on</p>
                                </>
                            ) : (
                                <>
                                    <WifiOff size={48} className="text-slate-600 mb-4" />
                                    <p className="text-slate-400">No devices found</p>
                                    <p className="text-xs text-slate-500 mt-1">Click "Start Scan" to search for devices</p>
                                </>
                            )}
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {devices.map(device => (
                                <div
                                    key={device.isMatter ? `matter-${device.name}` : `hap-${device.ipv4}`}
                                    className="bg-slate-800/50 rounded-xl border border-slate-700 p-4 hover:border-slate-600 transition-all"
                                >
                                    <div className="flex items-start justify-between">
                                        <div className="flex items-start gap-3">
                                            <div className={`p-2 rounded-lg ${device.isMatter
                                                ? 'bg-amber-500/20'
                                                : device.checkStatus === 'done' && device.canBind
                                                    ? 'bg-emerald-500/20'
                                                    : device.checkStatus === 'error'
                                                        ? 'bg-red-500/20'
                                                        : 'bg-slate-700'
                                                }`}>
                                                {device.isMatter ? (
                                                    <Zap size={20} className="text-amber-400" />
                                                ) : (
                                                    <Wifi size={20} className={
                                                        device.checkStatus === 'done' && device.canBind
                                                            ? 'text-emerald-400'
                                                            : device.checkStatus === 'error'
                                                                ? 'text-red-400'
                                                                : 'text-slate-400'
                                                    } />
                                                )}
                                            </div>
                                            <div>
                                                <h3 className="text-sm font-bold text-white">{device.name}</h3>
                                                <p className="text-xs text-slate-400 font-mono">{device.ipv4}:{device.port}</p>

                                                {/* Device Info */}
                                                {device.deviceInfo && (
                                                    <div className="mt-2 space-y-1">
                                                        {device.deviceInfo.type && typeof device.deviceInfo.type === 'string' && (
                                                            <p className="text-xs text-slate-500">
                                                                Type: <span className="text-slate-400">{device.deviceInfo.type}</span>
                                                            </p>
                                                        )}
                                                        {device.deviceInfo.mac && typeof device.deviceInfo.mac === 'string' && (
                                                            <p className="text-xs text-slate-500">
                                                                MAC: <span className="text-slate-400 font-mono">{device.deviceInfo.mac}</span>
                                                            </p>
                                                        )}
                                                        {device.deviceInfo.firmware && typeof device.deviceInfo.firmware === 'string' && (
                                                            <p className="text-xs text-slate-500">
                                                                Firmware: <span className="text-slate-400">{device.deviceInfo.firmware}</span>
                                                            </p>
                                                        )}
                                                    </div>
                                                )}

                                                {/* Matter Info */}
                                                {device.isMatter && (
                                                    <div className="mt-2 space-y-1">
                                                        <div className="flex items-center gap-2">
                                                            <span className="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 text-[10px] font-black uppercase tracking-wider border border-amber-500/20">Matter</span>
                                                            {device.vendorId && (
                                                                <span className="text-[10px] text-slate-500 font-mono">VID:{device.vendorId} PID:{device.productId}</span>
                                                            )}
                                                        </div>
                                                        {device.ipv6 && (
                                                            <p className="text-[10px] text-slate-500 font-mono truncate max-w-[200px]">IPv6: {device.ipv6}</p>
                                                        )}
                                                    </div>
                                                )}

                                                {/* Bind Status Info */}
                                                {device.checkStatus === 'done' && (
                                                    <div className="mt-2">
                                                        {device.bindId ? (
                                                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${device.who === 2
                                                                ? 'bg-amber-500/20 text-amber-400'
                                                                : 'bg-slate-600/50 text-slate-400'
                                                                }`}>
                                                                {device.who === 2 ? 'Shared (who=2)' : `Bound to ${device.bindId}`}
                                                            </span>
                                                        ) : (
                                                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-emerald-500/20 text-emerald-400">
                                                                <CheckCircle size={12} />
                                                                Available
                                                            </span>
                                                        )}
                                                    </div>
                                                )}

                                                {/* Error */}
                                                {device.checkStatus === 'error' && (
                                                    <p className="mt-2 text-xs text-red-400">{device.checkError}</p>
                                                )}

                                                {device.bindStatus === 'error' && (
                                                    <p className="mt-2 text-xs text-red-400">{device.bindError}</p>
                                                )}
                                            </div>
                                        </div>

                                        {/* Actions */}
                                        <div className="flex items-center gap-2">
                                            {device.checkStatus === 'checking' && (
                                                <Loader2 size={16} className="text-indigo-400 animate-spin" />
                                            )}

                                            {device.checkStatus === 'done' && device.canBind && device.bindStatus !== 'success' && (
                                                <button
                                                    onClick={() => bindDevice(device)}
                                                    disabled={device.bindStatus === 'binding'}
                                                    className="flex items-center gap-2 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-xs font-bold text-white transition-all disabled:opacity-50"
                                                >
                                                    {device.bindStatus === 'binding' ? (
                                                        <Loader2 size={14} className="animate-spin" />
                                                    ) : (
                                                        <Plus size={14} />
                                                    )}
                                                    Add
                                                </button>
                                            )}

                                            {device.bindStatus === 'success' && (
                                                <span className="flex items-center gap-1 px-3 py-1.5 bg-emerald-500/20 rounded-lg text-xs font-bold text-emerald-400">
                                                    <CheckCircle size={14} />
                                                    Added
                                                </span>
                                            )}

                                            {device.checkStatus === 'error' && (
                                                <button
                                                    onClick={() => checkDeviceBindStatus(device)}
                                                    className="flex items-center gap-2 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-xs font-bold text-slate-300 transition-all"
                                                >
                                                    <RefreshCw size={14} />
                                                    Retry
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-6 py-3 border-t border-slate-700 bg-slate-950/30">
                    <div className="flex items-center justify-between text-xs text-slate-500">
                        <span>{devices.length} device{devices.length !== 1 ? 's' : ''} found</span>
                        <span>Scanning for _hap._tcp and _matter._tcp services</span>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default DeviceDiscoveryModal;
