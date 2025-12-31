
import React, { useState, useEffect } from 'react';
import {
  X, Plus, Trash2, Wifi, Bluetooth, RefreshCw, CheckCircle, Cpu, Signal, ChevronDown, ChevronRight, Zap, Loader2, ArrowRight, ShieldCheck, ListFilter, Braces, Lock, Clock, AlertCircle
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
  session: any;
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
  deviceTypes, connectionTypes, session
}) => {
  const [step, setStep] = useState(1);

  // Provisioning State
  const [provisionStep, setProvisionStep] = useState<'INIT' | 'KEY' | 'TIME' | 'WIFI' | 'DONE'>('INIT');
  const [keyPayload, setKeyPayload] = useState<any>(null);
  const [wifiList, setWifiList] = useState<any[]>([]);
  const [selectedWifi, setSelectedWifi] = useState<string>('');
  const [wifiPassword, setWifiPassword] = useState<string>('');
  const [provisionStatus, setProvisionStatus] = useState<{
    init: 'PENDING' | 'LOADING' | 'SUCCESS' | 'ERROR';
    key: 'PENDING' | 'LOADING' | 'SUCCESS' | 'ERROR';
    time: 'PENDING' | 'LOADING' | 'SUCCESS' | 'ERROR';
    wifi: 'PENDING' | 'LOADING' | 'SUCCESS' | 'ERROR';
  }>({
    init: 'PENDING',
    key: 'PENDING',
    time: 'PENDING',
    wifi: 'PENDING'
  });
  const [provisionError, setProvisionError] = useState<string>('');
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

  const [targetIp, setTargetIp] = useState('10.10.10.1');
  const wifiPasswordRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      // 重置所有状态
      setStep(1);
      setConnectedDevice(null);
      setConnectionStatus('IDLE');
      setProvisioningStatus('IDLE');
      setDiscoveredDevices([]);
      setProvisionLog([]);
      setRequests([]);
      setConnectingToId(null);
      setFormData(prev => ({ ...prev, name: '' }));

      // 重置 Provisioning 状态
      setProvisionStep('INIT');
      setProvisionStatus({
        init: 'PENDING',
        key: 'PENDING',
        time: 'PENDING',
        wifi: 'PENDING'
      });
      setProvisionError('');
      setKeyPayload(null);
      setWifiList([]);
      setSelectedWifi('');
      setWifiPassword('');
      setTargetIp('10.10.10.1');
    }
  }, [isOpen]);

  // Auto-start provisioning when entering Step 3
  useEffect(() => {
    if (step === 3 && provisionStep === 'INIT' && provisionStatus.init === 'PENDING') {
      const timer = setTimeout(() => {
        runInit();
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [step, provisionStep, provisionStatus.init]);

  useEffect(() => {
    if (step === 3 && requests.length === 0) {
      const currentIp = targetIp;
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
  }, [step, requests.length, targetIp]);

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
    const currentIp = targetIp;
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

  // 辅助函数：执行初始化
  const runInit = async () => {
    setProvisionStatus(prev => ({ ...prev, init: 'LOADING' }));
    setProvisionError('');
    try {
      const ip = targetIp;
      const res = await window.electronAPI?.provisionInit({ ip, session });
      if (res?.success) {
        setProvisionStatus(prev => ({ ...prev, init: 'SUCCESS' }));
        setProvisionStep('KEY');
        runGetKey(); // 自动进入下一步获取 Key
      } else {
        setProvisionStatus(prev => ({ ...prev, init: 'ERROR' }));
        setProvisionError(res?.error || res?.message || 'Init failed');
      }
    } catch (e: any) {
      setProvisionStatus(prev => ({ ...prev, init: 'ERROR' }));
      setProvisionError(e.message);
    }
  };

  // 辅助函数：获取 Key Payload
  const runGetKey = async () => {
    setProvisionStatus(prev => ({ ...prev, key: 'LOADING' }));
    setProvisionError('');
    try {
      const res = await window.electronAPI?.provisionGetKeyPayload({ session });
      if (res?.success) {
        setKeyPayload(res.payload);
        setProvisionStatus(prev => ({ ...prev, key: 'PENDING' }));
        // 这里不自动发送，等待用户确认
      } else {
        setProvisionStatus(prev => ({ ...prev, key: 'ERROR' }));
        setProvisionError(res?.error || 'Get Key failed');
      }
    } catch (e: any) {
      setProvisionStatus(prev => ({ ...prev, key: 'ERROR' }));
      setProvisionError(e.message);
    }
  };

  // 辅助函数：发送 Key
  const sendKey = async () => {
    setProvisionStatus(prev => ({ ...prev, key: 'LOADING' }));
    setProvisionError('');
    try {
      const ip = targetIp;
      const res = await window.electronAPI?.provisionSendRequest({
        ip,
        namespace: 'Appliance.Config.Key',
        method: 'SET',
        payload: keyPayload,
        session
      });
      if (res?.success) {
        setProvisionStatus(prev => ({ ...prev, key: 'SUCCESS' }));
        setProvisionStep('TIME');
        runSetTime(); // 自动设置时间
      } else {
        setProvisionStatus(prev => ({ ...prev, key: 'ERROR' }));
        setProvisionError(res?.error || 'Send Key failed');
      }
    } catch (e: any) {
      setProvisionStatus(prev => ({ ...prev, key: 'ERROR' }));
      setProvisionError(e.message);
    }
  };

  // 辅助函数：设置时间
  const runSetTime = async () => {
    setProvisionStatus(prev => ({ ...prev, time: 'LOADING' }));
    setProvisionError('');
    try {
      const ip = targetIp;
      const res = await window.electronAPI?.provisionSetTime({ ip, session });
      if (res?.success) {
        setProvisionStatus(prev => ({ ...prev, time: 'SUCCESS' }));
        setProvisionStep('WIFI');
        scanWifiForProvision(); // 自动扫描 WiFi
      } else {
        setProvisionStatus(prev => ({ ...prev, time: 'ERROR' }));
        setProvisionError(res?.error || 'Set Time failed');
      }
    } catch (e: any) {
      setProvisionStatus(prev => ({ ...prev, time: 'ERROR' }));
      setProvisionError(e.message);
    }
  };

  // 辅助函数：扫描 WiFi
  const scanWifiForProvision = async () => {
    setProvisionStatus(prev => ({ ...prev, wifi: 'LOADING' }));
    setProvisionError('');
    try {
      const list = await window.electronAPI?.scanWifi() || [];
      setWifiList(list);
      // 扫描成功后重置状态为 PENDING，允许用户点击按钮
      setProvisionStatus(prev => ({ ...prev, wifi: 'PENDING' }));
    } catch (e: any) {
      setProvisionStatus(prev => ({ ...prev, wifi: 'ERROR' }));
      setProvisionError(e.message);
    }
  };

  // 辅助函数：发送 WiFi
  const sendWifi = async () => {
    console.log('[AddDeviceModal] sendWifi called');
    console.log('[AddDeviceModal] electronAPI:', window.electronAPI);

    if (!window.electronAPI?.provisionSetWifi) {
      console.error('[AddDeviceModal] provisionSetWifi API not found!');
      setProvisionStatus(prev => ({ ...prev, wifi: 'ERROR' }));
      setProvisionError('Internal Error: API not found');
      return;
    }

    setProvisionStatus(prev => ({ ...prev, wifi: 'LOADING' }));
    setProvisionError('');
    try {
      const ip = targetIp;

      // Test IPC connectivity with a known working method
      console.log('[AddDeviceModal] Testing IPC with provisionSetTime...');
      try {
        await window.electronAPI.provisionSetTime({ ip, session });
        console.log('[AddDeviceModal] IPC Test Passed (provisionSetTime)');
      } catch (err) {
        console.error('[AddDeviceModal] IPC Test Failed:', err);
      }

      console.log('[AddDeviceModal] Invoking provisionSetWifi IPC', { ip, ssid: selectedWifi });

      // 从 wifiList 中获取选中 WiFi 的完整信息
      const selectedWifiInfo = wifiList.find((w: any) => w.name === selectedWifi);

      // Sanitize session object to prevent IPC serialization issues
      const safeSession = {
        key: session?.key,
        uid: session?.uid,
        token: session?.token,
        mqttDomain: session?.mqttDomain,
        domain: session?.domain
      };

      // 构建 wifiConfig 对象
      const wifiConfig = {
        ssid: selectedWifi,
        password: wifiPassword,
        bssid: selectedWifiInfo?.mac || '',
        channel: selectedWifiInfo?.channel || 0
      };

      console.log('[AddDeviceModal] wifiConfig:', wifiConfig);

      // Add 15s timeout for IPC call
      const ipcPromise = window.electronAPI.provisionSetWifi({
        ip,
        wifiConfig,
        session: safeSession
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('IPC Timeout')), 15000)
      );

      const res: any = await Promise.race([ipcPromise, timeoutPromise]);

      console.log('[AddDeviceModal] provisionSetWifi returned', res);
      if (res?.success) {
        setProvisionStatus(prev => ({ ...prev, wifi: 'SUCCESS' }));
        setProvisionStep('DONE');
        setProvisionError(''); // Clear any previous error
        // 配网成功后，设备需要时间连接到家庭 WiFi 和 MQTT
        // 用户也需要切换回家庭 WiFi 才能继续使用
      } else {
        setProvisionStatus(prev => ({ ...prev, wifi: 'ERROR' }));
        setProvisionError(res?.error || 'Set WiFi failed');
      }
    } catch (e: any) {
      console.error('[AddDeviceModal] sendWifi error', e);
      setProvisionStatus(prev => ({ ...prev, wifi: 'ERROR' }));
      setProvisionError(e.message || 'Set WiFi failed');
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
                <label className="text-xs font-black text-slate-500 uppercase tracking-widest ml-1">Device Name</label>
                <input
                  autoFocus
                  value={formData.name}
                  onChange={e => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g. Workshop Smart Plug"
                  className="w-full bg-slate-900/50 border border-slate-800 rounded-3xl px-6 py-5 text-base text-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all outline-none"
                />
              </div>

              <div className="space-y-4">
                <label className="text-xs font-black text-slate-500 uppercase tracking-widest ml-1">Connection Type</label>
                <div className="grid grid-cols-2 gap-4">
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, connectionType: 'WIFI' })}
                    className={`p-6 rounded-2xl border-2 transition-all flex flex-col items-center gap-3 ${formData.connectionType === 'WIFI'
                      ? 'border-indigo-500 bg-indigo-500/10 text-indigo-400'
                      : 'border-slate-800 bg-slate-900/30 text-slate-500 hover:border-slate-700'
                      }`}
                  >
                    <Wifi size={32} />
                    <span className="font-black text-sm uppercase tracking-wider">WiFi AP Mode</span>
                    <p className="text-[10px] text-slate-500">Connect to device hotspot</p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, connectionType: 'BLE' })}
                    className={`p-6 rounded-2xl border-2 transition-all flex flex-col items-center gap-3 ${formData.connectionType === 'BLE'
                      ? 'border-indigo-500 bg-indigo-500/10 text-indigo-400'
                      : 'border-slate-800 bg-slate-900/30 text-slate-500 hover:border-slate-700'
                      }`}
                  >
                    <Bluetooth size={32} />
                    <span className="font-black text-sm uppercase tracking-wider">Bluetooth</span>
                    <p className="text-[10px] text-slate-500">Scan and pair via BLE</p>
                  </button>
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
                      <p className="text-xs font-medium text-emerald-400">Locked on {connectedDevice?.name} // Interface @ {targetIp}</p>
                    </div>
                  </div>
                  <ArrowRight className="text-emerald-500 animate-bounce-x" />
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="flex flex-col h-full max-h-[calc(100vh-200px)] animate-in fade-in slide-in-from-right-4 duration-500">
              {/* Header */}
              <div className="bg-slate-900/40 p-4 rounded-[2rem] border border-slate-800 flex items-center justify-between mb-4 flex-shrink-0">
                <div className="flex items-center gap-4">
                  <div className="p-3 bg-indigo-500/10 rounded-xl text-indigo-400"><Cpu size={20} /></div>
                  <div>
                    <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Target Endpoint</p>
                    <input
                      value={targetIp}
                      onChange={e => setTargetIp(e.target.value)}
                      className="text-sm font-mono text-white tracking-tight bg-transparent border-b border-slate-700 focus:border-indigo-500 outline-none w-32"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className={`w-2.5 h-2.5 rounded-full ${provisionStep === 'DONE' ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'}`} />
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{provisionStep === 'DONE' ? 'DONE' : 'PROVISIONING'}</span>
                </div>
              </div>

              {/* Provisioning Steps - Scrollable Area */}
              <div className="flex-1 overflow-y-auto space-y-3 custom-scrollbar pr-2 min-h-0">

                {/* Step 1: Initialization */}
                <div className={`p-4 rounded-xl border transition-all ${provisionStep === 'INIT' ? 'bg-slate-900/50 border-indigo-500/50 shadow-lg shadow-indigo-500/10' : 'bg-slate-950/50 border-slate-800/50 opacity-60'}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${provisionStatus.init === 'SUCCESS' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400'}`}>
                        {provisionStatus.init === 'LOADING' ? <Loader2 size={18} className="animate-spin" /> : <ShieldCheck size={18} />}
                      </div>
                      <div>
                        <h4 className="text-xs font-black text-white uppercase tracking-wide">Security Handshake</h4>
                        <p className="text-[10px] text-slate-500">Establish secure session</p>
                      </div>
                    </div>
                    {provisionStatus.init === 'PENDING' && provisionStep === 'INIT' && (
                      <button onClick={runInit} className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-[10px] font-black uppercase tracking-wider transition-all">Start</button>
                    )}
                    {provisionStatus.init === 'SUCCESS' && <CheckCircle size={18} className="text-emerald-500" />}
                  </div>
                  {provisionStatus.init === 'ERROR' && (
                    <div className="mt-2 p-2 bg-red-500/10 border border-red-500/20 rounded-lg text-[10px] text-red-400 flex items-center gap-2">
                      <AlertCircle size={12} /> {provisionError}
                      <button onClick={runInit} className="ml-auto underline hover:text-red-300">Retry</button>
                    </div>
                  )}
                </div>

                {/* Step 2: Set Key */}
                <div className={`p-4 rounded-xl border transition-all ${provisionStep === 'KEY' ? 'bg-slate-900/50 border-indigo-500/50 shadow-lg shadow-indigo-500/10' : 'bg-slate-950/50 border-slate-800/50 opacity-60'}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${provisionStatus.key === 'SUCCESS' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400'}`}>
                        {provisionStatus.key === 'LOADING' ? <Loader2 size={18} className="animate-spin" /> : <Lock size={18} />}
                      </div>
                      <div>
                        <h4 className="text-xs font-black text-white uppercase tracking-wide">Device Binding</h4>
                        <p className="text-[10px] text-slate-500">Configure owner key</p>
                      </div>
                    </div>
                    {provisionStatus.key === 'SUCCESS' && <CheckCircle size={18} className="text-emerald-500" />}
                  </div>

                  {provisionStep === 'KEY' && keyPayload && (
                    <div className="mt-3 space-y-2 animate-in slide-in-from-top-2">
                      <textarea
                        value={JSON.stringify(keyPayload, null, 2)}
                        onChange={e => {
                          try {
                            setKeyPayload(JSON.parse(e.target.value));
                          } catch { }
                        }}
                        className="w-full h-24 bg-slate-950 rounded-lg border border-slate-800 font-mono text-[9px] text-slate-400 p-3 outline-none focus:border-indigo-500 transition-all resize-none"
                      />
                      <button onClick={sendKey} disabled={provisionStatus.key === 'LOADING'} className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-[10px] font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2">
                        {provisionStatus.key === 'LOADING' ? <Loader2 size={12} className="animate-spin" /> : 'Confirm & Bind'}
                      </button>
                    </div>
                  )}

                  {provisionStatus.key === 'ERROR' && (
                    <div className="mt-2 p-2 bg-red-500/10 border border-red-500/20 rounded-lg text-[10px] text-red-400 flex items-center gap-2">
                      <AlertCircle size={12} /> {provisionError}
                      <button onClick={runGetKey} className="ml-auto underline hover:text-red-300">Retry</button>
                    </div>
                  )}
                </div>

                {/* Step 3: Set Time */}
                <div className={`p-4 rounded-xl border transition-all ${provisionStep === 'TIME' ? 'bg-slate-900/50 border-indigo-500/50 shadow-lg shadow-indigo-500/10' : 'bg-slate-950/50 border-slate-800/50 opacity-60'}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${provisionStatus.time === 'SUCCESS' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400'}`}>
                        {provisionStatus.time === 'LOADING' ? <Loader2 size={18} className="animate-spin" /> : <Clock size={18} />}
                      </div>
                      <div>
                        <h4 className="text-xs font-black text-white uppercase tracking-wide">Time Sync</h4>
                        <p className="text-[10px] text-slate-500">Synchronize device clock</p>
                      </div>
                    </div>
                    {provisionStatus.time === 'SUCCESS' && <CheckCircle size={18} className="text-emerald-500" />}
                  </div>
                  {provisionStatus.time === 'ERROR' && (
                    <div className="mt-2 p-2 bg-red-500/10 border border-red-500/20 rounded-lg text-[10px] text-red-400 flex items-center gap-2">
                      <AlertCircle size={12} /> {provisionError}
                      <button onClick={runSetTime} className="ml-auto underline hover:text-red-300">Retry</button>
                    </div>
                  )}
                </div>

                {/* Step 4: Set WiFi */}
                <div className={`p-4 rounded-xl border transition-all ${provisionStep === 'WIFI' ? 'bg-slate-900/50 border-indigo-500/50 shadow-lg shadow-indigo-500/10' : 'bg-slate-950/50 border-slate-800/50 opacity-60'}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${provisionStatus.wifi === 'SUCCESS' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400'}`}>
                        {provisionStatus.wifi === 'LOADING' ? <Loader2 size={18} className="animate-spin" /> : <Wifi size={18} />}
                      </div>
                      <div>
                        <h4 className="text-xs font-black text-white uppercase tracking-wide">Network Config</h4>
                        <p className="text-[10px] text-slate-500">Connect to home WiFi</p>
                      </div>
                    </div>
                    {provisionStatus.wifi === 'SUCCESS' && <CheckCircle size={18} className="text-emerald-500" />}
                  </div>

                  {provisionStep === 'WIFI' && (
                    <div className="mt-3 space-y-2 animate-in slide-in-from-top-2">
                      {wifiList.length === 0 ? (
                        <div className="text-center py-4">
                          <Loader2 size={20} className="animate-spin mx-auto text-indigo-500 mb-2" />
                          <p className="text-[10px] text-slate-500 font-medium">Scanning networks...</p>
                        </div>
                      ) : (
                        <>
                          <div className="space-y-1.5 max-h-44 overflow-y-auto custom-scrollbar pr-1">
                            {wifiList.map((net) => (
                              <button
                                key={net.id}
                                onClick={() => {
                                  setSelectedWifi(net.name);
                                  // 选择后自动滚动到密码输入区域
                                  setTimeout(() => {
                                    wifiPasswordRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                                  }, 100);
                                }}
                                className={`w-full p-2.5 rounded-lg border text-left flex items-center justify-between transition-all ${selectedWifi === net.name ? 'bg-indigo-600 border-indigo-500' : 'bg-slate-900 border-slate-800 hover:border-slate-600'}`}
                              >
                                <span className={`text-xs font-bold truncate ${selectedWifi === net.name ? 'text-white' : 'text-slate-200'}`}>{net.name}</span>
                                <span className={`text-[10px] ${selectedWifi === net.name ? 'text-indigo-200' : 'text-slate-500'}`}>{net.rssi}dBm</span>
                              </button>
                            ))}
                          </div>

                          {selectedWifi && (
                            <div ref={wifiPasswordRef} className="mt-2 space-y-2 animate-in slide-in-from-top-2">
                              <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                                  <Lock size={14} />
                                </div>
                                <input
                                  type="password"
                                  placeholder={`Password for ${selectedWifi}`}
                                  value={wifiPassword}
                                  onChange={(e) => setWifiPassword(e.target.value)}
                                  className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-9 pr-3 py-2 text-xs text-white outline-none focus:border-indigo-500 transition-all placeholder:text-slate-600"
                                  autoFocus
                                />
                              </div>
                              <button onClick={sendWifi} disabled={provisionStatus.wifi === 'LOADING'} className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-[10px] font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2">
                                {provisionStatus.wifi === 'LOADING' ? <Loader2 size={14} className="animate-spin" /> : 'Connect & Finish'}
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {provisionStatus.wifi === 'ERROR' && (
                    <div className="mt-2 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-400 flex items-center gap-2">
                      <AlertCircle size={14} /> {provisionError}
                      <button onClick={scanWifiForProvision} className="ml-auto underline hover:text-red-300">Retry</button>
                    </div>
                  )}
                </div>

                {/* Success Message */}
                {provisionStep === 'DONE' && (
                  <div className="p-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 animate-in fade-in slide-in-from-bottom-2">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center">
                        <CheckCircle size={24} className="text-emerald-400" />
                      </div>
                      <div>
                        <h4 className="text-sm font-black text-emerald-400 uppercase">Provisioning Complete!</h4>
                        <p className="text-[10px] text-slate-400">Device is connecting to your home network</p>
                      </div>
                    </div>
                    <div className="space-y-2 text-[10px] text-slate-400 bg-slate-900/50 rounded-lg p-3">
                      <p className="flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                        <span><b>Step 1:</b> Switch your computer back to your home WiFi network</span>
                      </p>
                      <p className="flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                        <span><b>Step 2:</b> Wait 30-60 seconds for the device to connect to MQTT</span>
                      </p>
                      <p className="flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                        <span><b>Step 3:</b> Click "Finalize & Bind" to complete the setup</span>
                      </p>
                    </div>
                  </div>
                )}

              </div>
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
              <button onClick={() => { onAdd({ ...formData, ip: targetIp, status: DeviceStatus.ONLINE }); onClose(); }} disabled={provisioningStatus !== 'SUCCESS'} className="px-12 py-4 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-900 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all">Finalize & Bind</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
