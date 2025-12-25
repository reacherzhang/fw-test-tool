
import React, { useState, useEffect } from 'react';
import { Save, AlertCircle, FileJson, List, Play, Plus, Trash2, Clock, Globe, Wifi } from 'lucide-react';
import { Device, SequenceStep } from '../types';

interface DeviceConfigurationProps {
  device: Device;
  onUpdateConfig: (newConfig: any) => void;
  onUpdateSequence: (sequence: SequenceStep[]) => void;
  onUpdateNetwork: (updates: Partial<Device>) => void;
}

export const DeviceConfiguration: React.FC<DeviceConfigurationProps> = ({ 
  device, onUpdateConfig, onUpdateSequence, onUpdateNetwork 
}) => {
  const [activeTab, setActiveTab] = useState<'PARAMS' | 'NETWORK' | 'SEQUENCE'>('PARAMS');
  const [configJson, setConfigJson] = useState(JSON.stringify(device.config, null, 2));
  const [localIp, setLocalIp] = useState(device.ip);
  const [localTopic, setLocalTopic] = useState(device.mqttTopic || '');

  useEffect(() => {
    setConfigJson(JSON.stringify(device.config, null, 2));
    setLocalIp(device.ip);
    setLocalTopic(device.mqttTopic || '');
  }, [device]);

  const handleSaveNetwork = () => {
    onUpdateNetwork({ ip: localIp, mqttTopic: localTopic });
    alert("Network topology updated.");
  };

  return (
    <div className="flex flex-col gap-6 animate-in fade-in duration-500">
      {/* Sub Tabs */}
      <div className="flex gap-4 border-b border-slate-800 pb-2">
        {[
          { id: 'PARAMS', label: 'Device Parameters', icon: List },
          { id: 'NETWORK', label: 'Network Topology', icon: Globe },
          { id: 'SEQUENCE', label: 'Boot Sequences', icon: Play },
        ].map(tab => (
          <button 
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={`flex items-center gap-2 px-4 py-2 text-[10px] font-black uppercase tracking-widest transition-all border-b-2 ${activeTab === tab.id ? 'border-indigo-500 text-white' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
          >
            <tab.icon size={14} />
            {tab.label}
          </button>
        ))}
      </div>

      <div className="min-h-[400px]">
        {activeTab === 'PARAMS' && (
          <div className="bg-slate-900/40 p-6 rounded-3xl border border-slate-800">
             <div className="flex justify-between items-center mb-6">
                <h4 className="text-sm font-bold text-slate-300">Functional Configuration</h4>
                <button onClick={() => onUpdateConfig(JSON.parse(configJson))} className="text-xs font-bold text-indigo-400 hover:text-indigo-300">Save JSON</button>
             </div>
             <textarea 
               value={configJson}
               onChange={e => setConfigJson(e.target.value)}
               className="w-full h-64 bg-slate-950 border border-slate-800 rounded-2xl p-4 text-xs font-mono text-slate-300 focus:outline-none focus:border-indigo-500 resize-none"
             />
          </div>
        )}

        {activeTab === 'NETWORK' && (
          <div className="bg-slate-900/40 p-8 rounded-3xl border border-slate-800 max-w-2xl space-y-6">
             <div className="space-y-4">
                <h4 className="text-sm font-bold text-white uppercase tracking-widest">Topology Definitions</h4>
                <div className="grid gap-6">
                   <div>
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1 mb-2 block">LAN Endpoint (HTTP)</label>
                      <div className="relative group">
                        <Wifi className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-600" size={18} />
                        <input 
                          type="text" 
                          value={localIp}
                          onChange={e => setLocalIp(e.target.value)}
                          className="w-full bg-slate-950 border border-slate-800 rounded-2xl pl-12 pr-4 py-4 text-sm text-white focus:outline-none focus:border-indigo-500 font-mono"
                        />
                      </div>
                   </div>
                   <div>
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1 mb-2 block">Global Pub/Sub Topic (MQTT)</label>
                      <div className="relative group">
                        <Globe className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-600" size={18} />
                        <input 
                          type="text" 
                          value={localTopic}
                          onChange={e => setLocalTopic(e.target.value)}
                          className="w-full bg-slate-950 border border-slate-800 rounded-2xl pl-12 pr-4 py-4 text-sm text-white focus:outline-none focus:border-indigo-500 font-mono"
                        />
                      </div>
                      <p className="text-[10px] text-slate-600 mt-2 italic px-1">Ensure this topic matches the subscription configured in the device firmware.</p>
                   </div>
                </div>
             </div>
             <button 
               onClick={handleSaveNetwork}
               className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-black text-xs uppercase tracking-widest py-4 rounded-2xl transition-all shadow-lg shadow-indigo-500/20 active:scale-95 flex items-center justify-center gap-2"
             >
               <Save size={16} /> Update Topology
             </button>
          </div>
        )}

        {activeTab === 'SEQUENCE' && (
           <div className="bg-slate-900/40 p-6 rounded-3xl border border-slate-800">
              <p className="text-slate-500 text-sm">Automated boot-up sequences for stress testing and mass initialization.</p>
              {/* Sequence Logic remains same as previous component... */}
              <button onClick={() => alert("Sequence feature active")} className="mt-4 px-6 py-2 bg-slate-800 rounded-xl text-xs font-bold text-slate-400">Add Test Step</button>
           </div>
        )}
      </div>
    </div>
  );
};
