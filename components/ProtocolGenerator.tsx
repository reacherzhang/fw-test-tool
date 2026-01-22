/**
 * 协议库生成器组件
 * 从设备 Ability + Confluence 文档自动生成协议库
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
    Wand2, BookOpen, RefreshCw, CheckCircle, XCircle, AlertTriangle,
    Settings, Play, ExternalLink, ChevronDown, ChevronRight, Check,
    X, FileText, Loader2, Info, Wifi, Copy, Bot, Sparkles, Zap
} from 'lucide-react';
import {
    ConfluenceConfig,
    ConfluenceProtocolService,
    ParsedProtocolDoc,
    generateProtocolFromDoc,
    HttpFetcher
} from '../services/confluence-protocol-service';
import {
    AIServiceConfig,
    AIMatchStrategy,
    AIProcessLog,
    AIGeneratedProtocol,
    AIProtocolService,
    DEFAULT_AI_CONFIG,
    AI_MODELS,
    AIProvider,
    estimateTokens,
    estimateProcessingTime
} from '../services/ai-protocol-service';

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


// 解析文档中的协议列表
const parseProtocolListFromDoc = (content: string): string[] => {
    const protocols: Set<string> = new Set();

    // 1. 尝试匹配 MRS_NS_ENTRY 宏 (源码格式)
    const macroRegex = /MRS_NS_ENTRY\s*\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,/g;
    let match;
    while ((match = macroRegex.exec(content)) !== null) {
        protocols.add(`${match[1].trim()}.${match[2].trim()}.${match[3].trim()}`);
    }

    // 2. 如果没找到宏，尝试匹配表格中的文本或纯文本 (Appliance.X.Y)
    if (protocols.size === 0) {
        // 匹配常见的 namespace 格式: Word.Word.Word (至少2个点)
        const textRegex = /\b([A-Z][a-zA-Z0-9]+(?:\.[A-Z][a-zA-Z0-9]+){2,})\b/g;
        while ((match = textRegex.exec(content)) !== null) {
            // 简单的过滤，避免匹配到文件名等
            if (!match[1].endsWith('.c') && !match[1].endsWith('.h') && !match[1].includes('meross')) {
                protocols.add(match[1]);
            }
        }
    }

    return Array.from(protocols);
};

// 文档匹配模式
type DocMatchMode = 'manual' | 'ai';

// 协议生成状态
interface ProtocolGenerationState {
    status: 'idle' | 'fetching-ability' | 'reviewing-comparison' | 'selecting-mode' | 'configuring-docs' | 'fetching-docs' | 'ai-processing' | 'ai-completed' | 'reviewing' | 'saving' | 'done' | 'error';
    abilityNamespaces: string[];
    parsedDocs: Map<string, ParsedProtocolDoc>;
    aiGeneratedProtocols: Map<string, AIGeneratedProtocol>;
    progress: { current: number; total: number; namespace: string; message?: string };
    error?: string;
    comparisonData?: {
        onlyInDevice: string[];
        onlyInDoc: string[];
        matched: string[];
        docProtocols: string[];
        deviceProtocols: string[];
        docUrl: string;
        docTitle: string;
    };
    comparisonResult?: {
        success: boolean;
        message: string;
    };
    matchedExistingProtocols?: ProtocolDefinition[];
}

// ProtocolDefinition needs to be imported or defined if not available. 
// Since it's defined in ProtocolAudit.tsx and not exported, we might need to define a compatible interface here or export it from ProtocolAudit.
// For now, let's assume we can use 'any' or a simplified interface if we don't want to change ProtocolAudit exports yet.
// But better to export it from ProtocolAudit.tsx.
// Wait, I cannot change ProtocolAudit exports easily without checking imports.
// Let's define a local interface compatible with it.

export interface ProtocolDefinition {
    id: string;
    namespace: string;
    name: string;
    description?: string;
    category?: string;
    docUrl?: string;
    methods: any;
    reviewStatus?: 'UNVERIFIED' | 'VERIFIED';
    verificationMode?: 'direct' | 'manual';
    tags?: string[];
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
    existingProtocols?: ProtocolDefinition[];
}

export const ProtocolGenerator: React.FC<ProtocolGeneratorProps> = ({
    isOpen,
    onClose,
    onGenerate,
    generateSchema,
    deviceName = '新设备',
    onFetchAbility,
    existingProtocols = []
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
        aiGeneratedProtocols: new Map(),
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

    // AI 模式相关状态
    const [docMatchMode, setDocMatchMode] = useState<DocMatchMode | null>(null);
    const [aiConfig, setAIConfig] = useState<AIServiceConfig>(() => {
        const saved = localStorage.getItem('ai_protocol_config');
        if (saved) {
            try {
                return JSON.parse(saved);
            } catch { }
        }
        return DEFAULT_AI_CONFIG;
    });
    const [aiStrategy, setAIStrategy] = useState<AIMatchStrategy>({
        semanticSearch: true,
        deepAnalysis: true,
        generateTestCases: false,
    });
    const [aiConfigTesting, setAIConfigTesting] = useState(false);
    const [aiConfigTestResult, setAIConfigTestResult] = useState<{ success: boolean; message: string } | null>(null);
    const [aiProcessLogs, setAIProcessLogs] = useState<AIProcessLog[]>([]);
    const [aiProcessingTime, setAIProcessingTime] = useState<number>(0);
    const [aiTokensUsed, setAITokensUsed] = useState<number>(0);
    const [aiProcessingStarted, setAIProcessingStarted] = useState(false);  // 标记 AI 处理是否已开始
    const [aiSelectedNamespaces, setAISelectedNamespaces] = useState<Set<string>>(new Set());  // AI 处理时选中的协议
    const aiServiceRef = useRef<AIProtocolService | null>(null);
    const aiSessionIdRef = useRef<number>(0);  // 用于跟踪当前 AI 处理会话，取消时增加 ID 使之前的任务失效
    const aiLogsContainerRef = useRef<HTMLDivElement>(null);
    const logsEndRef = useRef<HTMLDivElement>(null);

    // 自动滚动日志
    useEffect(() => {
        if (state.status === 'ai-processing' && logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [aiProcessLogs, state.status]);

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

            // Check for existing protocols
            const matchedExisting = existingProtocols.filter(p => namespaces.includes(p.namespace));
            if (matchedExisting.length > 0) {
                console.log('[ProtocolGenerator] Found existing protocols:', matchedExisting.length);
                setState(prev => ({
                    ...prev,
                    matchedExistingProtocols: matchedExisting
                }));
            }

            // 2. 比对文档 (新增逻辑)
            try {
                console.log('[ProtocolGenerator] Starting comparison for device:', deviceName);
                const service = new ConfluenceProtocolService(config);
                // 尝试加载 SSO cookies
                if (window.electronAPI?.confluenceGetCookies) {
                    try {
                        const { cookies } = await window.electronAPI.confluenceGetCookies({ baseUrl: config.baseUrl });
                        if (cookies && cookies.length > 0) {
                            service.setCookies(cookies);
                            console.log('[ProtocolGenerator] Cookies loaded:', cookies.length);
                        }
                    } catch (e) {
                        console.warn('Failed to load cookies:', e);
                    }
                }

                const rootPageId = '69698202';
                console.log('[ProtocolGenerator] Fetching child pages for root:', rootPageId);
                const childPages = await service.getChildPages(rootPageId);
                console.log('[ProtocolGenerator] Child pages found:', childPages.length);

                // 模糊匹配设备名
                const targetPage = childPages.find(p =>
                    deviceName.toLowerCase().includes(p.title.toLowerCase()) ||
                    p.title.toLowerCase().includes(deviceName.toLowerCase())
                );

                if (targetPage) {
                    console.log('[ProtocolGenerator] Matched page:', targetPage.title, targetPage.id);
                    const pageContent = await service.getPageContent(targetPage.id);
                    if (pageContent) {
                        const html = pageContent.body.view?.value || pageContent.body.storage.value;
                        let docProtocols = parseProtocolListFromDoc(html);
                        console.log('[ProtocolGenerator] Parsed protocols from doc:', docProtocols.length);

                        // 如果当前页面没找到协议，尝试查找其子页面 (例如: MRS105 -> MRS105支持协议列表)
                        if (docProtocols.length === 0) {
                            console.log('[ProtocolGenerator] No protocols in main page, checking sub-pages...');
                            try {
                                const subPages = await service.getChildPages(targetPage.id);
                                console.log('[ProtocolGenerator] Sub-pages found:', subPages.length);

                                // 优先查找标题包含 "协议" 或 "List" 的页面
                                const sortedSubPages = subPages.sort((a, b) => {
                                    const aScore = (a.title.includes('协议') || a.title.includes('List')) ? 1 : 0;
                                    const bScore = (b.title.includes('协议') || b.title.includes('List')) ? 1 : 0;
                                    return bScore - aScore;
                                });

                                for (const subPage of sortedSubPages) {
                                    console.log('[ProtocolGenerator] Checking sub-page:', subPage.title);
                                    const subContent = await service.getPageContent(subPage.id);
                                    if (subContent) {
                                        const subHtml = subContent.body.view?.value || subContent.body.storage.value;
                                        const subProtocols = parseProtocolListFromDoc(subHtml);
                                        if (subProtocols.length > 0) {
                                            console.log('[ProtocolGenerator] Found protocols in sub-page:', subPage.title);
                                            docProtocols = subProtocols;
                                            // 更新 targetPage 信息以便后续显示正确的文档链接
                                            targetPage.title = subPage.title;
                                            targetPage.url = subPage.url;
                                            break;
                                        }
                                    }
                                }
                            } catch (err) {
                                console.warn('[ProtocolGenerator] Failed to check sub-pages:', err);
                            }
                        }

                        if (docProtocols.length > 0) {
                            const deviceSet = new Set(namespaces);
                            const docSet = new Set(docProtocols);

                            const matched = namespaces.filter(p => docSet.has(p));
                            const onlyInDevice = namespaces.filter(p => !docSet.has(p));
                            const onlyInDoc = docProtocols.filter(p => !deviceSet.has(p));

                            console.log('[ProtocolGenerator] Comparison results:', {
                                matched: matched.length,
                                onlyInDevice: onlyInDevice.length,
                                onlyInDoc: onlyInDoc.length
                            });

                            // 只要找到了文档并解析出协议，就显示比对结果（无论是否一致）
                            setState(prev => ({
                                ...prev,
                                abilityNamespaces: namespaces,
                                status: 'reviewing-comparison',
                                comparisonData: {
                                    onlyInDevice,
                                    onlyInDoc,
                                    matched,
                                    docProtocols,
                                    deviceProtocols: namespaces,
                                    docUrl: targetPage.url.startsWith('http') ? targetPage.url : new URL(targetPage.url, new URL(config.baseUrl).origin).toString(),
                                    docTitle: targetPage.title
                                },
                                matchedExistingProtocols: matchedExisting
                            }));
                            return; // 中断流程，等待用户确认
                        } else {
                            console.warn('[ProtocolGenerator] No protocols found in doc or sub-pages');
                            setState(prev => ({ ...prev, comparisonResult: { success: false, message: `文档 "${targetPage.title}" 及其子页面中未找到协议定义` } }));
                        }
                    }
                } else {
                    console.warn('[ProtocolGenerator] No matching page found for device:', deviceName);
                    setState(prev => ({ ...prev, comparisonResult: { success: false, message: `未找到与 "${deviceName}" 匹配的文档` } }));
                }
            } catch (e: any) {
                console.warn('[ProtocolGenerator] Protocol comparison failed, skipping:', e);
                setState(prev => ({ ...prev, comparisonResult: { success: false, message: `比对出错: ${e.message}` } }));
            }

            setState(prev => ({
                ...prev,
                abilityNamespaces: namespaces,
                status: 'selecting-mode',
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

    // 测试 AI 连接
    const testAIConnection = async () => {
        if (!aiConfig.apiKey) {
            setAIConfigTestResult({ success: false, message: '请填写 API Key' });
            return;
        }

        setAIConfigTesting(true);
        setAIConfigTestResult(null);

        try {
            const service = new AIProtocolService(aiConfig, config);
            const result = await service.testConnection();
            setAIConfigTestResult(result);

            if (result.success) {
                localStorage.setItem('ai_protocol_config', JSON.stringify(aiConfig));
            }
        } catch (error: any) {
            setAIConfigTestResult({ success: false, message: `测试失败: ${error.message}` });
        } finally {
            setAIConfigTesting(false);
        }
    };

    // 开始 AI 处理
    const startAIProcessing = async () => {
        if (!aiConfig.apiKey) {
            setAIConfigTestResult({ success: false, message: '请填写 API Key' });
            return;
        }

        // 检查是否有选中的协议
        if (aiSelectedNamespaces.size === 0) {
            setAIConfigTestResult({ success: false, message: '请至少选择一个协议' });
            return;
        }

        // 获取选中的协议列表
        const namespacesToProcess = Array.from(aiSelectedNamespaces);

        // 1. 立即标记为已开始，让 UI 切换到进度界面
        setAIProcessingStarted(true);

        // 生成新的 session ID，使之前的任何异步任务失效
        const currentSessionId = Date.now();
        aiSessionIdRef.current = currentSessionId;

        // 2. 先更新状态，立即渲染 UI
        setState(prev => ({
            ...prev,
            status: 'ai-processing',
            aiGeneratedProtocols: new Map(),
            progress: { current: 0, total: namespacesToProcess.length, namespace: '' }
        }));

        setAIProcessLogs([]);
        setAIProcessingTime(0);
        setAITokensUsed(0);

        // 3. 延迟执行实际逻辑，避免阻塞 UI 渲染
        setTimeout(async () => {
            // 检查 session ID 是否仍然有效
            if (aiSessionIdRef.current !== currentSessionId) {
                console.log('[AI Processing] Session invalidated, aborting');
                return;
            }

            // 启动计时器
            const startTime = Date.now();
            const timerId = setInterval(() => {
                // 检查 session ID
                if (aiSessionIdRef.current !== currentSessionId) {
                    clearInterval(timerId);
                    return;
                }
                setAIProcessingTime(Math.floor((Date.now() - startTime) / 1000));
            }, 1000);

            try {
                // 创建带有 rootPageIds 的配置，用于文档索引
                const confluenceConfigWithIndex = {
                    ...config,
                    rootPageIds: ['69701229'],  // 设备通用消息指令集-新版
                };
                const service = new AIProtocolService(aiConfig, confluenceConfigWithIndex);
                aiServiceRef.current = service;

                const results = await service.processProtocols(
                    namespacesToProcess,  // 使用选中的协议
                    aiStrategy,
                    (current, total, namespace, log) => {
                        // 检查 session ID 是否仍然有效
                        if (aiSessionIdRef.current !== currentSessionId) {
                            return;  // 忽略过期的回调
                        }

                        setState(prev => ({
                            ...prev,
                            progress: { current, total, namespace, message: log.message }
                        }));

                        setAIProcessLogs(prev => [...prev, log]);
                    }
                );

                // 检查 session ID 是否仍然有效
                if (aiSessionIdRef.current !== currentSessionId) {
                    console.log('[AI Processing] Session invalidated after processing, discarding results');
                    return;
                }

                // 估算 Token 消耗
                const tokens = estimateTokens(namespacesToProcess.length, aiStrategy);
                setAITokensUsed(tokens);

                setState(prev => ({
                    ...prev,
                    status: 'ai-completed',
                    aiGeneratedProtocols: results,
                }));

                // 默认全选处理过的协议
                setSelectedProtocols(new Set(namespacesToProcess));

            } catch (error: any) {
                // 检查 session ID 是否仍然有效
                if (aiSessionIdRef.current !== currentSessionId) {
                    console.log('[AI Processing] Session invalidated, ignoring error');
                    return;
                }

                // 如果是 Aborted 错误，不显示错误
                if (error.message === 'Aborted') {
                    console.log('[AI Processing] Aborted by user');
                    return;
                }

                setState(prev => ({
                    ...prev,
                    status: 'error',
                    error: error.message || 'AI 处理失败',
                }));
            } finally {
                clearInterval(timerId);
                // 只有当 session ID 匹配时才清理
                if (aiSessionIdRef.current === currentSessionId) {
                    aiServiceRef.current = null;
                    setAIProcessingStarted(false);
                }
            }
        }, 100);
    };

    // 确认生成
    const confirmGeneration = () => {
        setState(prev => ({ ...prev, status: 'saving' }));

        const protocols: any[] = [];

        selectedProtocols.forEach(namespace => {
            if (docMatchMode === 'ai') {
                // AI 模式
                const aiProto = state.aiGeneratedProtocols.get(namespace);
                if (aiProto) {
                    protocols.push({
                        id: `proto_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                        namespace: aiProto.namespace,
                        name: aiProto.namespace, // 使用 namespace 作为 name
                        description: aiProto.description,
                        methods: aiProto.methods,
                        reviewStatus: 'UNVERIFIED'
                    });
                }
            } else {
                // 手动模式
                const doc = state.parsedDocs.get(namespace);
                if (doc) {
                    const generated = generateProtocolFromDoc(doc, generateSchema);
                    protocols.push({
                        id: generated.id,
                        namespace: generated.namespace,
                        name: generated.name,
                        description: generated.description,
                        methods: generated.methods,
                        reviewStatus: 'UNVERIFIED'
                    });
                }
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
                aiGeneratedProtocols: new Map(),
                progress: { current: 0, total: 0, namespace: '' },
            });
            setDocMatchMode(null);
            setAIProcessingStarted(false);  // 重置 AI 开始标记
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

                    {state.status === 'selecting-mode' && (
                        <div className="text-center py-12 flex flex-col h-full">
                            <div className="mb-8">
                                <h3 className="text-lg font-bold text-white mb-2">选择生成模式</h3>
                                <p className="text-sm text-slate-400">
                                    检测到 {state.abilityNamespaces.length} 个协议。请选择文档匹配方式。
                                </p>
                                {state.comparisonResult && !state.comparisonResult.success && (
                                    <div className="mt-4 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg inline-block max-w-lg">
                                        <div className="flex items-center gap-2 text-amber-400 text-sm font-bold mb-1">
                                            <AlertTriangle size={14} />
                                            自动比对未生效
                                        </div>
                                        <p className="text-xs text-amber-200/80">
                                            {state.comparisonResult.message}
                                        </p>
                                    </div>
                                )}
                            </div>

                            <div className="grid grid-cols-2 gap-6 max-w-4xl mx-auto w-full px-8">
                                {/* 手动模式 */}
                                <div
                                    onClick={() => {
                                        setDocMatchMode('manual');
                                        setState(prev => ({ ...prev, status: 'configuring-docs' }));
                                    }}
                                    className="bg-slate-800/50 hover:bg-slate-800 border border-slate-700 hover:border-indigo-500/50 rounded-2xl p-6 cursor-pointer transition-all group"
                                >
                                    <div className="w-12 h-12 bg-slate-700 rounded-xl flex items-center justify-center mb-4 group-hover:bg-indigo-500/20 group-hover:text-indigo-400 transition-colors">
                                        <FileText size={24} />
                                    </div>
                                    <h4 className="text-lg font-bold text-white mb-2">手动输入模式</h4>
                                    <p className="text-sm text-slate-400 mb-4 h-10">
                                        适用于已知文档链接的情况。支持输入父页面自动匹配或手动指定 URL。
                                    </p>
                                    <ul className="text-xs text-slate-500 space-y-2 mb-6">
                                        <li className="flex items-center gap-2">✓ 精确控制文档来源</li>
                                        <li className="flex items-center gap-2">✓ 适合结构化良好的文档库</li>
                                    </ul>
                                    <button className="w-full py-2 bg-slate-700 group-hover:bg-indigo-600 text-white rounded-lg text-sm font-bold transition-colors">
                                        选择此模式
                                    </button>
                                </div>

                                {/* AI 模式 */}
                                <div
                                    onClick={() => {
                                        setDocMatchMode('ai');
                                        // 更新 session ID，使之前的任何异步任务失效
                                        aiSessionIdRef.current = Date.now();
                                        aiServiceRef.current?.abort();
                                        aiServiceRef.current = null;
                                        // 强制重置所有 AI 相关状态
                                        setAIProcessingStarted(false);
                                        setState(prev => ({
                                            ...prev,
                                            status: 'ai-processing',
                                            aiGeneratedProtocols: new Map(),
                                            progress: { current: 0, total: prev.abilityNamespaces.length, namespace: '' }
                                        }));
                                        // 默认全选所有协议
                                        setAISelectedNamespaces(new Set(state.abilityNamespaces));
                                        setAIProcessLogs([]);
                                        setAIProcessingTime(0);
                                        setAITokensUsed(0);
                                    }}
                                    className="bg-slate-800/50 hover:bg-slate-800 border border-slate-700 hover:border-purple-500/50 rounded-2xl p-6 cursor-pointer transition-all group relative overflow-hidden"
                                >
                                    <div className="absolute top-0 right-0 bg-purple-600 text-white text-[10px] px-2 py-1 rounded-bl-lg font-bold">
                                        BETA
                                    </div>
                                    <div className="w-12 h-12 bg-slate-700 rounded-xl flex items-center justify-center mb-4 group-hover:bg-purple-500/20 group-hover:text-purple-400 transition-colors">
                                        <Sparkles size={24} />
                                    </div>
                                    <h4 className="text-lg font-bold text-white mb-2">AI 智能匹配模式</h4>
                                    <p className="text-sm text-slate-400 mb-4 h-10">
                                        调用 AI 自动在 Confluence 中检索、分析并生成最终协议配置。
                                    </p>
                                    <ul className="text-xs text-slate-500 space-y-2 mb-6">
                                        <li className="flex items-center gap-2">✓ 智能语义搜索匹配</li>
                                        <li className="flex items-center gap-2">✓ 自动提取 Schema</li>
                                        <li className="flex items-center gap-2">✓ 节省大量手动配置时间</li>
                                    </ul>
                                    <button className="w-full py-2 bg-slate-700 group-hover:bg-purple-600 text-white rounded-lg text-sm font-bold transition-colors">
                                        选择此模式
                                    </button>
                                </div>
                            </div>

                            <div className="mt-auto pt-6 border-t border-slate-800 flex justify-between px-8 pb-2">
                                <button
                                    onClick={() => setState(prev => ({ ...prev, status: 'idle' }))}
                                    className="px-4 py-2 text-slate-400 hover:text-white"
                                >
                                    返回
                                </button>
                            </div>
                        </div>
                    )
                    }

                    {
                        state.status === 'reviewing-comparison' && state.comparisonData && (
                            <div className="flex flex-col h-full">
                                <div className="text-center mb-6">
                                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-3 ${state.comparisonData.onlyInDevice.length > 0 || state.comparisonData.onlyInDoc.length > 0
                                        ? 'bg-yellow-500/20'
                                        : 'bg-green-500/20'
                                        }`}>
                                        {state.comparisonData.onlyInDevice.length > 0 || state.comparisonData.onlyInDoc.length > 0 ? (
                                            <AlertTriangle size={24} className="text-yellow-400" />
                                        ) : (
                                            <CheckCircle size={24} className="text-green-400" />
                                        )}
                                    </div>
                                    <h3 className="text-lg font-bold text-white mb-2">
                                        {state.comparisonData.onlyInDevice.length > 0 || state.comparisonData.onlyInDoc.length > 0
                                            ? '发现协议差异'
                                            : '协议完全匹配'}
                                    </h3>
                                    <div className="text-sm text-slate-400 max-w-lg mx-auto flex items-center justify-center gap-1 flex-wrap">
                                        <span>设备 Ability 与 Confluence 文档</span>
                                        {state.comparisonData.docUrl && (
                                            <div className="flex items-center gap-1 bg-slate-800/50 px-2 py-0.5 rounded border border-slate-700">
                                                <a
                                                    href={state.comparisonData.docUrl}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="text-indigo-400 hover:text-indigo-300 inline-flex items-center gap-0.5 max-w-[200px] truncate"
                                                    title={state.comparisonData.docUrl}
                                                >
                                                    {state.comparisonData.docTitle || '相关文档'}
                                                    <ExternalLink size={10} />
                                                </a>
                                                <button
                                                    onClick={() => {
                                                        navigator.clipboard.writeText(state.comparisonData!.docUrl);
                                                    }}
                                                    className="text-slate-500 hover:text-white p-0.5"
                                                    title="复制链接"
                                                >
                                                    <Copy size={12} />
                                                </button>
                                            </div>
                                        )}
                                        <span>比对结果如下：</span>
                                    </div>
                                </div>

                                <div className="flex-1 overflow-hidden grid grid-cols-3 gap-4 px-4 pb-4">
                                    {/* 仅在设备中 */}
                                    <div className="bg-slate-800/50 rounded-xl border border-slate-700 flex flex-col overflow-hidden">
                                        <div className="p-3 bg-slate-800 border-b border-slate-700 flex items-center justify-between">
                                            <span className="text-sm font-bold text-white flex items-center gap-2">
                                                <Zap size={14} className="text-yellow-400" /> 仅在设备 Ability 中
                                            </span>
                                            <div className="flex items-center gap-2">
                                                {state.matchedExistingProtocols && state.matchedExistingProtocols.length > 0 && (
                                                    <span className="text-xs bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded-full" title="库中已存在">
                                                        {state.matchedExistingProtocols.length} 已存
                                                    </span>
                                                )}
                                                <span className="text-xs bg-slate-700 text-slate-300 px-2 py-0.5 rounded-full">
                                                    {state.comparisonData?.onlyInDevice.length}
                                                </span>
                                            </div>
                                        </div>
                                        <div className="flex-1 overflow-y-auto p-2 space-y-1 select-text">
                                            {/* Existing Protocols Section */}
                                            {state.matchedExistingProtocols && state.matchedExistingProtocols.length > 0 && (
                                                <div className="mb-2 pb-2 border-b border-slate-700/50">
                                                    {state.matchedExistingProtocols.map(p => (
                                                        <div key={p.id} className="flex items-center justify-between p-2 hover:bg-slate-900 rounded group border border-purple-500/20 bg-purple-500/5 mb-1">
                                                            <div className="flex items-center gap-2 overflow-hidden">
                                                                <Sparkles size={12} className="text-purple-400 shrink-0" />
                                                                <span className="text-xs font-mono text-purple-300 truncate" title={p.namespace}>{p.namespace}</span>
                                                            </div>
                                                            <div className="text-[10px] text-purple-400 whitespace-nowrap">
                                                                已存在
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}

                                            {state.comparisonData?.onlyInDevice.map(p => (
                                                <div key={p} className="text-xs text-slate-300 bg-slate-900/50 px-2 py-1.5 rounded border border-slate-700/50">
                                                    {p}
                                                </div>
                                            ))}
                                            {state.comparisonData?.onlyInDevice.length === 0 && (
                                                <div className="text-xs text-slate-500 text-center py-4">无差异</div>
                                            )}
                                        </div>
                                    </div>

                                    {/* 匹配一致 */}
                                    <div className="bg-slate-800/50 rounded-xl border border-slate-700 flex flex-col overflow-hidden">
                                        <div className="p-3 bg-slate-800 border-b border-slate-700 flex items-center justify-between">
                                            <span className="text-sm font-bold text-white flex items-center gap-2">
                                                <CheckCircle size={14} className="text-green-400" /> 匹配一致
                                            </span>
                                            <span className="text-xs bg-slate-700 text-slate-300 px-2 py-0.5 rounded-full">
                                                {state.comparisonData?.matched.length}
                                            </span>
                                        </div>
                                        <div className="flex-1 overflow-y-auto p-2 space-y-1 select-text">
                                            {state.comparisonData?.matched.map(p => (
                                                <div key={p} className="text-xs text-slate-300 bg-slate-900/50 px-2 py-1.5 rounded border border-slate-700/50">
                                                    {p}
                                                </div>
                                            ))}
                                            {state.comparisonData?.matched.length === 0 && (
                                                <div className="text-xs text-slate-500 text-center py-4">无匹配</div>
                                            )}
                                        </div>
                                    </div>

                                    {/* 仅在文档中 */}
                                    <div className="bg-slate-800/50 rounded-xl border border-slate-700 flex flex-col overflow-hidden">
                                        <div className="p-3 bg-slate-800 border-b border-slate-700 flex items-center justify-between">
                                            <span className="text-sm font-bold text-white flex items-center gap-2">
                                                <BookOpen size={14} className="text-blue-400" /> 仅在文档中
                                            </span>
                                            <span className="text-xs bg-slate-700 text-slate-300 px-2 py-0.5 rounded-full">
                                                {state.comparisonData?.onlyInDoc.length}
                                            </span>
                                        </div>
                                        <div className="flex-1 overflow-y-auto p-2 space-y-1 select-text">
                                            {state.comparisonData?.onlyInDoc.map(p => (
                                                <div key={p} className="text-xs text-slate-300 bg-slate-900/50 px-2 py-1.5 rounded border border-slate-700/50">
                                                    {p}
                                                </div>
                                            ))}
                                            {state.comparisonData?.onlyInDoc.length === 0 && (
                                                <div className="text-xs text-slate-500 text-center py-4">无差异</div>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                <div className="mt-auto pt-4 border-t border-slate-800 flex justify-between px-6 pb-4">
                                    <button
                                        onClick={() => setState(prev => ({ ...prev, status: 'idle' }))}
                                        className="px-4 py-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg text-sm transition-colors"
                                    >
                                        返回
                                    </button>
                                    <div className="flex gap-3">
                                        <button
                                            onClick={() => {
                                                setState(prev => ({
                                                    ...prev,
                                                    status: 'selecting-mode',
                                                    progress: { current: 0, total: prev.abilityNamespaces.length, namespace: '' },
                                                }));
                                            }}
                                            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm transition-colors flex items-center gap-2"
                                        >
                                            <Zap size={14} />
                                            使用设备列表
                                        </button>
                                        <button
                                            onClick={() => {
                                                // 使用文档列表（标准）
                                                // 需要更新 abilityNamespaces 为文档列表
                                                const conflictData = state.comparisonData; // Capture in variable
                                                if (conflictData) {
                                                    setState(prev => ({
                                                        ...prev,
                                                        abilityNamespaces: conflictData.docProtocols,
                                                        status: 'selecting-mode',
                                                        progress: { current: 0, total: conflictData.docProtocols.length, namespace: '' },
                                                    }));
                                                }
                                            }}
                                            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-bold transition-colors flex items-center gap-2"
                                        >
                                            <BookOpen size={14} />
                                            使用文档列表 (标准)
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )
                    }

                    {
                        (state.status === 'ai-processing' || state.status === 'ai-completed') && (
                            <div className="flex flex-col h-full">
                                {!aiProcessingStarted && state.progress.current === 0 && state.aiGeneratedProtocols.size === 0 ? (
                                    // AI 配置界面（只有在未点击开始按钮时才显示）
                                    <div className="max-w-3xl mx-auto w-full">
                                        <div className="text-center mb-6">
                                            <div className="w-12 h-12 bg-purple-500/20 rounded-xl flex items-center justify-center mx-auto mb-3">
                                                <Bot size={24} className="text-purple-400" />
                                            </div>
                                            <h3 className="text-lg font-bold text-white mb-2">AI 智能匹配配置</h3>
                                            <p className="text-sm text-slate-400">
                                                配置 AI 服务以开始自动检索和分析
                                            </p>
                                        </div>

                                        <div className="bg-slate-800/50 rounded-xl p-6 border border-slate-700 space-y-6">
                                            {/* AI 服务配置 */}
                                            <div>
                                                <h4 className="text-sm font-bold text-white mb-4 flex items-center gap-2">
                                                    <Settings size={16} className="text-indigo-400" /> AI 服务配置
                                                </h4>
                                                <div className="grid grid-cols-2 gap-4">
                                                    <div>
                                                        <label className="text-xs text-slate-500 mb-1 block">AI 提供商</label>
                                                        <select
                                                            value={aiConfig.provider}
                                                            onChange={e => setAIConfig(prev => ({ ...prev, provider: e.target.value as AIProvider }))}
                                                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-indigo-500"
                                                        >
                                                            <option value="openai">OpenAI</option>
                                                            <option value="azure">Azure OpenAI</option>
                                                            <option value="ollama">Ollama (Local)</option>
                                                            <option value="custom">Custom / Other</option>
                                                        </select>
                                                    </div>
                                                    <div>
                                                        <label className="text-xs text-slate-500 mb-1 block">模型</label>
                                                        <input
                                                            type="text"
                                                            value={aiConfig.model}
                                                            onChange={e => setAIConfig(prev => ({ ...prev, model: e.target.value }))}
                                                            placeholder="gpt-4-turbo"
                                                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-indigo-500"
                                                        />
                                                    </div>
                                                    <div className="col-span-2">
                                                        <label className="text-xs text-slate-500 mb-1 block">API Endpoint</label>
                                                        <input
                                                            type="text"
                                                            value={aiConfig.apiEndpoint}
                                                            onChange={e => setAIConfig(prev => ({ ...prev, apiEndpoint: e.target.value }))}
                                                            placeholder="https://api.openai.com/v1"
                                                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-indigo-500"
                                                        />
                                                    </div>
                                                    <div className="col-span-2">
                                                        <label className="text-xs text-slate-500 mb-1 block">API Key</label>
                                                        <div className="flex gap-2">
                                                            <input
                                                                type="password"
                                                                value={aiConfig.apiKey}
                                                                onChange={e => setAIConfig(prev => ({ ...prev, apiKey: e.target.value }))}
                                                                placeholder="sk-..."
                                                                className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-indigo-500"
                                                            />
                                                            <button
                                                                onClick={testAIConnection}
                                                                disabled={aiConfigTesting}
                                                                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm flex items-center gap-2 whitespace-nowrap"
                                                            >
                                                                {aiConfigTesting ? <Loader2 size={14} className="animate-spin" /> : <Wifi size={14} />}
                                                                测试连接
                                                            </button>
                                                        </div>
                                                        {aiConfigTestResult && (
                                                            <div className={`mt-2 text-xs flex items-center gap-2 ${aiConfigTestResult.success ? 'text-emerald-400' : 'text-red-400'}`}>
                                                                {aiConfigTestResult.success ? <CheckCircle size={14} /> : <XCircle size={14} />}
                                                                {aiConfigTestResult.message}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>

                                            {/* 匹配策略 */}
                                            <div className="border-t border-slate-700 pt-6">
                                                <h4 className="text-sm font-bold text-white mb-4 flex items-center gap-2">
                                                    <Zap size={16} className="text-amber-400" /> 匹配策略
                                                </h4>
                                                <div className="space-y-3">
                                                    <label className="flex items-center gap-3 p-3 bg-slate-900/50 rounded-lg border border-slate-800 cursor-pointer hover:border-slate-600">
                                                        <input
                                                            type="checkbox"
                                                            checked={aiStrategy.semanticSearch}
                                                            onChange={e => setAIStrategy(prev => ({ ...prev, semanticSearch: e.target.checked }))}
                                                            className="w-4 h-4 accent-purple-500"
                                                        />
                                                        <div>
                                                            <div className="text-sm text-white font-bold">智能语义搜索</div>
                                                            <div className="text-xs text-slate-400">AI 理解协议含义，搜索最相关文档，而非仅靠关键词匹配</div>
                                                        </div>
                                                    </label>
                                                    <label className="flex items-center gap-3 p-3 bg-slate-900/50 rounded-lg border border-slate-800 cursor-pointer hover:border-slate-600">
                                                        <input
                                                            type="checkbox"
                                                            checked={aiStrategy.deepAnalysis}
                                                            onChange={e => setAIStrategy(prev => ({ ...prev, deepAnalysis: e.target.checked }))}
                                                            className="w-4 h-4 accent-purple-500"
                                                        />
                                                        <div>
                                                            <div className="text-sm text-white font-bold">内容深度分析</div>
                                                            <div className="text-xs text-slate-400">AI 分析文档结构，自动提取请求/响应 Schema</div>
                                                        </div>
                                                    </label>
                                                </div>
                                            </div>

                                            {/* 协议选择 */}
                                            <div className="border-t border-slate-700 pt-6">
                                                <div className="flex items-center justify-between mb-4">
                                                    <h4 className="text-sm font-bold text-white flex items-center gap-2">
                                                        <FileText size={16} className="text-cyan-400" /> 选择要处理的协议
                                                    </h4>
                                                    <div className="flex items-center gap-3">
                                                        <span className="text-xs text-slate-400">
                                                            已选 <span className="text-white font-bold">{aiSelectedNamespaces.size}</span> / {state.abilityNamespaces.length}
                                                        </span>
                                                        <button
                                                            onClick={() => {
                                                                if (aiSelectedNamespaces.size === state.abilityNamespaces.length) {
                                                                    setAISelectedNamespaces(new Set());
                                                                } else {
                                                                    setAISelectedNamespaces(new Set(state.abilityNamespaces));
                                                                }
                                                            }}
                                                            className="text-xs text-purple-400 hover:text-purple-300"
                                                        >
                                                            {aiSelectedNamespaces.size === state.abilityNamespaces.length ? '取消全选' : '全选'}
                                                        </button>
                                                    </div>
                                                </div>
                                                <div className="bg-slate-900/50 border border-slate-800 rounded-lg max-h-48 overflow-y-auto custom-scrollbar">
                                                    {state.abilityNamespaces.map((ns, idx) => (
                                                        <label
                                                            key={ns}
                                                            className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-slate-800/50 transition-colors ${idx !== state.abilityNamespaces.length - 1 ? 'border-b border-slate-800' : ''
                                                                }`}
                                                        >
                                                            <input
                                                                type="checkbox"
                                                                checked={aiSelectedNamespaces.has(ns)}
                                                                onChange={(e) => {
                                                                    const newSet = new Set(aiSelectedNamespaces);
                                                                    if (e.target.checked) {
                                                                        newSet.add(ns);
                                                                    } else {
                                                                        newSet.delete(ns);
                                                                    }
                                                                    setAISelectedNamespaces(newSet);
                                                                }}
                                                                className="w-4 h-4 accent-purple-500 shrink-0"
                                                            />
                                                            <span className="text-sm text-slate-300 font-mono truncate">{ns}</span>
                                                        </label>
                                                    ))}
                                                </div>
                                            </div>

                                            {/* 预估信息 */}
                                            <div className="bg-slate-900/50 rounded-lg p-4 flex items-center justify-between text-xs text-slate-400">
                                                <div>
                                                    待处理协议: <span className="text-white font-bold">{aiSelectedNamespaces.size}</span> 个
                                                </div>
                                                <div>
                                                    预计消耗 Token: <span className="text-white font-bold">~{estimateTokens(aiSelectedNamespaces.size, aiStrategy).toLocaleString()}</span>
                                                </div>
                                                <div>
                                                    预计耗时: <span className="text-white font-bold">
                                                        {aiSelectedNamespaces.size === 0 ? '0' : `${Math.ceil(estimateProcessingTime(aiSelectedNamespaces.size, aiStrategy).min / 60)}-${Math.ceil(estimateProcessingTime(aiSelectedNamespaces.size, aiStrategy).max / 60)}`} 分钟
                                                    </span>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="flex justify-between mt-6">
                                            <button
                                                onClick={() => {
                                                    // 更新 session ID，使之前的异步任务失效
                                                    aiSessionIdRef.current = Date.now();
                                                    aiServiceRef.current?.abort();
                                                    aiServiceRef.current = null;
                                                    setAIProcessingStarted(false);
                                                    setState(prev => ({ ...prev, status: 'selecting-mode' }));
                                                }}
                                                className="px-4 py-2 text-slate-400 hover:text-white"
                                            >
                                                返回选择
                                            </button>
                                            <button
                                                onClick={startAIProcessing}
                                                disabled={!aiConfig.apiKey || aiSelectedNamespaces.size === 0}
                                                className="px-6 py-2 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white rounded-xl font-bold text-sm flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                <Sparkles size={16} />
                                                {aiSelectedNamespaces.size === 0 ? '请选择协议' : '开始 AI 智能匹配'}
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    // AI 处理进度界面
                                    <div className="flex flex-col h-full">
                                        {/* 顶部进度区域 - 固定高度 */}
                                        <div className="text-center mb-4 shrink-0">
                                            {state.progress.message?.includes('构建文档索引') ? (
                                                // 索引构建动画
                                                <div className="mb-4">
                                                    <div className="inline-block p-4 bg-indigo-500/10 rounded-full mb-4 relative animate-pulse">
                                                        <BookOpen size={48} className="text-indigo-400" />
                                                        <div className="absolute -bottom-1 -right-1 bg-slate-900 rounded-full p-1">
                                                            <Loader2 size={20} className="text-indigo-400 animate-spin" />
                                                        </div>
                                                    </div>
                                                    <h3 className="text-xl font-bold text-white mb-2">正在构建文档索引</h3>
                                                    <p className="text-sm text-slate-400">这可能需要几分钟，请耐心等待...</p>
                                                </div>
                                            ) : (
                                                // 正常进度条
                                                <>
                                                    <div className="inline-block p-3 bg-purple-500/10 rounded-full mb-4 relative">
                                                        <Bot size={32} className="text-purple-400" />
                                                        <div className="absolute -top-1 -right-1 w-3 h-3 bg-green-500 rounded-full animate-pulse" />
                                                    </div>
                                                    <h3 className="text-xl font-bold text-white mb-2">AI 智能匹配中</h3>
                                                    <div className="w-96 mx-auto mt-4 h-2 bg-slate-700 rounded-full overflow-hidden">
                                                        <div
                                                            className="h-full bg-gradient-to-r from-purple-500 to-pink-500 transition-all duration-500"
                                                            style={{ width: `${(state.progress.current / state.progress.total) * 100}%` }}
                                                        />
                                                    </div>
                                                    <div className="flex justify-between w-96 mx-auto mt-2 text-xs text-slate-400">
                                                        <span>{state.progress.current} / {state.progress.total}</span>
                                                        <span>{Math.round((state.progress.current / state.progress.total) * 100)}%</span>
                                                    </div>
                                                    <p className="text-sm text-indigo-300 font-mono mt-2 h-6">
                                                        {state.progress.namespace ? `正在处理: ${state.progress.namespace}` : '准备中...'}
                                                    </p>
                                                </>
                                            )}
                                        </div>

                                        {/* 实时日志 - 弹性填充中间区域 */}
                                        <div className="flex-1 min-h-0 bg-slate-950 border border-slate-800 rounded-xl overflow-hidden flex flex-col">
                                            <div className="px-4 py-2 bg-slate-900 border-b border-slate-800 text-xs font-bold text-slate-400 flex justify-between shrink-0">
                                                <span>实时处理日志</span>
                                                <span>⏱️ {Math.floor(aiProcessingTime / 60)}m {aiProcessingTime % 60}s</span>
                                            </div>
                                            <div
                                                ref={aiLogsContainerRef}
                                                className="flex-1 overflow-y-auto p-4 space-y-2 font-mono text-xs custom-scrollbar select-text cursor-text"
                                            >
                                                {aiProcessLogs.length > 200 && (
                                                    <div className="text-center text-slate-600 py-2 text-[10px]">
                                                        ... 仅显示最近 200 条日志 ...
                                                    </div>
                                                )}
                                                {aiProcessLogs.slice(-200).map((log, i) => (
                                                    <div key={i} className="flex gap-3 hover:bg-slate-900/50 rounded px-1 -mx-1 transition-colors">
                                                        <span className="text-slate-600 shrink-0">
                                                            {new Date(log.timestamp).toLocaleTimeString()}
                                                        </span>
                                                        <span className={`shrink-0 w-16 font-bold ${log.type === 'search' ? 'text-blue-400' :
                                                            log.type === 'analyze' ? 'text-purple-400' :
                                                                log.type === 'extract' ? 'text-amber-400' :
                                                                    log.type === 'complete' ? 'text-emerald-400' :
                                                                        log.type === 'error' ? 'text-red-400' : 'text-slate-400'
                                                            }`}>
                                                            [{log.type.toUpperCase()}]
                                                        </span>
                                                        <span className="text-slate-300 break-all">
                                                            {log.message}
                                                        </span>
                                                    </div>
                                                ))}
                                                {aiProcessLogs.length === 0 && (
                                                    <div className="text-slate-600 text-center py-8">等待开始...</div>
                                                )}
                                                <div ref={logsEndRef} />
                                            </div>
                                        </div>

                                        {/* 底部按钮 - 固定在底部 */}
                                        <div className="shrink-0 pt-4 pb-2 flex justify-center gap-4 bg-slate-900">
                                            {state.status === 'ai-processing' ? (
                                                <button
                                                    onClick={() => {
                                                        // 更新 session ID，使之前的异步任务失效
                                                        aiSessionIdRef.current = Date.now();

                                                        // 立即取消所有请求
                                                        aiServiceRef.current?.abort();
                                                        aiServiceRef.current = null;

                                                        setAIProcessingStarted(false);
                                                        setAIProcessLogs(prev => [...prev, {
                                                            timestamp: Date.now(),
                                                            type: 'info',
                                                            message: '用户取消处理'
                                                        }]);
                                                        setState(prev => ({ ...prev, status: 'selecting-mode' }));
                                                    }}
                                                    className="px-6 py-2 border border-slate-600 hover:border-red-500/50 hover:bg-red-500/10 text-slate-300 hover:text-red-400 rounded-lg text-sm transition-colors"
                                                >
                                                    取消处理
                                                </button>
                                            ) : (
                                                <button
                                                    onClick={() => setState(prev => ({ ...prev, status: 'reviewing' }))}
                                                    className="px-6 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-bold shadow-lg shadow-emerald-500/20 transition-all"
                                                >
                                                    分析完成，下一步
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )
                    }

                    {
                        state.status === 'configuring-docs' && (
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
                        )
                    }

                    {
                        (state.status === 'fetching-ability' || state.status === 'fetching-docs') && (
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
                        )
                    }

                    {
                        state.status === 'error' && (
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
                        )
                    }

                    {
                        state.status === 'reviewing' && (
                            <>
                                {/* 统计信息 */}
                                <div className="flex items-center gap-4 mb-4 p-3 bg-slate-800/50 rounded-xl">
                                    <div className="flex items-center gap-2">
                                        <FileText size={16} className="text-slate-400" />
                                        <span className="text-sm text-white">{stats.total} 个协议</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <CheckCircle size={16} className="text-emerald-400" />
                                        <span className="text-sm text-slate-400">
                                            {docMatchMode === 'ai'
                                                ? `${Array.from(state.aiGeneratedProtocols.values()).filter(p => p.confidence > 0.6).length} 高置信度`
                                                : `${stats.withDocs} 已解析`
                                            }
                                        </span>
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
                                        const isSelected = selectedProtocols.has(namespace);
                                        const isExpanded = expandedProtocols.has(namespace);

                                        // 根据模式获取数据
                                        let doc: ParsedProtocolDoc | undefined;
                                        let aiProto: AIGeneratedProtocol | undefined;
                                        let hasWarnings = false;
                                        let notFound = false;
                                        let methods: string[] = [];
                                        let description = '';
                                        let docUrl = '';

                                        if (docMatchMode === 'ai') {
                                            aiProto = state.aiGeneratedProtocols.get(namespace);
                                            hasWarnings = (aiProto?.warnings?.length || 0) > 0;
                                            notFound = !aiProto?.documentUrl;
                                            methods = aiProto ? Object.keys(aiProto.methods).filter(m => aiProto!.methods[m].enabled) : [];
                                            description = aiProto?.description || '';
                                            docUrl = aiProto?.documentUrl || '';
                                        } else {
                                            doc = state.parsedDocs.get(namespace);
                                            hasWarnings = (doc?.parseWarnings?.length || 0) > 0;
                                            notFound = doc?.parseWarnings.includes('文档页面未找到，使用默认配置') || false;
                                            methods = doc ? Object.entries(doc.supportedMethods).filter(([_, v]) => v).map(([k]) => k) : [];
                                            description = doc?.description || '';
                                            docUrl = doc?.pageUrl || '';
                                        }

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
                                                            {docMatchMode === 'ai' && aiProto && (
                                                                <span className={`text-[10px] px-1.5 py-0.5 rounded ${aiProto.confidence > 0.8 ? 'bg-emerald-500/20 text-emerald-400' :
                                                                    aiProto.confidence > 0.5 ? 'bg-amber-500/20 text-amber-400' :
                                                                        'bg-red-500/20 text-red-400'
                                                                    }`}>
                                                                    {Math.round(aiProto.confidence * 100)}% 置信度
                                                                </span>
                                                            )}
                                                        </div>
                                                        {(methods.length > 0 || description) && (
                                                            <div className="flex items-center gap-2 mt-1">
                                                                {methods.map((method) => (
                                                                    <span key={method} className={`text-[10px] px-1.5 py-0.5 rounded ${method === 'GET' ? 'bg-blue-500/20 text-blue-400' :
                                                                        method === 'SET' ? 'bg-amber-500/20 text-amber-400' :
                                                                            method === 'PUSH' ? 'bg-purple-500/20 text-purple-400' :
                                                                                'bg-slate-500/20 text-slate-400'
                                                                        }`}>{method}</span>
                                                                ))}
                                                                {description && (
                                                                    <span className="text-xs text-slate-500 truncate max-w-[300px] ml-2">{description}</span>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>

                                                    {docUrl && (
                                                        <a
                                                            href={docUrl}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="p-1.5 text-slate-400 hover:text-white"
                                                            title="查看文档"
                                                        >
                                                            <ExternalLink size={14} />
                                                        </a>
                                                    )}
                                                </div>

                                                {isExpanded && (
                                                    <div className="border-t border-slate-700 p-3 bg-slate-900/50">
                                                        {docMatchMode === 'ai' && aiProto ? (
                                                            // AI 模式详情
                                                            <div className="space-y-2">
                                                                {aiProto.documentTitle && (
                                                                    <div className="text-xs text-slate-400">
                                                                        匹配文档: <span className="text-indigo-400">{aiProto.documentTitle}</span>
                                                                    </div>
                                                                )}
                                                                {aiProto.warnings.length > 0 && (
                                                                    <div className="space-y-1">
                                                                        {aiProto.warnings.map((warning, i) => (
                                                                            <div key={i} className="flex items-center gap-2 text-[11px] text-amber-400">
                                                                                <Info size={12} />
                                                                                {warning}
                                                                            </div>
                                                                        ))}
                                                                    </div>
                                                                )}
                                                                <div className="grid grid-cols-1 gap-2 mt-2">
                                                                    {Object.entries(aiProto.methods).filter(([_, m]) => m.enabled).map(([method, data]) => (
                                                                        <div key={method} className="bg-slate-950 rounded p-2 border border-slate-800">
                                                                            <div className="text-xs font-bold text-slate-300 mb-1">{method}</div>
                                                                            <div className="grid grid-cols-2 gap-2">
                                                                                <div>
                                                                                    <div className="text-[10px] text-slate-500 mb-1">Payload</div>
                                                                                    <pre className="text-[10px] text-slate-400 bg-slate-900 p-1 rounded overflow-x-auto custom-scrollbar">
                                                                                        {data.payload}
                                                                                    </pre>
                                                                                </div>
                                                                                <div>
                                                                                    <div className="text-[10px] text-slate-500 mb-1">Schema</div>
                                                                                    <pre className="text-[10px] text-slate-400 bg-slate-900 p-1 rounded overflow-x-auto custom-scrollbar">
                                                                                        {data.schema}
                                                                                    </pre>
                                                                                </div>
                                                                            </div>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            </div>
                                                        ) : doc ? (
                                                            // 手动模式详情
                                                            <>
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
                                                            </>
                                                        ) : null}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            </>
                        )
                    }

                    {
                        state.status === 'saving' && (
                            <div className="text-center py-12">
                                <Loader2 size={48} className="mx-auto mb-4 text-indigo-400 animate-spin" />
                                <h3 className="text-lg font-bold text-white">正在保存...</h3>
                            </div>
                        )
                    }

                    {
                        state.status === 'done' && (
                            <div className="text-center py-12">
                                <CheckCircle size={48} className="mx-auto mb-4 text-emerald-400" />
                                <h3 className="text-lg font-bold text-white mb-2">生成完成!</h3>
                                <p className="text-sm text-slate-400">
                                    已添加 {selectedProtocols.size} 个协议到 "{suiteName}"
                                </p>
                            </div>
                        )
                    }

                    {/* Footer */}
                    {
                        state.status === 'reviewing' && (
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
                        )
                    }
                </div>
            </div >
        </div >
    );
};

export default ProtocolGenerator;
