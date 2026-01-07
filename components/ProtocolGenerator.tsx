/**
 * 协议库生成器组件
 * 从设备 Ability + Confluence 文档自动生成协议库
 */

import React, { useState, useCallback, useMemo } from 'react';
import {
    Wand2, BookOpen, RefreshCw, CheckCircle, XCircle, AlertTriangle,
    Settings, Play, ExternalLink, ChevronDown, ChevronRight, Check,
    X, FileText, Loader2, Info, Wifi, Copy
} from 'lucide-react';
import {
    ConfluenceConfig,
    ConfluenceProtocolService,
    ParsedProtocolDoc,
    generateProtocolFromDoc,
    HttpFetcher
} from '../services/confluence-protocol-service';

/**
 * 创建使用 Electron 原生 HTTP 的 fetcher
 * 绕过浏览器 CORS 限制
 */
const createElectronFetcher = (): HttpFetcher => {
    return async (url, options) => {
        // 检查是否在 Electron 环境中
        if (window.electronAPI?.nativeRequest) {
            try {
                const result = await window.electronAPI.nativeRequest({
                    url,
                    method: options.method,
                    headers: options.headers,
                    body: options.body,
                    followRedirects: true,  // 启用自动重定向
                    maxRedirects: 5
                });

                const isOk = result.status >= 200 && result.status < 300;

                // 检测是否被重定向到登录页面 (即使跟随重定向后仍返回 HTML)
                const isLoginPage = result.text && (
                    result.text.includes('login') ||
                    result.text.includes('Log In') ||
                    result.text.includes('<!DOCTYPE') && result.text.includes('form')
                );

                if (isLoginPage && !isOk) {
                    console.warn('[Confluence] 可能被重定向到登录页面，请检查 Token 是否正确');
                }

                return {
                    ok: isOk,
                    status: result.status,
                    data: result.data,
                    text: result.text,
                };
            } catch (error: any) {
                throw new Error(`原生请求失败: ${error.message}`);
            }
        } else {
            // 回退到浏览器 fetch (可能会遇到 CORS)
            const response = await fetch(url, {
                method: options.method,
                headers: options.headers,
                body: options.body,
            });
            const text = await response.text();
            let data;
            try {
                data = JSON.parse(text);
            } catch {
                data = null;
            }
            return { ok: response.ok, status: response.status, data, text };
        }
    };
};


// 协议生成状态
interface ProtocolGenerationState {
    status: 'idle' | 'fetching-ability' | 'configuring-docs' | 'fetching-docs' | 'reviewing' | 'saving' | 'done' | 'error';
    abilityNamespaces: string[];
    parsedDocs: Map<string, ParsedProtocolDoc>;
    progress: { current: number; total: number; namespace: string };
    error?: string;
}

// Schema 生成函数类型
type GenerateSchemaFn = (json: any, includeRequired?: boolean) => any;

interface ProtocolGeneratorProps {
    isOpen: boolean;
    onClose: () => void;
    onGenerate: (protocols: any[], suiteName: string, suiteDescription: string) => void;
    generateSchema: GenerateSchemaFn;
    deviceName?: string;
    onFetchAbility: () => Promise<any>;  // 返回 Ability 响应
}

export const ProtocolGenerator: React.FC<ProtocolGeneratorProps> = ({
    isOpen,
    onClose,
    onGenerate,
    generateSchema,
    deviceName = '新设备',
    onFetchAbility
}) => {
    // Confluence 配置
    const [config, setConfig] = useState<ConfluenceConfig>(() => {
        const saved = localStorage.getItem('confluence_config');
        if (saved) {
            try {
                return JSON.parse(saved);
            } catch { }
        }
        return {
            baseUrl: '',
            spaceKey: '',
            accessToken: '',
            email: '',
            username: '',  // LDAP 用户名
        };
    });

    const [showConfig, setShowConfig] = useState(false);
    const [configTesting, setConfigTesting] = useState(false);
    const [configTestResult, setConfigTestResult] = useState<{ success: boolean; message: string } | null>(null);

    // 生成状态
    const [state, setState] = useState<ProtocolGenerationState>({
        status: 'idle',
        abilityNamespaces: [],
        parsedDocs: new Map(),
        progress: { current: 0, total: 0, namespace: '' },
    });

    // 套件信息
    const [suiteName, setSuiteName] = useState(`${deviceName} 协议库`);
    const [suiteDescription, setSuiteDescription] = useState(`从 ${deviceName} Ability 自动生成`);
    // 文档配置
    const [parentPageUrl, setParentPageUrl] = useState('');
    const [manualDocUrls, setManualDocUrls] = useState<Map<string, string>>(new Map());
    const [isFetchingChildPages, setIsFetchingChildPages] = useState(false);

    // 选中的协议
    const [selectedProtocols, setSelectedProtocols] = useState<Set<string>>(new Set());
    const [expandedProtocols, setExpandedProtocols] = useState<Set<string>>(new Set());

    // 保存配置
    const saveConfig = useCallback(() => {
        localStorage.setItem('confluence_config', JSON.stringify(config));
    }, [config]);

    // 测试 Confluence 连接
    const testConnection = async () => {
        if (!config.baseUrl || !config.accessToken) {
            setConfigTestResult({ success: false, message: '请填写 Confluence URL 和 Access Token' });
            return;
        }

        setConfigTesting(true);
        setConfigTestResult(null);

        try {
            const service = new ConfluenceProtocolService(config);

            // 尝试加载 SSO cookies
            if (window.electronAPI?.confluenceGetCookies) {
                try {
                    const { cookies } = await window.electronAPI.confluenceGetCookies({ baseUrl: config.baseUrl });
                    if (cookies && cookies.length > 0) {
                        service.setCookies(cookies);
                    }
                } catch (e) {
                    console.warn('Failed to load cookies:', e);
                }
            }

            const result = await service.testConnection();
            setConfigTestResult(result);

            if (result.success) {
                saveConfig();
            }
        } catch (error) {
            setConfigTestResult({ success: false, message: `测试失败: ${error}` });
        } finally {
            setConfigTesting(false);
        }
    };

    // 获取子页面并自动匹配
    const fetchChildPagesAndMatch = async () => {
        if (!parentPageUrl) return;
        setIsFetchingChildPages(true);

        try {
            // 提取 Page ID
            let pageId = '';
            try {
                const urlObj = new URL(parentPageUrl);
                if (urlObj.searchParams.has('pageId')) {
                    pageId = urlObj.searchParams.get('pageId') || '';
                } else {
                    const match = parentPageUrl.match(/\/(\d+)(\/|$|\?)/);
                    if (match) pageId = match[1];
                }
            } catch { }

            if (!pageId) {
                throw new Error('无法从 URL 解析 Page ID');
            }

            const service = new ConfluenceProtocolService(config);

            // 尝试加载 SSO cookies
            if (window.electronAPI?.confluenceGetCookies) {
                try {
                    const { cookies } = await window.electronAPI.confluenceGetCookies({ baseUrl: config.baseUrl });
                    if (cookies && cookies.length > 0) {
                        service.setCookies(cookies);
                    }
                } catch (e) {
                    console.warn('Failed to load cookies:', e);
                }
            }

            const childPages = await service.getChildPages(pageId);

            // 自动匹配
            const newManualUrls = new Map(manualDocUrls);
            let matchCount = 0;

            state.abilityNamespaces.forEach(ns => {
                // 简单匹配策略：页面标题包含 namespace，或 namespace 包含页面标题
                const match = childPages.find(page =>
                    page.title.toLowerCase().includes(ns.toLowerCase()) ||
                    ns.toLowerCase().includes(page.title.toLowerCase())
                );

                if (match) {
                    newManualUrls.set(ns, match.url);
                    matchCount++;
                }
            });

            setManualDocUrls(newManualUrls);
            // 这里可以添加一个 Toast 提示匹配数量，暂时省略
        } catch (error) {
            console.error('获取子页面失败:', error);
            setConfigTestResult({ success: false, message: `获取子页面失败: ${error}` });
        } finally {
            setIsFetchingChildPages(false);
        }
    };

    // 开始获取文档 (第二步)
    const startFetchingDocs = async () => {
        setState(prev => ({
            ...prev,
            status: 'fetching-docs',
        }));

        try {
            const service = new ConfluenceProtocolService(config);

            // 尝试加载 SSO cookies
            if (window.electronAPI?.confluenceGetCookies) {
                try {
                    const { cookies } = await window.electronAPI.confluenceGetCookies({ baseUrl: config.baseUrl });
                    if (cookies && cookies.length > 0) {
                        service.setCookies(cookies);
                    }
                } catch (e) {
                    console.warn('Failed to load cookies:', e);
                }
            }

            const parsedDocs = await service.fetchProtocolDocs(
                state.abilityNamespaces,
                (current, total, namespace, status) => {
                    setState(prev => ({
                        ...prev,
                        progress: { current, total, namespace },
                    }));
                },
                manualDocUrls
            );

            // 默认全选
            setSelectedProtocols(new Set(state.abilityNamespaces));

            setState(prev => ({
                ...prev,
                status: 'reviewing',
                parsedDocs,
            }));

        } catch (error: any) {
            setState(prev => ({
                ...prev,
                status: 'error',
                error: error.message || '生成失败',
            }));
        }
    };

    // 开始生成流程
    const startGeneration = async () => {
        // 检查配置 (只需要 URL 和 Token)
        if (!config.baseUrl || !config.accessToken) {
            setShowConfig(true);
            return;
        }

        setState(prev => ({
            ...prev,
            status: 'fetching-ability',
            error: undefined,
        }));

        try {
            // 1. 获取 Ability
            const abilityResponse = await onFetchAbility();
            const ability = abilityResponse?.payload?.ability;

            if (!ability || typeof ability !== 'object') {
                throw new Error('获取 Ability 失败或格式错误');
            }

            const namespaces = Object.keys(ability);
            setState(prev => ({
                ...prev,
                abilityNamespaces: namespaces,
                status: 'configuring-docs',
                progress: { current: 0, total: namespaces.length, namespace: '' },
            }));

        } catch (error: any) {
            setState(prev => ({
                ...prev,
                status: 'error',
                error: error.message || '生成失败',
            }));
        }
    };

    // 确认生成
    const confirmGeneration = () => {
        setState(prev => ({ ...prev, status: 'saving' }));

        const protocols: any[] = [];

        selectedProtocols.forEach(namespace => {
            const doc = state.parsedDocs.get(namespace);
            if (doc) {
                const generated = generateProtocolFromDoc(doc, generateSchema);
                protocols.push({
                    id: generated.id,
                    namespace: generated.namespace,
                    name: generated.name,
                    description: generated.description,
                    methods: generated.methods,
                });
            }
        });

        onGenerate(protocols, suiteName, suiteDescription);

        setState(prev => ({ ...prev, status: 'done' }));
        setTimeout(() => {
            onClose();
            // 重置状态
            setState({
                status: 'idle',
                abilityNamespaces: [],
                parsedDocs: new Map(),
                progress: { current: 0, total: 0, namespace: '' },
            });
        }, 1500);
    };

    // 切换协议选中
    const toggleProtocol = (namespace: string) => {
        setSelectedProtocols(prev => {
            const next = new Set(prev);
            if (next.has(namespace)) {
                next.delete(namespace);
            } else {
                next.add(namespace);
            }
            return next;
        });
    };

    // 切换协议展开
    const toggleExpand = (namespace: string) => {
        setExpandedProtocols(prev => {
            const next = new Set(prev);
            if (next.has(namespace)) {
                next.delete(namespace);
            } else {
                next.add(namespace);
            }
            return next;
        });
    };

    // 全选/全不选
    const toggleAll = () => {
        if (selectedProtocols.size === state.abilityNamespaces.length) {
            setSelectedProtocols(new Set());
        } else {
            setSelectedProtocols(new Set(state.abilityNamespaces));
        }
    };

    // 统计
    const stats = {
        total: state.abilityNamespaces.length,
        selected: selectedProtocols.size,
        withWarnings: Array.from(state.parsedDocs.values()).filter(d => d.parseWarnings.length > 0).length,
        withDocs: Array.from(state.parsedDocs.values()).filter(d => !d.parseWarnings.includes('文档页面未找到，使用默认配置')).length,
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[100]">
            <div className="bg-slate-900 border border-slate-700 rounded-2xl w-[900px] max-h-[85vh] flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between p-6 border-b border-slate-800">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-gradient-to-br from-purple-500 to-indigo-600 rounded-xl">
                            <Wand2 className="text-white" size={24} />
                        </div>
                        <div>
                            <h2 className="text-xl font-black text-white">协议库生成器</h2>
                            <p className="text-sm text-slate-400">从设备 Ability + Confluence 文档自动生成</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800">
                        <X size={20} />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-6">
                    {/* Confluence 配置 */}
                    <div className="mb-6">
                        <button
                            onClick={() => setShowConfig(!showConfig)}
                            className="flex items-center gap-2 text-sm text-slate-400 hover:text-white mb-3"
                        >
                            <Settings size={16} />
                            <span>Confluence 配置</span>
                            {showConfig ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                            {config.baseUrl && !showConfig && (
                                <span className="text-emerald-400 text-xs ml-2">✓ 已配置</span>
                            )}
                        </button>

                        {showConfig && (
                            <div className="bg-slate-800/50 rounded-xl p-4 space-y-4">
                                <div className="text-xs text-slate-500 mb-2">
                                    💡 <strong>LDAP/SSO 版本</strong>: 填写 Base URL、用户名 和 Token<br />
                                    💡 <strong>标准 Server 版本</strong>: 填写 Base URL 和 Token，用户名留空<br />
                                    💡 <strong>Cloud 版本</strong>: 填写 Base URL、Email 和 API Token
                                </div>
                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label className="text-xs text-slate-500 mb-1 block">Confluence Base URL</label>
                                        <input
                                            type="text"
                                            value={config.baseUrl}
                                            onChange={e => setConfig(prev => ({ ...prev, baseUrl: e.target.value }))}
                                            placeholder="https://jira.meross.cn/doc"
                                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-indigo-500"
                                        />
                                        <div className="text-[10px] text-slate-600 mt-1">不需要包含 /wiki 后缀</div>
                                    </div>
                                    <div>
                                        <label className="text-xs text-slate-500 mb-1 block">Space Key <span className="text-slate-600">(可选)</span></label>
                                        <input
                                            type="text"
                                            value={config.spaceKey || ''}
                                            onChange={e => setConfig(prev => ({ ...prev, spaceKey: e.target.value }))}
                                            placeholder="留空则全局搜索"
                                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-indigo-500"
                                        />
                                        <div className="text-[10px] text-slate-600 mt-1">不知道可以留空，自动在所有空间搜索</div>
                                    </div>
                                    <div>
                                        <label className="text-xs text-slate-500 mb-1 block">
                                            用户名 <span className="text-amber-400">(LDAP/SSO 必填)</span>
                                        </label>
                                        <input
                                            type="text"
                                            value={config.username || ''}
                                            onChange={e => setConfig(prev => ({ ...prev, username: e.target.value }))}
                                            placeholder="例如: zhangyu"
                                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-indigo-500"
                                        />
                                        <div className="text-[10px] text-slate-600 mt-1">你登录 Confluence 使用的用户名</div>
                                    </div>
                                    <div>
                                        <label className="text-xs text-slate-500 mb-1 block">Personal Access Token</label>
                                        <div className="flex gap-2">
                                            <input
                                                type="password"
                                                value={config.accessToken}
                                                onChange={e => setConfig(prev => ({ ...prev, accessToken: e.target.value }))}
                                                placeholder="••••••••"
                                                className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-indigo-500"
                                            />
                                            {window.electronAPI?.confluenceLogin && (
                                                <button
                                                    onClick={async () => {
                                                        if (!config.baseUrl) {
                                                            setConfigTestResult({ success: false, message: '请先填写 Base URL' });
                                                            return;
                                                        }
                                                        setConfigTesting(true);
                                                        try {
                                                            const result = await window.electronAPI?.confluenceLogin({ baseUrl: config.baseUrl });
                                                            if (!result) {
                                                                throw new Error('Electron API 不可用');
                                                            }
                                                            if (result.success) {
                                                                setConfigTestResult({ success: true, message: result.message });
                                                                // 自动触发一次连接测试以确认
                                                                setTimeout(testConnection, 1000);
                                                            } else {
                                                                setConfigTestResult({ success: false, message: result.message });
                                                            }
                                                        } catch (e: any) {
                                                            setConfigTestResult({ success: false, message: `登录出错: ${e.message}` });
                                                        } finally {
                                                            setConfigTesting(false);
                                                        }
                                                    }}
                                                    className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white text-xs rounded-lg whitespace-nowrap"
                                                    title="如果 Token 无法通过认证，请尝试使用 SSO 登录"
                                                >
                                                    SSO 登录
                                                </button>
                                            )}
                                        </div>
                                        <div className="text-[10px] text-slate-600 mt-1">在个人设置 → 个人访问令牌 中创建，或使用 SSO 登录</div>
                                    </div>
                                </div>

                                <div className="flex items-center justify-between">
                                    <button
                                        onClick={testConnection}
                                        disabled={configTesting}
                                        className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm flex items-center gap-2"
                                    >
                                        {configTesting ? (
                                            <Loader2 size={14} className="animate-spin" />
                                        ) : (
                                            <Wifi size={14} />
                                        )}
                                        测试连接
                                    </button>

                                    {configTestResult && (
                                        <div className={`flex items-center gap-2 text-sm ${configTestResult.success ? 'text-emerald-400' : 'text-red-400'}`}>
                                            {configTestResult.success ? <CheckCircle size={16} /> : <XCircle size={16} />}
                                            {configTestResult.message}
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* 状态展示 */}
                    {state.status === 'idle' && (
                        <div className="text-center py-12">
                            <BookOpen size={48} className="mx-auto mb-4 text-slate-600" />
                            <h3 className="text-lg font-bold text-white mb-2">准备生成协议库</h3>
                            <p className="text-sm text-slate-400 mb-6 max-w-md mx-auto">
                                系统将从设备获取 Ability 列表，然后自动从 Confluence 获取每个协议的文档并生成完整的协议配置。
                            </p>

                            <div className="max-w-sm mx-auto space-y-3 mb-6">
                                <div>
                                    <label className="text-xs text-slate-500 mb-1 block text-left">协议库名称</label>
                                    <input
                                        type="text"
                                        value={suiteName}
                                        onChange={e => setSuiteName(e.target.value)}
                                        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-indigo-500"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs text-slate-500 mb-1 block text-left">描述</label>
                                    <input
                                        type="text"
                                        value={suiteDescription}
                                        onChange={e => setSuiteDescription(e.target.value)}
                                        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-indigo-500"
                                    />
                                </div>
                            </div>

                            <button
                                onClick={startGeneration}
                                className="px-6 py-3 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-xl font-bold text-sm flex items-center gap-2 mx-auto"
                            >
                                <Play size={18} />
                                开始生成
                            </button>
                        </div>
                    )}

                    {state.status === 'configuring-docs' && (
                        <div className="flex flex-col h-full">
                            <div className="text-center mb-6">
                                <h3 className="text-lg font-bold text-white mb-2">配置文档链接</h3>
                                <p className="text-sm text-slate-400">
                                    检测到 {state.abilityNamespaces.length} 个协议。请配置文档链接以提高解析准确率。
                                </p>
                            </div>

                            {/* 父页面配置 */}
                            <div className="bg-slate-800/50 rounded-xl p-4 mb-4">
                                <label className="text-xs text-slate-500 mb-2 block">父页面链接 (自动匹配子页面)</label>
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={parentPageUrl}
                                        onChange={e => setParentPageUrl(e.target.value)}
                                        placeholder="例如: https://jira.meross.cn/doc/pages/viewpage.action?pageId=..."
                                        className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-indigo-500"
                                    />
                                    <button
                                        onClick={fetchChildPagesAndMatch}
                                        disabled={!parentPageUrl || isFetchingChildPages}
                                        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm disabled:opacity-50 flex items-center gap-2"
                                    >
                                        {isFetchingChildPages ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                                        获取并匹配
                                    </button>
                                </div>
                            </div>

                            {/* 协议列表 */}
                            <div className="flex-1 overflow-y-auto custom-scrollbar space-y-2 mb-6">
                                {state.abilityNamespaces.map(ns => (
                                    <div key={ns} className="flex items-center gap-3 bg-slate-800/30 p-3 rounded-lg border border-slate-700">
                                        <div className="w-1/3 min-w-[200px] flex items-center gap-2 group">
                                            <div className="text-sm text-white font-mono truncate select-all" title={ns}>{ns}</div>
                                            <button
                                                onClick={() => navigator.clipboard.writeText(ns)}
                                                className="p-1 text-slate-500 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
                                                title="复制"
                                            >
                                                <Copy size={12} />
                                            </button>
                                        </div>
                                        <div className="flex-1">
                                            <input
                                                type="text"
                                                value={manualDocUrls.get(ns) || ''}
                                                onChange={e => {
                                                    const newMap = new Map(manualDocUrls);
                                                    if (e.target.value) {
                                                        newMap.set(ns, e.target.value);
                                                    } else {
                                                        newMap.delete(ns);
                                                    }
                                                    setManualDocUrls(newMap);
                                                }}
                                                placeholder="文档 URL (留空则自动搜索)"
                                                className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300 outline-none focus:border-indigo-500"
                                            />
                                        </div>
                                        {manualDocUrls.has(ns) && (
                                            <CheckCircle size={16} className="text-emerald-400" />
                                        )}
                                    </div>
                                ))}
                            </div>

                            <div className="flex justify-between pt-4 border-t border-slate-800">
                                <button
                                    onClick={() => setState(prev => ({ ...prev, status: 'idle' }))}
                                    className="px-4 py-2 text-slate-400 hover:text-white"
                                >
                                    返回
                                </button>
                                <button
                                    onClick={startFetchingDocs}
                                    className="px-6 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-xl font-bold text-sm flex items-center gap-2"
                                >
                                    <Play size={16} />
                                    开始解析文档
                                </button>
                            </div>
                        </div>
                    )}

                    {(state.status === 'fetching-ability' || state.status === 'fetching-docs') && (
                        <div className="text-center py-12">
                            <Loader2 size={48} className="mx-auto mb-4 text-indigo-400 animate-spin" />
                            <h3 className="text-lg font-bold text-white mb-2">
                                {state.status === 'fetching-ability' ? '获取设备 Ability...' : '获取协议文档...'}
                            </h3>
                            {state.status === 'fetching-docs' && (
                                <>
                                    <p className="text-sm text-slate-400 mb-4">
                                        {state.progress.current} / {state.progress.total}
                                    </p>
                                    <p className="text-xs text-slate-500 font-mono">
                                        {state.progress.namespace}
                                    </p>
                                    <div className="w-64 mx-auto mt-4 h-2 bg-slate-700 rounded-full overflow-hidden">
                                        <div
                                            className="h-full bg-indigo-500 transition-all"
                                            style={{ width: `${(state.progress.current / state.progress.total) * 100}%` }}
                                        />
                                    </div>
                                </>
                            )}
                        </div>
                    )}

                    {state.status === 'error' && (
                        <div className="text-center py-12">
                            <XCircle size={48} className="mx-auto mb-4 text-red-400" />
                            <h3 className="text-lg font-bold text-white mb-2">生成失败</h3>
                            <p className="text-sm text-red-400 mb-6">{state.error}</p>
                            <button
                                onClick={() => setState(prev => ({ ...prev, status: 'idle' }))}
                                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm"
                            >
                                重试
                            </button>
                        </div>
                    )}

                    {state.status === 'reviewing' && (
                        <>
                            {/* 统计信息 */}
                            <div className="flex items-center gap-4 mb-4 p-3 bg-slate-800/50 rounded-xl">
                                <div className="flex items-center gap-2">
                                    <FileText size={16} className="text-slate-400" />
                                    <span className="text-sm text-white">{stats.total} 个协议</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <CheckCircle size={16} className="text-emerald-400" />
                                    <span className="text-sm text-slate-400">{stats.withDocs} 已解析</span>
                                </div>
                                {stats.withWarnings > 0 && (
                                    <div className="flex items-center gap-2">
                                        <AlertTriangle size={16} className="text-amber-400" />
                                        <span className="text-sm text-slate-400">{stats.withWarnings} 有警告</span>
                                    </div>
                                )}
                                <div className="flex-1" />
                                <button
                                    onClick={toggleAll}
                                    className="text-xs text-indigo-400 hover:text-indigo-300"
                                >
                                    {selectedProtocols.size === stats.total ? '取消全选' : '全选'}
                                </button>
                            </div>

                            {/* 协议列表 */}
                            <div className="space-y-2 max-h-[400px] overflow-y-auto custom-scrollbar">
                                {state.abilityNamespaces.map(namespace => {
                                    const doc = state.parsedDocs.get(namespace);
                                    const isSelected = selectedProtocols.has(namespace);
                                    const isExpanded = expandedProtocols.has(namespace);
                                    const hasWarnings = doc && doc.parseWarnings.length > 0;
                                    const notFound = doc?.parseWarnings.includes('文档页面未找到，使用默认配置');

                                    return (
                                        <div key={namespace} className={`border rounded-xl overflow-hidden ${isSelected ? 'border-indigo-500/50 bg-indigo-500/5' : 'border-slate-700 bg-slate-800/30'
                                            }`}>
                                            <div className="flex items-center p-3">
                                                <button
                                                    onClick={() => toggleProtocol(namespace)}
                                                    className={`w-5 h-5 rounded flex items-center justify-center mr-3 ${isSelected ? 'bg-indigo-500' : 'border border-slate-600'
                                                        }`}
                                                >
                                                    {isSelected && <Check size={12} className="text-white" />}
                                                </button>

                                                <button
                                                    onClick={() => toggleExpand(namespace)}
                                                    className="mr-2 text-slate-400 hover:text-white"
                                                >
                                                    {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                                </button>

                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-sm font-mono text-white truncate">{namespace}</span>
                                                        {notFound && (
                                                            <span className="text-[10px] px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded">无文档</span>
                                                        )}
                                                        {hasWarnings && !notFound && (
                                                            <AlertTriangle size={14} className="text-amber-400" />
                                                        )}
                                                    </div>
                                                    {doc && (
                                                        <div className="flex items-center gap-2 mt-1">
                                                            {Object.entries(doc.supportedMethods)
                                                                .filter(([_, v]) => v)
                                                                .map(([method]) => (
                                                                    <span key={method} className={`text-[10px] px-1.5 py-0.5 rounded ${method === 'GET' ? 'bg-blue-500/20 text-blue-400' :
                                                                        method === 'SET' ? 'bg-amber-500/20 text-amber-400' :
                                                                            method === 'PUSH' ? 'bg-purple-500/20 text-purple-400' :
                                                                                'bg-slate-500/20 text-slate-400'
                                                                        }`}>{method}</span>
                                                                ))
                                                            }
                                                        </div>
                                                    )}
                                                </div>

                                                {doc?.pageUrl && (
                                                    <a
                                                        href={doc.pageUrl}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="p-1.5 text-slate-400 hover:text-white"
                                                        title="查看文档"
                                                    >
                                                        <ExternalLink size={14} />
                                                    </a>
                                                )}
                                            </div>

                                            {isExpanded && doc && (
                                                <div className="border-t border-slate-700 p-3 bg-slate-900/50">
                                                    {doc.description && (
                                                        <p className="text-xs text-slate-400 mb-2">{doc.description}</p>
                                                    )}

                                                    {doc.parseWarnings.length > 0 && (
                                                        <div className="space-y-1">
                                                            {doc.parseWarnings.map((warning, i) => (
                                                                <div key={i} className="flex items-center gap-2 text-[11px] text-amber-400">
                                                                    <Info size={12} />
                                                                    {warning}
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}

                                                    {Object.keys(doc.methods).length > 0 && (
                                                        <div className="mt-2 space-y-2">
                                                            {Object.entries(doc.methods).map(([method, data]) => (
                                                                <div key={method} className="text-xs">
                                                                    <span className="text-slate-500">{method}:</span>
                                                                    {data.requestExample ? (
                                                                        <span className="text-emerald-400 ml-2">✓ 请求示例</span>
                                                                    ) : (
                                                                        <span className="text-slate-600 ml-2">○ 无请求示例</span>
                                                                    )}
                                                                    {data.responseExample ? (
                                                                        <span className="text-emerald-400 ml-2">✓ 响应示例</span>
                                                                    ) : (
                                                                        <span className="text-slate-600 ml-2">○ 无响应示例</span>
                                                                    )}
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </>
                    )}

                    {state.status === 'saving' && (
                        <div className="text-center py-12">
                            <Loader2 size={48} className="mx-auto mb-4 text-indigo-400 animate-spin" />
                            <h3 className="text-lg font-bold text-white">正在保存...</h3>
                        </div>
                    )}

                    {state.status === 'done' && (
                        <div className="text-center py-12">
                            <CheckCircle size={48} className="mx-auto mb-4 text-emerald-400" />
                            <h3 className="text-lg font-bold text-white mb-2">生成完成!</h3>
                            <p className="text-sm text-slate-400">
                                已添加 {selectedProtocols.size} 个协议到 "{suiteName}"
                            </p>
                        </div>
                    )}
                </div>

                {/* Footer */}
                {state.status === 'reviewing' && (
                    <div className="flex items-center justify-between p-6 border-t border-slate-800">
                        <div className="text-sm text-slate-400">
                            已选择 <span className="text-white font-bold">{stats.selected}</span> 个协议
                        </div>
                        <button
                            onClick={() => setState(prev => ({ ...prev, status: 'idle' }))}
                            className="px-4 py-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg text-sm mr-auto ml-4"
                        >
                            重新开始
                        </button>
                        <div className="flex gap-3">
                            <button
                                onClick={onClose}
                                className="px-4 py-2 text-slate-400 hover:text-white"
                            >
                                取消
                            </button>
                            <button
                                onClick={confirmGeneration}
                                disabled={selectedProtocols.size === 0}
                                className="px-6 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white rounded-xl font-bold text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                确认生成 ({selectedProtocols.size} 个协议)
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default ProtocolGenerator;
