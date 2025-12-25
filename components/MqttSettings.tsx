
import React, { useState, useEffect } from 'react';
import { Server, Shield, Globe, Play, CheckCircle, RefreshCw, AlertTriangle, Key, Cpu, Zap, Bug, ToggleLeft, ToggleRight, ListTodo, Hash, Wifi, WifiOff, XCircle } from 'lucide-react';
import { MqttSessionConfig, CloudSession, GlobalLogEntry, IOT_CONSTANTS } from '../types';
import { md5 } from './AuthScreen';

interface MqttSettingsProps {
  config: MqttSessionConfig;
  session: CloudSession;
  onUpdate: (config: MqttSessionConfig) => void;
  onConnect: () => void;
  onCancel: () => void;
  isLogEnabled: boolean;
  onToggleLog: (enabled: boolean) => void;
  onLog?: (log: Omit<GlobalLogEntry, 'id' | 'timestamp'>) => void;
}

export const MqttSettings: React.FC<MqttSettingsProps> = ({
  config, session, onUpdate, onConnect, onCancel, isLogEnabled, onToggleLog, onLog
}) => {
  const [localConfig, setLocalConfig] = useState(config);

  useEffect(() => {
    setLocalConfig(config);
  }, [config]);

  const handleAutoFill = () => {
    const md5_old = md5(`${session.udid}${IOT_CONSTANTS.VENDOR}`).toLowerCase();
    const old_appid = `${session.guid}_${md5_old}`.substring(0, 32);
    const md5_new = md5(`${old_appid}${session.mqttDomain}`).toLowerCase();
    const final_appid = `${session.guid}_${md5_new}`.substring(0, 32);

    const client_id = `app:${final_appid}`;
    const password = md5(`${session.uid}${session.key}`).toLowerCase();

    const newConfig = {
      ...localConfig,
      host: session.mqttDomain,
      port: IOT_CONSTANTS.DEFAULT_PORT,
      clientId: client_id,
      username: session.uid,
      password: password,
      retryCount: 0
    };
    setLocalConfig(newConfig);
    onUpdate(newConfig);

    onLog?.({ type: 'MQTT', direction: 'SYS', label: 'Derive Credentials', detail: `ClientID: ${client_id}\nUsername: ${session.uid}` });
  };

  const getStatusColor = () => {
    switch (config.status) {
      case 'CONNECTED': return 'text-emerald-400 border-emerald-500/20 bg-emerald-500/10';
      case 'CONNECTING': return 'text-amber-400 border-amber-500/20 bg-amber-500/10';
      case 'ERROR': return 'text-red-400 border-red-500/20 bg-red-500/10';
      default: return 'text-slate-400 border-slate-500/20 bg-slate-500/10';
    }
  };

  const md5_old = md5(`${session.udid}${IOT_CONSTANTS.VENDOR}`).toLowerCase();
  const old_appid = `${session.guid}_${md5_old}`.substring(0, 32);
  const md5_new = md5(`${old_appid}${session.mqttDomain}`).toLowerCase();
  const final_appid = `${session.guid}_${md5_new}`.substring(0, 32);

  return (
    <div className="max-w-5xl mx-auto space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-20 selectable-text">
      <div className="bg-slate-900/40 p-12 rounded-[3.5rem] border border-slate-800 shadow-2xl backdrop-blur-xl relative overflow-hidden">
        <div className="flex items-center justify-between mb-12">
          <div className="flex items-center gap-6">
            <div className="w-16 h-16 bg-purple-600/10 border border-purple-500/20 rounded-2xl flex items-center justify-center text-purple-400">
              <Zap size={32} />
            </div>
            <div>
              <h3 className="text-3xl font-black text-white uppercase tracking-tight">Cloud Link Matrix</h3>
              <p className="text-slate-500 text-sm mt-1 uppercase font-bold tracking-widest text-[10px]">
                Active Infrastructure Status {config.status === 'CONNECTING' && `(Attempt ${config.retryCount}/3)`}
              </p>
            </div>
          </div>
          <div className={`flex items-center gap-3 px-6 py-2.5 rounded-full border ${getStatusColor()}`}>
            {config.status === 'CONNECTED' ? <Wifi size={14} /> : (config.status === 'CONNECTING' ? <RefreshCw className="animate-spin" size={14} /> : <WifiOff size={14} />)}
            <span className="text-xs font-black uppercase tracking-widest">
              {config.status === 'CONNECTING' ? `Negotiating...` : (config.status || 'DISCONNECTED')}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
          <div className="space-y-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1 mb-2 block">Broker Hostname</label>
              <div className="relative group">
                <Globe className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-600" size={20} />
                <input type="text" value={localConfig.host} onChange={e => setLocalConfig({ ...localConfig, host: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-2xl pl-14 pr-6 py-4 text-sm text-white focus:border-indigo-500 transition-all font-mono shadow-inner" />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-6">
              <div className="col-span-1 space-y-2">
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1 block">Port</label>
                <input type="number" value={localConfig.port} onChange={e => setLocalConfig({ ...localConfig, port: Number(e.target.value) })} className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-sm text-white font-mono shadow-inner" />
              </div>
              <div className="col-span-2 space-y-2">
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1 block">ClientID (Nexus v4)</label>
                <input type="text" value={localConfig.clientId} readOnly className="w-full bg-slate-900 border border-slate-800 rounded-2xl px-6 py-4 text-xs text-indigo-400 font-mono shadow-inner selectable-text" />
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1 block">Username</label>
              <div className="relative group">
                <Key className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-600" size={20} />
                <input type="text" value={localConfig.username || ''} onChange={e => setLocalConfig({ ...localConfig, username: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-2xl pl-14 pr-6 py-4 text-sm text-white font-mono shadow-inner" />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1 block">Password</label>
              <input type="password" value={localConfig.password || ''} onChange={e => setLocalConfig({ ...localConfig, password: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-sm text-white font-mono shadow-inner" />
            </div>
          </div>
        </div>

        <div className="mt-12 flex gap-6">
          <button
            onClick={handleAutoFill}
            className="px-10 py-5 bg-slate-950 border border-slate-800 hover:border-indigo-500/50 text-slate-400 hover:text-white rounded-[2rem] font-black text-[10px] uppercase tracking-widest transition-all flex items-center gap-3"
          >
            <RefreshCw size={16} /> Re-derive Credentials
          </button>

          <div className="flex-1 flex gap-4">
            {config.status === 'CONNECTING' && (
              <button
                onClick={onCancel}
                className="px-8 bg-red-600/10 border border-red-500/30 text-red-400 hover:bg-red-600 hover:text-white transition-all rounded-[2rem] font-black text-xs uppercase tracking-widest flex items-center justify-center gap-2"
              >
                <XCircle size={18} /> Cancel
              </button>
            )}
            <button
              onClick={onConnect}
              disabled={config.status === 'CONNECTING'}
              className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white font-black text-xs uppercase tracking-[0.2em] py-5 rounded-[2rem] shadow-2xl transition-all flex items-center justify-center gap-4 active:scale-95 disabled:opacity-50"
            >
              {config.status === 'CONNECTING' ? <RefreshCw className="animate-spin" size={20} /> : <Play size={20} />}
              {config.status === 'CONNECTED' ? 'Re-establish Link' : 'Commit Connection'}
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
        <div className="bg-slate-900/40 p-10 rounded-[3rem] border border-slate-800 flex gap-6">
          <div className="w-14 h-14 bg-indigo-500/10 rounded-2xl border border-indigo-500/20 flex items-center justify-center text-indigo-400 shrink-0">
            <Hash size={28} />
          </div>
          <div className="flex-1 overflow-hidden">
            <h4 className="text-white font-black text-sm uppercase tracking-widest mb-4">Derived AppID Components</h4>
            <div className="space-y-2 font-mono text-[9px] selectable-text">
              <p className="text-slate-500 truncate">GUID: <span className="text-slate-300">{session.guid}</span></p>
              <p className="text-slate-500 truncate">Old MD5: <span className="text-slate-300">{md5_old}</span></p>
              <p className="text-slate-500 truncate">Old AppID: <span className="text-slate-300">{old_appid}</span></p>
              <p className="text-slate-500 truncate">New MD5: <span className="text-slate-300">{md5_new}</span></p>
              <div className="pt-2 border-t border-slate-800 mt-2">
                <p className="text-indigo-400 font-bold truncate">Final AppID: {final_appid}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-slate-900/40 p-10 rounded-[3rem] border border-slate-800 flex gap-6">
          <div className="w-14 h-14 bg-purple-500/10 rounded-2xl border border-purple-500/20 flex items-center justify-center text-purple-400 shrink-0">
            <ListTodo size={28} />
          </div>
          <div className="flex-1">
            <h4 className="text-white font-black text-sm uppercase tracking-widest mb-4">Active Subscription Map</h4>
            <div className="space-y-3 selectable-text">
              <div className="bg-slate-950 border border-slate-800 p-4 rounded-2xl flex justify-between items-center">
                <span className="text-[10px] font-mono text-slate-300">/app/{session.uid}/subscribe</span>
                <span className="text-[8px] font-black text-emerald-500 bg-emerald-500/10 px-2 py-1 rounded">Public</span>
              </div>
              <div className="bg-slate-950 border border-slate-800 p-4 rounded-2xl flex justify-between items-center">
                <span className="text-[10px] font-mono text-slate-300">/app/{session.uid}-{final_appid}/subscribe</span>
                <span className="text-[8px] font-black text-purple-500 bg-purple-500/10 px-2 py-1 rounded">Private</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
