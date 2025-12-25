
import React, { useState, useEffect } from 'react';
import { Network, Send, StopCircle, Play, Save, Settings2, Shield, Zap, Code, Database, Terminal, Search, Binary, ListTree, BookMarked, History } from 'lucide-react';
import { Protocol, GlobalLogEntry } from '../types';

interface ProtocolLabProps {
  onLog?: (log: Omit<GlobalLogEntry, 'id' | 'timestamp'>) => void;
}

export const ProtocolLab: React.FC<ProtocolLabProps> = ({ onLog }) => {
  const [selectedProtocol, setSelectedProtocol] = useState<Protocol>(Protocol.MQTT);
  const [dataMode, setDataMode] = useState<'JSON' | 'HEX' | 'TEXT'>('HEX');
  const [payload, setPayload] = useState('AA 55 08 01 12 34 56 78 FF');
  const [logs, setLogs] = useState<{t: string, m: string, d: 'TX'|'RX'|'SYS'}[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  
  const [presets] = useState([
    { name: '设备身份查询', hex: 'AA 55 01 00 FF', desc: 'Query ID' },
    { name: '固件状态自检', hex: 'AA 55 01 05 EE', desc: 'Self Check' },
    { name: '远程硬重启', hex: 'AA 55 02 0F 00 FF', desc: 'Hard Reset' },
    { name: '读取传感器通道1', hex: 'AA 55 01 20 DF', desc: 'Read CH1' },
  ]);

  const addLog = (msg: string, dir: 'TX'|'RX'|'SYS' = 'SYS') => {
    setLogs(prev => [{ t: new Date().toLocaleTimeString(), m: msg, d: dir }, ...prev.slice(0, 49)]);
    
    // 全局日志同步
    if (dir !== 'SYS') {
      onLog?.({
        type: 'CUSTOM',
        direction: dir,
        label: `Lab Protocol Message`,
        detail: `Format: ${dataMode}\nPayload: ${msg}`
      });
    }
  };

  const handleSend = (customPayload?: string) => {
    if (!isConnected) {
      addLog("错误: 通信链路未就绪 (SOCKET_NOT_READY)。", 'SYS');
      onLog?.({ type: 'SYSTEM', direction: 'ERR', label: 'Lab Error', detail: 'Socket connection failed: PHYSICAL_LINK_NOT_FOUND' });
      return;
    }
    const p = customPayload || payload;
    addLog(p, 'TX');
    setTimeout(() => addLog('AA 55 05 81 00 EE', 'RX'), 400);
  };

  return (
    <div className="max-w-[1600px] mx-auto h-full flex flex-col gap-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="bg-gradient-to-br from-indigo-600 to-blue-600 p-3 rounded-2xl text-white shadow-lg glow-indigo">
            <Binary size={24} />
          </div>
          <div>
            <h2 className="text-2xl font-black text-white uppercase tracking-tight">协议实验室 <span className="text-indigo-500 font-mono text-sm ml-2">PRO</span></h2>
            <p className="text-slate-500 text-[10px] font-black uppercase tracking-[0.2em] mt-1">深度调试私有二进制报文与自定义 API 交互</p>
          </div>
        </div>
        <button 
          onClick={() => {
            const newState = !isConnected;
            setIsConnected(newState);
            onLog?.({ type: 'SYSTEM', direction: 'TX', label: 'Physical Link State', detail: `Bridge status transitioned to: ${newState ? 'ACTIVE' : 'IDLE'}` });
          }}
          className={`px-8 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-all ${isConnected ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'bg-indigo-600 text-white shadow-xl shadow-indigo-500/20'}`}
        >
          {isConnected ? '断开物理链路' : '建立物理链路'}
        </button>
      </div>

      <div className="grid grid-cols-12 gap-6 flex-1 min-h-0">
        <div className="col-span-3 bg-slate-900/40 border border-slate-800 rounded-[2.5rem] p-8 flex flex-col backdrop-blur-xl">
           <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.3em] mb-6 flex items-center gap-3">
             <BookMarked size={16} className="text-indigo-500" /> 指令预设 (Presets)
           </h3>
           <div className="space-y-3 flex-1 overflow-y-auto custom-scrollbar pr-2">
              {presets.map((p, i) => (
                <button 
                  key={i}
                  onClick={() => setPayload(p.hex)}
                  className="w-full p-4 bg-slate-950/50 border border-slate-800 rounded-2xl text-left hover:border-indigo-500/50 transition-all group"
                >
                  <p className="text-[10px] font-black text-slate-300 uppercase mb-1">{p.name}</p>
                  <p className="text-[9px] font-mono text-slate-500 group-hover:text-indigo-400 transition-colors">{p.hex}</p>
                </button>
              ))}
           </div>
        </div>

        <div className="col-span-9 flex flex-col gap-6 min-h-0">
           <div className="flex-1 bg-slate-900/40 border border-slate-800 rounded-[2.5rem] p-8 flex flex-col backdrop-blur-xl">
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.3em] flex items-center gap-3">
                  <Code size={16} className="text-purple-500" /> 数据构造器
                </h3>
                <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800">
                  {['HEX', 'JSON'].map(m => (
                    <button 
                      key={m}
                      onClick={() => setDataMode(m as any)}
                      className={`px-4 py-1.5 text-[9px] font-black rounded-lg transition-all ${dataMode === m ? 'bg-indigo-600 text-white' : 'text-slate-600'}`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
              <textarea 
                value={payload}
                onChange={e => setPayload(e.target.value)}
                className="flex-1 w-full bg-slate-950/50 border border-slate-800 rounded-3xl p-6 font-mono text-sm text-indigo-300 focus:border-indigo-500 outline-none resize-none leading-relaxed mb-6"
              />
              <div className="flex justify-end">
                <button 
                  onClick={() => handleSend()}
                  className="px-12 py-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-indigo-600/20 active:scale-95 transition-all"
                >
                  发送报文 (Commit)
                </button>
              </div>
           </div>

           <div className="h-[250px] bg-slate-950 border border-slate-800 rounded-[2.5rem] p-8 flex flex-col shadow-inner overflow-hidden">
              <h3 className="text-[10px] font-black text-slate-600 uppercase tracking-[0.3em] flex items-center gap-3 mb-4">
                <Terminal size={16} /> 通信追踪 (Trace)
              </h3>
              <div className="flex-1 overflow-y-auto custom-scrollbar font-mono text-[11px] space-y-2">
                 {logs.map((log, i) => (
                   <div key={i} className="flex gap-4 animate-in slide-in-from-left-2">
                     <span className="text-slate-700 shrink-0">[{log.t}]</span>
                     <span className={`font-black shrink-0 w-8 ${log.d === 'TX' ? 'text-indigo-500' : log.d === 'RX' ? 'text-emerald-500' : 'text-slate-600'}`}>{log.d}</span>
                     <span className="text-slate-300 break-all">{log.m}</span>
                   </div>
                 ))}
              </div>
           </div>
        </div>
      </div>
    </div>
  );
};
