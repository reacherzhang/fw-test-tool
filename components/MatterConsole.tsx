
import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { Wifi, Radio, Search, Link2, Power, RefreshCw, ChevronRight, AlertCircle, CheckCircle2, Loader2, Settings, Zap, Plus, Edit3, Trash2 } from 'lucide-react';
import { GlobalLogEntry } from '../types';

interface MatterConsoleProps {
    onLog?: (log: Omit<GlobalLogEntry, 'id' | 'timestamp'>) => void;
}

interface DiscoveredDevice {
    id: string;
    name: string;
    discriminator: number;
    vendorId?: string;
    productId?: string;
    deviceType?: number;
    addresses: string[];
    port?: number;
}

interface CommissionedDevice {
    nodeId: string;
    name: string;
    endpoints: number[];
    online: boolean;
}

type CommissioningStage = 'idle' | 'connecting' | 'configuring' | 'joining' | 'complete' | 'error';

export const MatterConsole: React.FC<MatterConsoleProps> = ({ onLog }) => {
    const [matterInitialized, setMatterInitialized] = useState(false);
    const [isInitializing, setIsInitializing] = useState(false);
    const [isScanning, setIsScanning] = useState(false);
    const [scanProgress, setScanProgress] = useState({ elapsed: 0, total: 30 });
    const [discoveredDevices, setDiscoveredDevices] = useState<DiscoveredDevice[]>([]);
    const [commissionedDevices, setCommissionedDevices] = useState<CommissionedDevice[]>([]);
    const [selectedDevice, setSelectedDevice] = useState<DiscoveredDevice | null>(null);

    // 扫描过滤条件
    const [filterDiscriminator, setFilterDiscriminator] = useState('');

    // Commissioning 相关状态
    const [showCommissionModal, setShowCommissionModal] = useState(false);
    const [setupCode, setSetupCode] = useState('');
    const [pairingMode, setPairingMode] = useState<'ble-wifi' | 'ble-thread'>('ble-wifi');
    const [wifiSsid, setWifiSsid] = useState('');
    const [wifiPassword, setWifiPassword] = useState('');
    const [threadDataset, setThreadDataset] = useState('');
    const [commissioningStage, setCommissioningStage] = useState<CommissioningStage>('idle');
    const [commissioningMessage, setCommissioningMessage] = useState('');

    // 配网成功后的设备命名
    const [showNamingModal, setShowNamingModal] = useState(false);
    const [newDeviceName, setNewDeviceName] = useState('');
    const [newDeviceNodeId, setNewDeviceNodeId] = useState<number | null>(null);
    const [isSavingName, setIsSavingName] = useState(false);


    // SSH 配置 - 多条目管理
    const [showSshConfig, setShowSshConfig] = useState(false);
    const [sshConfigs, setSshConfigs] = useState<Array<{
        id: string;
        name: string;
        host: string;
        port: number;
        username: string;
        password: string;
        chipToolPath: string;
        paaTrustStorePath: string;
    }>>([]);
    const [selectedSshId, setSelectedSshId] = useState<string | null>(null);
    const [editingSshConfig, setEditingSshConfig] = useState<{
        id?: string;
        name: string;
        host: string;
        port: number;
        username: string;
        password: string;
        chipToolPath: string;
        paaTrustStorePath: string;
    } | null>(null);
    const [sshTestResult, setSshTestResult] = useState<string | null>(null);
    const [isSshTesting, setIsSshTesting] = useState(false);
    const [useRemoteCommissioning, setUseRemoteCommissioning] = useState(true);

    // 获取当前选中的 SSH 配置
    const selectedSshConfig = sshConfigs.find(c => c.id === selectedSshId) || sshConfigs[0];

    // 初始化 Matter Controller
    const handleInitialize = async () => {
        setIsInitializing(true);
        try {
            const result = await window.electronAPI?.matterInit();
            if (result?.success) {
                setMatterInitialized(true);
                onLog?.({
                    type: 'MATTER',
                    direction: 'SYS',
                    label: 'Matter Controller Initialized',
                    detail: 'Ready to discover and commission devices'
                });
            } else {
                throw new Error(result?.error || 'Unknown error');
            }
        } catch (error: any) {
            onLog?.({
                type: 'MATTER',
                direction: 'ERR',
                label: 'Matter Init Failed',
                detail: error.message
            });
        } finally {
            setIsInitializing(false);
        }
    };

    // 扫描 Matter 设备
    const handleScan = async () => {
        if (!matterInitialized) {
            await handleInitialize();
        }

        setIsScanning(true);
        setDiscoveredDevices([]);
        setScanProgress({ elapsed: 0, total: 30 });

        // 启动进度更新定时器
        const progressTimer = setInterval(() => {
            setScanProgress(prev => ({
                ...prev,
                elapsed: Math.min(prev.elapsed + 1, prev.total)
            }));
        }, 1000);

        try {
            const scanOptions: { discriminator?: number; timeout: number } = {
                timeout: 30  // 30 秒扫描
            };

            // 如果输入了 discriminator，添加过滤
            if (filterDiscriminator.trim()) {
                const disc = parseInt(filterDiscriminator.trim(), 10);
                if (!isNaN(disc)) {
                    scanOptions.discriminator = disc;
                }
            }

            onLog?.({
                type: 'MATTER',
                direction: 'TX',
                label: 'Scanning for Matter Devices (BLE)',
                detail: `Timeout: 30s${scanOptions.discriminator ? `\nFilter Discriminator: ${scanOptions.discriminator}` : '\nNo filter (scanning all)'}`
            });

            const result = await window.electronAPI?.matterDiscover(scanOptions);

            if (result?.success && result.devices) {
                setDiscoveredDevices(result.devices);
                onLog?.({
                    type: 'MATTER',
                    direction: 'RX',
                    label: `Found ${result.devices.length} Device(s)`,
                    detail: result.devices.length > 0
                        ? JSON.stringify(result.devices, null, 2)
                        : result.message || 'No devices found'
                });
            } else {
                onLog?.({
                    type: 'MATTER',
                    direction: 'SYS',
                    label: 'Scan Complete',
                    detail: result?.message || result?.error || 'No devices found'
                });
            }
        } catch (error: any) {
            onLog?.({
                type: 'MATTER',
                direction: 'ERR',
                label: 'Scan Failed',
                detail: error.message
            });
        } finally {
            clearInterval(progressTimer);
            setIsScanning(false);
        }
    };

    // 获取已配网设备
    const handleGetCommissioned = async () => {
        try {
            const result = await window.electronAPI?.matterDevices();
            if (result?.success && result.devices) {
                setCommissionedDevices(result.devices);
            }
        } catch (error: any) {
            console.error('Failed to get commissioned devices:', error);
        }
    };

    // 开始配网流程
    const startCommissioning = (device: DiscoveredDevice) => {
        setSelectedDevice(device);
        setShowCommissionModal(true);
        setCommissioningStage('idle');
        setCommissioningMessage('');
        setSetupCode('');
        setWifiSsid('');
        setWifiPassword('');
    };

    // 执行配网
    const handleCommission = async () => {
        if (!selectedDevice || !setupCode) return;

        setCommissioningStage('connecting');
        setCommissioningMessage('Establishing secure connection...');

        try {
            onLog?.({
                type: 'MATTER',
                direction: 'TX',
                label: `Commissioning: ${selectedDevice.name}`,
                detail: `Setup Code: ${setupCode}\nWiFi SSID: ${wifiSsid || 'N/A'}`
            });

            const result = await window.electronAPI?.matterCommission({
                deviceId: selectedDevice.id,
                setupCode,
                wifiCredentials: wifiSsid ? { ssid: wifiSsid, password: wifiPassword } : undefined
            });

            if (result?.success) {
                setCommissioningStage('complete');
                setCommissioningMessage(`Device commissioned! Node ID: ${result.nodeId}`);
                onLog?.({
                    type: 'MATTER',
                    direction: 'SYS',
                    label: 'Commissioning Complete',
                    detail: `Node ID: ${result.nodeId}`
                });
                // 刷新已配网设备列表
                await handleGetCommissioned();
            } else {
                throw new Error(result?.error || 'Commissioning failed');
            }
        } catch (error: any) {
            setCommissioningStage('error');
            setCommissioningMessage(error.message);
            onLog?.({
                type: 'MATTER',
                direction: 'ERR',
                label: 'Commissioning Failed',
                detail: error.message
            });
        }
    };

    // 监听配网进度
    useEffect(() => {
        window.electronAPI?.onMatterCommissioningProgress?.((data) => {
            setCommissioningStage(data.stage as CommissioningStage);
            setCommissioningMessage(data.message);
        });

        // 监听扫描进度
        const handleScanProgress = (data: { elapsed: number; total: number; devicesFound: number }) => {
            setScanProgress({ elapsed: data.elapsed, total: data.total });
        };

        // 注意：需要在 preload.js 中添加 onMatterScanProgress
        // 这里先用定时器模拟进度更新
    }, []);

    // 初始化时检查 Matter 状态
    useEffect(() => {
        (async () => {
            const status = await window.electronAPI?.matterStatus();
            setMatterInitialized(status?.initialized || false);
            if (status?.initialized) {
                await handleGetCommissioned();
            }

            // 加载 SSH 配置
            const sshResult = await window.electronAPI?.matterGetSshConfigs();
            if (sshResult?.success && sshResult.configs) {
                setSshConfigs(sshResult.configs.map((c: any) => ({
                    ...c,
                    paaTrustStorePath: c.paaTrustStorePath || '/var/paa-root-certs/'
                })));
                setSelectedSshId(sshResult.selectedId || null);
            }
        })();
    }, []);

    // 测试 SSH 连接
    const handleTestSsh = async () => {
        if (!editingSshConfig) return;
        setIsSshTesting(true);
        setSshTestResult(null);
        try {
            const result = await window.electronAPI?.matterTestSshConnection(editingSshConfig as any);
            if (result?.success) {
                setSshTestResult('✓ Connection successful: ' + (result.output || ''));
            } else {
                setSshTestResult('✗ Failed: ' + (result?.error || 'Unknown error'));
            }
        } catch (error: any) {
            setSshTestResult('✗ Error: ' + error.message);
        } finally {
            setIsSshTesting(false);
        }
    };

    // 保存 SSH 配置
    const handleSaveSshConfig = async () => {
        if (!editingSshConfig) return;

        if (editingSshConfig.id) {
            // 更新现有配置
            await window.electronAPI?.matterSaveSshConfig(editingSshConfig as any);
        } else {
            // 添加新配置
            await window.electronAPI?.matterAddSshConfig(editingSshConfig as any);
        }

        // 重新加载
        const result = await window.electronAPI?.matterGetSshConfigs();
        if (result?.success && result.configs) {
            setSshConfigs(result.configs.map((c: any) => ({
                ...c,
                paaTrustStorePath: c.paaTrustStorePath || '/var/paa-root-certs/'
            })));
            setSelectedSshId(result.selectedId || null);
        }

        setEditingSshConfig(null);
        onLog?.({
            type: 'MATTER',
            direction: 'SYS',
            label: 'SSH Config Saved',
            detail: `Host: ${editingSshConfig.host}, User: ${editingSshConfig.username}`
        });
    };

    // 删除 SSH 配置
    const handleDeleteSshConfig = async (configId: string) => {
        await window.electronAPI?.matterDeleteSshConfig(configId);
        const result = await window.electronAPI?.matterGetSshConfigs();
        if (result?.success && result.configs) {
            setSshConfigs(result.configs.map((c: any) => ({
                id: c.id || '',
                name: c.name || '',
                host: c.host,
                port: c.port,
                username: c.username,
                password: c.password,
                chipToolPath: c.chipToolPath,
                paaTrustStorePath: c.paaTrustStorePath || '/var/paa-root-certs/'
            })));
            setSelectedSshId(result.selectedId || null);
        }
    };

    // 选择 SSH 配置
    const handleSelectSshConfig = async (configId: string) => {
        await window.electronAPI?.matterSelectSshConfig(configId);
        setSelectedSshId(configId);
    };

    // 远程配网 (通过 SSH)
    const handleRemoteCommission = async () => {
        if (!selectedDevice || !selectedSshConfig) return;

        setCommissioningStage('connecting');
        setCommissioningMessage(`Starting remote commissioning via SSH (${pairingMode})...`);

        try {
            const result = await window.electronAPI?.matterCommissionViaSSH({
                sshConfig: selectedSshConfig as any,
                commissionParams: {
                    deviceId: selectedDevice.id,
                    discriminator: selectedDevice.discriminator,
                    setupCode: setupCode,
                    pairingMode: pairingMode,
                    wifiSsid: pairingMode === 'ble-wifi' ? (wifiSsid || undefined) : undefined,
                    wifiPassword: pairingMode === 'ble-wifi' ? (wifiPassword || undefined) : undefined,
                    threadDataset: pairingMode === 'ble-thread' ? (threadDataset || undefined) : undefined
                }
            });

            if (result?.success) {
                setCommissioningStage('complete');
                setCommissioningMessage(`Commissioning successful! Node ID: ${result.nodeId}`);
                onLog?.({
                    type: 'MATTER',
                    direction: 'RX',
                    label: 'Remote Commissioning Complete',
                    detail: `Node ID: ${result.nodeId}`
                });

                // 配网成功后，显示命名弹窗
                if (result.nodeId) {
                    setNewDeviceNodeId(result.nodeId);
                    setNewDeviceName(`Matter Device ${result.nodeId}`);
                    // 延迟显示命名弹窗，让用户先看到成功消息
                    setTimeout(() => {
                        setShowCommissionModal(false);
                        setShowNamingModal(true);
                    }, 1500);
                }
            } else {
                throw new Error(result?.error || 'Remote commissioning failed');
            }
        } catch (error: any) {
            setCommissioningStage('error');
            setCommissioningMessage(error.message);
            onLog?.({
                type: 'MATTER',
                direction: 'ERR',
                label: 'Remote Commissioning Failed',
                detail: error.message
            });
        }
    };

    // 保存设备名称
    const handleSaveDeviceName = async () => {
        if (!newDeviceNodeId || !newDeviceName.trim()) return;

        setIsSavingName(true);
        try {
            const result = await window.electronAPI?.matterUpdateDeviceName(newDeviceNodeId, newDeviceName.trim());
            if (result?.success) {
                onLog?.({
                    type: 'MATTER',
                    direction: 'SYS',
                    label: 'Device Named',
                    detail: `Node ${newDeviceNodeId} named as "${newDeviceName.trim()}"`
                });
                // 刷新设备列表
                await handleGetCommissioned();
                // 关闭弹窗
                setShowNamingModal(false);
                setNewDeviceNodeId(null);
                setNewDeviceName('');
            } else {
                throw new Error(result?.error || 'Failed to save name');
            }
        } catch (error: any) {
            onLog?.({
                type: 'MATTER',
                direction: 'ERR',
                label: 'Failed to Save Name',
                detail: error.message
            });
        } finally {
            setIsSavingName(false);
        }
    };

    return (
        <div className="bg-slate-900/60 rounded-2xl border border-slate-800 shadow-xl overflow-hidden backdrop-blur-xl">
            {/* Header */}
            <div className="bg-slate-950/40 px-4 py-3 border-b border-slate-800 flex justify-between items-center">
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2">
                        <Zap size={16} className="text-amber-400" />
                        <span className="text-xs font-black text-white uppercase tracking-widest">Matter Console</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${matterInitialized ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
                        <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">
                            {matterInitialized ? 'Ready' : 'Not Initialized'}
                        </span>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    {!matterInitialized && (
                        <button
                            onClick={handleInitialize}
                            disabled={isInitializing}
                            className="flex items-center gap-2 px-3 py-1.5 bg-amber-600 hover:bg-amber-500 rounded-lg text-[10px] font-bold text-white transition-all disabled:opacity-50"
                        >
                            {isInitializing ? <Loader2 size={12} className="animate-spin" /> : <Power size={12} />}
                            Initialize
                        </button>
                    )}
                    {!isScanning ? (
                        <button
                            onClick={handleScan}
                            className="flex items-center gap-2 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-[10px] font-bold text-white transition-all"
                        >
                            <Search size={12} />
                            Scan (30s)
                        </button>
                    ) : (
                        <button
                            onClick={async () => {
                                await window.electronAPI?.matterStopScan();
                            }}
                            className="flex items-center gap-2 px-3 py-1.5 bg-red-600 hover:bg-red-500 rounded-lg text-[10px] font-bold text-white transition-all"
                        >
                            <Loader2 size={12} className="animate-spin" />
                            Stop Scan
                        </button>
                    )}
                    <button
                        onClick={() => setShowSshConfig(true)}
                        className="flex items-center gap-2 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-[10px] font-bold text-white transition-all"
                        title="SSH Configuration for Remote Commissioning"
                    >
                        <Settings size={12} />
                        SSH
                    </button>
                </div>
            </div>

            {/* 扫描过滤选项 */}
            <div className="px-4 py-3 bg-slate-950/30 border-b border-slate-800">
                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                        <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest whitespace-nowrap">
                            Discriminator Filter:
                        </label>
                        <input
                            type="text"
                            value={filterDiscriminator}
                            onChange={(e) => setFilterDiscriminator(e.target.value)}
                            placeholder="e.g. 3840"
                            className="w-24 px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-white text-xs focus:border-amber-500 outline-none font-mono"
                            disabled={isScanning}
                        />
                    </div>
                    <p className="text-[9px] text-slate-600 flex-1">
                        {filterDiscriminator.trim()
                            ? `Only devices with discriminator ${filterDiscriminator} will be shown`
                            : 'Leave empty to scan all Matter devices'
                        }
                    </p>
                </div>

                {/* 扫描进度 */}
                {isScanning && (
                    <div className="mt-3">
                        <div className="flex justify-between text-[10px] text-slate-500 mb-1">
                            <span>Scanning via BLE...</span>
                            <span>{scanProgress.elapsed}s / {scanProgress.total}s</span>
                        </div>
                        <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-gradient-to-r from-indigo-500 to-amber-500 transition-all duration-1000"
                                style={{ width: `${(scanProgress.elapsed / scanProgress.total) * 100}%` }}
                            />
                        </div>
                    </div>
                )}
            </div>

            {/* Content */}
            <div className="p-4 space-y-4 max-h-[400px] overflow-y-auto custom-scrollbar">
                {/* 发现的设备 */}
                {discoveredDevices.length > 0 && (
                    <div>
                        <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">
                            Discovered Devices ({discoveredDevices.length})
                        </h3>
                        <div className="space-y-2">
                            {discoveredDevices.map(device => (
                                <div
                                    key={device.id}
                                    className="bg-slate-950/50 border border-slate-800 rounded-xl p-3 flex items-center justify-between hover:border-amber-500/50 transition-colors"
                                >
                                    <div className="flex items-center gap-3">
                                        <div className="w-10 h-10 bg-amber-600/20 rounded-full flex items-center justify-center">
                                            <Radio size={18} className="text-amber-400" />
                                        </div>
                                        <div>
                                            <p className="text-sm font-bold text-white">{device.name}</p>
                                            <p className="text-[10px] text-slate-500 font-mono">
                                                Discriminator: {device.discriminator} | VID: {device.vendorId || 'N/A'}
                                            </p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => startCommissioning(device)}
                                        className="flex items-center gap-2 px-3 py-2 bg-emerald-600/10 hover:bg-emerald-600 border border-emerald-500/20 hover:border-emerald-500 rounded-lg text-emerald-400 hover:text-white text-[10px] font-bold transition-all"
                                    >
                                        <Link2 size={12} />
                                        Commission
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* 已配网设备 */}
                {commissionedDevices.length > 0 && (
                    <div>
                        <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">
                            Commissioned Devices ({commissionedDevices.length})
                        </h3>
                        <div className="space-y-2">
                            {commissionedDevices.map(device => (
                                <div
                                    key={device.nodeId}
                                    className="bg-slate-950/50 border border-slate-800 rounded-xl p-3 flex items-center justify-between"
                                >
                                    <div className="flex items-center gap-3">
                                        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${device.online ? 'bg-emerald-600/20' : 'bg-slate-700/20'}`}>
                                            <Wifi size={18} className={device.online ? 'text-emerald-400' : 'text-slate-500'} />
                                        </div>
                                        <div>
                                            <p className="text-sm font-bold text-white">{device.name}</p>
                                            <p className="text-[10px] text-slate-500 font-mono">
                                                Node: {device.nodeId} | {device.online ? 'Online' : 'Offline'}
                                            </p>
                                        </div>
                                    </div>
                                    <ChevronRight size={16} className="text-slate-600" />
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* 空状态 */}
                {discoveredDevices.length === 0 && commissionedDevices.length === 0 && (
                    <div className="text-center py-8 text-slate-600">
                        <Radio size={40} className="mx-auto mb-3 opacity-30" />
                        <p className="text-xs font-bold">No Matter devices</p>
                        <p className="text-[10px] mt-1">Click "Scan" to discover nearby devices</p>
                    </div>
                )}
            </div>

            {/* 配网弹窗 - 使用 Portal 渲染到 body */}
            {showCommissionModal && selectedDevice && ReactDOM.createPortal(
                <div
                    className="fixed inset-0 flex items-center justify-center p-4"
                    style={{ zIndex: 99999 }}
                >
                    {/* 背景遮罩 */}
                    <div
                        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
                        onClick={() => {
                            setShowCommissionModal(false);
                            setCommissioningStage('idle');
                            setCommissioningMessage('');
                        }}
                    />

                    {/* 弹窗内容 */}
                    <div
                        className="relative bg-slate-900 border border-slate-600 rounded-2xl shadow-2xl w-full max-w-md"
                        style={{
                            maxHeight: 'calc(100vh - 40px)',
                            display: 'flex',
                            flexDirection: 'column'
                        }}
                    >
                        {/* Header - 固定 */}
                        <div className="p-4 border-b border-slate-700 bg-slate-900 rounded-t-2xl">
                            <h2 className="text-lg font-bold text-white">Commission Device</h2>
                            <p className="text-sm text-slate-400 mt-1 truncate">{selectedDevice.name}</p>
                            <div className="flex flex-wrap gap-2 mt-2 text-xs">
                                <span className="text-slate-500">ID: <span className="text-slate-300 font-mono">{selectedDevice.id?.substring(0, 12)}...</span></span>
                                <span className="text-amber-500">Discriminator: <span className="font-bold">{selectedDevice.discriminator || 'N/A'}</span></span>
                            </div>
                        </div>

                        {/* Content - 可滚动 */}
                        <div className="p-4 space-y-4 overflow-y-auto flex-1">
                            {commissioningStage === 'idle' && (
                                <>
                                    <div className="space-y-2">
                                        <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Setup Code *</label>
                                        <input
                                            type="text"
                                            value={setupCode}
                                            onChange={(e) => setSetupCode(e.target.value)}
                                            placeholder="e.g. 28479586"
                                            className="w-full px-4 py-3 bg-slate-950 border border-slate-600 rounded-xl text-white text-base font-mono focus:border-amber-500 outline-none"
                                        />
                                        <p className="text-xs text-slate-500">Enter the device's PIN code from its label</p>
                                    </div>

                                    {/* 配网模式选择 */}
                                    <div className="space-y-2">
                                        <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Pairing Mode</label>
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => setPairingMode('ble-wifi')}
                                                className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-all ${pairingMode === 'ble-wifi' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
                                            >
                                                📶 BLE + WiFi
                                            </button>
                                            <button
                                                onClick={() => setPairingMode('ble-thread')}
                                                className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-all ${pairingMode === 'ble-thread' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
                                            >
                                                🧵 BLE + Thread
                                            </button>
                                        </div>
                                    </div>

                                    {/* WiFi 配置 */}
                                    {pairingMode === 'ble-wifi' && (
                                        <>
                                            <div className="space-y-2">
                                                <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">WiFi SSID</label>
                                                <input
                                                    type="text"
                                                    value={wifiSsid}
                                                    onChange={(e) => setWifiSsid(e.target.value)}
                                                    placeholder="Network name"
                                                    className="w-full px-4 py-3 bg-slate-950 border border-slate-600 rounded-xl text-white text-base focus:border-amber-500 outline-none"
                                                />
                                            </div>

                                            <div className="space-y-2">
                                                <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">WiFi Password</label>
                                                <input
                                                    type="password"
                                                    value={wifiPassword}
                                                    onChange={(e) => setWifiPassword(e.target.value)}
                                                    placeholder="Network password"
                                                    className="w-full px-4 py-3 bg-slate-950 border border-slate-600 rounded-xl text-white text-base focus:border-amber-500 outline-none"
                                                />
                                            </div>
                                        </>
                                    )}

                                    {/* Thread 配置 */}
                                    {pairingMode === 'ble-thread' && (
                                        <div className="space-y-2">
                                            <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Thread Dataset (Hex)</label>
                                            <textarea
                                                value={threadDataset}
                                                onChange={(e) => setThreadDataset(e.target.value)}
                                                placeholder="0e080000000000010000000300000f4a..."
                                                rows={3}
                                                className="w-full px-4 py-3 bg-slate-950 border border-slate-600 rounded-xl text-white text-sm font-mono focus:border-amber-500 outline-none resize-none"
                                            />
                                            <p className="text-xs text-slate-500">Enter the Thread network dataset in hex format (without 'hex:' prefix)</p>
                                        </div>
                                    )}
                                </>
                            )}

                            {commissioningStage !== 'idle' && (
                                <div className="text-center py-6">
                                    {commissioningStage === 'complete' ? (
                                        <CheckCircle2 size={48} className="mx-auto mb-4 text-emerald-500" />
                                    ) : commissioningStage === 'error' ? (
                                        <AlertCircle size={48} className="mx-auto mb-4 text-red-500" />
                                    ) : (
                                        <Loader2 size={48} className="mx-auto mb-4 text-amber-500 animate-spin" />
                                    )}
                                    <div className={`text-sm font-medium max-h-32 overflow-y-auto ${commissioningStage === 'error' ? 'text-red-400' :
                                        commissioningStage === 'complete' ? 'text-emerald-400' : 'text-white'
                                        }`}>
                                        <p className="whitespace-pre-wrap break-words px-2">{commissioningMessage}</p>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Footer - 固定 */}
                        <div className="p-4 border-t border-slate-700 flex gap-3 bg-slate-900 rounded-b-2xl">
                            <button
                                onClick={() => {
                                    setShowCommissionModal(false);
                                    setCommissioningStage('idle');
                                    setCommissioningMessage('');
                                }}
                                className="flex-1 py-3 bg-slate-800 hover:bg-slate-700 rounded-xl text-slate-300 font-bold text-sm uppercase tracking-wider transition-all"
                            >
                                {commissioningStage === 'complete' || commissioningStage === 'error' ? 'Close' : 'Cancel'}
                            </button>
                            {commissioningStage === 'idle' && (
                                <button
                                    onClick={useRemoteCommissioning ? handleRemoteCommission : handleCommission}
                                    disabled={
                                        !setupCode ||
                                        (useRemoteCommissioning && !selectedSshConfig?.password) ||
                                        (pairingMode === 'ble-wifi' && (!wifiSsid || !wifiPassword)) ||
                                        (pairingMode === 'ble-thread' && !threadDataset)
                                    }
                                    className="flex-1 py-3 bg-amber-600 hover:bg-amber-500 rounded-xl text-white font-bold text-sm uppercase tracking-wider transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {useRemoteCommissioning ? '🔗 Remote Commission' : 'Start Commission'}
                                </button>
                            )}
                        </div>
                    </div>
                </div>,
                document.body
            )}

            {/* SSH 配置弹窗 - 多条目管理 */}
            {showSshConfig && ReactDOM.createPortal(
                <div
                    className="fixed inset-0 flex items-center justify-center p-4"
                    style={{ zIndex: 99999 }}
                >
                    <div
                        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
                        onClick={() => { setShowSshConfig(false); setEditingSshConfig(null); }}
                    />

                    <div className="relative bg-slate-900 border border-slate-600 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
                        <div className="p-4 border-b border-slate-700 flex justify-between items-center">
                            <div>
                                <h2 className="text-lg font-bold text-white">
                                    {editingSshConfig ? (editingSshConfig.id ? 'Edit SSH Configuration' : 'Add SSH Configuration') : 'SSH Configurations'}
                                </h2>
                                <p className="text-sm text-slate-400 mt-1">Manage Raspberry Pi connections for remote chip-tool</p>
                            </div>
                            {!editingSshConfig && (
                                <button
                                    onClick={() => setEditingSshConfig({
                                        name: '',
                                        host: '',
                                        port: 22,
                                        username: 'ubuntu',
                                        password: '',
                                        chipToolPath: '/home/ubuntu/apps/chip-tool',
                                        paaTrustStorePath: '/var/paa-root-certs/'
                                    })}
                                    className="flex items-center gap-2 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-xs font-bold text-white"
                                >
                                    <Plus size={14} /> Add New
                                </button>
                            )}
                        </div>

                        <div className="flex-1 overflow-y-auto p-4">
                            {editingSshConfig ? (
                                /* 编辑表单 */
                                <div className="space-y-4">
                                    <div className="space-y-2">
                                        <label className="text-xs font-bold text-slate-400 uppercase">Configuration Name</label>
                                        <input
                                            type="text"
                                            value={editingSshConfig.name}
                                            onChange={(e) => setEditingSshConfig(prev => prev ? { ...prev, name: e.target.value } : null)}
                                            placeholder="e.g., Raspberry Pi 4"
                                            className="w-full px-3 py-2 bg-slate-950 border border-slate-600 rounded-lg text-white text-sm"
                                        />
                                    </div>

                                    <div className="grid grid-cols-3 gap-4">
                                        <div className="col-span-2 space-y-2">
                                            <label className="text-xs font-bold text-slate-400 uppercase">Host IP</label>
                                            <input
                                                type="text"
                                                value={editingSshConfig.host}
                                                onChange={(e) => setEditingSshConfig(prev => prev ? { ...prev, host: e.target.value } : null)}
                                                placeholder="192.168.1.234"
                                                className="w-full px-3 py-2 bg-slate-950 border border-slate-600 rounded-lg text-white text-sm"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-xs font-bold text-slate-400 uppercase">Port</label>
                                            <input
                                                type="number"
                                                value={editingSshConfig.port}
                                                onChange={(e) => setEditingSshConfig(prev => prev ? { ...prev, port: parseInt(e.target.value) || 22 } : null)}
                                                className="w-full px-3 py-2 bg-slate-950 border border-slate-600 rounded-lg text-white text-sm"
                                            />
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-2">
                                            <label className="text-xs font-bold text-slate-400 uppercase">Username</label>
                                            <input
                                                type="text"
                                                value={editingSshConfig.username}
                                                onChange={(e) => setEditingSshConfig(prev => prev ? { ...prev, username: e.target.value } : null)}
                                                placeholder="ubuntu"
                                                className="w-full px-3 py-2 bg-slate-950 border border-slate-600 rounded-lg text-white text-sm"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-xs font-bold text-slate-400 uppercase">Password</label>
                                            <input
                                                type="password"
                                                value={editingSshConfig.password}
                                                onChange={(e) => setEditingSshConfig(prev => prev ? { ...prev, password: e.target.value } : null)}
                                                placeholder="••••••••"
                                                className="w-full px-3 py-2 bg-slate-950 border border-slate-600 rounded-lg text-white text-sm"
                                            />
                                        </div>
                                    </div>

                                    <div className="space-y-2">
                                        <label className="text-xs font-bold text-slate-400 uppercase">chip-tool Path</label>
                                        <input
                                            type="text"
                                            value={editingSshConfig.chipToolPath}
                                            onChange={(e) => setEditingSshConfig(prev => prev ? { ...prev, chipToolPath: e.target.value } : null)}
                                            placeholder="/home/ubuntu/apps/chip-tool"
                                            className="w-full px-3 py-2 bg-slate-950 border border-slate-600 rounded-lg text-white text-sm font-mono"
                                        />
                                    </div>

                                    <div className="space-y-2">
                                        <label className="text-xs font-bold text-slate-400 uppercase">PAA Trust Store Path</label>
                                        <input
                                            type="text"
                                            value={editingSshConfig.paaTrustStorePath}
                                            onChange={(e) => setEditingSshConfig(prev => prev ? { ...prev, paaTrustStorePath: e.target.value } : null)}
                                            placeholder="/var/paa-root-certs/"
                                            className="w-full px-3 py-2 bg-slate-950 border border-slate-600 rounded-lg text-white text-sm font-mono"
                                        />
                                    </div>

                                    {sshTestResult && (
                                        <div className={`p-3 rounded-lg text-sm ${sshTestResult.startsWith('✓') ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                                            {sshTestResult}
                                        </div>
                                    )}
                                </div>
                            ) : (
                                /* 配置列表 */
                                <div className="space-y-3">
                                    {sshConfigs.length === 0 ? (
                                        <div className="text-center py-8">
                                            <Settings size={32} className="mx-auto mb-3 text-slate-600" />
                                            <p className="text-sm text-slate-400">No SSH configurations yet</p>
                                            <p className="text-xs text-slate-500 mt-1">Click "Add New" to create one</p>
                                        </div>
                                    ) : (
                                        sshConfigs.map(config => (
                                            <div
                                                key={config.id}
                                                onClick={() => handleSelectSshConfig(config.id)}
                                                className={`p-4 rounded-xl border cursor-pointer transition-all hover:border-amber-500/30 ${selectedSshId === config.id ? 'bg-amber-600/10 border-amber-500/50' : 'bg-slate-800/50 border-slate-700 hover:bg-slate-800'}`}
                                            >
                                                <div className="flex items-center justify-between">
                                                    <div className="flex items-center gap-3">
                                                        <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${selectedSshId === config.id ? 'border-amber-500 bg-amber-500' : 'border-slate-500'}`}>
                                                            {selectedSshId === config.id && (
                                                                <div className="w-1.5 h-1.5 rounded-full bg-white" />
                                                            )}
                                                        </div>
                                                        <div>
                                                            <p className={`font-bold ${selectedSshId === config.id ? 'text-amber-400' : 'text-white'}`}>{config.name || 'Unnamed'}</p>
                                                            <p className="text-xs text-slate-400 font-mono">{config.username}@{config.host}:{config.port}</p>
                                                        </div>
                                                    </div>
                                                    <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                                                        <button
                                                            onClick={() => {
                                                                setEditingSshConfig({ ...config });
                                                                setSshTestResult(null);
                                                            }}
                                                            className="p-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-slate-300"
                                                            title="Edit"
                                                        >
                                                            <Edit3 size={14} />
                                                        </button>
                                                        <button
                                                            onClick={() => handleDeleteSshConfig(config.id)}
                                                            className="p-2 bg-red-600/20 hover:bg-red-600/40 rounded-lg text-red-400"
                                                            title="Delete"
                                                        >
                                                            <Trash2 size={14} />
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            )}
                        </div>

                        <div className="p-4 border-t border-slate-700 flex gap-3">
                            {editingSshConfig ? (
                                <>
                                    <button
                                        onClick={() => { setEditingSshConfig(null); setSshTestResult(null); }}
                                        className="flex-1 py-2.5 bg-slate-800 hover:bg-slate-700 rounded-xl text-slate-300 font-bold text-sm"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={handleTestSsh}
                                        disabled={isSshTesting || !editingSshConfig.host || !editingSshConfig.username}
                                        className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 rounded-xl text-white font-bold text-sm disabled:opacity-50"
                                    >
                                        {isSshTesting ? <Loader2 size={16} className="animate-spin" /> : 'Test'}
                                    </button>
                                    <button
                                        onClick={handleSaveSshConfig}
                                        disabled={!editingSshConfig.name || !editingSshConfig.host}
                                        className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-white font-bold text-sm disabled:opacity-50"
                                    >
                                        Save
                                    </button>
                                </>
                            ) : (
                                <button
                                    onClick={() => setShowSshConfig(false)}
                                    className="flex-1 py-2.5 bg-slate-800 hover:bg-slate-700 rounded-xl text-slate-300 font-bold text-sm"
                                >
                                    Close
                                </button>
                            )}
                        </div>
                    </div>
                </div>,
                document.body
            )}

            {/* 设备命名弹窗 */}
            {showNamingModal && newDeviceNodeId && ReactDOM.createPortal(
                <div
                    className="fixed inset-0 flex items-center justify-center p-4"
                    style={{ zIndex: 99999 }}
                >
                    <div
                        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
                        onClick={() => {
                            // 不允许点击外部关闭，必须输入名称
                        }}
                    />

                    <div className="relative bg-slate-900 border border-emerald-500/50 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
                        <div className="p-4 border-b border-slate-700 bg-emerald-950/30">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 bg-emerald-500/20 rounded-full flex items-center justify-center">
                                    <CheckCircle2 size={24} className="text-emerald-400" />
                                </div>
                                <div>
                                    <h2 className="text-lg font-bold text-white">Device Commissioned!</h2>
                                    <p className="text-sm text-slate-400">Node ID: {newDeviceNodeId}</p>
                                </div>
                            </div>
                        </div>

                        <div className="p-4 space-y-4">
                            <div className="space-y-2">
                                <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                                    Name Your Device *
                                </label>
                                <input
                                    type="text"
                                    value={newDeviceName}
                                    onChange={(e) => setNewDeviceName(e.target.value)}
                                    placeholder="e.g., Living Room Light"
                                    className="w-full px-4 py-3 bg-slate-950 border border-slate-600 rounded-xl text-white text-base focus:border-emerald-500 outline-none"
                                    autoFocus
                                />
                                <p className="text-xs text-slate-500">
                                    Give your device a memorable name for easy identification
                                </p>
                            </div>
                        </div>

                        <div className="p-4 border-t border-slate-700 flex gap-3">
                            <button
                                onClick={() => {
                                    handleSaveDeviceName();
                                }}
                                disabled={isSavingName || !newDeviceName.trim()}
                                className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-white font-bold text-sm uppercase tracking-wider transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                            >
                                {isSavingName ? (
                                    <>
                                        <Loader2 size={16} className="animate-spin" />
                                        Saving...
                                    </>
                                ) : (
                                    <>
                                        <CheckCircle2 size={16} />
                                        Save & Continue
                                    </>
                                )}
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
};
