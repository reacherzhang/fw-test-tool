
import React, { useState } from 'react';
import { Mail, Lock, CloudLightning, ArrowRight, Loader2, UserCircle, Shield, AlertCircle, UserPlus, LogIn, Globe, Settings2, Terminal, ToggleLeft, ToggleRight, ChevronDown } from 'lucide-react';
import { CloudSession, GlobalLogEntry, IOT_CONSTANTS } from '../types';

// ============================================================
// 稳健的 MD5 算法实现 (Standard Implementation)
// ============================================================
export function md5(string: string) {
  function k(n: number, s: number) { return (n << s) | (n >>> (32 - s)); }
  function add(x: number, y: number) {
    const lsw = (x & 0xFFFF) + (y & 0xFFFF);
    const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xFFFF);
  }
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];
  const t: number[] = [];
  for (let i = 0; i < 64; i++) t[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

  const words: number[] = [];
  const str = unescape(encodeURIComponent(string));
  for (let i = 0; i < str.length; i++) words[i >> 2] |= (str.charCodeAt(i) & 0xFF) << ((i % 4) * 8);

  const byteCount = str.length;
  words[byteCount >> 2] |= 0x80 << ((byteCount % 4) * 8);
  words[(((byteCount + 8) >> 6) << 4) + 14] = byteCount * 8;

  let a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;

  for (let i = 0; i < words.length; i += 16) {
    let [oa, ob, oc, od] = [a, b, c, d];
    for (let j = 0; j < 64; j++) {
      let f, g;
      if (j < 16) { f = (b & c) | (~b & d); g = j; }
      else if (j < 32) { f = (d & b) | (~d & c); g = (5 * j + 1) % 16; }
      else if (j < 48) { f = b ^ c ^ d; g = (3 * j + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * j) % 16; }
      const temp = d;
      d = c;
      c = b;
      b = add(b, k(add(a, add(f, add(t[j], words[i + g]))), s[j]));
      a = temp;
    }
    a = add(a, oa); b = add(b, ob); c = add(c, oc); d = add(d, od);
  }

  return [a, b, c, d].map(v => {
    let hex = "";
    for (let i = 0; i < 4; i++) hex += ((v >> (i * 8)) & 0xFF).toString(16).padStart(2, "0");
    return hex;
  }).join("");
}

// 安全的 Python 风格 JSON 序列化
const pythonJsonDumps = (obj: any) => {
  const compact = JSON.stringify(obj);
  return compact.replace(/("(?:\\.|[^"])*")|([,:])/g, (match, isString, isPunctuation) => {
    if (isString) return isString;
    return isPunctuation === ',' ? ', ' : ': ';
  });
};

// 区域服务器配置
const REGION_SERVERS: { [key: string]: string } = {
  'meross-iot-ap': 'https://iotx-ap.meross.com',
  'meross-iot-us': 'https://iotx-us.meross.com',
  'meross-iot-eu': 'https://iotx-eu.meross.com',
  'meross-test-ap': 'https://test-ap-alb-mix.meross.com',
  'meross-test-us': 'https://test-us-alb-mix.meross.com',
  'refoss-iot-ap': 'https://iotx-ap.refoss.net',
  'refoss-iot-us': 'https://iotx-us.refoss.net',
  'refoss-iot-eu': 'https://iotx-eu.refoss.net',
  'refoss-test-ap': 'https://test-ap-alb-mix.refoss.net',
  'refoss-test-us': 'https://test-us-alb-mix.refoss.net',
};

const IOT_CONFIG = {
  DEFAULT_URL: 'https://iotx-us.meross.com',
  UDID: 'B817C936-3F0F-4EEE-BC4D-6EFDEC79E2F9',
  VENDOR: 'merossBeta',
  APP_GRAY_ID: 91522422430125,
  ACCOUNT_COUNTRY_CODE: 'US'
};

interface AuthScreenProps {
  onLoginSuccess: (session: CloudSession) => void;
  onLog: (log: Omit<GlobalLogEntry, 'id' | 'timestamp'>) => void;
  isLogEnabled: boolean;
  onToggleLog: (enabled: boolean) => void;
  isLogVisible: boolean;
  onToggleLogVisibility: () => void;
}

export const AuthScreen: React.FC<AuthScreenProps> = ({
  onLoginSuccess, onLog, isLogEnabled, onToggleLog, isLogVisible, onToggleLogVisibility
}) => {
  const [isLoginMode, setIsLoginMode] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [selectedRegion, setSelectedRegion] = useState('meross-iot-us');
  const [serverUrl, setServerUrl] = useState(REGION_SERVERS['meross-iot-us']);
  const [showConfig, setShowConfig] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 当 region 变化时，自动更新 serverUrl
  const handleRegionChange = (region: string) => {
    setSelectedRegion(region);
    setServerUrl(REGION_SERVERS[region] || IOT_CONFIG.DEFAULT_URL);
  };

  const encapsulatePacket = (paramsValues: any) => {
    const key = IOT_CONSTANTS.APP_PRODUCT_KEY;
    const nonce = IOT_CONFIG.UDID;
    const timestamp_int = Math.floor(Date.now() / 1000);
    const params_json = pythonJsonDumps(paramsValues);
    const params_b64_str = btoa(unescape(encodeURIComponent(params_json)));
    const md5_source = key + String(timestamp_int) + nonce + params_b64_str;
    const sign_md5 = md5(md5_source);

    return {
      nonce,
      sign: sign_md5,
      timestamp: timestamp_int,
      params: params_b64_str,
      _debug_info: {
        source: md5_source,
        json: params_json,
        params_b64: params_b64_str,
        key: key,
        sign: sign_md5
      }
    };
  };

  const sendRequestWithRedirect = async (url: string, data: any, headers: any): Promise<any> => {
    const bodyStr = new URLSearchParams(Object.entries(data).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, String(v)])).toString();

    // 增强型 TX 日志
    onLog({
      type: 'HTTP',
      direction: 'TX',
      label: `HTTP Request -> [${url.split('/').pop()}]`,
      detail: `[URL]: ${url}\n[Method]: POST\n[Headers]: ${JSON.stringify(headers, null, 2)}\n[Body]: ${bodyStr}\n\n[Sign Details]:\nKey: ${data._debug_info?.key}\nMD5 Source: ${data._debug_info?.source}\nParams JSON: ${data._debug_info?.json}`
    });

    try {
      const resultObj = await (window as any).electronAPI.nativeRequest({
        url,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...headers
        },
        body: bodyStr
      });

      const result = resultObj.data;

      // 增强型 RX 日志
      onLog({
        type: 'HTTP',
        direction: result.apiStatus === 0 || result.apiStatus === 1030 ? 'RX' : 'ERR',
        label: `HTTP Response <- Status: ${resultObj.status}`,
        detail: `[Status]: ${resultObj.status}\n[Body]:\n${JSON.stringify(result, null, 2)}`
      });

      if (result.apiStatus === 1030) {
        const newDomain = result.data.domain;
        const path = new URL(url).pathname;
        const newUrl = `https://${newDomain.replace(/^https?:\/\//, '')}${path}`;
        return sendRequestWithRedirect(newUrl, data, headers);
      }

      return result;
    } catch (e: any) {
      onLog({
        type: 'HTTP',
        direction: 'ERR',
        label: `Network Failure`,
        detail: `[Error]: ${e.message}\n[URL]: ${url}`
      });
      throw e;
    }
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    const authPath = isLoginMode ? '/v1/Auth/signIn' : '/v1/Auth/signUp';
    const initialUrl = `${serverUrl}${authPath}`;

    try {
      const merossHeaders = {
        "App-Gray-Id": String(IOT_CONFIG.APP_GRAY_ID),
        "AppLanguage": "en",
        "AppType": "iOS",
        "AppVersion": "3.38.6",
        "Vendor": IOT_CONFIG.VENDOR
      };

      const loginParams = {
        accountCountryCode: IOT_CONFIG.ACCOUNT_COUNTRY_CODE,
        email,
        encryption: 1,
        mobileInfo: {
          carrier: "--",
          deviceModel: "iPhone",
          mobileOs: "iOS",
          mobileOsVersion: "18.6.2",
          resolution: "1170 * 2532",
          uuid: IOT_CONFIG.UDID
        },
        password: md5(password),
        vendor: IOT_CONFIG.VENDOR
      };

      const initialPacket = encapsulatePacket(loginParams);
      const authResult = await sendRequestWithRedirect(initialUrl, initialPacket, merossHeaders);

      if (authResult.apiStatus !== 0) {
        throw new Error(authResult.info || `Auth API Error ${authResult.apiStatus}`);
      }

      const dynamicUserKey = authResult.data.key;
      const rawDomain = authResult.data.domain;
      let cleanHttpDomain = "";
      if (rawDomain) {
        cleanHttpDomain = rawDomain.replace(/^https?:\/\//, '');
      } else {
        try {
          cleanHttpDomain = new URL(serverUrl).hostname;
        } catch (e) {
          cleanHttpDomain = serverUrl.replace(/^https?:\/\//, '');
        }
      }

      const initialSession: CloudSession = {
        email,
        uid: authResult.data.userid || authResult.data.uid,
        key: dynamicUserKey,
        token: authResult.data.token,
        httpDomain: cleanHttpDomain,
        mqttDomain: (authResult.data.mqttDomain || 'mqtt.meross.com').replace(/^https?:\/\//, ''),
        udid: IOT_CONFIG.UDID,
        guid: 'PENDING'
      };

      onLoginSuccess(initialSession);

      (async () => {
        try {
          const baseInfoUrl = `https://${cleanHttpDomain}/user/v1/baseInfo`;
          const baseInfoPacket = encapsulatePacket({
            "timezone": "Asia/shanghai",
            "regionCode": "CN"
          });

          const infoResult = await sendRequestWithRedirect(baseInfoUrl, baseInfoPacket, {
            ...merossHeaders,
            "Authorization": `Basic ${authResult.data.token}`
          });

          if (infoResult.apiStatus === 0 && infoResult.data.guid) {
            onLoginSuccess({
              ...initialSession,
              guid: infoResult.data.guid
            });
          }
        } catch (err) {
          console.error("Background Guid Sync Failed:", err);
        }
      })();

    } catch (err: any) {
      setError(err.message || "Authentication Matrix Failure.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4 font-sans relative">
      <div className="absolute top-10 right-10">
        <button onClick={onToggleLogVisibility} className={`flex items-center gap-3 px-6 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest border transition-all ${isLogVisible ? 'bg-emerald-600 border-emerald-500 text-white shadow-lg' : 'bg-slate-900 border-slate-800 text-slate-400'}`}>
          <Terminal size={16} /> Trace Matrix
        </button>
      </div>

      <div className="max-w-md w-full animate-in fade-in zoom-in duration-500">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-24 h-24 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-[2.5rem] mb-6 shadow-2xl shadow-indigo-500/20">
            <CloudLightning size={44} className="text-white" />
          </div>
          <h1 className="text-4xl font-black text-white mb-2 uppercase tracking-tighter italic">IoT Nexus <span className="text-indigo-500">Cloud</span></h1>
          <p className="text-slate-500 font-bold uppercase tracking-[0.3em] text-[10px]">Secure Native Protocol v4.0</p>
        </div>

        <div className="bg-slate-900/40 backdrop-blur-3xl border border-slate-800 rounded-[3rem] shadow-2xl p-10 relative overflow-hidden">
          <div className="flex justify-between items-center mb-8">
            <div className="flex bg-slate-950/80 p-1 rounded-2xl border border-slate-800/50 shadow-inner">
              <button onClick={() => setIsLoginMode(true)} className={`px-6 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${isLoginMode ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}>SignIn</button>
              <button onClick={() => setIsLoginMode(false)} className={`px-6 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${!isLoginMode ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}>SignUp</button>
            </div>
            <button onClick={() => setShowConfig(!showConfig)} className={`p-3 rounded-2xl border transition-all ${showConfig ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-slate-950 border-slate-800 text-slate-500'}`}>
              <Settings2 size={18} />
            </button>
          </div>

          {showConfig && (
            <div className="mb-8 p-6 bg-slate-950/50 border border-slate-800 rounded-3xl animate-in slide-in-from-top-4 duration-300">
              <label className="text-[9px] font-black text-indigo-500 uppercase tracking-widest ml-1 mb-2 block">API Gateway Override</label>
              <input type="text" value={serverUrl} onChange={e => setServerUrl(e.target.value)} className="w-full px-4 py-3 bg-slate-900 border border-slate-800 rounded-xl text-xs text-white focus:border-indigo-500 outline-none font-mono" />
            </div>
          )}

          <form onSubmit={handleAuth} className="space-y-5">
            {/* Region 选择器 */}
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Server Region</label>
              <div className="relative">
                <Globe className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-600" size={20} />
                <select
                  value={selectedRegion}
                  onChange={e => handleRegionChange(e.target.value)}
                  className="w-full pl-14 pr-6 py-4 bg-slate-950/50 border border-slate-700 rounded-2xl text-white focus:border-indigo-500 outline-none text-sm appearance-none cursor-pointer"
                >
                  <optgroup label="Meross Production">
                    <option value="meross-iot-us">meross-iot-us (US)</option>
                    <option value="meross-iot-eu">meross-iot-eu (EU)</option>
                    <option value="meross-iot-ap">meross-iot-ap (AP)</option>
                  </optgroup>
                  <optgroup label="Meross Test">
                    <option value="meross-test-us">meross-test-us</option>
                    <option value="meross-test-ap">meross-test-ap</option>
                  </optgroup>
                  <optgroup label="Refoss Production">
                    <option value="refoss-iot-us">refoss-iot-us (US)</option>
                    <option value="refoss-iot-eu">refoss-iot-eu (EU)</option>
                    <option value="refoss-iot-ap">refoss-iot-ap (AP)</option>
                  </optgroup>
                  <optgroup label="Refoss Test">
                    <option value="refoss-test-us">refoss-test-us</option>
                    <option value="refoss-test-ap">refoss-test-ap</option>
                  </optgroup>
                </select>
                <ChevronDown className="absolute right-5 top-1/2 -translate-y-1/2 text-slate-600 pointer-events-none" size={18} />
              </div>
              <p className="text-[9px] text-slate-600 ml-1 font-mono">{serverUrl}</p>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Account ID</label>
              <div className="relative">
                <Mail className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-600" size={20} />
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} className="w-full pl-14 pr-6 py-4 bg-slate-950/50 border border-slate-700 rounded-2xl text-white placeholder-slate-700 focus:border-indigo-500 outline-none text-sm shadow-inner" placeholder="developer@meross.com" required />
              </div>
            </div>
            <div className="space-y-2">
              <div className="relative">
                <Lock className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-600" size={20} />
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} className="w-full pl-14 pr-6 py-4 bg-slate-950/50 border border-slate-700 rounded-2xl text-white placeholder-slate-700 focus:border-indigo-500 outline-none text-sm shadow-inner" placeholder="••••••••" required />
              </div>
            </div>
            {error && <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-2xl flex items-center gap-3 text-xs"><AlertCircle size={18} />{error}</div>}
            <button type="submit" disabled={isLoading} className="w-full h-16 bg-indigo-600 hover:bg-indigo-500 text-white font-black uppercase tracking-[0.2em] text-xs rounded-2xl shadow-2xl shadow-indigo-600/20 flex items-center justify-center gap-3 transition-all active:scale-95 disabled:opacity-50">
              {isLoading ? <Loader2 size={24} className="animate-spin" /> : <>{isLoginMode ? 'Connect Cloud' : 'Create Node'} <ArrowRight size={20} /></>}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
