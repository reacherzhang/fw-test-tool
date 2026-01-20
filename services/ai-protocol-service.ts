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

// 导入文档索引服务
import {
    ConfluenceDocIndexService,
    getDocIndexService,
    DocIndexConfig,
    DEFAULT_DOC_INDEX_CONFIG
} from './confluenceDocIndexService';

/**
 * AI 协议服务类
 */
export class AIProtocolService {
    private config: AIServiceConfig;
    private confluenceConfig: any;
    private abortController: AbortController | null = null;
    private docIndexService: ConfluenceDocIndexService | null = null;
    private useDocIndex: boolean = true;  // 默认使用文档索引

    constructor(aiConfig: AIServiceConfig, confluenceConfig: any, useDocIndex: boolean = true) {
        this.config = aiConfig;
        this.confluenceConfig = confluenceConfig;
        this.useDocIndex = useDocIndex;

        // 初始化文档索引服务
        if (useDocIndex && confluenceConfig?.baseUrl) {
            const indexConfig: Partial<DocIndexConfig> = {
                confluenceBaseUrl: confluenceConfig.baseUrl,
                rootPageIds: confluenceConfig.rootPageIds || DEFAULT_DOC_INDEX_CONFIG.rootPageIds,
            };
            this.docIndexService = getDocIndexService(indexConfig, aiConfig);
        }
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
        // 同时也取消文档索引构建
        if (this.docIndexService) {
            this.docIndexService.abort();
        }
    }

    /**
     * 获取文档索引统计
     */
    getIndexStats(): { totalPages: number; lastUpdated: Date | null; cacheStatus: string } | null {
        return this.docIndexService?.getStats() || null;
    }

    /**
     * 刷新文档索引
     */
    async refreshIndex(): Promise<number> {
        if (this.docIndexService) {
            const index = await this.docIndexService.getIndex(true);
            return index.items.size;
        }
        return 0;
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

        // 如果启用文档索引，先构建索引
        if (this.useDocIndex && this.docIndexService) {
            onProgress(0, total, '', {
                timestamp: Date.now(),
                type: 'info',
                message: '正在构建文档索引...'
            });

            // 给 UI 一点时间渲染消息
            await new Promise(resolve => setTimeout(resolve, 50));

            try {
                const index = await this.docIndexService.getIndex();
                onProgress(0, total, '', {
                    timestamp: Date.now(),
                    type: 'info',
                    message: `文档索引就绪，共 ${index.items.size} 个页面`
                });
            } catch (error) {
                console.warn('[AI Protocol] Failed to build index, falling back to CQL search');
                this.useDocIndex = false;
            }
        }

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
                // 1. 搜索文档（优先使用索引）
                onProgress(i, total, namespace, {
                    timestamp: Date.now(),
                    type: 'search',
                    message: this.useDocIndex ? `索引匹配中...` : `CQL 搜索中...`,
                    namespace
                });

                let bestMatch: { title: string; url: string; pageId?: string } | null = null;
                let matchConfidence = 0;
                let matchMethod = '';

                // 优先使用文档索引
                if (this.useDocIndex && this.docIndexService) {
                    const matchResult = await this.docIndexService.matchDocument(namespace);

                    if (matchResult.matched && matchResult.document) {
                        bestMatch = {
                            title: matchResult.document.title,
                            url: matchResult.document.url,
                            pageId: matchResult.document.pageId,
                        };
                        matchConfidence = matchResult.document.confidence;
                        matchMethod = matchResult.document.matchReason;

                        onProgress(i, total, namespace, {
                            timestamp: Date.now(),
                            type: 'search',
                            message: `✓ 匹配到: "${bestMatch.title}" (${Math.round(matchConfidence * 100)}% ${matchMethod})`,
                            namespace
                        });
                    } else {
                        onProgress(i, total, namespace, {
                            timestamp: Date.now(),
                            type: 'info',
                            message: `索引中未找到匹配，尝试 CQL 搜索...`,
                            namespace
                        });

                        // 回退到 CQL 搜索
                        const searchResults = await this.searchDocuments(namespace);
                        if (searchResults.length > 0) {
                            bestMatch = await this.selectBestDocument(namespace, searchResults, strategy.semanticSearch);
                            matchMethod = 'CQL 搜索';
                            matchConfidence = 0.5;
                        }
                    }
                } else {
                    // 使用原有的 CQL 搜索
                    const searchResults = await this.searchDocuments(namespace);

                    if (searchResults.length > 0) {
                        onProgress(i, total, namespace, {
                            timestamp: Date.now(),
                            type: 'search',
                            message: `找到 ${searchResults.length} 个候选文档`,
                            namespace
                        });

                        if (strategy.semanticSearch) {
                            onProgress(i, total, namespace, {
                                timestamp: Date.now(),
                                type: 'analyze',
                                message: `AI 分析最佳匹配...`,
                                namespace
                            });
                        }

                        bestMatch = await this.selectBestDocument(namespace, searchResults, strategy.semanticSearch);
                        matchConfidence = 0.5;
                    }
                }

                // 如果没找到匹配，使用默认配置
                if (!bestMatch) {
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
                    type: 'analyze',
                    message: `选择最佳匹配: "${bestMatch.title}"`,
                    namespace
                });

                // 获取并分析文档内容
                if (strategy.deepAnalysis) {
                    // 检查取消状态
                    if (this.abortController?.signal.aborted) {
                        throw new Error('Aborted');
                    }

                    onProgress(i, total, namespace, {
                        timestamp: Date.now(),
                        type: 'extract',
                        message: `深度分析文档内容...`,
                        namespace
                    });

                    const docContent = await this.fetchDocumentContent(bestMatch.url);

                    // 再次检查取消状态
                    if (this.abortController?.signal.aborted) {
                        throw new Error('Aborted');
                    }

                    const protocol = await this.analyzeDocument(namespace, docContent, bestMatch, strategy.generateTestCases);

                    // 再次检查取消状态
                    if (this.abortController?.signal.aborted) {
                        throw new Error('Aborted');
                    }

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
            ]);

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

            // 如果有文档索引服务，优先使用它（因为它处理了认证和 Cookie）
            if (this.docIndexService) {
                return await this.docIndexService.fetchDocumentContent(pageId);
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

请遵循以下步骤进行分析：
1. **识别交互方式**：查看文档中的交互方式表，确定支持的方法（GET, SET, PUSH）。
2. **提取 Request Payload (JSON 示例)**：
   - 生成纯粹的 JSON 数据示例，用于发送请求。
   - **不要使用 Schema 格式**。
   - **必须生成具体的示例值**：不要使用 "string", "integer" 等类型描述。
   - 对于敏感字段（如 key, password, token），使用 "***" 或 "REPLACE_ME"。
3. **提取 Response Payload (JSON Schema)**：
   - **必须生成标准的 JSON Schema 格式**，用于验证响应。
   - 包含 "type", "properties" 等关键字。
   - **利用表格中的“必填”列**：将标记为“必填（Y）”的字段添加到 "required" 数组中。
   - 字段的示例值可以放在 "default" 或 "examples" 字段中。

请以 JSON 格式输出分析结果，格式如下:
{
  "description": "协议功能描述",
  "methods": {
    "GET": {
      "enabled": true/false,
      "payload": { ... },  // Request Payload: JSON 数据示例
      "response": { ... },   // Response Payload: JSON Schema (包含 required)
      "description": "GET 方法描述"
    },
    "SET": {
      "enabled": true/false,
      "payload": { ... },  // Request Payload: JSON 数据示例
      "response": { ... },   // Response Payload: JSON Schema (包含 required)
      "description": "SET 方法描述"
    },
    "PUSH": { ... }
  },
  "confidence": 0.0-1.0
}

注意:
1. 只输出 JSON，不要其他内容。
2. 确保 JSON 格式合法。
3. **Request Payload 必须是 JSON 示例，Response Payload 必须是 JSON Schema。**`;

        try {
            const response = await this.callAI([
                { role: 'user', content: prompt }
            ]);

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
                        schema: typeof methodData.response === 'object'
                            ? JSON.stringify(methodData.response, null, 2)
                            : (typeof methodData.schema === 'object' ? JSON.stringify(methodData.schema, null, 2) : '{}'),
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
     * 调用 AI API (带重试)
     */
    private async callAI(messages: Array<{ role: string; content: string }>, timeoutSeconds: number = 60): Promise<string> {
        const { provider, apiEndpoint, apiKey, model, azureDeploymentName, azureApiVersion } = this.config;
        const maxRetries = 2; // 用户要求重试2次

        // 移除 endpoint 结尾的斜杠，避免双斜杠问题
        const cleanEndpoint = apiEndpoint.replace(/\/+$/, '');

        // 创建 Abort Promise
        const abortPromise = new Promise<any>((_, reject) => {
            if (this.abortController?.signal.aborted) reject(new Error('Aborted'));
            this.abortController?.signal.addEventListener('abort', () => reject(new Error('Aborted')));
        });

        let lastError: any;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            // 每次尝试前检查是否取消
            if (this.abortController?.signal.aborted) throw new Error('Aborted');

            try {
                let url: string;
                let headers: Record<string, string>;
                let body: any;

                switch (provider) {
                    case 'azure':
                        url = `${cleanEndpoint}/openai/deployments/${azureDeploymentName}/chat/completions?api-version=${azureApiVersion || '2024-02-15-preview'}`;
                        headers = {
                            'Content-Type': 'application/json',
                            'api-key': apiKey,
                        };
                        body = { messages, max_tokens: 4096 };
                        break;

                    case 'ollama':
                        url = `${cleanEndpoint}/api/chat`;
                        headers = { 'Content-Type': 'application/json' };
                        body = { model, messages, stream: false };
                        break;

                    case 'custom':
                    case 'openai':
                    default:
                        // 如果用户输入了完整的 /chat/completions 路径，则直接使用
                        if (cleanEndpoint.endsWith('/chat/completions')) {
                            url = cleanEndpoint;
                        } else {
                            url = `${cleanEndpoint}/chat/completions`;
                        }

                        headers = {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${apiKey}`,
                        };
                        body = { model, messages, max_tokens: 4096 };
                        break;
                }

                // 使用 Electron 原生请求绕过 CORS
                if (window.electronAPI?.nativeRequest) {
                    // 发起请求前再次检查是否取消
                    if (this.abortController?.signal.aborted) {
                        throw new Error('Aborted');
                    }

                    const requestPromise = window.electronAPI.nativeRequest({
                        url,
                        method: 'POST',
                        headers,
                        body: JSON.stringify(body),
                        timeout: timeoutSeconds * 1000,
                    });

                    // 使用 Promise.race 实现立即取消
                    const result = await Promise.race([requestPromise, abortPromise]);

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
                } else {
                    // 回退到浏览器 fetch
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

                    // 监听外部取消信号
                    const onAbort = () => controller.abort();
                    this.abortController?.signal.addEventListener('abort', onAbort);

                    try {
                        const response = await fetch(url, {
                            method: 'POST',
                            headers,
                            body: JSON.stringify(body),
                            signal: controller.signal,
                        });

                        clearTimeout(timeoutId);
                        this.abortController?.signal.removeEventListener('abort', onAbort);

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
                        this.abortController?.signal.removeEventListener('abort', onAbort);
                        if (error.name === 'AbortError') {
                            if (this.abortController?.signal.aborted) {
                                throw new Error('Aborted');
                            }
                            throw new Error('请求超时');
                        }
                        throw error;
                    }
                }
            } catch (error: any) {
                if (error.message === 'Aborted') {
                    throw error; // 立即抛出取消错误，停止重试
                }

                console.warn(`[AI] Attempt ${attempt + 1} failed: ${error.message}`);
                lastError = error;

                // 只有超时或网络错误才重试
                const isTimeout = error.message.includes('timeout') || error.message.includes('超时') || error.message.includes('socket');

                if (attempt < maxRetries && isTimeout) {
                    // 检查是否已取消
                    if (this.abortController?.signal.aborted) throw new Error('Aborted');

                    console.log(`[AI] Retrying... (${maxRetries - attempt} left)`);

                    // 使用 Promise.race 让等待可被中断
                    await Promise.race([
                        new Promise(r => setTimeout(r, 1000)),
                        new Promise((_, reject) => {
                            if (this.abortController?.signal.aborted) reject(new Error('Aborted'));
                            this.abortController?.signal.addEventListener('abort', () => reject(new Error('Aborted')));
                        })
                    ]).catch(e => { if (e.message === 'Aborted') throw e; });

                    continue;
                }

                // 如果是最后一次尝试，或者不是可重试的错误，则抛出
                if (attempt === maxRetries) {
                    throw error;
                }
            }
        }

        throw lastError || new Error('AI request failed');
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
     * 延迟函数 (可被 abort 信号中断)
     */
    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const timeoutId = setTimeout(resolve, ms);

            // 监听 abort 信号
            const onAbort = () => {
                clearTimeout(timeoutId);
                resolve();  // 立即返回，不抛出错误
            };

            if (this.abortController?.signal.aborted) {
                clearTimeout(timeoutId);
                resolve();
                return;
            }

            this.abortController?.signal.addEventListener('abort', onAbort, { once: true });
        });
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
