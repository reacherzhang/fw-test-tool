
import React from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area, ReferenceLine
} from 'recharts';
import { Device, TelemetryPoint } from '../types';
import { Cpu, Thermometer, Droplets, Zap, Activity } from 'lucide-react';

interface DeviceMonitorProps {
  device: Device;
}

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

export const DeviceMonitor: React.FC<DeviceMonitorProps> = ({ device }) => {
  const data = device.telemetry;
  const latest = data[data.length - 1] || { temperature: 0, humidity: 0, cpuLoad: 0, voltage: 0 };

  return (
    <div className="space-y-4 animate-in fade-in duration-500">
      {/* Real-time Indicator Cards - 缩小版 */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { icon: Thermometer, label: 'Thermals', val: latest.temperature.toFixed(1) + '°C', color: 'orange' },
          { icon: Droplets, label: 'Humidity', val: latest.humidity.toFixed(1) + '%', color: 'blue' },
          { icon: Cpu, label: 'CPU Load', val: latest.cpuLoad.toFixed(0) + '%', color: 'purple' },
          { icon: Zap, label: 'Voltage', val: latest.voltage.toFixed(2) + 'V', color: 'yellow' }
        ].map((card, i) => (
          <div key={i} className="bg-slate-900/40 p-3 rounded-xl border border-slate-800/50 relative overflow-hidden group">
            <div className="relative z-10 flex items-center gap-3">
              <div className={`p-2 bg-${card.color}-500/10 rounded-lg text-${card.color}-500`}>
                <card.icon size={16} />
              </div>
              <div>
                <p className="text-slate-500 text-[8px] font-black uppercase tracking-wider">{card.label}</p>
                <div className="text-lg font-black text-white">{card.val}</div>
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
            <h3 className="text-[9px] font-black text-slate-300 uppercase tracking-wider flex items-center gap-2">
              <Cpu size={12} className="text-purple-400" /> CPU Load
            </h3>
            <div className="px-2 py-0.5 bg-purple-400/10 rounded text-[8px] font-black text-purple-400 uppercase">%</div>
          </div>
          <ResponsiveContainer width="100%" height="85%">
            <AreaChart data={data}>
              <defs>
                <linearGradient id="colorCpu" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#c084fc" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#c084fc" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
              <XAxis dataKey="timestamp" hide />
              <YAxis stroke="#475569" fontSize={8} domain={[0, 100]} width={25} />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="cpuLoad"
                stroke="#c084fc"
                strokeWidth={2}
                fill="url(#colorCpu)"
                name="CPU Load"
                isAnimationActive={false}
              />
              <ReferenceLine y={80} stroke="#ef4444" strokeDasharray="5 5" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
};
