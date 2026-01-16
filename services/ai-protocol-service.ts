/**
 * AI 协议服务
 * 调用第三方 AI API 进行协议文档的智能检索、分析和生成
 */

// AI 服务提供商类型
export type AIProvider = 'openai' | 'azure' | 'ollama' | 'custom';

// AI 服务配置
export interface AIServiceConfig {
    provider: AIProvider;
    apiEndpoint: string;
    apiKey: string;
    model: string;
    // Azure 特定配置
    azureDeploymentName?: string;
    azureApiVersion?: string;
}

// AI 匹配策略
export interface AIMatchStrategy {
    semanticSearch: boolean;      // 智能语义搜索
    deepAnalysis: boolean;        // 内容深度分析
    generateTestCases: boolean;   // 生成测试用例
}

// AI 处理日志
export interface AIProcessLog {
    timestamp: number;
    type: 'search' | 'analyze' | 'extract' | 'complete' | 'error' | 'info';
    message: string;
    namespace?: string;
}

// AI 生成的协议结果
export interface AIGeneratedProtocol {
    namespace: string;
    description: string;
    documentUrl?: string;
    documentTitle?: string;
    methods: {
        [method: string]: {
            enabled: boolean;
            payload: string;
            schema: string;
            description?: string;
        };
    };
    confidence: number; // 0-1 匹配置信度
    warnings: string[];
}

// 进度回调
export type AIProgressCallback = (
    current: number,
    total: number,
    namespace: string,
    log: AIProcessLog
) => void;

// 默认配置
export const DEFAULT_AI_CONFIG: AIServiceConfig = {
    provider: 'openai',
    apiEndpoint: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4-turbo',
};

// 可用模型列表
export const AI_MODELS: Record<AIProvider, string[]> = {
    openai: ['gpt-4-turbo', 'gpt-4', 'gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo'],
    azure: ['gpt-4', 'gpt-4-turbo', 'gpt-35-turbo'],
    ollama: ['llama3', 'llama2', 'mistral', 'codellama', 'mixtral'],
    custom: ['custom-model'],
};

/**
 * AI 协议服务类
 */
export class AIProtocolService {
    private config: AIServiceConfig;
    private confluenceConfig: any;
    private abortController: AbortController | null = null;

    constructor(aiConfig: AIServiceConfig, confluenceConfig: any) {
        this.config = aiConfig;
        this.confluenceConfig = confluenceConfig;
    }

    /**
     * 测试 AI 服务连接
     */
    async testConnection(): Promise<{ success: boolean; message: string }> {
        try {
            const response = await this.callAI([
                { role: 'user', content: 'Hello, respond with "OK" only.' }
            ], 10);

            if (response) {
                return { success: true, message: `连接成功，模型 ${this.config.model} 可用` };
            }
            return { success: false, message: '无法获取 AI 响应' };
        } catch (error: any) {
            return { success: false, message: `连接失败: ${error.message}` };
        }
    }

    /**
     * 停止当前处理
     */
    abort() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }

    /**
     * 批量处理协议
     */
    async processProtocols(
        namespaces: string[],
        strategy: AIMatchStrategy,
        onProgress: AIProgressCallback
    ): Promise<Map<string, AIGeneratedProtocol>> {
        const results = new Map<string, AIGeneratedProtocol>();
        this.abortController = new AbortController();

        const total = namespaces.length;

        for (let i = 0; i < namespaces.length; i++) {
            if (this.abortController?.signal.aborted) {
                onProgress(i, total, '', {
                    timestamp: Date.now(),
                    type: 'info',
                    message: '处理已取消'
                });
                break;
            }

            const namespace = namespaces[i];

            try {
                // 1. 搜索文档
                onProgress(i, total, namespace, {
                    timestamp: Date.now(),
                    type: 'search',
                    message: `搜索中...`,
                    namespace
                });

                const searchResults = await this.searchDocuments(namespace);

                if (searchResults.length === 0) {
                    onProgress(i, total, namespace, {
                        timestamp: Date.now(),
                        type: 'info',
                        message: `未找到相关文档，使用默认配置`,
                        namespace
                    });

                    results.set(namespace, this.createDefaultProtocol(namespace));
                    continue;
                }

                onProgress(i, total, namespace, {
                    timestamp: Date.now(),
                    type: 'search',
                    message: `找到 ${searchResults.length} 个候选文档`,
                    namespace
                });

                // 2. AI 选择最佳匹配
                if (strategy.semanticSearch) {
                    onProgress(i, total, namespace, {
                        timestamp: Date.now(),
                        type: 'analyze',
                        message: `AI 分析最佳匹配...`,
                        namespace
                    });
                }

                const bestMatch = await this.selectBestDocument(namespace, searchResults, strategy.semanticSearch);

                if (!bestMatch) {
                    results.set(namespace, this.createDefaultProtocol(namespace));
                    continue;
                }

                onProgress(i, total, namespace, {
                    timestamp: Date.now(),
                    type: 'analyze',
                    message: `选择最佳匹配: "${bestMatch.title}"`,
                    namespace
                });

                // 3. 获取并分析文档内容
                if (strategy.deepAnalysis) {
                    onProgress(i, total, namespace, {
                        timestamp: Date.now(),
                        type: 'extract',
                        message: `深度分析文档内容...`,
                        namespace
                    });

                    const docContent = await this.fetchDocumentContent(bestMatch.url);
                    const protocol = await this.analyzeDocument(namespace, docContent, bestMatch, strategy.generateTestCases);

                    results.set(namespace, protocol);

                    onProgress(i, total, namespace, {
                        timestamp: Date.now(),
                        type: 'extract',
                        message: `成功生成 ${Object.keys(protocol.methods).filter(m => protocol.methods[m]?.enabled).join('/')} 方法`,
                        namespace
                    });
                } else {
                    // 简单模式：只记录文档链接
                    results.set(namespace, {
                        ...this.createDefaultProtocol(namespace),
                        documentUrl: bestMatch.url,
                        documentTitle: bestMatch.title,
                    });
                }

                onProgress(i + 1, total, namespace, {
                    timestamp: Date.now(),
                    type: 'complete',
                    message: `✓`,
                    namespace
                });

            } catch (error: any) {
                onProgress(i, total, namespace, {
                    timestamp: Date.now(),
                    type: 'error',
                    message: `处理失败: ${error.message}`,
                    namespace
                });

                results.set(namespace, this.createDefaultProtocol(namespace, [`处理错误: ${error.message}`]));
            }

            // 避免 API 限流
            await this.delay(500);
        }

        return results;
    }

    /**
     * 在 Confluence 中搜索文档
     */
    private async searchDocuments(namespace: string): Promise<Array<{ title: string; url: string; excerpt: string }>> {
        try {
            // 构建搜索查询
            const searchTerms = this.extractSearchTerms(namespace);

            // 构建 CQL: (title ~ "term" OR text ~ "term")
            // 优先匹配标题，然后是正文
            const clauses = searchTerms.flatMap(term => [
                `title ~ "${term}"`,
                `text ~ "${term}"`
            ]).join(' OR ');

            const baseUrl = this.confluenceConfig.baseUrl.replace(/\/$/, '');
            const spaceClause = this.confluenceConfig.spaceKey ? ` AND space="${this.confluenceConfig.spaceKey}"` : '';
            const cql = `(${clauses})${spaceClause}`;

            console.log(`[AI Protocol] Searching for ${namespace} with CQL: ${cql}`);

            const searchUrl = `${baseUrl}/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=10`;

            const response = await this.confluenceFetch(searchUrl);

            if (!response.ok || !response.data?.results) {
                console.warn(`[AI Protocol] Search failed for ${namespace}:`, response);
                return [];
            }

            return response.data.results.map((result: any) => ({
                title: result.title,
                url: `${baseUrl}${result._links?.webui || `/pages/viewpage.action?pageId=${result.id}`}`,
                excerpt: result.excerpt || '',
            }));
        } catch (error) {
            console.error('Search documents error:', error);
            return [];
        }
    }

    /**
     * 从 namespace 提取搜索词
     */
    private extractSearchTerms(namespace: string): string[] {
        const terms: string[] = [];

        // 1. 完整 namespace: "Appliance.Config.Key"
        terms.push(namespace);

        // 2. 空格分隔版本: "Appliance Config Key" (Confluence 分词更友好)
        if (namespace.includes('.')) {
            terms.push(namespace.replace(/\./g, ' '));
        }

        // 移除对单个单词（如 "Key"）的搜索，避免匹配到大量无关文档导致目标文档被挤出 limit 范围

        return [...new Set(terms)];
    }

    /**
     * 使用 AI 选择最佳匹配文档
     */
    private async selectBestDocument(
        namespace: string,
        candidates: Array<{ title: string; url: string; excerpt: string }>,
        useAI: boolean
    ): Promise<{ title: string; url: string } | null> {
        if (candidates.length === 0) return null;
        if (candidates.length === 1) return candidates[0];

        if (!useAI) {
            // 简单匹配：标题包含 namespace 最后部分
            const lastPart = namespace.split('.').pop()?.toLowerCase() || '';
            const match = candidates.find(c => c.title.toLowerCase().includes(lastPart));
            return match || candidates[0];
        }

        // 使用 AI 选择
        const prompt = `你是一个协议文档匹配专家。给定一个协议名称和多个候选文档，请选择最相关的文档。

协议名称: ${namespace}

候选文档:
${candidates.map((c, i) => `${i + 1}. 标题: "${c.title}"
   摘要: ${c.excerpt.slice(0, 200)}...`).join('\n\n')}

请只回复最相关文档的编号（1-${candidates.length}），不要其他内容。`;

        try {
            const response = await this.callAI([
                { role: 'user', content: prompt }
            ], 5);

            const index = parseInt(response.trim()) - 1;
            if (index >= 0 && index < candidates.length) {
                return candidates[index];
            }
        } catch (error) {
            console.error('AI selection error:', error);
        }

        return candidates[0];
    }

    /**
     * 获取文档内容
     */
    private async fetchDocumentContent(docUrl: string): Promise<string> {
        try {
            // 提取 Page ID
            let pageId = '';
            try {
                const urlObj = new URL(docUrl);
                if (urlObj.searchParams.has('pageId')) {
                    pageId = urlObj.searchParams.get('pageId') || '';
                } else {
                    const match = docUrl.match(/\/(\d+)(\/|$|\?)/);
                    if (match) pageId = match[1];
                }
            } catch { }

            if (!pageId) {
                throw new Error('无法解析页面 ID');
            }

            const baseUrl = this.confluenceConfig.baseUrl.replace(/\/$/, '');
            const contentUrl = `${baseUrl}/rest/api/content/${pageId}?expand=body.storage`;

            const response = await this.confluenceFetch(contentUrl);

            if (!response.ok || !response.data) {
                throw new Error('获取页面内容失败');
            }

            // 提取 HTML 内容并转换为纯文本
            const htmlContent = response.data.body?.storage?.value || '';
            return this.htmlToText(htmlContent);
        } catch (error) {
            console.error('Fetch document content error:', error);
            return '';
        }
    }

    /**
     * 使用 AI 分析文档内容
     */
    private async analyzeDocument(
        namespace: string,
        content: string,
        docInfo: { title: string; url: string },
        generateTestCases: boolean
    ): Promise<AIGeneratedProtocol> {
        if (!content) {
            return {
                ...this.createDefaultProtocol(namespace, ['文档内容为空']),
                documentUrl: docInfo.url,
                documentTitle: docInfo.title,
            };
        }

        // 截取内容，避免超出 token 限制
        const truncatedContent = content.slice(0, 8000);

        const prompt = `你是一个 IoT 协议分析专家。请分析以下协议文档，提取协议的请求和响应结构。

协议名称: ${namespace}
文档标题: ${docInfo.title}

文档内容:
${truncatedContent}

请以 JSON 格式输出分析结果，格式如下:
{
  "description": "协议功能描述",
  "methods": {
    "GET": {
      "enabled": true/false,
      "payload": { ... },  // 请求 payload JSON 对象
      "schema": { ... },   // 响应 JSON Schema
      "description": "GET 方法描述"
    },
    "SET": { ... },
    "PUSH": { ... }
  },
  "confidence": 0.0-1.0
}

注意:
1. payload 是请求时发送的数据结构示例
2. schema 是响应的 JSON Schema，用于验证响应格式
3. 如果文档中没有明确说明某个方法，设置 enabled 为 false
4. confidence 表示你对分析结果的置信度

只输出 JSON，不要其他内容。`;

        try {
            const response = await this.callAI([
                { role: 'user', content: prompt }
            ], 60);

            // 解析 AI 响应
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                throw new Error('AI 响应格式错误');
            }

            const parsed = JSON.parse(jsonMatch[0]);

            // 构建协议结果
            const methods: AIGeneratedProtocol['methods'] = {};

            for (const method of ['GET', 'SET', 'PUSH']) {
                const methodData = parsed.methods?.[method];
                if (methodData) {
                    methods[method] = {
                        enabled: methodData.enabled ?? false,
                        payload: typeof methodData.payload === 'object'
                            ? JSON.stringify(methodData.payload, null, 2)
                            : '{}',
                        schema: typeof methodData.schema === 'object'
                            ? JSON.stringify(methodData.schema, null, 2)
                            : '{"type":"object"}',
                        description: methodData.description,
                    };
                }
            }

            return {
                namespace,
                description: parsed.description || `${namespace} 协议`,
                documentUrl: docInfo.url,
                documentTitle: docInfo.title,
                methods,
                confidence: parsed.confidence ?? 0.5,
                warnings: [],
            };
        } catch (error: any) {
            console.error('AI analyze error:', error);
            return {
                ...this.createDefaultProtocol(namespace, [`AI 分析失败: ${error.message}`]),
                documentUrl: docInfo.url,
                documentTitle: docInfo.title,
            };
        }
    }

    /**
     * 创建默认协议配置
     */
    private createDefaultProtocol(namespace: string, warnings: string[] = []): AIGeneratedProtocol {
        return {
            namespace,
            description: `${namespace} 协议`,
            methods: {
                GET: { enabled: true, payload: '{}', schema: '{"type":"object"}' },
            },
            confidence: 0.1,
            warnings: warnings.length > 0 ? warnings : ['未找到文档，使用默认配置'],
        };
    }

    /**
     * 调用 AI API
     */
    private async callAI(messages: Array<{ role: string; content: string }>, timeoutSeconds: number = 30): Promise<string> {
        const { provider, apiEndpoint, apiKey, model, azureDeploymentName, azureApiVersion } = this.config;

        let url: string;
        let headers: Record<string, string>;
        let body: any;

        switch (provider) {
            case 'azure':
                url = `${apiEndpoint}/openai/deployments/${azureDeploymentName}/chat/completions?api-version=${azureApiVersion || '2024-02-15-preview'}`;
                headers = {
                    'Content-Type': 'application/json',
                    'api-key': apiKey,
                };
                body = { messages, max_tokens: 4096 };
                break;

            case 'ollama':
                url = `${apiEndpoint}/api/chat`;
                headers = { 'Content-Type': 'application/json' };
                body = { model, messages, stream: false };
                break;

            case 'custom':
            case 'openai':
            default:
                url = `${apiEndpoint}/chat/completions`;
                headers = {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                };
                body = { model, messages, max_tokens: 4096 };
                break;
        }

        // 使用 Electron 原生请求绕过 CORS
        if (window.electronAPI?.nativeRequest) {
            try {
                const result = await window.electronAPI.nativeRequest({
                    url,
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                    // timeout: timeoutSeconds * 1000, // nativeRequest 可能不支持 timeout，暂移除
                });

                const isOk = result.status >= 200 && result.status < 300;

                if (!isOk) {
                    throw new Error(`API 请求失败: ${result.status} - ${result.text?.slice(0, 200)}`);
                }

                // 解析响应
                if (provider === 'ollama') {
                    return result.data?.message?.content || '';
                } else {
                    return result.data?.choices?.[0]?.message?.content || '';
                }
            } catch (error: any) {
                throw new Error(`AI 请求失败: ${error.message}`);
            }
        } else {
            // 回退到浏览器 fetch
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    const text = await response.text();
                    throw new Error(`API 请求失败: ${response.status} - ${text.slice(0, 200)}`);
                }

                const data = await response.json();

                if (provider === 'ollama') {
                    return data?.message?.content || '';
                } else {
                    return data?.choices?.[0]?.message?.content || '';
                }
            } catch (error: any) {
                clearTimeout(timeoutId);
                if (error.name === 'AbortError') {
                    throw new Error('请求超时');
                }
                throw error;
            }
        }
    }

    /**
     * Confluence API 请求
     * 修改：移除 Basic Auth，改用 Cookie 认证以穿透 LDAP 网关
     */
    /**
     * Confluence API 请求
     * 修改：手动获取并注入 Cookie 以穿透 LDAP 网关
     */
    /**
     * Confluence API 请求
     * 修改：优先使用浏览器 fetch 以利用自动 Cookie 管理穿透 LDAP
     */
    private async confluenceFetch(url: string): Promise<{ ok: boolean; status: number; data: any }> {
        const headers: Record<string, string> = {
            'Accept': 'application/json',
            'X-Atlassian-Token': 'no-check',
        };

        // 尝试手动获取 Cookie (作为 fetch 的辅助，虽然通常不需要)
        if (window.electronAPI?.confluenceGetCookies) {
            try {
                const result = await window.electronAPI.confluenceGetCookies(this.confluenceConfig.baseUrl);
                if (result && result.success && Array.isArray(result.cookies) && result.cookies.length > 0) {
                    // 打印 Cookie 名称以供调试
                    console.log('[AI Protocol] Got cookies:', result.cookies.map((c: any) => c.name).join(', '));
                }
            } catch (e) {
                console.warn('[AI Protocol] Failed to get cookies:', e);
            }
        }

        // 策略 1: 优先尝试浏览器原生 fetch
        // 优势：自动继承当前窗口的所有 Cookie (包括 LDAP/SSO)，只要 Electron 禁用了 Web 安全策略即可成功
        try {
            console.log('[AI Protocol] Trying browser fetch...');
            const response = await fetch(url, {
                method: 'GET',
                headers,
                credentials: 'include' // 关键：携带 Cookie
            });

            // 检查 Content-Type
            const contentType = response.headers.get('content-type');
            if (contentType && !contentType.includes('application/json')) {
                console.warn('[AI Protocol] Fetch received non-JSON response, likely auth redirect.');
                // 如果 fetch 拿到的是 HTML，说明 fetch 也被拦截了，或者 CORS 预检通过但请求被重定向
                // 此时继续尝试 nativeRequest 也没用，因为认证都失败了
                return { ok: false, status: 401, data: null };
            }

            const data = await response.json();
            return { ok: response.ok, status: response.status, data };
        } catch (error: any) {
            console.warn('[AI Protocol] Browser fetch failed (likely CORS), falling back to nativeRequest:', error);
        }

        // 策略 2: 回退到 nativeRequest (如果 fetch 因 CORS 失败)
        if (window.electronAPI?.nativeRequest) {
            try {
                // 再次尝试注入 Cookie，因为 nativeRequest 不会自动继承渲染进程的 Cookie
                if (window.electronAPI?.confluenceGetCookies) {
                    const result = await window.electronAPI.confluenceGetCookies(this.confluenceConfig.baseUrl);
                    if (result && result.success && Array.isArray(result.cookies) && result.cookies.length > 0) {
                        const cookieString = result.cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
                        headers['Cookie'] = cookieString;
                    }
                }

                const result = await window.electronAPI.nativeRequest({
                    url,
                    method: 'GET',
                    headers,
                    followRedirects: true,
                    maxRedirects: 5,
                } as any);

                if (typeof result.data === 'string' && result.data.includes('<!DOCTYPE html>')) {
                    console.warn('[AI Protocol] Native request detected HTML response (LDAP login page).');
                    return { ok: false, status: 401, data: null };
                }

                return {
                    ok: result.status >= 200 && result.status < 300,
                    status: result.status,
                    data: result.data,
                };
            } catch (error: any) {
                console.error('[AI Protocol] Native request error:', error);
                return { ok: false, status: 0, data: null };
            }
        }

        return { ok: false, status: 0, data: null };
    }

    /**
     * HTML 转纯文本
     */
    private htmlToText(html: string): string {
        // 移除 HTML 标签
        let text = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
            .replace(/\s+/g, ' ')
            .trim();

        return text;
    }

    /**
     * 延迟函数
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

/**
 * 估算 Token 消耗
 */
export function estimateTokens(namespaceCount: number, strategy: AIMatchStrategy): number {
    let tokensPerNamespace = 500; // 基础搜索

    if (strategy.semanticSearch) {
        tokensPerNamespace += 300;
    }

    if (strategy.deepAnalysis) {
        tokensPerNamespace += 2000;
    }

    if (strategy.generateTestCases) {
        tokensPerNamespace += 500;
    }

    return namespaceCount * tokensPerNamespace;
}

/**
 * 估算处理时间（秒）
 */
export function estimateProcessingTime(namespaceCount: number, strategy: AIMatchStrategy): { min: number; max: number } {
    let secondsPerNamespace = 2;

    if (strategy.deepAnalysis) {
        secondsPerNamespace += 3;
    }

    if (strategy.generateTestCases) {
        secondsPerNamespace += 2;
    }

    return {
        min: Math.round(namespaceCount * secondsPerNamespace * 0.8),
        max: Math.round(namespaceCount * secondsPerNamespace * 1.5),
    };
}
