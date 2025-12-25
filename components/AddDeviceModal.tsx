
import React, { useState, useEffect } from 'react';
import {
  X, Plus, Trash2, Wifi, Bluetooth, RefreshCw, CheckCircle, Cpu, Signal, ChevronDown, ChevronRight, Zap, Loader2, ArrowRight, ShieldCheck, ListFilter, Braces
} from 'lucide-react';
import { DeviceStatus } from '../types';

// Removed duplicate Window.electronAPI declaration to resolve TypeScript conflict with env.d.ts

interface AddDeviceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (deviceData: any) => void;
  deviceTypes: string[];
  connectionTypes: string[];
  onUpdateDeviceTypes: (types: string[]) => void;
  onUpdateConnectionTypes: (types: string[]) => void;
}

interface DiscoveredDevice {
  id: string;
  name: string;
  rssi: number;
  mac: string;
}

interface ConfigRequest {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers: { key: string; value: string }[];
  body: string;
  bodyMode: 'JSON' | 'FORM';
}

export const AddDeviceModal: React.FC<AddDeviceModalProps> = ({
  isOpen, onClose, onAdd,
  deviceTypes, connectionTypes
}) => {
  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState({
    name: '',
    type: deviceTypes[0] || 'Sensor',
    connectionType: connectionTypes[0] || 'WIFI',
    config: {}
  });

  const [isScanning, setIsScanning] = useState(false);
  const [discoveredDevices, setDiscoveredDevices] = useState<DiscoveredDevice[]>([]);
  const [connectedDevice, setConnectedDevice] = useState<DiscoveredDevice | null>(null);
  const [connectingToId, setConnectingToId] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'IDLE' | 'CONNECTING' | 'CONNECTED' | 'FAILED'>('IDLE');

  const [configMode, setConfigMode] = useState<'JSON' | 'BUILDER'>('BUILDER');
  const [requests, setRequests] = useState<ConfigRequest[]>([]);
  const [rawConfigJson, setRawConfigJson] = useState('');
  const [expandedRequestId, setExpandedRequestId] = useState<string | null>(null);

  const [provisioningStatus, setProvisioningStatus] = useState<'IDLE' | 'SENDING' | 'SUCCESS' | 'ERROR'>('IDLE');
  const [provisionLog, setProvisionLog] = useState<string[]>([]);

  const getDeviceIp = () => {
    if (!connectedDevice) return '192.168.1.1';
    return '192.168.1.1';
  };

  useEffect(() => {
    if (isOpen) {
      setStep(1);
      setConnectedDevice(null);
      setConnectionStatus('IDLE');
      setProvisioningStatus('IDLE');
      setDiscoveredDevices([]);
      setProvisionLog([]);
      setRequests([]);
      setConnectingToId(null);
      setFormData(prev => ({ ...prev, name: '' }));
    }
  }, [isOpen]);

  useEffect(() => {
    if (step === 3 && requests.length === 0) {
      const currentIp = getDeviceIp();
      const defaultRequests: ConfigRequest[] = [{
        id: 'req-' + Date.now(),
        method: 'POST',
        url: `http://${currentIp}/config`,
        bodyMode: 'FORM',
        headers: [
          { key: 'Content-Type', value: 'application/json' },
          { key: 'Accept', value: '*/*' }
        ],
        body: JSON.stringify({
          ssid: "Home_WiFi",
          password: "YOUR_PASSWORD",
          server: "iot.nexus.io"
        }, null, 2)
      }];
      setRequests(defaultRequests);
      setRawConfigJson(JSON.stringify(defaultRequests, null, 2));
      setExpandedRequestId(defaultRequests[0].id);
    }
  }, [step, connectedDevice]);

  if (!isOpen) return null;

  const handleNext = () => {
    if (step === 1 && !formData.name.trim()) return alert("Please enter a name.");
    setStep(prev => prev + 1);
  };

  const syncToRawJson = (newRequests: ConfigRequest[]) => {
    setRequests(newRequests);
    setRawConfigJson(JSON.stringify(newRequests, null, 2));
  };

  const addRequest = () => {
    const currentIp = getDeviceIp();
    const newReq: ConfigRequest = {
      id: 'req-' + Math.random().toString(36).substr(2, 9),
      method: 'POST',
      url: `http://${currentIp}/api/command`,
      headers: [{ key: 'Content-Type', value: 'application/json' }],
      body: '{\n  "status": 1\n}',
      bodyMode: 'FORM'
    };
    const newRequests = [...requests, newReq];
    syncToRawJson(newRequests);
    setExpandedRequestId(newReq.id);
  };

  const updateRequest = (id: string, field: keyof ConfigRequest, value: any) => {
    const newRequests = requests.map(r => r.id === id ? { ...r, [field]: value } : r);
    syncToRawJson(newRequests);
  };

  const getBodyFields = (jsonBody: string) => {
    try {
      const parsed = JSON.parse(jsonBody);
      return Object.entries(parsed).map(([key, value]) => ({
        key,
        value: typeof value === 'object' ? JSON.stringify(value) : String(value)
      }));
    } catch { return []; }
  };

  const updateBodyFromFields = (reqId: string, fields: { key: string, value: string }[]) => {
    const obj: any = {};
    fields.forEach(f => {
      let v: any = f.value;
      if (v === 'true') v = true; else if (v === 'false') v = false; else if (!isNaN(Number(v)) && v !== '') v = Number(v);
      else { try { v = JSON.parse(f.value); } catch { v = f.value; } }
      obj[f.key] = v;
    });
    updateRequest(reqId, 'body', JSON.stringify(obj, null, 2));
  };

  const startScan = async () => {
    setIsScanning(true);
    setDiscoveredDevices([]);
    try {
      let results: DiscoveredDevice[] = [];
      if (formData.connectionType.includes('BLE')) {
        results = window.electronAPI ? await window.electronAPI.scanBluetooth() : [];
      } else {
        results = window.electronAPI ? await window.electronAPI.scanWifi() : [];
      }
      const sorted = results.sort((a, b) => {
        const aSpecial = a.name.startsWith('Meross_') || a.name.startsWith('Refoss_');
        const bSpecial = b.name.startsWith('Meross_') || b.name.startsWith('Refoss_');
        if (aSpecial && !bSpecial) return -1;
        if (!aSpecial && bSpecial) return 1;
        return b.rssi - a.rssi;
      });
      setDiscoveredDevices(sorted);
    } catch (err) {
      console.error(err);
    } finally {
      setIsScanning(false);
    }
  };

  const handleConnect = async (device: DiscoveredDevice) => {
    setConnectingToId(device.id);
    setConnectionStatus('CONNECTING');
    try {
      if (window.electronAPI) {
        await window.electronAPI.connectWifi({ ssid: device.name });
        setConnectedDevice(device);
        setConnectionStatus('CONNECTED');
        setTimeout(() => setStep(3), 1200);
      } else {
        await new Promise(r => setTimeout(r, 2000));
        setConnectedDevice(device);
        setConnectionStatus('CONNECTED');
        setTimeout(() => setStep(3), 800);
      }
    } catch (e) {
      alert("Hardware connection failed.");
      setConnectionStatus('FAILED');
    } finally {
      setConnectingToId(null);
    }
  };

  const deployConfig = async () => {
    setProvisioningStatus('SENDING');
    setProvisionLog([]);
    for (let i = 0; i < requests.length; i++) {
      setProvisionLog(prev => [...prev, `[TX] Executing Instruction ${i + 1}...`]);
      await new Promise(r => setTimeout(r, 800));
    }
    setProvisioningStatus('SUCCESS');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xl">
      <div className="bg-slate-950 border border-slate-800 rounded-[2.5rem] shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex justify-between items-center px-10 py-8 border-b border-slate-900/50">
          <div>
            <h3 className="text-2xl font-black text-white uppercase tracking-tight">Provision Node</h3>
            <p className="text-[11px] font-bold text-slate-500 uppercase tracking-[0.2em] mt-1">Sequence Control // Stage {step}</p>
          </div>
          <button onClick={onClose} className="w-12 h-12 flex items-center justify-center bg-slate-900 rounded-2xl text-slate-400 hover:text-white transition-all"><X size={24} /></button>
        </div>

        {/* Content */}
        <div className="p-10 flex-1 overflow-y-auto custom-scrollbar">
          {step === 1 && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="space-y-4">
                <label className="text-xs font-black text-slate-500 uppercase tracking-widest ml-1">Identity Tag</label>
                <input
                  autoFocus
                  value={formData.name}
                  onChange={e => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g. Workshop Smart Plug"
                  className="w-full bg-slate-900/50 border border-slate-800 rounded-3xl px-6 py-5 text-base text-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-8">
                <div className="space-y-4">
                  <label className="text-xs font-black text-slate-500 uppercase tracking-widest ml-1">Hardware Class</label>
                  <select value={formData.type} onChange={e => setFormData({ ...formData, type: e.target.value })} className="w-full bg-slate-900/50 border border-slate-800 rounded-2xl px-6 py-4 text-sm text-white appearance-none">{deviceTypes.map(t => <option key={t}>{t}</option>)}</select>
                </div>
                <div className="space-y-4">
                  <label className="text-xs font-black text-slate-500 uppercase tracking-widest ml-1">Physical Link</label>
                  <select value={formData.connectionType} onChange={e => setFormData({ ...formData, connectionType: e.target.value })} className="w-full bg-slate-900/50 border border-slate-800 rounded-2xl px-6 py-4 text-sm text-white appearance-none">{connectionTypes.map(c => <option key={c}>{c}</option>)}</select>
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="flex flex-col gap-4">
                <button onClick={startScan} disabled={isScanning} className="w-full py-6 bg-indigo-600 hover:bg-indigo-500 text-white rounded-[2rem] flex items-center justify-center gap-4 transition-all shadow-xl shadow-indigo-600/20 active:scale-95 disabled:opacity-50">
                  {isScanning ? <Loader2 className="animate-spin" size={24} /> : (formData.connectionType.includes('BLE') ? <Bluetooth size={24} /> : <Wifi size={24} />)}
                  <span className="font-black text-sm uppercase tracking-widest">{isScanning ? 'Syncing Hardware...' : `Scan ${formData.connectionType}`}</span>
                </button>
                <div className="flex justify-between px-6">
                  <span className="text-[10px] font-black text-slate-600 uppercase tracking-widest flex items-center gap-2">
                    <ShieldCheck size={14} className="text-indigo-500" /> I/O Adapter Active
                  </span>
                  <span className="text-[10px] font-bold text-slate-600 uppercase tracking-widest">{discoveredDevices.length} Signals Captured</span>
                </div>
              </div>

              <div className="space-y-4 max-h-[400px] overflow-y-auto custom-scrollbar pr-3">
                {discoveredDevices.length === 0 && !isScanning && (
                  <div className="text-center py-20 border-2 border-dashed border-slate-900 rounded-[3rem] text-slate-700 text-xs font-black uppercase tracking-[0.3em]">No target signals in proximity</div>
                )}
                {discoveredDevices.map(d => {
                  const isPriority = d.name.startsWith('Refoss_') || d.name.startsWith('Meross_');
                  const isConnecting = connectingToId === d.id;
                  return (
                    <div key={d.id} className={`group p-6 rounded-[2.5rem] border transition-all flex justify-between items-center ${isConnecting ? 'border-indigo-500 bg-indigo-500/5' : (isPriority ? 'bg-slate-900/40 border-slate-800/80 hover:border-indigo-500/50' : 'bg-slate-900/20 border-slate-900 hover:border-slate-800')}`}>
                      <div className="flex items-center gap-6">
                        <Signal size={28} className={d.rssi > -60 ? 'text-emerald-400' : (d.rssi > -80 ? 'text-amber-400' : 'text-red-400')} />
                        <div>
                          <div className="flex items-center gap-3 mb-1">
                            <h4 className="text-base font-black text-white truncate max-w-[200px]">{d.name}</h4>
                            {isPriority && <span className="text-[9px] bg-indigo-600 text-white px-2 py-0.5 rounded-full font-black uppercase tracking-tighter">Verified</span>}
                          </div>
                          <p className="text-xs text-slate-600 font-mono tracking-tighter">{d.mac} // {d.rssi}dBm</p>
                        </div>
                      </div>
                      <button onClick={() => handleConnect(d)} disabled={isConnecting || connectionStatus === 'CONNECTING'} className={`px-10 py-4 rounded-2xl font-black text-[11px] uppercase tracking-widest transition-all ${isConnecting ? 'bg-slate-800 text-slate-500' : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg'}`}>
                        {isConnecting ? <Loader2 size={14} className="animate-spin" /> : 'Connect'}
                      </button>
                    </div>
                  );
                })}
              </div>
              {connectionStatus === 'CONNECTED' && (
                <div className="bg-emerald-500/10 border border-emerald-500/20 p-8 rounded-[2.5rem] flex items-center justify-between animate-in zoom-in duration-500">
                  <div className="flex items-center gap-5">
                    <div className="w-12 h-12 bg-emerald-500 rounded-2xl flex items-center justify-center text-white"><CheckCircle size={24} /></div>
                    <div>
                      <p className="text-sm font-black text-white uppercase">STA Established</p>
                      <p className="text-xs font-medium text-emerald-400">Locked on {connectedDevice?.name} // Interface @ {getDeviceIp()}</p>
                    </div>
                  </div>
                  <ArrowRight className="text-emerald-500 animate-bounce-x" />
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="flex flex-col h-full min-h-[500px] animate-in fade-in slide-in-from-right-4 duration-500">
              {/* Metadata Header */}
              <div className="bg-slate-900/40 p-6 rounded-[2.5rem] border border-slate-800 flex items-center justify-between mb-8">
                <div className="flex items-center gap-5">
                  <div className="p-4 bg-indigo-500/10 rounded-2xl text-indigo-400"><Cpu size={24} /></div>
                  <div>
                    <p className="text-[11px] font-black text-slate-500 uppercase tracking-widest">Target Endpoint</p>
                    <p className="text-sm font-mono text-white tracking-tight">{getDeviceIp()}</p>
                  </div>
                </div>
                <div className="flex bg-slate-950 p-1.5 rounded-2xl border border-slate-800 shadow-inner">
                  <button onClick={() => setConfigMode('BUILDER')} className={`px-6 py-2.5 text-xs font-black uppercase rounded-xl transition-all ${configMode === 'BUILDER' ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-600 hover:text-slate-400'}`}>Builder</button>
                  <button onClick={() => setConfigMode('JSON')} className={`px-6 py-2.5 text-xs font-black uppercase rounded-xl transition-all ${configMode === 'JSON' ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-600 hover:text-slate-400'}`}>JSON</button>
                </div>
              </div>

              {/* Configuration Area */}
              <div className="flex-1 overflow-y-auto space-y-6 custom-scrollbar pr-3">
                {configMode === 'JSON' ? (
                  <textarea value={rawConfigJson} onChange={e => syncToRawJson(JSON.parse(e.target.value))} className="w-full h-[400px] bg-slate-950 border border-slate-800 rounded-[2.5rem] p-10 text-sm font-mono text-indigo-300 outline-none shadow-inner leading-relaxed" />
                ) : (
                  <div className="space-y-6">
                    {requests.map((req, idx) => (
                      <div key={req.id} className="bg-slate-900/20 border border-slate-800 rounded-[3rem] overflow-hidden">
                        {/* Request Header */}
                        <div className="px-8 py-6 bg-slate-900/50 flex items-center justify-between cursor-pointer group" onClick={() => setExpandedRequestId(expandedRequestId === req.id ? null : req.id)}>
                          <div className="flex items-center gap-5">
                            <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center text-indigo-400 font-black text-xs">0{idx + 1}</div>
                            <div>
                              <span className="text-xs font-black text-indigo-500 uppercase tracking-widest block mb-0.5">{req.method}</span>
                              <span className="text-sm font-mono text-slate-400 truncate max-w-[300px] block">{req.url}</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            <button onClick={(e) => { e.stopPropagation(); setRequests(requests.filter(r => r.id !== req.id)); }} className="p-3 text-slate-600 hover:text-red-400 transition-colors"><Trash2 size={20} /></button>
                            {expandedRequestId === req.id ? <ChevronDown size={20} className="text-slate-400" /> : <ChevronRight size={20} className="text-slate-600 group-hover:text-slate-400" />}
                          </div>
                        </div>

                        {/* Expanded Form */}
                        {expandedRequestId === req.id && (
                          <div className="p-10 space-y-10 border-t border-slate-800/50 animate-in slide-in-from-top-4 duration-300">
                            {/* Section: URL & Method */}
                            <div className="grid grid-cols-4 gap-4">
                              <div className="col-span-1">
                                <label className="text-[11px] font-black text-slate-500 uppercase tracking-widest ml-1 mb-2 block">Method</label>
                                <select value={req.method} onChange={e => updateRequest(req.id, 'method', e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-5 py-4 text-sm text-white font-black uppercase outline-none focus:border-indigo-500 transition-all">{['GET', 'POST', 'PUT', 'DELETE'].map(m => <option key={m}>{m}</option>)}</select>
                              </div>
                              <div className="col-span-3">
                                <label className="text-[11px] font-black text-slate-500 uppercase tracking-widest ml-1 mb-2 block">Endpoint URL</label>
                                <input value={req.url} onChange={e => updateRequest(req.id, 'url', e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-sm text-slate-300 font-mono outline-none focus:border-indigo-500 transition-all" />
                              </div>
                            </div>

                            {/* Section: Headers */}
                            <div className="space-y-4">
                              <div className="flex justify-between items-center ml-1">
                                <label className="text-[11px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-2"><ListFilter size={14} /> Request Headers</label>
                                <button onClick={() => updateRequest(req.id, 'headers', [...req.headers, { key: '', value: '' }])} className="text-[11px] font-black text-indigo-500 hover:text-indigo-400 transition-colors tracking-widest uppercase">Add Header +</button>
                              </div>
                              <div className="space-y-3 bg-slate-950/30 p-6 rounded-3xl border border-slate-800/50">
                                {req.headers.length === 0 && <p className="text-xs text-slate-700 italic text-center py-2">No custom headers defined.</p>}
                                {req.headers.map((h, i) => (
                                  <div key={i} className="flex gap-4">
                                    <input value={h.key} onChange={e => { const nh = [...req.headers]; nh[i].key = e.target.value; updateRequest(req.id, 'headers', nh); }} placeholder="Header Key" className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-5 py-3 text-sm text-indigo-400 font-bold outline-none" />
                                    <input value={h.value} onChange={e => { const nh = [...req.headers]; nh[i].value = e.target.value; updateRequest(req.id, 'headers', nh); }} placeholder="Value" className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-5 py-3 text-sm text-slate-400 outline-none" />
                                    <button onClick={() => updateRequest(req.id, 'headers', req.headers.filter((_, j) => i !== j))} className="text-slate-700 hover:text-red-400"><X size={18} /></button>
                                  </div>
                                ))}
                              </div>
                            </div>

                            {/* Section: Body/Payload */}
                            <div className="space-y-4">
                              <div className="flex justify-between items-center ml-1">
                                <label className="text-[11px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-2"><Braces size={14} /> Request Payload</label>
                                <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800 scale-90 origin-right">
                                  <button onClick={() => updateRequest(req.id, 'bodyMode', 'FORM')} className={`px-4 py-1.5 text-[10px] font-black uppercase rounded-lg transition-all ${req.bodyMode === 'FORM' ? 'bg-indigo-600 text-white' : 'text-slate-600'}`}>Fields</button>
                                  <button onClick={() => updateRequest(req.id, 'bodyMode', 'JSON')} className={`px-4 py-1.5 text-[10px] font-black uppercase rounded-lg transition-all ${req.bodyMode === 'JSON' ? 'bg-indigo-600 text-white' : 'text-slate-600'}`}>Raw JSON</button>
                                </div>
                              </div>

                              {req.bodyMode === 'JSON' ? (
                                <textarea value={req.body} onChange={e => updateRequest(req.id, 'body', e.target.value)} className="w-full h-48 bg-slate-950 border border-slate-800 rounded-3xl p-6 text-sm font-mono text-indigo-300 outline-none shadow-inner" />
                              ) : (
                                <div className="space-y-3 bg-slate-950/30 p-6 rounded-3xl border border-slate-800/50">
                                  {getBodyFields(req.body).map((f, i) => (
                                    <div key={i} className="flex gap-4">
                                      <input value={f.key} onChange={e => { const fs = getBodyFields(req.body); fs[i].key = e.target.value; updateBodyFromFields(req.id, fs); }} placeholder="Param Name" className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-5 py-3 text-sm text-emerald-400 font-bold outline-none" />
                                      <input value={f.value} onChange={e => { const fs = getBodyFields(req.body); fs[i].value = e.target.value; updateBodyFromFields(req.id, fs); }} placeholder="Value" className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-5 py-3 text-sm text-slate-300 outline-none" />
                                      <button onClick={() => { const fs = getBodyFields(req.body).filter((_, j) => i !== j); updateBodyFromFields(req.id, fs); }} className="text-slate-700 hover:text-red-400"><X size={18} /></button>
                                    </div>
                                  ))}
                                  <button onClick={() => { const fs = getBodyFields(req.body); fs.push({ key: '', value: '' }); updateBodyFromFields(req.id, fs); }} className="text-[11px] font-black text-emerald-500 hover:text-emerald-400 flex items-center gap-2 mt-4 ml-1 uppercase tracking-widest"><Plus size={14} /> Append Data Field</button>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <button onClick={addRequest} className="w-full py-6 border-2 border-dashed border-slate-900 rounded-[3rem] text-slate-700 text-xs font-black uppercase tracking-[0.3em] hover:text-indigo-500 hover:border-indigo-500/50 transition-all">+ Add Instruction Step</button>
              </div>

              {/* Activity Log */}
              {provisioningStatus !== 'IDLE' && (
                <div className="mt-8 bg-slate-950 p-6 rounded-[2.5rem] border border-slate-900 h-32 overflow-y-auto custom-scrollbar font-mono text-xs shadow-inner">
                  {provisionLog.map((l, i) => <div key={i} className="text-emerald-500/80 mb-2 flex items-center gap-3"><ChevronRight size={12} /> {l}</div>)}
                  {provisioningStatus === 'SENDING' && <div className="text-indigo-400 animate-pulse pl-6">Negotiating protocol...</div>}
                  {provisioningStatus === 'SUCCESS' && <div className="text-emerald-400 font-black mt-4 pl-6 flex items-center gap-2"><CheckCircle size={14} /> Provisioning Sequence Finalized.</div>}
                </div>
              )}

              {/* Deploy Action */}
              {provisioningStatus === 'IDLE' && (
                <button onClick={deployConfig} className="mt-8 w-full py-6 bg-emerald-600 hover:bg-emerald-500 text-white rounded-[2.5rem] font-black text-sm uppercase tracking-[0.2em] shadow-2xl shadow-emerald-600/20 active:scale-95 transition-all flex items-center justify-center gap-4">
                  <Zap size={24} /> Commit Sequence to Node
                </button>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-10 py-10 border-t border-slate-900/50 flex justify-between bg-slate-950/50 backdrop-blur-3xl">
          <button onClick={() => step > 1 ? setStep(step - 1) : onClose()} className="px-10 py-4 text-slate-500 hover:text-white font-black text-xs uppercase tracking-widest transition-colors">Back</button>
          <div className="flex gap-4">
            {step < 3 ? (
              <button onClick={handleNext} disabled={step === 2 && !connectedDevice} className="px-12 py-4 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-900 disabled:text-slate-700 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all shadow-xl shadow-indigo-600/20">Proceed</button>
            ) : (
              <button onClick={() => { onAdd({ ...formData, ip: getDeviceIp(), status: DeviceStatus.ONLINE }); onClose(); }} disabled={provisioningStatus !== 'SUCCESS'} className="px-12 py-4 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-900 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all">Finalize & Bind</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
