
import React, { useState, useRef, useEffect } from 'react';
import { Send, Terminal, Trash2, Globe, Wifi, ShieldCheck, Zap, Server, ChevronDown, RefreshCw } from 'lucide-react';
import { Device, LogEntry, Protocol, GlobalLogEntry } from '../types';

interface ProtocolConsoleProps {
  device: Device;
  mqttConnected: boolean;
  onLog?: (log: Omit<GlobalLogEntry, 'id' | 'timestamp'>) => void;
}

export const ProtocolConsole: React.FC<ProtocolConsoleProps> = ({ device, mqttConnected, onLog }) => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [commMode, setCommMode] = useState<'HTTP' | 'MQTT'>(device.isBound && mqttConnected ? 'MQTT' : 'HTTP');
  const [inputPayload, setInputPayload] = useState('{\n  "method": "CMD_REBOOT",\n  "params": {\n    "delay": 0,\n    "force": true\n  }\n}');
  const [target, setTarget] = useState('');
  const [isSending, setIsSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (commMode === 'MQTT') {
      setTarget(device.mqttTopic || `iot/nexus/${device.id}/rpc`);
    } else {
      setTarget(`http://${device.ip}/api/v1/control`);
    }
  }, [commMode, device]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [logs]);

  const addLog = (direction: 'IN' | 'OUT', payload: string, extra?: string) => {
    const newLog: LogEntry = {
      id: Math.random().toString(36).substr(2, 9),
      timestamp: new Date().toLocaleTimeString(),
      direction,
      protocol: commMode,
      payload,
      status: 'SUCCESS',
      topic: commMode === 'MQTT' ? extra : undefined,
      endpoint: commMode === 'HTTP' ? extra : undefined
    };
    setLogs(prev => [...prev.slice(-99), newLog]);

    // 全局日志同步
    onLog?.({
      type: commMode,
      direction: direction === 'OUT' ? 'TX' : 'RX',
      label: `${commMode} Packet: ${device.name}`,
      detail: `${direction === 'OUT' ? 'Target' : 'From'}: ${extra}\nPayload: ${payload}`
    });
  };

  const handleSend = async () => {
    if (!inputPayload.trim() || isSending) return;

    if (commMode === 'MQTT' && !mqttConnected) {
      onLog?.({ type: 'SYSTEM', direction: 'ERR', label: 'Protocol Violation', detail: 'MQTT transmission attempted without active Broker link.' });
      alert("Operational Error: No active Cloud Broker link established.");
      return;
    }

    setIsSending(true);
    addLog('OUT', inputPayload, target);

    await new Promise(r => setTimeout(r, 800));

    const response = commMode === 'MQTT'
      ? `{\n  "id": "${device.id}",\n  "status": "ACCEPTED",\n  "relay_node": "nexus_gw_01",\n  "execution_time": "12ms"\n}`
      : `{\n  "code": 200,\n  "msg": "OK",\n  "uptime": "14h 22m",\n  "heap_free": 12480\n}`;

    addLog('IN', response, target);
    setIsSending(false);
  };

  return (
    <div className="flex flex-col h-full bg-slate-900/60 rounded-[2.5rem] border border-slate-800 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-500 backdrop-blur-xl">
      <div className="bg-slate-950/40 px-8 py-5 border-b border-slate-800 flex justify-between items-center">
        <div className="flex items-center gap-6">
          <div className="flex bg-slate-950 p-1.5 rounded-2xl border border-slate-800 shadow-inner">
            <button
              onClick={() => setCommMode('HTTP')}
              className={`flex items-center gap-2 px-6 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${commMode === 'HTTP' ? 'bg-indigo-600 text-white shadow-xl shadow-indigo-500/20' : 'text-slate-500 hover:text-slate-300'}`}
            >
              <Wifi size={14} /> Local Endpoint
            </button>
            <button
              onClick={() => setCommMode('MQTT')}
              className={`flex items-center gap-2 px-6 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${commMode === 'MQTT' ? 'bg-purple-600 text-white shadow-xl shadow-purple-500/20' : 'text-slate-500 hover:text-slate-300'}`}
            >
              <Globe size={14} /> Remote Broker
            </button>
          </div>

          <div className="flex items-center gap-3">
            <div className={`w-2 h-2 rounded-full ${commMode === 'MQTT' ? (mqttConnected ? 'bg-emerald-500 animate-pulse' : 'bg-red-500') : 'bg-blue-500'}`} />
            <span className="text-[9px] font-black text-slate-500 uppercase tracking-[0.3em]">
              {commMode === 'MQTT' ? (mqttConnected ? 'Tunnel Secure' : 'Link Failed') : 'Direct Access'}
            </span>
          </div>
        </div>

        <button
          onClick={() => { if (confirm("Purge all logs?")) setLogs([]); }}
          className="p-3 hover:bg-red-500/10 rounded-2xl text-slate-500 hover:text-red-400 transition-all border border-transparent hover:border-red-500/20"
        >
          <Trash2 size={18} />
        </button>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-8 space-y-6 font-mono text-sm bg-slate-950/20 custom-scrollbar"
      >
        {logs.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-slate-800 opacity-30">
            <Terminal size={80} className="mb-6" />
            <p className="font-black uppercase tracking-[0.4em]">Listening for Data Frames...</p>
          </div>
        )}
        {logs.map((log) => (
          <div key={log.id} className="group animate-in slide-in-from-bottom-2 duration-300">
            <div className="flex items-center gap-4 mb-3">
              <span className={`text-[11px] font-black px-3 py-1 rounded-md border shadow-sm ${log.direction === 'OUT' ? 'text-indigo-400 border-indigo-500/30 bg-indigo-500/5' : 'text-emerald-400 border-emerald-500/30 bg-emerald-500/5'}`}>
                {log.direction === 'OUT' ? 'TX_COMMAND' : 'RX_FEEDBACK'}
              </span>
              <span className="text-slate-600 font-bold text-[11px] uppercase tracking-tighter">{log.timestamp}</span>
              <span className="text-slate-500 text-[11px] truncate max-w-[300px] font-mono italic opacity-60">
                {log.direction === 'OUT' ? 'TARGET » ' : 'FROM « '} {log.topic || log.endpoint}
              </span>
            </div>
            <div className={`p-6 rounded-[1.5rem] border backdrop-blur-sm transition-all ${log.direction === 'OUT'
                ? 'bg-slate-900/60 border-slate-800/80 text-slate-300'
                : 'bg-emerald-500/5 border-emerald-500/20 text-emerald-200 shadow-lg shadow-emerald-500/5'
              } group-hover:border-slate-600`}>
              <pre className="whitespace-pre-wrap break-all leading-relaxed font-mono">{log.payload}</pre>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-slate-900/80 p-8 border-t border-slate-800/50 backdrop-blur-2xl">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 mb-6">
          <div className="lg:col-span-3">
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-[0.3em] mb-2.5 block ml-1">
              Routing Descriptor
            </label>
            <div className="relative group">
              <div className="absolute inset-y-0 left-0 pl-5 flex items-center pointer-events-none text-slate-600 group-focus-within:text-indigo-400 transition-colors">
                {commMode === 'MQTT' ? <Server size={16} /> : <Zap size={16} />}
              </div>
              <input
                type="text"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="w-full bg-slate-950/80 border border-slate-800 rounded-2xl pl-12 pr-6 py-4 text-xs text-white focus:outline-none focus:border-indigo-500 font-mono shadow-inner"
              />
            </div>
          </div>
          <div>
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-[0.3em] mb-2.5 block ml-1">Context Type</label>
            <div className="relative">
              <select className="w-full bg-slate-950/80 border border-slate-800 rounded-2xl px-6 py-4 text-xs text-slate-400 focus:outline-none appearance-none font-bold">
                <option>JSON Payload</option>
                <option>Raw Stream</option>
                <option>Hex Buffer</option>
              </select>
              <ChevronDown className="absolute right-6 top-1/2 -translate-y-1/2 text-slate-600 pointer-events-none" size={16} />
            </div>
          </div>
        </div>

        <div className="relative group">
          <textarea
            value={inputPayload}
            onChange={(e) => setInputPayload(e.target.value)}
            className="w-full h-40 bg-slate-950/80 border border-slate-800 rounded-[2rem] p-6 text-xs font-mono text-indigo-200 focus:outline-none focus:border-indigo-500 resize-none custom-scrollbar shadow-inner leading-relaxed"
            placeholder="Construct logic payload..."
          />
          <button
            onClick={handleSend}
            disabled={isSending}
            className={`absolute bottom-6 right-6 px-8 py-4 rounded-2xl shadow-2xl transition-all active:scale-95 flex items-center gap-3 font-black text-xs uppercase tracking-[0.2em] ${isSending ? 'bg-slate-800 text-slate-500 cursor-not-allowed' : (commMode === 'MQTT' ? 'bg-purple-600 hover:bg-purple-500 text-white glow-indigo' : 'bg-indigo-600 hover:bg-indigo-500 text-white glow-indigo')}`}
          >
            {isSending ? <RefreshCw className="animate-spin" size={18} /> : <Send size={18} />}
            {isSending ? 'Sending...' : 'Dispatch Packet'}
          </button>
        </div>
      </div>
    </div>
  );
};
