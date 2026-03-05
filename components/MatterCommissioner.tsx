/**
 * MatterCommissioner 组件
 * Commissioner 模式的完整 UI，支持：
 * - 初始化 CommissioningController
 * - BLE + mDNS 设备发现
 * - BLE-WiFi / BLE-Thread 配网
 * - 已配网设备管理
 * - 属性读写、命令调用
 * - 实时事件订阅
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
    Zap, Wifi, Radio, Search, Plus, Trash2, RefreshCw, Power, PowerOff,
    ChevronRight, ChevronDown, ChevronUp, Activity, Eye, Pencil, Send, Loader2,
    CheckCircle, XCircle, X, AlertCircle, Link, Unlink, Settings, Maximize2, Copy, Radar, Terminal
} from 'lucide-react';

interface MatterCommissionerProps {
    onLog: (log: { type: string; direction: string; label: string; detail: string }) => void;
}

// 日志条目
interface LogEntry {
    id: string;
    timestamp: string;
    stage: string;
    message: string;
    type: 'info' | 'success' | 'error' | 'progress';
}

export const MatterCommissioner: React.FC<MatterCommissionerProps> = ({ onLog }) => {
    // ===== 状态 =====

    // Commissioner 状态
    const [isInitialized, setIsInitialized] = useState(false);
    const [isInitializing, setIsInitializing] = useState(false);
    const [bleAvailable, setBleAvailable] = useState(false);

    // 设备发现
    const [discoveredDevices, setDiscoveredDevices] = useState<CommissionerDiscoveredDevice[]>([]);
    const [isDiscovering, setIsDiscovering] = useState(false);
    const [discriminatorFilter, setDiscriminatorFilter] = useState('');
    const [discoveryTimeout, setDiscoveryTimeout] = useState(30);

    // 配网
    const [selectedDevice, setSelectedDevice] = useState<CommissionerDiscoveredDevice | null>(null);
    const [pairingMode, setPairingMode] = useState<'ble-wifi' | 'ble-thread'>('ble-wifi');
    const [passcode, setPasscode] = useState('');
    const [wifiSsid, setWifiSsid] = useState('');
    const [wifiPassword, setWifiPassword] = useState('');
    const [threadDataset, setThreadDataset] = useState('');
    const [isCommissioning, setIsCommissioning] = useState(false);

    // 已配网设备
    const [commissionedNodes, setCommissionedNodes] = useState<CommissionerNode[]>([]);
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [nodeStructure, setNodeStructure] = useState<any>(null);
    const [isLoadingStructure, setIsLoadingStructure] = useState(false);
    const [isScanningThread, setIsScanningThread] = useState(false);
    const nodeStructureCache = useRef<Record<string, any>>({});
    const fullStructureCache = useRef<Record<string, any>>({});

    // 属性操作
    const [attrEndpoint, setAttrEndpoint] = useState('');
    const [attrCluster, setAttrCluster] = useState('');
    const [attrId, setAttrId] = useState('');
    const [attrValue, setAttrValue] = useState('');
    const [lastReadResult, setLastReadResult] = useState<any>(null);
    const [isOperating, setIsOperating] = useState(false);

    // PICS 及高级结构
    const [fullStructure, setFullStructure] = useState<any>(null); // 从 Auto Fetch 获得
    const [picsOptions, setPicsOptions] = useState<any>(null); // 从 XML 获得
    const [isReadingAll, setIsReadingAll] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // 日志
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const logRef = useRef<HTMLDivElement>(null);
    const [modalLogs, setModalLogs] = useState<LogEntry[]>([]);
    const modalLogRef = useRef<HTMLDivElement>(null);

    // UI 折叠状态
    const [showCommissioningPanel, setShowCommissioningPanel] = useState(false);
    const [showDetailModal, setShowDetailModal] = useState(false);
    const [copiedDetail, setCopiedDetail] = useState(false);

    // ===== 辅助函数 =====

    const addLog = useCallback((stage: string, message: string, type: LogEntry['type'] = 'info') => {
        const entry: LogEntry = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            timestamp: new Date().toLocaleTimeString('en-GB', { hour12: false }),
            stage,
            message,
            type,
        };
        setLogs(prev => [...prev.slice(-499), entry]);

        const isOuterLog =
            stage === 'state' ||
            stage === 'event' ||
            stage === 'read' ||
            stage === 'write' ||
            stage === 'invoke' ||
            (message && (message.includes('state: reconnecting') || message.includes('state: connected')));

        if (!isOuterLog) {
            setModalLogs(prev => [...prev.slice(-499), entry]);
        }
    }, []);

    // 自动滚动日志
    useEffect(() => {
        if (logRef.current) {
            logRef.current.scrollTop = logRef.current.scrollHeight;
        }
    }, [logs]);

    useEffect(() => {
        if (modalLogRef.current) {
            modalLogRef.current.scrollTop = modalLogRef.current.scrollHeight;
        }
    }, [modalLogs]);

    // ===== 初始化 =====

    const handleInitialize = async () => {
        setIsInitializing(true);
        addLog('init', 'Initializing Commissioner...', 'progress');
        onLog({ type: 'MATTER', direction: 'TX', label: 'Commissioner Init', detail: 'Starting CommissioningController...' });

        try {
            const result = await window.electronAPI?.commissionerInit();
            if (result?.success) {
                setIsInitialized(true);
                setBleAvailable(result.bleAvailable || false);
                addLog('init', `Commissioner initialized. BLE: ${result.bleAvailable ? '✓' : '✗'}. ${result.commissionedNodeCount || 0} existing node(s).`, 'success');
                onLog({ type: 'MATTER', direction: 'RX', label: 'Commissioner Ready', detail: result.message || 'Initialized' });

                // 自动加载已配网设备
                await loadCommissionedNodes();
            } else {
                addLog('init', `Init failed: ${result?.error || 'Unknown error'}`, 'error');
                onLog({ type: 'MATTER', direction: 'ERR', label: 'Commissioner Init Failed', detail: result?.error || 'Unknown' });
            }
        } catch (e: any) {
            addLog('init', `Error: ${e.message}`, 'error');
        }
        setIsInitializing(false);
    };

    // ===== 设备发现 =====

    const handleDiscover = async () => {
        if (!isInitialized) {
            addLog('discover', 'Commissioner not initialized', 'error');
            return;
        }

        setIsDiscovering(true);
        setDiscoveredDevices([]);
        addLog('discover', `Scanning for ${discoveryTimeout}s...`, 'progress');

        // 设置实时发现回调
        window.electronAPI?.onCommissionerDeviceDiscovered((device: CommissionerDiscoveredDevice) => {
            setDiscoveredDevices(prev => {
                if (prev.some(d => d.id === device.id)) return prev;
                return [...prev, device];
            });
            addLog('discover', `Found: ${device.deviceName} (disc: ${device.discriminator}, via: ${device.discoveredVia})`, 'info');
        });

        try {
            const options: any = { timeoutSeconds: discoveryTimeout };
            if (discriminatorFilter) {
                options.discriminator = parseInt(discriminatorFilter);
            }

            const result = await window.electronAPI?.commissionerDiscover(options);

            if (result?.success) {
                addLog('discover', `Discovery complete. Found ${result.devices?.length || 0} device(s)`, 'success');
            } else {
                addLog('discover', `Discovery error: ${result?.error}`, 'error');
            }
        } catch (e: any) {
            addLog('discover', `Error: ${e.message}`, 'error');
        }

        setIsDiscovering(false);
    };

    const handleStopDiscovery = async () => {
        try {
            await window.electronAPI?.commissionerStopDiscovery();
            setIsDiscovering(false);
            addLog('discover', 'Discovery stopped', 'info');
        } catch (e: any) {
            addLog('discover', `Stop error: ${e.message}`, 'error');
        }
    };

    // ===== 配网 =====

    const handleCommission = async () => {
        if (!passcode) {
            addLog('commission', 'Please enter passcode', 'error');
            return;
        }

        if (pairingMode === 'ble-wifi' && (!wifiSsid || !wifiPassword)) {
            addLog('commission', 'WiFi SSID and password required', 'error');
            return;
        }

        if (pairingMode === 'ble-thread' && !threadDataset) {
            addLog('commission', 'Thread dataset required', 'error');
            return;
        }

        setIsCommissioning(true);
        addLog('commission', `Starting ${pairingMode} commissioning...`, 'progress');

        // 监听配网进度
        window.electronAPI?.onCommissionerCommissioningProgress((data: { stage: string; message: string }) => {
            addLog(data.stage, data.message, data.stage === 'error' ? 'error' : data.stage === 'complete' ? 'success' : 'progress');
        });

        try {
            const params: any = {
                passcode,
                pairingMode,
            };

            if (selectedDevice?.discriminator != null) {
                params.discriminator = selectedDevice.discriminator;
            } else if (discriminatorFilter) {
                params.discriminator = parseInt(discriminatorFilter);
            }

            if (pairingMode === 'ble-wifi') {
                params.wifiSsid = wifiSsid;
                params.wifiPassword = wifiPassword;
            } else {
                params.threadDataset = threadDataset;
            }

            // 如果有已知地址
            if (selectedDevice?.addresses?.length && selectedDevice.port) {
                params.knownAddress = {
                    ip: selectedDevice.addresses[0],
                    port: selectedDevice.port,
                };
            }

            const result = await window.electronAPI?.commissionerCommission(params);

            if (result?.success) {
                addLog('commission', `✓ Commissioned successfully! Node ID: ${result.nodeId}`, 'success');
                onLog({ type: 'MATTER', direction: 'RX', label: 'Commissioner: Device Commissioned', detail: `Node ID: ${result.nodeId}, Network: ${result.networkType}` });

                // 刷新已配网设备列表
                await loadCommissionedNodes();

                // 清空配网表单
                setPasscode('');
                setSelectedDevice(null);
            } else {
                addLog('commission', `✗ Failed: ${result?.error}`, 'error');
                onLog({ type: 'MATTER', direction: 'ERR', label: 'Commissioning Failed', detail: result?.error || 'Unknown' });

                // Display scanned Thread networks if available (helps debug Thread commissioning)
                if (result?.scannedThreadNetworks?.length) {
                    addLog('thread-scan', `📡 Device found ${result.scannedThreadNetworks.length} Thread networks nearby:`, 'info');
                    result.scannedThreadNetworks.forEach((n: any, i: number) => {
                        addLog('thread-scan', `  ${i + 1}. ${n.networkName} | Ch:${n.channel} | PAN:0x${n.panId?.toString(16)} | RSSI:${n.rssi}dBm | LQI:${n.lqi}`, 'info');
                    });
                    addLog('thread-scan', `⚠️ Ensure your Thread Dataset matches one of the above networks.`, 'error');
                }
            }
        } catch (e: any) {
            addLog('commission', `Error: ${e.message}`, 'error');
        }

        setIsCommissioning(false);
    };

    const handleScanThread = async () => {
        if (!passcode) {
            addLog('thread-scan', 'Setup Passcode is required to establish a secure connection before scanning!', 'error');
            setModalLogs(prev => [...prev, {
                id: Date.now().toString(),
                timestamp: new Date().toLocaleTimeString('en-GB'),
                stage: 'thread-scan',
                message: 'Error: Cannot scan networks without a Setup Passcode.',
                type: 'error'
            }]);
            return;
        }

        setIsScanningThread(true);
        addLog('thread-scan', 'Scanning for nearby Thread networks (This may take roughly 10s)...', 'progress');
        setModalLogs(prev => [...prev, {
            id: Date.now().toString(),
            timestamp: new Date().toLocaleTimeString('en-GB'),
            stage: 'thread-scan',
            message: 'Starting Discovery of nearby Thread routers...',
            type: 'info'
        }]);

        try {
            const params: any = { passcode };
            if (selectedDevice?.discriminator != null) {
                params.discriminator = selectedDevice.discriminator;
            } else if (discriminatorFilter) {
                params.discriminator = parseInt(discriminatorFilter);
            }
            if (selectedDevice?.addresses?.length && selectedDevice.port) {
                params.knownAddress = {
                    ip: selectedDevice.addresses[0],
                    port: selectedDevice.port,
                };
            }

            const result = await window.electronAPI?.commissionerScanThreadNetworks(params);
            if (result?.success) {
                const networks = result.scannedThreadNetworks || [];
                addLog('thread-scan', `Scan complete. Found ${networks.length} Thread networks.`, 'success');
                if (networks.length > 0) {
                    networks.forEach((n: any, i: number) => {
                        addLog('thread-scan', `  [Network ${i + 1}] ${n.networkName} | Channel:${n.channel} | PAN:0x${n.panId?.toString(16)} | RSSI:${n.rssi}dBm | LQI:${n.lqi}`, 'info');
                    });
                } else {
                    addLog('thread-scan', 'No Thread networks found nearby', 'info');
                }
            } else {
                addLog('thread-scan', `Scan failed: ${result?.error}`, 'error');
            }
        } catch (e: any) {
            addLog('thread-scan', `Error: ${e.message}`, 'error');
        }
        setIsScanningThread(false);
    };

    const handleCancelCommissioning = async () => {
        if (!isCommissioning) return;

        addLog('commission', 'Cancelling commissioning...', 'progress');
        try {
            const result = await window.electronAPI?.commissionerCancelCommissioning();
            if (result?.success) {
                addLog('commission', 'Commissioning cancelled successfully', 'info');
                setIsCommissioning(false);
            } else {
                addLog('commission', `Failed to cancel: ${result?.error}`, 'error');
            }
        } catch (e: any) {
            addLog('commission', `Error cancelling: ${e.message}`, 'error');
        }
    };

    // ===== 已配网设备管理 =====

    const loadCommissionedNodes = async () => {
        try {
            const result = await window.electronAPI?.commissionerGetNodes();
            if (result?.success) {
                setCommissionedNodes(result.nodes || []);
            }
        } catch (e: any) {
            addLog('nodes', `Load error: ${e.message}`, 'error');
        }
    };

    const handleConnectNode = async (nodeId: string) => {
        addLog('connect', `Connecting to node ${nodeId}...`, 'progress');
        try {
            const result = await window.electronAPI?.commissionerConnectNode(nodeId);
            if (result?.success) {
                addLog('connect', `Node ${nodeId} connected`, 'success');

                // 订阅事件
                await window.electronAPI?.commissionerSubscribeNode(nodeId);

                // 加载结构
                await loadNodeStructure(nodeId);
                await loadCommissionedNodes();
            } else {
                addLog('connect', `Connect failed: ${result?.error}`, 'error');
            }
        } catch (e: any) {
            addLog('connect', `Error: ${e.message}`, 'error');
        }
    };

    const handleDisconnectNode = async (nodeId: string) => {
        try {
            await window.electronAPI?.commissionerDisconnectNode(nodeId);
            addLog('connect', `Node ${nodeId} disconnected`, 'info');
            await loadCommissionedNodes();
            if (selectedNodeId === nodeId) {
                setNodeStructure(null);
                setFullStructure(null); // Clear full structure
            }
        } catch (e: any) {
            addLog('connect', `Disconnect error: ${e.message}`, 'error');
        }
    };

    const handleRemoveNode = async (nodeId: string) => {
        if (!confirm(`Remove node ${nodeId} from fabric? This cannot be undone.`)) return;

        addLog('remove', `Removing node ${nodeId}...`, 'progress');
        try {
            const result = await window.electronAPI?.commissionerRemoveNode(nodeId);
            if (result?.success) {
                addLog('remove', `Node ${nodeId} removed`, 'success');
                if (selectedNodeId === nodeId) {
                    setSelectedNodeId(null);
                    setNodeStructure(null);
                    setFullStructure(null);
                }
                await loadCommissionedNodes();
            } else {
                addLog('remove', `Remove failed: ${result?.error}`, 'error');
            }
        } catch (e: any) {
            addLog('remove', `Error: ${e.message}`, 'error');
        }
    };

    const loadNodeStructure = async (nodeId: string, showLoading = true) => {
        // Show cached data immediately if available
        const cached = nodeStructureCache.current[nodeId];
        if (cached) {
            setNodeStructure(cached);
            // Also restore cached fullStructure for this node
            setFullStructure(fullStructureCache.current[nodeId] || null);
        }
        if (showLoading && !cached) setIsLoadingStructure(true);
        try {
            const result = await window.electronAPI?.commissionerGetNodeStructure(nodeId);
            if (result?.success) {
                nodeStructureCache.current[nodeId] = result;
                setNodeStructure(result);
                if (!cached) addLog('structure', `Loaded structure for node ${nodeId}: ${result.endpoints?.length || 0} endpoint(s)`, 'info');
            } else {
                if (!cached) addLog('structure', `Failed: ${result?.error}`, 'error');
            }
        } catch (e: any) {
            if (!cached) addLog('structure', `Error: ${e.message}`, 'error');
        }
        setIsLoadingStructure(false);
    };

    const handleReadAllAttributes = async () => {
        if (!selectedNodeId) return;
        setIsReadingAll(true);
        addLog('readAll', `Fetching all endpoints, clusters, and attributes for node ${selectedNodeId}...`, 'progress');

        try {
            const result = await window.electronAPI?.commissionerReadAllAttributes(selectedNodeId);
            if (result?.success) {
                setFullStructure(result.data);
                // Cache fullStructure per node
                fullStructureCache.current[selectedNodeId] = result.data;
                addLog('readAll', `Successfully fetched full structure!`, 'success');
            } else {
                addLog('readAll', `Failed: ${result?.error}`, 'error');
            }
        } catch (e: any) {
            addLog('readAll', `Error: ${e.message}`, 'error');
        }
        setIsReadingAll(false);
    };

    const handlePicsUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const xml = ev.target?.result as string;
                const parser = new DOMParser();
                const doc = parser.parseFromString(xml, "text/xml");

                // PICS XMLs have various structures. We will extract all <cluster> elements
                // and their child <attribute> or <command> elements.
                // We'll map them to endpoint 0 as PICS usually represents device capabilities,
                // not exact endpoint tree, but this allows dropdowns to work.
                const options: any = {
                    endpoints: [{ id: 0, clusters: [] }]
                };

                const clusters = doc.getElementsByTagName("cluster");
                for (let i = 0; i < clusters.length; i++) {
                    const cNode = clusters[i];
                    const name = cNode.getAttribute("name");
                    let idStr = cNode.getAttribute("id");
                    if (!idStr && name) idStr = name; // Fallback to name if no id

                    if (!idStr) continue;

                    let clusterId = parseInt(idStr, 16);
                    if (isNaN(clusterId)) clusterId = i + 1000; // Fake ID if completely missing

                    const clusterObj = {
                        id: clusterId,
                        name: name || `Cluster-${idStr}`,
                        attributes: [] as any[],
                        commands: [] as any[]
                    };

                    const attrs = cNode.getElementsByTagName("attribute");
                    for (let j = 0; j < attrs.length; j++) {
                        const aNode = attrs[j];
                        const aName = aNode.getAttribute("name") || aNode.getAttribute("desc") || undefined;
                        const aIdStr = aNode.getAttribute("id") || aNode.getAttribute("code");
                        if (aIdStr) {
                            clusterObj.attributes.push({
                                id: parseInt(aIdStr, 16) || aIdStr,
                                name: aName || `Attr-${aIdStr}`
                            });
                        }
                    }

                    const cmds = cNode.getElementsByTagName("command");
                    for (let j = 0; j < cmds.length; j++) {
                        const cmdNode = cmds[j];
                        const cName = cmdNode.getAttribute("name") || cmdNode.getAttribute("desc") || undefined;
                        const cIdStr = cmdNode.getAttribute("id") || cmdNode.getAttribute("code");
                        if (cIdStr) {
                            clusterObj.commands.push({
                                id: parseInt(cIdStr, 16) || cIdStr,
                                name: cName || `Cmd-${cIdStr}`
                            });
                        }
                    }

                    options.endpoints[0].clusters.push(clusterObj);
                }

                setPicsOptions(options);
                addLog('pics', `Parsed PICS file: ${file.name} successfully`, 'success');
            } catch (err: any) {
                addLog('pics', `XML Parse Error: ${err.message}`, 'error');
            }
        };
        reader.readAsText(file);
    };

    // ===== 属性/命令操作 =====

    const handleReadAttribute = async () => {
        if (!selectedNodeId || !attrEndpoint || !attrCluster || !attrId) {
            addLog('read', 'Please fill in all fields', 'error');
            return;
        }

        setIsOperating(true);
        try {
            const result = await window.electronAPI?.commissionerReadAttribute({
                nodeId: selectedNodeId,
                endpointId: parseInt(attrEndpoint),
                clusterId: parseInt(attrCluster),
                attributeId: parseInt(attrId),
            });

            if (result?.success) {
                setLastReadResult(result.value);
                addLog('read', `Attr ${attrEndpoint}/${attrCluster}/${attrId} = ${JSON.stringify(result.value)}`, 'success');
                onLog({ type: 'MATTER', direction: 'RX', label: 'Commissioner Read', detail: `Node ${selectedNodeId}, EP ${attrEndpoint}, Cluster 0x${parseInt(attrCluster).toString(16)}, Attr ${attrId} = ${JSON.stringify(result.value)}` });
            } else {
                addLog('read', `Read failed: ${result?.error}`, 'error');
            }
        } catch (e: any) {
            addLog('read', `Error: ${e.message}`, 'error');
        }
        setIsOperating(false);
    };

    const handleWriteAttribute = async () => {
        if (!selectedNodeId || !attrEndpoint || !attrCluster || !attrId) {
            addLog('write', 'Please fill in all fields', 'error');
            return;
        }

        setIsOperating(true);
        try {
            let value: any = attrValue;
            try { value = JSON.parse(attrValue); } catch { /* use as string */ }

            const result = await window.electronAPI?.commissionerWriteAttribute({
                nodeId: selectedNodeId,
                endpointId: parseInt(attrEndpoint),
                clusterId: parseInt(attrCluster),
                attributeId: parseInt(attrId),
                value,
            });

            if (result?.success) {
                addLog('write', `Written ${attrEndpoint}/${attrCluster}/${attrId} = ${attrValue}`, 'success');
            } else {
                addLog('write', `Write failed: ${result?.error}`, 'error');
            }
        } catch (e: any) {
            addLog('write', `Error: ${e.message}`, 'error');
        }
        setIsOperating(false);
    };

    const handleInvokeCommand = async () => {
        if (!selectedNodeId || !attrEndpoint || !attrCluster || !attrId) {
            addLog('invoke', 'Please fill in endpoint, cluster, and command ID', 'error');
            return;
        }

        setIsOperating(true);
        try {
            let args: any = {};
            if (attrValue) {
                try { args = JSON.parse(attrValue); } catch { /* empty */ }
            }

            const result = await window.electronAPI?.commissionerInvokeCommand({
                nodeId: selectedNodeId,
                endpointId: parseInt(attrEndpoint),
                clusterId: parseInt(attrCluster),
                commandId: parseInt(attrId),
                args,
            });

            if (result?.success) {
                addLog('invoke', `Command ${attrEndpoint}/${attrCluster}/${attrId} invoked. Result: ${JSON.stringify(result.result)}`, 'success');
            } else {
                addLog('invoke', `Invoke failed: ${result?.error}`, 'error');
            }
        } catch (e: any) {
            addLog('invoke', `Error: ${e.message}`, 'error');
        }
        setIsOperating(false);
    };

    // ===== 事件监听 =====

    useEffect(() => {
        // 监听属性变化
        window.electronAPI?.onCommissionerAttributeChanged((data) => {
            addLog('event', `Attribute changed: ${data.nodeId}/${data.endpointId}/${data.clusterId}/${data.attributeName} = ${JSON.stringify(data.value)}`, 'info');
        });

        // 监听设备状态
        window.electronAPI?.onCommissionerNodeStateChanged((data) => {
            addLog('state', `Node ${data.nodeId}: ${data.state}`, data.state === 'connected' ? 'success' : 'info');
            loadCommissionedNodes();
        });

        // Add global log listener for matter SDK and backend
        window.electronAPI?.onCommissionerLog?.((data: any) => {
            addLog(data.stage || 'SYS', data.message || String(data), data.type || 'info');
        });

        return () => {
            window.electronAPI?.removeCommissionerListeners();
        };
    }, []);

    // 初始化时检查状态 & 自动连接已配网设备
    useEffect(() => {
        const checkStatus = async () => {
            try {
                const status = await window.electronAPI?.commissionerStatus();
                if (status?.initialized) {
                    setIsInitialized(true);
                    setBleAvailable(status.bleAvailable);
                    const result = await window.electronAPI?.commissionerGetNodes();
                    if (result?.success) {
                        setCommissionedNodes(result.nodes || []);
                        // Auto-connect disconnected nodes
                        for (const node of (result.nodes || [])) {
                            if (!node.isConnected) {
                                try {
                                    addLog('auto', `Auto-connecting node ${node.nodeId}...`, 'progress');
                                    await window.electronAPI?.commissionerConnectNode(node.nodeId);
                                    await window.electronAPI?.commissionerSubscribeNode(node.nodeId);
                                    addLog('auto', `Node ${node.nodeId} connected`, 'success');
                                } catch (e: any) {
                                    addLog('auto', `Auto-connect ${node.nodeId} failed: ${e.message}`, 'error');
                                }
                            }
                        }
                        // Refresh status after auto-connect attempts
                        await loadCommissionedNodes();
                    }
                } else {
                    handleInitialize();
                }
            } catch {
                handleInitialize();
            }
        };
        checkStatus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Auto-select EP0, Cluster 0, Target 0 when structure loads
    useEffect(() => {
        if ((fullStructure || picsOptions)) {
            const optRoot = fullStructure || picsOptions;
            const eps = optRoot?.endpoints || [];
            if (eps.length > 0) {
                const ep0 = eps[0];
                const epIdStr = ep0.id !== undefined ? String(ep0.id) : "0";

                // Only select if there isn't one selected already or it's a new load
                if (!attrEndpoint) {
                    setAttrEndpoint(epIdStr);
                    if (ep0.clusters?.length > 0) {
                        const c0 = ep0.clusters[0];
                        const cIdStr = typeof c0.id === 'number' ? c0.id.toString() : (parseInt(c0.id, 16) || c0.id).toString();
                        setAttrCluster(cIdStr);

                        if (c0.attributes?.length > 0) {
                            const aIdStr = typeof c0.attributes[0].id === 'number' ? c0.attributes[0].id.toString() : (parseInt(c0.attributes[0].id, 16) || c0.attributes[0].id).toString();
                            setAttrId(aIdStr);
                        } else if (c0.commands?.length > 0) {
                            const cmdIdStr = typeof c0.commands[0].id === 'number' ? c0.commands[0].id.toString() : (parseInt(c0.commands[0].id, 16) || c0.commands[0].id).toString();
                            setAttrId(cmdIdStr);
                        }
                    }
                }
            }
        }
    }, [fullStructure, picsOptions]);

    // ===== 渲染 =====

    return (
        <div className="space-y-6 select-text">
            {/* ====== 操作栏 ====== */}
            <div className="flex items-center justify-between bg-slate-900 rounded-2xl border border-slate-800 p-4">
                <div className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full ${isInitialized ? 'bg-emerald-400 shadow-sm shadow-emerald-400/50' : 'bg-slate-600 animate-pulse'}`} />
                    <span className="text-xs text-slate-400 uppercase tracking-wider font-bold">
                        {isInitialized ? `BLE: ${bleAvailable ? 'Yes' : 'No '} • Nodes: ${commissionedNodes.length}` : 'Initializing...'}
                    </span>
                </div>

                <div className="flex items-center gap-3">
                    {!isInitialized ? (
                        <button
                            onClick={handleInitialize}
                            disabled={isInitializing}
                            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold uppercase tracking-wider transition-all disabled:opacity-50"
                        >
                            {isInitializing ? <Loader2 size={12} className="animate-spin" /> : <Power size={12} />}
                            Initialize
                        </button>
                    ) : (
                        <>
                            <button
                                onClick={loadCommissionedNodes}
                                className="flex items-center justify-center p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl transition-all"
                                title="Refresh nodes"
                            >
                                <RefreshCw size={14} />
                            </button>
                            <button
                                onClick={() => { setModalLogs([]); setShowCommissioningPanel(true); }}
                                className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold uppercase tracking-wider transition-all shadow-lg shadow-emerald-500/20"
                            >
                                <Plus size={14} /> New Device
                            </button>
                        </>
                    )}
                </div>
            </div>

            {isInitialized && (
                <div className="space-y-4">
                    {/* ====== Commissioning Modal ====== */}
                    {showCommissioningPanel && (
                        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => { setShowCommissioningPanel(false); setModalLogs([]); }}>
                            <div className="bg-slate-900 border border-slate-700 rounded-3xl w-full max-w-[95vw] max-h-[90vh] flex flex-col shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
                                <div className="flex items-center justify-between p-6 bg-slate-800/80 border-b border-slate-700">
                                    <h3 className="text-base font-black text-white uppercase tracking-wider flex items-center gap-2">
                                        <Plus size={20} className="text-emerald-400" /> Commission New Device
                                    </h3>
                                    <button onClick={() => { setShowCommissioningPanel(false); setModalLogs([]); }} className="text-slate-400 hover:text-white transition-colors">
                                        <X size={22} />
                                    </button>
                                </div>
                                <div className="flex-1 overflow-hidden grid grid-cols-[1fr_500px] lg:grid-cols-[1fr_600px] xl:grid-cols-[1fr_800px]">
                                    {/* Left Config Panel */}
                                    <div className="p-8 space-y-6 overflow-y-auto custom-scrollbar border-r border-slate-800">
                                        {/* Device Discovery */}
                                        <div className="p-5 bg-slate-800/40 rounded-2xl border border-slate-700/50">
                                            <div className="flex items-center gap-3 mb-4">
                                                <Search size={16} className="text-indigo-400" />
                                                <span className="text-xs text-slate-300 font-bold uppercase tracking-wider">Device Discovery (Optional)</span>
                                            </div>
                                            <div className="flex gap-3">
                                                <input type="text" placeholder="Discriminator" value={discriminatorFilter} onChange={e => setDiscriminatorFilter(e.target.value)}
                                                    className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none" />
                                                <input type="number" value={discoveryTimeout} onChange={e => setDiscoveryTimeout(parseInt(e.target.value) || 30)}
                                                    className="w-20 bg-slate-900 border border-slate-700 rounded-xl px-2 py-3 text-sm text-white text-center focus:border-indigo-500 focus:outline-none" title="Timeout (s)" />
                                                {!isDiscovering ? (
                                                    <button onClick={handleDiscover} className="flex items-center justify-center gap-2 px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-sm font-bold transition-all shadow-lg hover:shadow-indigo-500/25">
                                                        <Radio size={14} /> Scan
                                                    </button>
                                                ) : (
                                                    <button onClick={handleStopDiscovery} className="flex items-center justify-center gap-2 px-6 py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl text-sm font-bold transition-all shadow-lg hover:shadow-red-500/25">
                                                        <XCircle size={14} /> Stop
                                                    </button>
                                                )}
                                            </div>
                                            {discoveredDevices.length > 0 && (
                                                <div className="mt-4 space-y-2 max-h-40 overflow-y-auto custom-scrollbar pr-2">
                                                    {discoveredDevices.map(device => (
                                                        <div key={device.id} onClick={() => setSelectedDevice(device)}
                                                            className={`p-3 rounded-xl cursor-pointer text-sm transition-all flex items-center justify-between ${selectedDevice?.id === device.id ? 'bg-indigo-600/20 border border-indigo-500/50' : 'bg-slate-900 border border-slate-800 hover:border-slate-600'}`}>
                                                            <span className="font-bold text-slate-100">{device.deviceName}</span>
                                                            <span className="text-slate-400 text-xs font-mono bg-slate-800 px-2 py-1 rounded">D:{device.discriminator ?? 'N/A'} • {device.discoveredVia?.toUpperCase()}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>

                                        {/* Commissioning Config Grid */}
                                        <div className="grid grid-cols-2 gap-4">
                                            <div>
                                                <label className="text-xs text-slate-400 font-bold uppercase tracking-wider mb-2 block">Pairing Mode</label>
                                                <div className="flex bg-slate-900 border border-slate-800 rounded-xl p-1 gap-1">
                                                    <button onClick={() => setPairingMode('ble-wifi')} className={`flex-1 py-2.5 rounded-lg text-xs font-bold flex items-center justify-center gap-2 transition-all ${pairingMode === 'ble-wifi' ? 'bg-blue-600 text-white shadow-md' : 'text-slate-400 hover:bg-slate-800'}`}>
                                                        <Wifi size={14} /> BLE-WiFi
                                                    </button>
                                                    <button onClick={() => setPairingMode('ble-thread')} className={`flex-1 py-2.5 rounded-lg text-xs font-bold flex items-center justify-center gap-2 transition-all ${pairingMode === 'ble-thread' ? 'bg-purple-600 text-white shadow-md' : 'text-slate-400 hover:bg-slate-800'}`}>
                                                        <Activity size={14} /> BLE-Thread
                                                    </button>
                                                </div>
                                            </div>
                                            <div>
                                                <label className="text-xs text-slate-400 font-bold uppercase tracking-wider mb-2 block">Setup Passcode</label>
                                                <input type="text" placeholder="e.g. 20202021" value={passcode} onChange={e => setPasscode(e.target.value)}
                                                    className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white focus:border-indigo-500 focus:outline-none placeholder-slate-600 font-mono tracking-wider" />
                                            </div>
                                        </div>
                                        <div className="bg-slate-800 h-px w-full" />
                                        {pairingMode === 'ble-wifi' && (
                                            <div className="grid grid-cols-2 gap-4">
                                                <div>
                                                    <label className="text-xs text-slate-400 font-bold uppercase tracking-wider mb-2 block">WiFi SSID</label>
                                                    <input type="text" placeholder="Network name" value={wifiSsid} onChange={e => setWifiSsid(e.target.value)}
                                                        className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white focus:border-indigo-500 focus:outline-none placeholder-slate-600" />
                                                </div>
                                                <div>
                                                    <label className="text-xs text-slate-400 font-bold uppercase tracking-wider mb-2 block">WiFi Password</label>
                                                    <input type="password" placeholder="Password" value={wifiPassword} onChange={e => setWifiPassword(e.target.value)}
                                                        className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white focus:border-indigo-500 focus:outline-none placeholder-slate-600" />
                                                </div>
                                            </div>
                                        )}
                                        {pairingMode === 'ble-thread' && (
                                            <div className="space-y-4">
                                                <div className="flex items-center justify-between pl-1">
                                                    <label className="text-xs text-slate-400 font-bold uppercase tracking-wider block">Thread Operational Dataset</label>
                                                    <button onClick={handleScanThread} disabled={isScanningThread}
                                                        className="flex items-center justify-center gap-2 px-4 py-1.5 bg-purple-600/20 hover:bg-purple-600 border border-purple-500/30 text-purple-300 hover:text-white rounded-lg text-xs font-bold tracking-wider transition-all shadow-lg hover:shadow-purple-500/25 disabled:opacity-50">
                                                        {isScanningThread ? <Loader2 size={12} className="animate-spin" /> : <Radar size={12} />}
                                                        Scan Env Thread Networks
                                                    </button>
                                                </div>
                                                <textarea placeholder="Paste Hex-encoded operational dataset here..." value={threadDataset} onChange={e => setThreadDataset(e.target.value)} rows={5}
                                                    className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-emerald-400 focus:border-indigo-500 focus:outline-none placeholder-slate-600 font-mono resize-none custom-scrollbar" />
                                            </div>
                                        )}
                                        <div className="mt-6 pt-4 border-t border-slate-800">
                                            {!isCommissioning ? (
                                                <button onClick={handleCommission} disabled={!passcode}
                                                    className="w-full flex items-center justify-center gap-2 px-6 py-4 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded-xl text-sm font-bold uppercase tracking-widest transition-all shadow-[0_0_20px_rgba(16,185,129,0.2)] hover:shadow-[0_0_30px_rgba(16,185,129,0.4)]">
                                                    <Zap size={16} /> Start Commission
                                                </button>
                                            ) : (
                                                <div className="flex gap-4">
                                                    <div className="flex-1 flex items-center justify-center gap-3 px-6 py-4 bg-slate-800 border border-slate-700 text-slate-300 rounded-xl text-sm font-bold uppercase tracking-widest cursor-wait shadow-inner">
                                                        <Loader2 size={16} className="animate-spin text-emerald-400" /> Commissioning In Progress...
                                                    </div>
                                                    <button onClick={handleCancelCommissioning}
                                                        className="flex items-center justify-center gap-2 px-8 py-4 bg-red-600 hover:bg-red-500 text-white rounded-xl text-sm font-bold uppercase tracking-widest transition-all shadow-lg hover:shadow-red-500/25">
                                                        <XCircle size={16} /> Cancel
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    {/* Right Log Panel */}
                                    <div className="bg-slate-950 flex flex-col overflow-hidden relative border-l border-slate-800">
                                        <div className="absolute inset-0 bg-[linear-gradient(rgba(100,116,139,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(100,116,139,0.03)_1px,transparent_1px)] bg-[size:20px_20px] pointer-events-none opacity-50" />
                                        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800/50 bg-slate-950/80 z-10 backdrop-blur">
                                            <h3 className="text-xs font-black text-emerald-500 uppercase tracking-widest flex items-center gap-2 relative">
                                                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.8)]" /> Active Log Trace
                                            </h3>
                                            <button onClick={() => setModalLogs([])} className="text-[10px] uppercase font-bold text-slate-500 hover:text-slate-300 transition-colors">Clear</button>
                                        </div>
                                        <div ref={modalLogRef} className="flex-1 overflow-y-auto w-full p-6 space-y-2 font-mono text-[13px] leading-relaxed custom-scrollbar relative z-10">
                                            {modalLogs.length === 0 && (
                                                <div className="flex flex-col items-center justify-center h-full text-center opacity-30 select-none">
                                                    <Terminal size={48} className="mb-4 text-slate-600" />
                                                    <p className="tracking-widest uppercase font-bold">Awaiting Execution Trace...</p>
                                                </div>
                                            )}
                                            {modalLogs.map(log => (
                                                <div key={log.id} className="flex gap-3 hover:bg-slate-800/30 p-1.5 rounded transition-colors break-words group">
                                                    <span className="text-slate-600 shrink-0 select-none group-hover:text-slate-500 transition-colors">[{log.timestamp}]</span>
                                                    <span className={`flex-1 break-all ${log.type === 'error' ? 'text-red-400' :
                                                        log.type === 'success' ? 'text-emerald-400' :
                                                            log.type === 'progress' ? 'text-indigo-400' :
                                                                log.type === 'info' ? 'text-blue-400' :
                                                                    'text-slate-300'
                                                        }`}>
                                                        {log.message}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                    {/* ====== Commissioned Devices — full width ====== */}
                    <div className="bg-slate-900 rounded-2xl border border-slate-800 p-6">
                        <h3 className="text-sm font-black text-white uppercase tracking-wider mb-4 flex items-center gap-2">
                            <Link size={16} className="text-emerald-400" /> Commissioned Devices
                            <span className="text-slate-600 text-xs font-normal ml-2">({commissionedNodes.length})</span>
                        </h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                            {commissionedNodes.length === 0 && (
                                <p className="text-sm text-slate-600 text-center py-4 col-span-full">No commissioned devices</p>
                            )}
                            {commissionedNodes.map(node => (
                                <div key={node.nodeId} onClick={() => {
                                    if (selectedNodeId === node.nodeId) return; // Already selected
                                    // Immediately clear old data and show cached or loading
                                    setNodeStructure(nodeStructureCache.current[node.nodeId] || null);
                                    setFullStructure(fullStructureCache.current[node.nodeId] || null);
                                    setPicsOptions(null);
                                    setAttrEndpoint(''); setAttrCluster(''); setAttrId(''); setAttrValue('');
                                    setSelectedNodeId(node.nodeId);
                                    if (node.isConnected) { loadNodeStructure(node.nodeId); }
                                }}
                                    className={`p-4 rounded-xl cursor-pointer transition-all duration-150 ${selectedNodeId === node.nodeId ? 'bg-indigo-600/20 border border-indigo-500/30' : 'bg-slate-800/50 border border-transparent hover:border-slate-700'}`}>
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-3">
                                            <div className={`w-2.5 h-2.5 rounded-full ${node.isConnected ? 'bg-emerald-400 shadow-sm shadow-emerald-400/50' : 'bg-slate-600'}`} />
                                            <div>
                                                <p className="text-sm font-bold text-white">Node {node.nodeId}</p>
                                                <p className="text-xs text-slate-500">{node.isConnected ? 'Connected' : 'Disconnected'}</p>
                                            </div>
                                        </div>
                                        <div className="flex gap-1">
                                            {!node.isConnected ? (
                                                <button onClick={e => { e.stopPropagation(); handleConnectNode(node.nodeId); }} className="p-2 text-emerald-400 hover:bg-emerald-600/20 rounded-lg transition-all" title="Connect"><Power size={14} /></button>
                                            ) : (
                                                <button onClick={e => { e.stopPropagation(); handleDisconnectNode(node.nodeId); }} className="p-2 text-slate-400 hover:bg-slate-700 rounded-lg transition-all" title="Disconnect"><PowerOff size={14} /></button>
                                            )}
                                            <button onClick={e => { e.stopPropagation(); handleRemoveNode(node.nodeId); }} className="p-2 text-red-400 hover:bg-red-600/20 rounded-lg transition-all" title="Remove"><Trash2 size={14} /></button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                    {/* ====== Device Details + Interaction ====== */}
                    {selectedNodeId && (
                        <div className="bg-slate-900 rounded-2xl border border-slate-800 p-6">
                            <h3 className="text-sm font-black text-white uppercase tracking-wider mb-4 flex items-center gap-2">
                                <Settings size={16} className="text-amber-400" /> Node {selectedNodeId}
                            </h3>

                            {/* Device Info */}
                            {nodeStructure?.deviceInfo && (
                                <div className="mb-4 p-4 bg-slate-800/80 rounded-xl border border-slate-700/50">
                                    <p className="text-xs text-indigo-300 font-bold uppercase mb-2">Device Info</p>
                                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-6 gap-y-3">
                                        {Object.entries(nodeStructure.deviceInfo).filter(([, v]) => v != null && v !== '').map(([k, v]) => (
                                            <div key={k} className="flex items-center gap-3 overflow-hidden">
                                                <span className="text-xs text-slate-400 uppercase tracking-wider font-bold shrink-0 w-28 line-clamp-1 truncate" title={k}>{k}</span>
                                                <span className="text-sm text-slate-100 font-medium truncate" title={String(v)}>{String(v)}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Discovered Details — Summary line + modal */}
                            {isLoadingStructure ? (
                                <div className="flex items-center gap-2 py-4">
                                    <Loader2 size={14} className="animate-spin text-indigo-400" />
                                    <span className="text-sm text-slate-400">Loading structure...</span>
                                </div>
                            ) : (fullStructure || picsOptions) ? (
                                <div className="mb-4">
                                    <div
                                        onClick={() => setShowDetailModal(true)}
                                        className="flex items-center justify-between p-3 bg-slate-800/50 rounded-xl border border-slate-700/30 cursor-pointer hover:border-indigo-500/30 transition-all group"
                                    >
                                        <div className="flex items-center gap-3">
                                            <Eye size={14} className="text-indigo-400" />
                                            <span className="text-xs text-slate-300 font-bold uppercase">
                                                {fullStructure ? 'Discovered Details' : 'PICS Capabilities'}
                                            </span>
                                            <span className="text-sm font-medium text-slate-400 ml-2">
                                                {(fullStructure || picsOptions).endpoints?.length || 0} Endpoints •{' '}
                                                {(fullStructure || picsOptions).endpoints?.reduce((s: number, ep: any) => s + (ep.clusters?.length || 0), 0) || 0} Clusters
                                            </span>
                                        </div>
                                        <Maximize2 size={14} className="text-slate-500 group-hover:text-indigo-400 transition-colors" />
                                    </div>
                                </div>
                            ) : null}

                            {/* Interact & Configure */}
                            <div className="space-y-3 mt-4 border-t border-slate-800 pt-4">
                                <div className="flex items-center justify-between mb-2">
                                    <p className="text-xs text-slate-500 font-bold uppercase">Interact & Configure</p>
                                    <div className="flex items-center gap-2">
                                        <button onClick={handleReadAllAttributes} disabled={isReadingAll}
                                            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/30 rounded-lg text-[10px] font-bold uppercase transition-all"
                                            title="Auto-fetch all endpoints, servers, and attributes directly from the device">
                                            {isReadingAll ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                                            Auto Fetch Details
                                        </button>
                                        <input type="file" accept=".xml" ref={fileInputRef} onChange={handlePicsUpload} className="hidden" />
                                        <button onClick={() => fileInputRef.current?.click()}
                                            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-[10px] font-bold uppercase transition-all">
                                            <Plus size={12} /> Upload PICS
                                        </button>
                                    </div>
                                </div>

                                {picsOptions && !fullStructure && (
                                    <div className="text-[10px] text-emerald-400 bg-emerald-400/10 px-3 py-1.5 rounded-lg border border-emerald-400/20">
                                        ✔ PICS data loaded. Dropdowns are populated.
                                    </div>
                                )}

                                {(picsOptions || fullStructure) && (() => {
                                    const optRoot = fullStructure || picsOptions;
                                    const eps = optRoot?.endpoints || [];
                                    return (
                                        <div className="flex gap-2 bg-slate-800/50 p-2 rounded-xl border border-slate-700/50 overflow-x-auto custom-scrollbar items-center">
                                            <span className="text-xs text-slate-500 font-bold uppercase px-3 tracking-widest">Endpoint:</span>
                                            {eps.map((e: any, i: number) => {
                                                const epId = e.id !== undefined ? String(e.id) : String(i);
                                                return (
                                                    <button key={`ep-tab-${epId}`} onClick={() => setAttrEndpoint(epId)}
                                                        className={`px-5 py-2 text-sm font-bold rounded-lg transition-all ${attrEndpoint === epId ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/30 border border-indigo-500' : 'bg-slate-900 border border-slate-700 text-slate-400 hover:text-white hover:bg-slate-700 hover:border-slate-500'}`}>
                                                        {epId}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    );
                                })()}

                                {(() => {
                                    const optRoot = fullStructure || picsOptions;
                                    const eps = optRoot?.endpoints || [];
                                    const activeEp = eps.find((e: any) => String(e.id) === attrEndpoint);
                                    const clusters = activeEp ? activeEp.clusters : eps.flatMap((e: any) => e.clusters || []);
                                    const activeCluster = clusters.find((c: any) => String(c.id) === attrCluster);
                                    const attrs = activeCluster ? activeCluster.attributes : clusters.flatMap((c: any) => c.attributes || []);
                                    const cmds = activeCluster ? activeCluster.commands : clusters.flatMap((c: any) => c.commands || []);
                                    return (
                                        <div className="space-y-4 p-5 bg-slate-900/50 rounded-2xl border border-slate-700">
                                            <div className="flex items-center gap-4">
                                                <span className="text-xs text-slate-500 font-bold uppercase tracking-wider w-20">Cluster</span>
                                                <select value={attrCluster} onChange={e => { setAttrCluster(e.target.value); setAttrId(''); }}
                                                    className="flex-1 bg-slate-800 border border-slate-600 rounded-xl px-4 py-3 text-sm text-indigo-100 hover:border-indigo-500 focus:border-indigo-500 focus:outline-none transition-all cursor-pointer font-medium">
                                                    <option value="" disabled>-- Select Cluster --</option>
                                                    {clusters.map((c: any, i: number) => (
                                                        <option key={`cls-opt-${i}`} value={typeof c.id === 'number' ? c.id : parseInt(c.id, 16) || c.id}>
                                                            {c.name} (0x{typeof c.id === 'number' ? c.id.toString(16) : c.id})
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>
                                            <div className="flex items-center gap-4">
                                                <span className="text-xs text-slate-500 font-bold uppercase tracking-wider w-20">Target</span>
                                                <select value={attrId} onChange={e => setAttrId(e.target.value)}
                                                    className="flex-1 bg-slate-800 border border-slate-600 rounded-xl px-4 py-3 text-sm text-emerald-100 hover:border-emerald-500 focus:border-emerald-500 focus:outline-none transition-all cursor-pointer font-medium">
                                                    <option value="" disabled>-- Select Attribute or Command --</option>
                                                    {attrs.length > 0 && <optgroup label="Attributes">
                                                        {attrs.map((a: any, i: number) => (
                                                            <option key={`attr-opt-${i}`} value={typeof a.id === 'number' ? a.id : parseInt(a.id, 16) || a.id}>
                                                                [Attr] {a.name} (0x{typeof a.id === 'number' ? a.id.toString(16) : a.id})
                                                            </option>
                                                        ))}
                                                    </optgroup>}
                                                    {cmds.length > 0 && <optgroup label="Commands">
                                                        {cmds.map((c: any, i: number) => (
                                                            <option key={`cmd-opt-${i}`} value={typeof c.id === 'number' ? c.id : parseInt(c.id, 16) || c.id}>
                                                                [Cmd] {c.name} (0x{typeof c.id === 'number' ? c.id.toString(16) : c.id})
                                                            </option>
                                                        ))}
                                                    </optgroup>}
                                                </select>
                                            </div>
                                        </div>
                                    );
                                })()}
                                <div className="flex items-center gap-4">
                                    <span className="text-xs text-slate-500 font-bold uppercase tracking-wider w-20">Param</span>
                                    <input type="text" placeholder="Value / Command args (optional json)" value={attrValue} onChange={e => setAttrValue(e.target.value)}
                                        className="flex-1 bg-slate-800 border border-slate-600 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 hover:border-slate-500 focus:border-indigo-500 focus:outline-none transition-all font-mono" />
                                </div>
                                <div className="flex justify-end gap-3 pt-2">
                                    <button onClick={handleReadAttribute} disabled={isOperating} className="flex items-center justify-center gap-2 px-8 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 text-white rounded-xl text-sm font-bold transition-all shadow-lg hover:shadow-blue-500/25">
                                        <Eye size={16} /> Read
                                    </button>
                                    <button onClick={handleWriteAttribute} disabled={isOperating} className="flex items-center justify-center gap-2 px-8 py-2.5 bg-amber-600 hover:bg-amber-500 disabled:bg-slate-700 text-white rounded-xl text-sm font-bold transition-all shadow-lg hover:shadow-amber-500/25">
                                        <Pencil size={16} /> Write
                                    </button>
                                    <button onClick={handleInvokeCommand} disabled={isOperating} className="flex items-center justify-center gap-2 px-8 py-2.5 bg-purple-600 hover:bg-purple-500 disabled:bg-slate-700 text-white rounded-xl text-sm font-bold transition-all shadow-lg hover:shadow-purple-500/25">
                                        <Send size={16} /> Invoke
                                    </button>
                                </div>
                                {lastReadResult !== null && (
                                    <div className="p-4 bg-slate-800/80 border border-slate-700 rounded-xl mt-4">
                                        <p className="text-xs text-slate-400 uppercase tracking-widest font-bold mb-2">Last Result</p>
                                        <pre className="text-sm text-emerald-400 font-mono whitespace-pre-wrap">{JSON.stringify(lastReadResult, null, 2)}</pre>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ====== Detail Modal ====== */}
            {showDetailModal && (fullStructure || picsOptions) && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => setShowDetailModal(false)}>
                    <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between p-5 border-b border-slate-800">
                            <h3 className="text-sm font-black text-white uppercase tracking-wider flex items-center gap-2">
                                <Eye size={16} className="text-indigo-400" /> Full Device Structure
                            </h3>
                            <div className="flex items-center gap-2">
                                <button onClick={() => {
                                    const text = JSON.stringify(fullStructure || picsOptions, null, 2);
                                    navigator.clipboard.writeText(text);
                                    setCopiedDetail(true);
                                    setTimeout(() => setCopiedDetail(false), 2000);
                                }} className="flex items-center gap-1 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-bold transition-all">
                                    <Copy size={14} /> {copiedDetail ? 'Copied!' : 'Copy JSON'}
                                </button>
                                <button onClick={() => setShowDetailModal(false)} className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-all">
                                    <X size={18} />
                                </button>
                            </div>
                        </div>
                        <div className="flex-1 overflow-y-auto p-5 space-y-4 custom-scrollbar select-text">
                            {(fullStructure || picsOptions).endpoints?.map((ep: any, idx: number) => (
                                <div key={`modal-ep-${ep.id ?? idx}`} className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/30">
                                    <div className="flex items-center gap-3 mb-4">
                                        <span className="text-sm font-black text-white uppercase tracking-wider">Endpoint {ep.id ?? '?'}</span>
                                        {ep.deviceTypes?.[0] && (
                                            <span className="text-xs font-medium text-indigo-400 bg-indigo-400/10 border border-indigo-400/20 px-2.5 py-0.5 rounded-full">Type: {ep.deviceTypes[0].name}</span>
                                        )}
                                    </div>
                                    <div className="space-y-4">
                                        {ep.clusters?.map((c: any) => (
                                            <div key={`modal-c-${c.id}`} className="bg-slate-900/60 rounded-xl p-4 border border-slate-700/20">
                                                <p className="text-sm font-bold text-slate-200 border-b border-slate-700/50 pb-2.5 mb-3">
                                                    {c.name} <span className="text-slate-500 font-normal ml-2 text-xs">(0x{typeof c.id === 'number' ? c.id.toString(16) : c.id})</span>
                                                </p>
                                                {c.attributes?.length > 0 && (
                                                    <div className="mb-4">
                                                        <p className="text-[11px] text-slate-400 uppercase tracking-widest font-bold mb-2">Attributes</p>
                                                        <div className="grid grid-cols-1 gap-1">
                                                            {c.attributes.map((a: any) => (
                                                                <div key={`modal-a-${a.id}`} className="text-xs flex items-center justify-between gap-4 py-1.5 hover:bg-slate-800/70 px-3 rounded-lg transition-colors">
                                                                    <div className="flex gap-4 min-w-0 flex-1">
                                                                        <span className="text-amber-500/90 shrink-0 w-14 font-mono">0x{typeof a.id === 'number' ? a.id.toString(16).padStart(4, '0') : a.id}</span>
                                                                        <span className="text-slate-300 truncate" title={a.name}>{a.name}</span>
                                                                    </div>
                                                                    <span className="text-emerald-400/90 font-mono shrink-0 whitespace-nowrap overflow-x-auto custom-scrollbar max-w-[60%]" title={a.value !== undefined ? (typeof a.value === 'object' && a.value !== null ? JSON.stringify(a.value) : String(a.value)) : ''}>
                                                                        {a.value !== undefined ? (
                                                                            a.name === 'attributeList' && Array.isArray(a.value)
                                                                                ? '[' + a.value.map((v: any) => {
                                                                                    const attrName = c.attributes?.find((attr: any) => attr.id === v)?.name;
                                                                                    const hexId = typeof v === 'number' ? `0x${v.toString(16)}` : String(v);
                                                                                    return attrName ? `${attrName} (${hexId})` : hexId;
                                                                                }).join(', ') + ']'
                                                                                : (typeof a.value === 'object' && a.value !== null ? JSON.stringify(a.value) : String(a.value))
                                                                        ) : '---'}
                                                                    </span>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                                {c.commands?.length > 0 && (
                                                    <div>
                                                        <p className="text-[11px] text-slate-400 uppercase tracking-widest font-bold mb-2">Commands</p>
                                                        <div className="flex flex-wrap gap-2">
                                                            {c.commands.map((cmd: any) => (
                                                                <span key={`modal-cmd-${cmd.id}`} className="text-xs px-2.5 py-1 bg-purple-500/10 text-purple-300 rounded border border-purple-500/20">
                                                                    {cmd.name} <span className="text-purple-500/60 ml-1 font-mono text-[10px]">(0x{typeof cmd.id === 'number' ? cmd.id.toString(16) : cmd.id})</span>
                                                                </span>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* ====== Commissioner Log ====== */}
            <div className="bg-slate-900 rounded-2xl border border-slate-800 p-6 h-96 flex flex-col">
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-black text-white uppercase tracking-wider flex items-center gap-2">
                        <Activity size={16} className="text-indigo-400" /> Commissioner Log
                    </h3>
                    <button onClick={() => setLogs([])} className="text-xs text-slate-600 hover:text-slate-400 transition-colors">Clear</button>
                </div>
                <div ref={logRef} className="flex-1 overflow-y-auto space-y-0.5 custom-scrollbar font-mono select-text">
                    {logs.length === 0 && (
                        <p className="text-xs text-slate-700 text-center py-4">No logs yet. Initialize Commissioner to start.</p>
                    )}
                    {logs.map(log => (
                        <div key={log.id} className="flex gap-3 py-0.5 hover:bg-slate-800/30 px-2 rounded">
                            <span className="text-[13px] text-slate-700 shrink-0">{log.timestamp}</span>
                            <span className={`text-[13px] font-bold uppercase shrink-0 w-28 ${log.type === 'success' ? 'text-emerald-400' : log.type === 'error' ? 'text-red-400' : log.type === 'progress' ? 'text-amber-400' : 'text-slate-500'}`}>
                                [{log.stage}]
                            </span>
                            <span className={`text-[14px] whitespace-pre-wrap break-all ${log.type === 'success' ? 'text-emerald-300/90' : log.type === 'error' ? 'text-red-300/90' : log.type === 'progress' ? 'text-amber-300/90' : 'text-slate-400'}`}>
                                {log.message}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};
