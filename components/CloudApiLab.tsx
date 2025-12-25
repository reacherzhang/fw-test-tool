
import React, { useState, useEffect } from 'react';
import { Send, Terminal, Trash2, Globe, ShieldCheck, Zap, History, Braces, ListFilter, Play, ChevronRight, X, Loader2 } from 'lucide-react';
import { CloudSession, ApiHistoryEntry, GlobalLogEntry } from '../types';

interface CloudApiLabProps {
  session: CloudSession;
  onLog?: (log: Omit<GlobalLogEntry, 'id' | 'timestamp'>) => void;
}

export const CloudApiLab: React.FC<CloudApiLabProps> = ({ session, onLog }) => {
  const [method, setMethod] = useState<'GET' | 'POST' | 'PUT' | 'DELETE'>('POST');
  const [path, setPath] = useState('/user/v1/baseInfo');
  const [payload, setPayload] = useState('{\n  "regionCode": "CN",\n  "timezone": "Asia/Shanghai"\n}');
  const [response, setResponse] = useState<any>(null);
  const [isSending, setIsSending] = useState(false);
  const [history, setHistory] = useState<ApiHistoryEntry[]>([]);

  useEffect(() => {
    const saved = localStorage.getItem('nexus_api_history');
    if (saved) setHistory(JSON.parse(saved));
  }, []);

  const saveHistory = (newHistory: ApiHistoryEntry[]) => {
    setHistory(newHistory);
    localStorage.setItem('nexus_api_history', JSON.stringify(newHistory));
  };

  const handleSend = async () => {
    setIsSending(true);

    const domain = session.httpDomain.replace(/^https?:\/\//, '');
    const fullUrl = `https://${domain}${path.startsWith('/') ? path : '/' + path}`;

    const headers = {
      "Vendor": "merossBeta",
      "AppVersion": "3.35.1",
      "Authorization": `Basic ${session.token}`,
      "Tz": "Asia/Shanghai",
      "AppLanguage": "en",
      "AppType": "Android",
      "App-Gray-Id": "291953204307901",
      "Content-Type": "application/json"
    };

    // 增强型 TX 日志
    onLog?.({
      type: 'HTTP',
      direction: 'TX',
      label: `Lab Request -> [${path}]`,
      detail: `[URL]: ${fullUrl}\n[Method]: ${method}\n[Headers]: ${JSON.stringify(headers, null, 2)}\n[Body]: ${payload}\n\n[Channel]: Electron Native`
    });

    try {
      const resultObj = await (window as any).electronAPI.nativeRequest({
        url: fullUrl,
        method,
        headers,
        body: method !== 'GET' ? payload : undefined
      });

      const result = resultObj.data;
      setResponse(result);

      // 增强型 RX 日志
      onLog?.({
        type: 'HTTP',
        direction: 'RX',
        label: `Lab Response <- Status: ${resultObj.status}`,
        detail: `[Status]: ${resultObj.status}\n[Body]:\n${JSON.stringify(result, null, 2)}`
      });

      const newEntry: ApiHistoryEntry = {
        id: Math.random().toString(36).substr(2, 9),
        timestamp: new Date().toLocaleTimeString(),
        method,
        url: path,
        requestBody: payload,
        responseBody: JSON.stringify(result, null, 2),
        status: resultObj.status
      };

      saveHistory([newEntry, ...history.slice(0, 49)]);
    } catch (err: any) {
      setResponse({ error: err.message });
      onLog?.({
        type: 'HTTP',
        direction: 'ERR',
        label: `Lab Connection Failed`,
        detail: `[Error]: ${err.message}\n[URL]: ${fullUrl}`
      });
    } finally {
      setIsSending(false);
    }
  };

  const deleteHistory = (id: string) => {
    saveHistory(history.filter(h => h.id !== id));
  };

  const loadFromHistory = (h: ApiHistoryEntry) => {
    setMethod(h.method as any);
    setPath(h.url);
    setPayload(h.requestBody);
    try {
      setResponse(JSON.parse(h.responseBody));
    } catch {
      setResponse(h.responseBody);
    }
  };

  return (
    <div className="max-w-[1600px] mx-auto grid grid-cols-12 gap-8 h-full animate-in fade-in duration-500">
      <aside className="col-span-3 bg-slate-900/40 border border-slate-800 rounded-[3rem] p-8 flex flex-col backdrop-blur-xl">
        <div className="flex justify-between items-center mb-8">
          <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.4em] flex items-center gap-3">
            <History size={16} className="text-indigo-400" /> API History
          </h3>
          <button onClick={() => { if (confirm("Clear all history?")) saveHistory([]); }} className="text-slate-600 hover:text-red-400 transition-colors"><Trash2 size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar space-y-3 pr-2">
          {history.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-slate-700 opacity-20 italic text-[10px] font-black uppercase tracking-widest text-center px-4">
              No history recorded.
            </div>
          )}
          {history.map((h) => (
            <div
              key={h.id}
              className="group bg-slate-950/50 border border-slate-800 hover:border-indigo-500/50 p-4 rounded-2xl cursor-pointer transition-all relative"
              onClick={() => loadFromHistory(h)}
            >
              <div className="flex justify-between items-center mb-1">
                <span className={`text-[8px] font-black px-1.5 py-0.5 rounded uppercase ${h.method === 'POST' ? 'bg-indigo-500/10 text-indigo-400' : 'bg-emerald-500/10 text-emerald-400'}`}>{h.method}</span>
                <span className="text-[8px] font-mono text-slate-600">{h.timestamp}</span>
              </div>
              <p className="text-[11px] font-mono text-slate-400 truncate">{h.url}</p>
              <button
                onClick={(e) => { e.stopPropagation(); deleteHistory(h.id); }}
                className="absolute -top-1 -right-1 p-1.5 bg-red-500/10 text-red-400 rounded-full opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500/20"
              >
                <Trash2 size={10} />
              </button>
            </div>
          ))}
        </div>
      </aside>

      <main className="col-span-9 flex flex-col gap-8">
        <div className="bg-slate-900/40 border border-slate-800 rounded-[3.5rem] p-10 backdrop-blur-xl flex flex-col gap-8">
          <div className="flex items-center justify-between border-b border-slate-800 pb-8">
            <div className="flex items-center gap-6">
              <div className="w-14 h-14 bg-indigo-600/10 border border-indigo-500/20 rounded-2xl flex items-center justify-center text-indigo-400">
                <Globe size={28} />
              </div>
              <div>
                <h2 className="text-2xl font-black text-white uppercase tracking-tighter">Custom API <span className="text-indigo-500">Bridge</span></h2>
                <p className="text-[10px] font-black text-slate-600 uppercase tracking-[0.3em] mt-1 font-mono">{session.httpDomain}</p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-right">
                <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Active Token</p>
                <p className="text-xs font-mono text-emerald-400 truncate max-w-[150px]">{session.token}</p>
              </div>
              <div className="w-10 h-10 bg-emerald-500/10 rounded-xl flex items-center justify-center text-emerald-500"><ShieldCheck size={20} /></div>
            </div>
          </div>

          <div className="grid grid-cols-12 gap-6">
            <div className="col-span-2">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1 mb-2 block">Method</label>
              <select
                value={method}
                onChange={e => setMethod(e.target.value as any)}
                className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-5 py-4 text-xs font-black text-white uppercase outline-none focus:border-indigo-500 shadow-inner"
              >
                <option>GET</option>
                <option>POST</option>
                <option>PUT</option>
                <option>DELETE</option>
              </select>
            </div>
            <div className="col-span-10">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1 mb-2 block">Endpoint Path</label>
              <div className="relative">
                <input
                  type="text"
                  value={path}
                  onChange={e => setPath(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-6 py-4 text-xs font-mono text-white outline-none focus:border-indigo-500 shadow-inner"
                  placeholder="/user/v1/baseInfo"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-10 flex-1">
            <div className="flex flex-col gap-4">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-2"><Braces size={14} /> Request Body</label>
              <textarea
                value={payload}
                onChange={e => setPayload(e.target.value)}
                className="flex-1 bg-slate-950 border border-slate-800 rounded-[2.5rem] p-8 font-mono text-xs text-indigo-300 outline-none focus:border-indigo-500 shadow-inner leading-relaxed resize-none"
              />
            </div>
            <div className="flex flex-col gap-4">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-2"><Terminal size={14} /> Response</label>
              <div className="flex-1 bg-slate-950 border border-slate-800 rounded-[2.5rem] p-8 font-mono text-xs text-emerald-400 overflow-y-auto custom-scrollbar shadow-inner leading-relaxed">
                {response ? <pre className="whitespace-pre-wrap">{JSON.stringify(response, null, 2)}</pre> : <p className="text-slate-800 italic">No response received.</p>}
              </div>
            </div>
          </div>

          <div className="flex justify-end pt-4 border-t border-slate-800">
            <button
              onClick={handleSend}
              disabled={isSending}
              className="px-16 py-5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-[2rem] font-black text-xs uppercase tracking-[0.3em] flex items-center gap-4 transition-all shadow-2xl shadow-indigo-600/20 active:scale-95 disabled:opacity-50"
            >
              {isSending ? <Loader2 size={18} className="animate-spin" /> : <Zap size={18} />}
              {isSending ? 'Sending...' : 'Send Request'}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
};
