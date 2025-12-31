import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Wifi, WifiOff, RefreshCw, Cloud, ArrowUpCircle } from 'lucide-react';

interface OnlineStatusRecord {
    timestamp: number;
    status: number; // 0=MQTT连接中, 1=在线, 2=离线, 3=升级中
}

interface DeviceOnlineMonitorProps {
    deviceUuid: string;
    onGetStatus?: () => Promise<{ status: number }>;
    onStatusPush?: (callback: (status: number) => void) => () => void;
}

const STATUS_CONFIG = {
    0: { label: 'Connecting', color: 'amber', icon: Cloud, bgClass: 'bg-amber-500', textClass: 'text-amber-400' },
    1: { label: 'Online', color: 'emerald', icon: Wifi, bgClass: 'bg-emerald-500', textClass: 'text-emerald-400' },
    2: { label: 'Offline', color: 'red', icon: WifiOff, bgClass: 'bg-red-500', textClass: 'text-red-400' },
    3: { label: 'Upgrading', color: 'blue', icon: ArrowUpCircle, bgClass: 'bg-blue-500', textClass: 'text-blue-400' },
};

const MAX_RECORDS = 60; // 保存 60 条记录（每分钟一条 = 1小时）

export const DeviceOnlineMonitor: React.FC<DeviceOnlineMonitorProps> = ({
    deviceUuid,
    onGetStatus,
    onStatusPush,
}) => {
    const [records, setRecords] = useState<OnlineStatusRecord[]>([]);
    const [currentStatus, setCurrentStatus] = useState<number>(2); // 默认离线
    const [isPolling, setIsPolling] = useState(false);
    const intervalRef = useRef<NodeJS.Timeout | null>(null);

    // 添加新记录
    const addRecord = useCallback((status: number) => {
        const now = Date.now();
        setRecords(prev => {
            const newRecords = [...prev, { timestamp: now, status }];
            // 只保留最近 MAX_RECORDS 条
            if (newRecords.length > MAX_RECORDS) {
                return newRecords.slice(-MAX_RECORDS);
            }
            return newRecords;
        });
        setCurrentStatus(status);
    }, []);

    // 主动获取状态
    const fetchStatus = useCallback(async () => {
        if (!onGetStatus) return;
        try {
            setIsPolling(true);
            const result = await onGetStatus();
            if (typeof result.status === 'number') {
                addRecord(result.status);
            }
        } catch (error) {
            console.error('[OnlineMonitor] Failed to get status:', error);
            // 获取失败视为离线
            addRecord(2);
        } finally {
            setIsPolling(false);
        }
    }, [onGetStatus, addRecord]);

    // 设置定时轮询（每分钟）
    useEffect(() => {
        // 立即获取一次
        fetchStatus();

        // 每分钟轮询一次
        intervalRef.current = setInterval(fetchStatus, 60000);

        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
            }
        };
    }, [fetchStatus]);

    // 监听设备 push 消息
    useEffect(() => {
        if (!onStatusPush) return;

        const unsubscribe = onStatusPush((status) => {
            addRecord(status);
        });

        return unsubscribe;
    }, [onStatusPush, addRecord]);

    // 获取当前状态配置
    const statusConfig = STATUS_CONFIG[currentStatus as keyof typeof STATUS_CONFIG] || STATUS_CONFIG[2];
    const StatusIcon = statusConfig.icon;

    // 生成时间线数据（将记录映射到 60 个槽位）
    const timelineSlots = React.useMemo(() => {
        const slots = new Array(60).fill(null);
        const now = Date.now();
        const oneMinute = 60000;

        // 将记录填充到对应的槽位
        records.forEach(record => {
            const minutesAgo = Math.floor((now - record.timestamp) / oneMinute);
            const slotIndex = 59 - minutesAgo; // 最新的在右边
            if (slotIndex >= 0 && slotIndex < 60) {
                slots[slotIndex] = record.status;
            }
        });

        return slots;
    }, [records]);

    // 格式化时间
    const formatTime = (timestamp: number) => {
        return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    };

    return (
        <div className="bg-slate-900/40 border border-slate-800/50 rounded-2xl p-4 h-[180px]">
            {/* Header */}
            <div className="flex justify-between items-center mb-3">
                <h3 className="text-[9px] font-black text-slate-300 uppercase tracking-wider flex items-center gap-2">
                    <StatusIcon size={12} className={statusConfig.textClass} /> Online Status
                </h3>
                <div className="flex items-center gap-2">
                    <button
                        onClick={fetchStatus}
                        disabled={isPolling}
                        className="p-1 hover:bg-slate-800 rounded transition-all disabled:opacity-50"
                    >
                        <RefreshCw size={10} className={`text-slate-500 ${isPolling ? 'animate-spin' : ''}`} />
                    </button>
                    <div className={`px-2 py-0.5 ${statusConfig.bgClass}/20 rounded text-[8px] font-black ${statusConfig.textClass} uppercase flex items-center gap-1`}>
                        <div className={`w-1.5 h-1.5 rounded-full ${statusConfig.bgClass} ${currentStatus === 1 ? 'animate-pulse' : ''}`} />
                        {statusConfig.label}
                    </div>
                </div>
            </div>

            {/* Current Status Display */}
            <div className="flex items-center gap-3 mb-3">
                <div className={`p-2 ${statusConfig.bgClass}/10 rounded-lg ${statusConfig.textClass}`}>
                    <StatusIcon size={20} />
                </div>
                <div>
                    <p className="text-xs font-black text-white">{statusConfig.label}</p>
                    <p className="text-[9px] text-slate-500">
                        {records.length > 0 ? `Last update: ${formatTime(records[records.length - 1]?.timestamp || Date.now())}` : 'No data yet'}
                    </p>
                </div>
            </div>

            {/* Timeline Bar */}
            <div className="space-y-1">
                <div className="flex justify-between text-[8px] text-slate-600 font-mono">
                    <span>-60m</span>
                    <span>-30m</span>
                    <span>Now</span>
                </div>
                <div className="flex gap-px h-6 rounded overflow-hidden bg-slate-800/50">
                    {timelineSlots.map((status, i) => {
                        const slotConfig = status !== null
                            ? STATUS_CONFIG[status as keyof typeof STATUS_CONFIG]
                            : null;
                        return (
                            <div
                                key={i}
                                className={`flex-1 transition-all ${slotConfig ? slotConfig.bgClass : 'bg-slate-700/30'} ${slotConfig ? 'opacity-80 hover:opacity-100' : 'opacity-30'}`}
                                title={status !== null ? `${STATUS_CONFIG[status as keyof typeof STATUS_CONFIG]?.label || 'Unknown'}` : 'No data'}
                            />
                        );
                    })}
                </div>
                {/* Legend */}
                <div className="flex justify-center gap-3 mt-2">
                    {Object.entries(STATUS_CONFIG).map(([key, config]) => (
                        <div key={key} className="flex items-center gap-1">
                            <div className={`w-2 h-2 rounded-sm ${config.bgClass}`} />
                            <span className="text-[7px] text-slate-500 uppercase font-bold">{config.label}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};

export default DeviceOnlineMonitor;
