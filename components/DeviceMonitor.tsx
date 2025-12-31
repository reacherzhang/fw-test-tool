
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import { Device, TelemetryPoint } from '../types';
import { Thermometer, Droplets, Zap, Activity, Wifi, WifiOff, Cloud, ArrowUpCircle, RefreshCw } from 'lucide-react';

interface DeviceMonitorProps {
  device: Device;
  onGetOnlineStatus?: () => Promise<{ status: number }>;
  onStatusPush?: (callback: (status: number) => void) => () => void;
}

// 在线状态配置
const STATUS_CONFIG = {
  0: { label: 'Connecting', color: 'amber', icon: Cloud, bgClass: 'bg-amber-500', textClass: 'text-amber-400' },
  1: { label: 'Online', color: 'emerald', icon: Wifi, bgClass: 'bg-emerald-500', textClass: 'text-emerald-400' },
  2: { label: 'Offline', color: 'red', icon: WifiOff, bgClass: 'bg-red-500', textClass: 'text-red-400' },
  3: { label: 'Upgrading', color: 'blue', icon: ArrowUpCircle, bgClass: 'bg-blue-500', textClass: 'text-blue-400' },
};

interface OnlineStatusRecord {
  timestamp: number;
  status: number;
}

const MAX_RECORDS = 60;

const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-slate-950/90 border border-slate-700/50 p-3 rounded-xl shadow-2xl backdrop-blur-xl text-[9px] font-mono">
        <p className="text-slate-500 mb-1 uppercase font-black tracking-widest border-b border-slate-800 pb-1">{label}</p>
        {payload.map((p: any) => (
          <div key={p.name} className="flex items-center justify-between gap-4 mb-0.5 last:mb-0">
            <span className="text-slate-400 font-bold uppercase">{p.name}</span>
            <span style={{ color: p.color }} className="font-black">
              {p.value.toFixed(2)}
            </span>
          </div>
        ))}
      </div>
    );
  }
  return null;
};

export const DeviceMonitor: React.FC<DeviceMonitorProps> = ({ device, onGetOnlineStatus, onStatusPush }) => {
  const data = device.telemetry;
  const latest = data[data.length - 1] || { temperature: 0, humidity: 0, cpuLoad: 0, voltage: 0 };

  // 在线状态记录
  const [statusRecords, setStatusRecords] = useState<OnlineStatusRecord[]>([]);
  const [currentStatus, setCurrentStatus] = useState<number>(2);
  const [isPolling, setIsPolling] = useState(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const addRecord = useCallback((status: number) => {
    const now = Date.now();
    setStatusRecords(prev => {
      const newRecords = [...prev, { timestamp: now, status }];
      return newRecords.length > MAX_RECORDS ? newRecords.slice(-MAX_RECORDS) : newRecords;
    });
    setCurrentStatus(status);
  }, []);

  const fetchStatus = useCallback(async () => {
    if (!onGetOnlineStatus) return;
    try {
      setIsPolling(true);
      const result = await onGetOnlineStatus();
      if (typeof result.status === 'number') {
        addRecord(result.status);
      }
    } catch (error) {
      addRecord(2);
    } finally {
      setIsPolling(false);
    }
  }, [onGetOnlineStatus, addRecord]);

  useEffect(() => {
    fetchStatus();
    intervalRef.current = setInterval(fetchStatus, 60000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetchStatus]);

  useEffect(() => {
    if (!onStatusPush) return;
    return onStatusPush(addRecord);
  }, [onStatusPush, addRecord]);

  const statusConfig = STATUS_CONFIG[currentStatus as keyof typeof STATUS_CONFIG] || STATUS_CONFIG[2];
  const StatusIcon = statusConfig.icon;

  const timelineSlots = React.useMemo(() => {
    const slots = new Array(60).fill(null);
    const now = Date.now();
    const oneMinute = 60000;
    statusRecords.forEach(record => {
      const minutesAgo = Math.floor((now - record.timestamp) / oneMinute);
      const slotIndex = 59 - minutesAgo;
      if (slotIndex >= 0 && slotIndex < 60) slots[slotIndex] = record.status;
    });
    return slots;
  }, [statusRecords]);

  return (
    <div className="space-y-4 animate-in fade-in duration-500">
      {/* Real-time Indicator Cards */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { icon: Thermometer, label: 'Thermals', val: latest.temperature.toFixed(1) + '°C', color: 'orange' },
          { icon: Droplets, label: 'Humidity', val: latest.humidity.toFixed(1) + '%', color: 'blue' },
          { icon: StatusIcon, label: 'Status', val: statusConfig.label, color: statusConfig.color, isStatus: true },
          { icon: Zap, label: 'Voltage', val: latest.voltage.toFixed(2) + 'V', color: 'yellow' }
        ].map((card, i) => (
          <div key={i} className="bg-slate-900/40 p-3 rounded-xl border border-slate-800/50 relative overflow-hidden group">
            <div className="relative z-10 flex items-center gap-3">
              <div className={`p-2 bg-${card.color}-500/10 rounded-lg text-${card.color}-500`}>
                <card.icon size={16} />
              </div>
              <div>
                <p className="text-slate-500 text-[8px] font-black uppercase tracking-wider">{card.label}</p>
                <div className={`text-lg font-black ${card.isStatus ? statusConfig.textClass : 'text-white'}`}>
                  {card.val}
                  {card.isStatus && currentStatus === 1 && <span className="inline-block w-2 h-2 ml-1 bg-emerald-500 rounded-full animate-pulse" />}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Analytics Visualization - 缩小版 */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-slate-900/40 border border-slate-800/50 rounded-2xl p-4 h-[180px]">
          <div className="flex justify-between items-center mb-2">
            <h3 className="text-[9px] font-black text-slate-300 uppercase tracking-wider flex items-center gap-2">
              <Activity size={12} className="text-orange-400" /> Environment
            </h3>
            <div className="flex gap-1">
              <div className="px-2 py-0.5 bg-orange-400/10 rounded text-[8px] font-black text-orange-400 uppercase">Temp</div>
              <div className="px-2 py-0.5 bg-blue-400/10 rounded text-[8px] font-black text-blue-400 uppercase">Hum</div>
            </div>
          </div>
          <ResponsiveContainer width="100%" height="85%">
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
              <XAxis dataKey="timestamp" hide />
              <YAxis stroke="#475569" fontSize={8} tickFormatter={(val) => val.toFixed(0)} width={25} />
              <Tooltip content={<CustomTooltip />} />
              <Line
                type="monotone"
                dataKey="temperature"
                stroke="#fb923c"
                strokeWidth={2}
                dot={false}
                name="Temperature"
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="humidity"
                stroke="#38bdf8"
                strokeWidth={2}
                dot={false}
                name="Humidity"
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-slate-900/40 border border-slate-800/50 rounded-2xl p-4 h-[180px]">
          <div className="flex justify-between items-center mb-2">
            <h3 className="text-xs font-black text-slate-300 uppercase tracking-wider flex items-center gap-2">
              <StatusIcon size={14} className={statusConfig.textClass} /> Online Status
            </h3>
            <div className="flex items-center gap-2">
              <button
                onClick={fetchStatus}
                disabled={isPolling}
                className="p-1.5 hover:bg-slate-800 rounded transition-all disabled:opacity-50"
                title="Refresh status"
              >
                <RefreshCw size={12} className={`text-slate-500 ${isPolling ? 'animate-spin' : ''}`} />
              </button>
              <div className={`px-2.5 py-1 ${statusConfig.bgClass}/20 rounded text-xs font-black ${statusConfig.textClass} uppercase flex items-center gap-1.5`}>
                <div className={`w-2 h-2 rounded-full ${statusConfig.bgClass} ${currentStatus === 1 ? 'animate-pulse' : ''}`} />
                {statusConfig.label}
              </div>
            </div>
          </div>

          {/* Timeline Bar */}
          <div className="mt-3 space-y-1">
            <div className="flex justify-between text-[10px] text-slate-500 font-mono">
              <span>-60m</span>
              <span>-30m</span>
              <span>Now</span>
            </div>
            <div className="flex gap-px h-10 rounded overflow-hidden bg-slate-800/50">
              {timelineSlots.map((status, i) => {
                const slotConfig = status !== null
                  ? STATUS_CONFIG[status as keyof typeof STATUS_CONFIG]
                  : null;
                return (
                  <div
                    key={i}
                    className={`flex-1 transition-all ${slotConfig ? slotConfig.bgClass : 'bg-slate-700/30'} ${slotConfig ? 'opacity-80 hover:opacity-100' : 'opacity-30'}`}
                    title={status !== null ? STATUS_CONFIG[status as keyof typeof STATUS_CONFIG]?.label || 'Unknown' : 'No data'}
                  />
                );
              })}
            </div>
            {/* Legend */}
            <div className="flex justify-center gap-4 mt-2">
              {Object.entries(STATUS_CONFIG).map(([key, config]) => (
                <div key={key} className="flex items-center gap-1.5">
                  <div className={`w-2.5 h-2.5 rounded-sm ${config.bgClass}`} />
                  <span className="text-[9px] text-slate-400 uppercase font-bold">{config.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
