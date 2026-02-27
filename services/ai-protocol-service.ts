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
    type: 'search' | 'analyze' | 'extract' | 'complete' | 'error' | 'info' | 'warning';
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

                // 检查索引是否为空（可能是认证失败但没抛出错误的情况）
                if (index.items.size === 0) {
                    onProgress(0, total, '', {
                        timestamp: Date.now(),
                        type: 'error',
                        message: '⚠️ 文档索引为空，可能是 Confluence 认证失败。请先在浏览器中登录 Confluence，然后重试。'
                    });
                    this.useDocIndex = false;
                } else {
                    onProgress(0, total, '', {
                        timestamp: Date.now(),
                        type: 'info',
                        message: `文档索引就绪，共 ${index.items.size} 个页面`
                    });
                }
            } catch (error: any) {
                // 特殊处理 Confluence 认证错误
                if (error.code === 'CONFLUENCE_AUTH_ERROR' ||
                    error.message?.includes('认证') ||
                    error.message?.includes('登录') ||
                    error.message?.includes('LDAP')) {
                    onProgress(0, total, '', {
                        timestamp: Date.now(),
                        type: 'error',
                        message: `❌ Confluence 访问失败：${error.message || '认证已过期'}。请先在浏览器中打开 Confluence 并完成登录，然后重新尝试。`
                    });
                    // 不继续处理，直接返回空结果
                    return results;
                }

                console.warn('[AI Protocol] Failed to build index, falling back to CQL search:', error.message);
                onProgress(0, total, '', {
                    timestamp: Date.now(),
                    type: 'info',
                    message: '索引构建失败，切换到 CQL 搜索模式...'
                });
                this.useDocIndex = false;
            }
        }

        // 并发控制：恢复为线性处理（concurrency = 1），避免日志错位和潜在的竞争问题
        const concurrency = 1;
        const queue = namespaces.map((ns, index) => ({ ns, index }));
        let processedCount = 0;

        const processItem = async (namespace: string, i: number) => {
            try {
                // 1. 搜索文档（优先使用索引）
                onProgress(processedCount, total, namespace, {
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

                        const isLowConfidence = matchConfidence < 0.8;
                        onProgress(processedCount, total, namespace, {
                            timestamp: Date.now(),
                            type: isLowConfidence ? 'warning' : 'search',
                            message: `${isLowConfidence ? '⚠️' : '✓'} 匹配到: "${bestMatch.title}" (${Math.round(matchConfidence * 100)}% ${matchMethod})`,
                            namespace
                        });

                        if (isLowConfidence) {
                            onProgress(processedCount, total, namespace, {
                                timestamp: Date.now(),
                                type: 'error',
                                message: `匹配度过低，跳过深度分析。已标记为异常。`,
                                namespace
                            });
                            results.set(namespace, this.createDefaultProtocol(namespace, [`匹配度低于80% (${Math.round(matchConfidence * 100)}%)，未生成内容`]));
                            processedCount++;
                            await this.delay(500);
                            return;
                        }
                    } else {
                        onProgress(processedCount, total, namespace, {
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
                        onProgress(processedCount, total, namespace, {
                            timestamp: Date.now(),
                            type: 'search',
                            message: `找到 ${searchResults.length} 个候选文档`,
                            namespace
                        });

                        if (strategy.semanticSearch) {
                            onProgress(processedCount, total, namespace, {
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
                    onProgress(processedCount, total, namespace, {
                        timestamp: Date.now(),
                        type: 'info',
                        message: `未找到相关文档，使用默认配置`,
                        namespace
                    });
                    results.set(namespace, this.createDefaultProtocol(namespace));
                    return;
                }

                onProgress(processedCount, total, namespace, {
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

                    onProgress(processedCount, total, namespace, {
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

                    onProgress(processedCount, total, namespace, {
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

                processedCount++;
                onProgress(processedCount, total, namespace, {
                    timestamp: Date.now(),
                    type: 'complete',
                    message: `✓`,
                    namespace
                });

            } catch (error: any) {
                onProgress(processedCount, total, namespace, {
                    timestamp: Date.now(),
                    type: 'error',
                    message: `处理失败: ${error.message}`,
                    namespace
                });

                results.set(namespace, this.createDefaultProtocol(namespace, [`处理错误: ${error.message}`]));
                processedCount++;
            }

            // 避免 API 限流
            await this.delay(500);
        };

        const workers = Array(concurrency).fill(null).map(async () => {
            while (queue.length > 0) {
                if (this.abortController?.signal.aborted) break;
                const item = queue.shift();
                if (!item) break;
                await processItem(item.ns, item.index);
            }
        });

        await Promise.all(workers);

        if (this.abortController?.signal.aborted) {
            onProgress(processedCount, total, '', {
                timestamp: Date.now(),
                type: 'info',
                message: '处理已取消'
            });
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
     * 获取文档内容（返回 Markdown 格式，保留表格结构）
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
                const htmlContent = await this.docIndexService.fetchDocumentHtml(pageId);
                if (htmlContent) {
                    return this.htmlToMarkdown(htmlContent);
                }
                return await this.docIndexService.fetchDocumentContent(pageId);
            }

            const baseUrl = this.confluenceConfig.baseUrl.replace(/\/$/, '');
            const contentUrl = `${baseUrl}/rest/api/content/${pageId}?expand=body.storage`;

            const response = await this.confluenceFetch(contentUrl);

            if (!response.ok || !response.data) {
                throw new Error('获取页面内容失败');
            }

            // 提取 HTML 内容并转换为 Markdown（保留表格结构）
            const htmlContent = response.data.body?.storage?.value || '';
            return this.htmlToMarkdown(htmlContent);
        } catch (error) {
            console.error('Fetch document content error:', error);
            return '';
        }
    }

    /**
     * 从HTML内容中提取表格里包含链接引用的字段
     * 返回格式: { linkedFields: Map<fieldName, {pageId, linkText}>, titleLinkedFields: Map<fieldName, {title, linkText}> }
     */
    private extractLinkedFieldsFromHtml(htmlContent: string): {
        linkedFields: Map<string, { pageId: string; linkText: string }>;
        titleLinkedFields: Map<string, { title: string; linkText: string }>;
    } {
        const linkedFields = new Map<string, { pageId: string; linkText: string }>();
        const titleLinkedFields = new Map<string, { title: string; linkText: string }>();

        try {
            // 匹配表格行中的链接引用，格式类似：
            // <tr><td>fieldName</td><td>Y/N</td><td>object</td><td><a href="...pageId=xxx">描述文字</a></td></tr>
            // 或者 <ac:link><ri:page ri:content-title="..." ri:space-key="..."/><ac:link-body>描述</ac:link-body></ac:link>

            // 模式1: 标准 HTML 链接格式 (pageId in href)
            const htmlLinkRegex = /<tr[^>]*>[\s\S]*?<td[^>]*>([^<]+)<\/td>[\s\S]*?<td[^>]*>[YN]?<\/td>[\s\S]*?<td[^>]*>(object|array)<\/td>[\s\S]*?<td[^>]*>[\s\S]*?<a[^>]+href="[^"]*pageId=(\d+)"[^>]*>([^<]*)<\/a>[\s\S]*?<\/td>[\s\S]*?<\/tr>/gi;

            let match;
            while ((match = htmlLinkRegex.exec(htmlContent)) !== null) {
                const fieldName = match[1]?.trim();
                const pageId = match[3];
                const linkText = match[4];

                if (fieldName && pageId) {
                    linkedFields.set(fieldName, { pageId, linkText: linkText || fieldName });
                    console.log(`[AI Protocol] Found linked field (HTML): ${fieldName} -> pageId=${pageId} (${linkText})`);
                }
            }

            // 模式2: Confluence Storage Format 链接 (ri-content-id)
            const confluenceIdRegex = /<td[^>]*>([a-zA-Z_][a-zA-Z0-9_]*)<\/td>[\s\S]*?<td[^>]*>[YN]?<\/td>[\s\S]*?<td[^>]*>(?:object|array)<\/td>[\s\S]*?<td[^>]*>[\s\S]*?<ac:link>[\s\S]*?<ri:page[^>]+ri-content-id="(\d+)"[\s\S]*?<\/ac:link>[\s\S]*?<\/td>/gi;

            while ((match = confluenceIdRegex.exec(htmlContent)) !== null) {
                const fieldName = match[1]?.trim();
                const pageId = match[2];

                if (fieldName && pageId && !linkedFields.has(fieldName)) {
                    linkedFields.set(fieldName, { pageId, linkText: fieldName });
                    console.log(`[AI Protocol] Found linked field (Confluence ri-content-id): ${fieldName} -> pageId=${pageId}`);
                }
            }

            // 模式3: 简化版 - 直接在 object/array 类型字段后查找 pageId
            const simplePageIdRegex = /([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:<\/[^>]+>)?\s*(?:<[^>]+>\s*)*(?:Y|N|是|否)?\s*(?:<\/[^>]+>)?\s*(?:<[^>]+>\s*)*(?:object|array)\s*(?:<\/[^>]+>)?\s*(?:<[^>]+>\s*)*[\s\S]{0,200}?pageId[=:](\d+)/gi;

            while ((match = simplePageIdRegex.exec(htmlContent)) !== null) {
                const fieldName = match[1]?.trim();
                const pageId = match[2];

                if (fieldName && pageId && !linkedFields.has(fieldName)) {
                    linkedFields.set(fieldName, { pageId, linkText: fieldName });
                    console.log(`[AI Protocol] Found linked field (simple pageId): ${fieldName} -> pageId=${pageId}`);
                }
            }

            // 模式4: Confluence Wiki 链接格式 (ri:content-title) - 收集标题，后续查询 pageId
            const wikiLinkRegex = /<td[^>]*>\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*<\/td>[\s\S]*?<td[^>]*>\s*[YN是否]?\s*<\/td>[\s\S]*?<td[^>]*>\s*(?:object|array)\s*<\/td>[\s\S]*?<td[^>]*>[\s\S]*?<ri:page[^>]+ri:content-title="([^"]+)"[\s\S]*?<\/td>/gi;

            while ((match = wikiLinkRegex.exec(htmlContent)) !== null) {
                const fieldName = match[1]?.trim();
                const contentTitle = match[2];

                if (fieldName && contentTitle && !linkedFields.has(fieldName) && !titleLinkedFields.has(fieldName)) {
                    titleLinkedFields.set(fieldName, { title: contentTitle, linkText: contentTitle });
                    console.log(`[AI Protocol] Found linked field (Wiki title): ${fieldName} -> title="${contentTitle}"`);
                }
            }

            // 模式5: 更宽松的匹配 - 查找任何包含 viewpage.action?pageId= 的链接
            const viewpageRegex = /([a-zA-Z_][a-zA-Z0-9_]*)[\s\S]{0,500}?viewpage\.action\?pageId=(\d+)/gi;

            // 只处理表格中的情况
            const tableRegex = /<table[\s\S]*?<\/table>/gi;
            let tableMatch;
            while ((tableMatch = tableRegex.exec(htmlContent)) !== null) {
                const tableContent = tableMatch[0];

                // 在每个表格中查找行
                const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
                let rowMatch;
                while ((rowMatch = rowRegex.exec(tableContent)) !== null) {
                    const rowContent = rowMatch[1];

                    // 提取单元格
                    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
                    const cells: string[] = [];
                    let cellMatch;
                    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
                        cells.push(cellMatch[1]);
                    }

                    // 检查是否是我们要找的格式
                    // 格式1: 字段名 | 必填 | 类型 | 描述 (>= 4 columns)
                    // 格式2: 字段名 | 类型 | 描述 (3 columns)
                    if (cells.length >= 3) {
                        const fieldNameCell = cells[0].replace(/<[^>]+>/g, '').trim();
                        let typeCell = '';
                        let descCell = '';

                        if (cells.length >= 4) {
                            typeCell = cells[2].replace(/<[^>]+>/g, '').trim().toLowerCase();
                            descCell = cells[3];
                        } else {
                            typeCell = cells[1].replace(/<[^>]+>/g, '').trim().toLowerCase();
                            descCell = cells[2];
                        }

                        if ((typeCell === 'object' || typeCell === 'array') && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(fieldNameCell)) {
                            // 在描述中查找 pageId
                            const pageIdMatch = descCell.match(/pageId[=:](\d+)/i) ||
                                descCell.match(/ri-content-id="(\d+)"/i) ||
                                descCell.match(/content-id="(\d+)"/i);

                            if (pageIdMatch && !linkedFields.has(fieldNameCell)) {
                                const pageId = pageIdMatch[1];
                                // 尝试提取链接文字
                                const linkTextMatch = descCell.match(/<a[^>]*>([^<]*)<\/a>/i) ||
                                    descCell.match(/<ac:link-body>([^<]*)<\/ac:link-body>/i);
                                const linkText = linkTextMatch ? linkTextMatch[1].trim() : fieldNameCell;

                                linkedFields.set(fieldNameCell, { pageId, linkText });
                                console.log(`[AI Protocol] Found linked field (table cell): ${fieldNameCell} -> pageId=${pageId} (${linkText})`);
                            }

                            // 在描述中查找 ri:content-title
                            if (!linkedFields.has(fieldNameCell) && !titleLinkedFields.has(fieldNameCell)) {
                                const titleMatch = descCell.match(/ri:content-title="([^"]+)"/i);
                                if (titleMatch) {
                                    const title = titleMatch[1];
                                    const linkTextMatch = descCell.match(/<ac:link-body>([^<]*)<\/ac:link-body>/i);
                                    const linkText = linkTextMatch ? linkTextMatch[1].trim() : title;
                                    titleLinkedFields.set(fieldNameCell, { title, linkText });
                                    console.log(`[AI Protocol] Found linked field (table cell title): ${fieldNameCell} -> title="${title}"`);
                                }
                            }
                        }
                    }
                }
            }

        } catch (error) {
            console.error('[AI Protocol] Error extracting linked fields:', error);
        }

        return { linkedFields, titleLinkedFields };
    }


    /**
     * 从 HTML 内容中解析表格，提取字段定义
     * 返回格式化的字段列表，便于AI理解
     */
    private parseTableFieldsFromHtml(htmlContent: string): Array<{
        name: string;
        required: boolean;
        type: string;
        description: string;
    }> {
        const fields: Array<{ name: string; required: boolean; type: string; description: string }> = [];

        try {
            // 查找所有表格
            const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
            let tableMatch;

            while ((tableMatch = tableRegex.exec(htmlContent)) !== null) {
                const tableContent = tableMatch[1];

                // 查找表格行
                const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
                let rowMatch;
                let isHeader = true;

                while ((rowMatch = rowRegex.exec(tableContent)) !== null) {
                    const rowContent = rowMatch[1];

                    // 跳过表头行（包含 th 或者第一行）
                    if (rowContent.includes('<th') || isHeader) {
                        isHeader = false;
                        // 检查是否真的是表头
                        const headerText = rowContent.replace(/<[^>]+>/g, '').toLowerCase();
                        if (headerText.includes('名称') || headerText.includes('name') ||
                            headerText.includes('字段') || headerText.includes('field')) {
                            continue;
                        }
                    }

                    // 提取单元格
                    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
                    const cells: string[] = [];
                    let cellMatch;

                    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
                        // 移除 HTML 标签，保留文本
                        const cellText = cellMatch[1]
                            .replace(/<br\s*\/?>/gi, ' ')
                            .replace(/<[^>]+>/g, '')
                            .replace(/&nbsp;/g, ' ')
                            .replace(/&lt;/g, '<')
                            .replace(/&gt;/g, '>')
                            .replace(/&amp;/g, '&')
                            .replace(/\s+/g, ' ')
                            .trim();
                        cells.push(cellText);
                    }

                    // 解析字段信息（假设格式为：名称 | 必填 | 类型 | 描述）
                    if (cells.length >= 3) {
                        const name = cells[0];
                        // 检查是否是有效的字段名
                        if (!name || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
                            continue;
                        }

                        let required = false;
                        let type = '';
                        let description = '';

                        if (cells.length === 3) {
                            // 格式可能是：名称 | 类型 | 描述
                            type = cells[1].toLowerCase();
                            description = cells[2];
                        } else if (cells.length >= 4) {
                            // 格式：名称 | 必填 | 类型 | 描述
                            const requiredCell = cells[1].toLowerCase();
                            required = requiredCell === 'y' || requiredCell === 'yes' ||
                                requiredCell === '是' || requiredCell === '必填';
                            type = cells[2].toLowerCase();
                            description = cells[3];
                        }

                        fields.push({ name, required, type, description });
                    }
                }
            }
        } catch (error) {
            console.error('[AI Protocol] Error parsing table fields:', error);
        }

        return fields;
    }

    /**
     * 批量获取链接文档的内容，并解析为结构化字段定义
     * @param linkedFields 字段名到页面ID的映射
     * @returns 字段名到解析后的字段定义列表的映射
     */
    private async fetchLinkedDocuments(
        linkedFields: Map<string, { pageId: string; linkText: string }>
    ): Promise<Map<string, { rawText: string; parsedFields: Array<{ name: string; required: boolean; type: string; description: string }> }>> {
        const documentContents = new Map<string, { rawText: string; parsedFields: Array<{ name: string; required: boolean; type: string; description: string }> }>();

        for (const [fieldName, { pageId, linkText }] of linkedFields) {
            if (this.abortController?.signal.aborted) break;

            try {
                console.log(`[AI Protocol] Fetching linked document for field "${fieldName}" (pageId=${pageId})...`);

                let htmlContent = '';

                // 优先使用 docIndexService（带 Cookie 认证）
                if (this.docIndexService) {
                    htmlContent = await this.docIndexService.fetchDocumentHtml(pageId);
                    if (htmlContent) {
                        console.log(`[AI Protocol] 通过 docIndexService 获取子文档 "${fieldName}" 成功，长度=${htmlContent.length}`);
                    }
                }

                // 回退到直接请求
                if (!htmlContent) {
                    const baseUrl = this.confluenceConfig.baseUrl.replace(/\/$/, '');
                    const contentUrl = `${baseUrl}/rest/api/content/${pageId}?expand=body.storage`;

                    const response = await this.confluenceFetch(contentUrl);

                    if (response.ok && response.data) {
                        htmlContent = response.data.body?.storage?.value || '';
                    }
                }

                if (htmlContent) {
                    // 从 HTML 解析字段定义
                    const parsedFields = this.parseTableFieldsFromHtml(htmlContent);
                    const rawText = this.htmlToMarkdown(htmlContent); // 使用 Markdown 保留结构

                    if (parsedFields.length > 0 || rawText) {
                        documentContents.set(fieldName, { rawText, parsedFields });
                        console.log(`[AI Protocol] ✓ 子文档 "${fieldName}" 解析成功: ${parsedFields.length} 个字段`);
                    }
                } else {
                    console.warn(`[AI Protocol] ✗ 子文档 "${fieldName}" 获取失败: 内容为空`);
                }

                // 避免请求过快
                await this.delay(200);
            } catch (error) {
                console.error(`[AI Protocol] Failed to fetch linked document for ${fieldName}:`, error);
            }
        }

        return documentContents;
    }


    /**
     * 从原始HTML中提取链接字段信息（保留HTML以便解析）
     */
    private async fetchDocumentHtml(docUrl: string): Promise<string> {
        try {
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
                console.warn('[AI Protocol] fetchDocumentHtml: 无法从 URL 解析 pageId:', docUrl);
                return '';
            }

            console.log(`[AI Protocol] fetchDocumentHtml: pageId=${pageId}`);

            // 优先使用 docIndexService（带 Cookie 认证）
            if (this.docIndexService) {
                const htmlContent = await this.docIndexService.fetchDocumentHtml(pageId);
                if (htmlContent) {
                    console.log(`[AI Protocol] fetchDocumentHtml: 通过 docIndexService 获取成功，长度=${htmlContent.length}`);
                    return htmlContent;
                }
            }

            // 回退到直接请求
            const baseUrl = this.confluenceConfig.baseUrl.replace(/\/$/, '');
            const contentUrl = `${baseUrl}/rest/api/content/${pageId}?expand=body.storage`;

            console.log(`[AI Protocol] fetchDocumentHtml: 尝试直接请求 ${contentUrl}`);
            const response = await this.confluenceFetch(contentUrl);

            if (response.ok && response.data) {
                const htmlContent = response.data.body?.storage?.value || '';
                console.log(`[AI Protocol] fetchDocumentHtml: 直接请求成功，长度=${htmlContent.length}`);
                return htmlContent;
            } else {
                console.warn(`[AI Protocol] fetchDocumentHtml: 请求失败，status=${response.status}`);
            }
        } catch (error) {
            console.error('[AI Protocol] Failed to fetch document HTML:', error);
        }

        return '';
    }

    /**
     * 使用 AI 分析文档内容
     * (Restored stable version)
     */
    /**
     * 使用 AI 分析文档内容
     * 改进策略：
     * 1. 识别链接字段
     * 2. 独立分析链接的子文档，获取其 Schema
     * 3. 分析主文档获取骨架
     * 4. 将子文档 Schema 拼接到主文档中
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

        // 1. 获取原始HTML以提取链接字段
        const subSchemas = new Map<string, any>();
        const linkedFields = new Map<string, { pageId: string; linkText: string }>();

        try {
            console.log(`[AI Protocol] ========== STEP 1: 获取主文档 HTML ==========`);
            const htmlContent = await this.fetchDocumentHtml(docInfo.url);
            console.log(`[AI Protocol] 主文档 HTML 长度: ${htmlContent.length} 字符`);

            // 提取链接字段
            console.log(`[AI Protocol] ========== STEP 2: 提取链接字段 ==========`);
            const extractResult = this.extractLinkedFieldsFromHtml(htmlContent);
            extractResult.linkedFields.forEach((v, k) => linkedFields.set(k, v));

            console.log(`[AI Protocol] 直接找到的链接字段数: ${extractResult.linkedFields.size}`);
            console.log(`[AI Protocol] 需要通过标题查询的字段数: ${extractResult.titleLinkedFields.size}`);

            // 对于通过标题链接的字段，尝试查询 pageId
            if (extractResult.titleLinkedFields.size > 0 && this.docIndexService) {
                console.log(`[AI Protocol] ========== STEP 2.5: 解析标题链接 ==========`);
                const index = await this.docIndexService.getIndex();
                console.log(`[AI Protocol] 文档索引包含 ${index.items.size} 个页面`);

                for (const [fieldName, { title, linkText }] of extractResult.titleLinkedFields) {
                    console.log(`[AI Protocol] 尝试解析: ${fieldName} -> title="${title}"`);
                    // 在索引中查找匹配的页面
                    let found = false;
                    for (const item of index.items.values()) {
                        if (item.title.toLowerCase() === title.toLowerCase() ||
                            item.title.toLowerCase().includes(title.toLowerCase())) {
                            linkedFields.set(fieldName, { pageId: item.pageId, linkText });
                            console.log(`[AI Protocol] ✓ 解析成功: "${title}" -> pageId=${item.pageId} (${item.title})`);
                            found = true;
                            break;
                        }
                    }
                    if (!found) {
                        console.warn(`[AI Protocol] ✗ 解析失败: 找不到标题匹配 "${title}"`);
                    }
                }
            }

            console.log(`[AI Protocol] ========== STEP 3: 获取子文档内容 ==========`);
            console.log(`[AI Protocol] 总共需要获取 ${linkedFields.size} 个子文档:`, Array.from(linkedFields.keys()));

            if (linkedFields.size > 0) {
                // 批量获取链接文档内容
                const linkedDocs = await this.fetchLinkedDocuments(linkedFields);
                console.log(`[AI Protocol] 成功获取 ${linkedDocs.size} 个子文档`);

                // 对每个子文档进行独立 AI 分析
                console.log(`[AI Protocol] ========== STEP 4: AI 分析子文档 ==========`);
                for (const [fieldName, docData] of linkedDocs) {
                    if (this.abortController?.signal.aborted) break;

                    console.log(`[AI Protocol] 分析子文档 "${fieldName}": rawText长度=${docData.rawText.length}, parsedFields数量=${docData.parsedFields.length}`);

                    if (docData.rawText) {
                        try {
                            const subSchema = await this.analyzeDataStructure(fieldName, docData.rawText);
                            if (subSchema) {
                                subSchemas.set(fieldName, subSchema);
                                console.log(`[AI Protocol] ✓ 子文档 "${fieldName}" 分析成功:`, JSON.stringify(subSchema).slice(0, 200) + '...');
                            } else {
                                console.warn(`[AI Protocol] ✗ 子文档 "${fieldName}" 分析返回空结果`);
                            }
                        } catch (err) {
                            console.warn(`[AI Protocol] ✗ 子文档 "${fieldName}" 分析失败:`, err);
                        }
                    }
                }
                console.log(`[AI Protocol] 成功分析 ${subSchemas.size} 个子文档Schema`);
            }
        } catch (error) {
            console.warn('[AI Protocol] 处理链接文档失败:', error);
        }

        console.log(`[AI Protocol] ========== SUMMARY: 子Schema ==========`);
        console.log(`[AI Protocol] subSchemas.size = ${subSchemas.size}`);
        for (const [key, schema] of subSchemas) {
            console.log(`[AI Protocol] - ${key}: ${JSON.stringify(schema).slice(0, 100)}...`);
        }

        // 2. 分析主文档
        // 改进策略：让 AI 完整分析主文档的所有字段，不再简化处理
        // 子文档 Schema 用于"增强"已有字段的定义
        const prompt = `你是一个 IoT 协议分析专家。请分析以下协议文档，提取协议的请求和响应结构。

协议名称: ${namespace}
文档标题: ${docInfo.title}

文档内容:
${content.slice(0, 15000)}

请遵循以下步骤进行分析：
1. **识别交互方式**：查看文档中的交互方式表，确定支持的方法（GET, SET, PUSH, DELETE, SYNC）。
2. **提取 Request Payload(JSON 示例)**：
   - 生成纯粹的 JSON 数据示例，用于发送请求。
3. **类型映射规则（非常重要）**：
   - 如果文档中字段类型描述为 "int", "integer", "long"，必须将 JSON Schema 的 type 设置为 "integer"。
   - 如果文档中字段类型描述为 "float", "double", "number"，必须将 JSON Schema 的 type 设置为 "number"。
   - 严禁将 "int" 类型映射为 "string"。

请以 JSON 格式输出分析结果，格式如下:
{
    "description": "协议功能描述",
    "methods": {
        "GET": {
            "enabled": true/false,
            "payload": { ... },  // Request Payload: JSON 数据示例
            "response": {        // Response Payload: JSON Schema
                "type": "object",
                "properties": { ... }
            },
            "description": "GET 方法描述"
        },
        "SET": { ... },
        "PUSH": { ... }
    },
    "confidence": 0.0-1.0
}

注意: 只输出 JSON，不要其他内容。确保 JSON 格式合法。`;

        try {
            const response = await this.callAI([
                { role: 'user', content: prompt }
            ], 120);

            // 解析 AI 响应
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                throw new Error('AI 响应格式错误');
            }

            const parsed = JSON.parse(jsonMatch[0]);

            console.log(`[AI Protocol] ========== STEP 5: 拼接子Schema ==========`);
            console.log(`[AI Protocol] AI 返回的主 Schema 包含方法:`, Object.keys(parsed.methods || {}));

            // 3. 拼接子文档 Schema（只在正确的嵌套位置替换）
            if (subSchemas.size > 0 && parsed.methods) {
                console.log(`[AI Protocol] 需要拼接 ${subSchemas.size} 个子Schema...`);

                for (const methodKey of Object.keys(parsed.methods)) {
                    const method = parsed.methods[methodKey];
                    console.log(`[AI Protocol] 处理方法 ${methodKey}...`);

                    // 递归拼接 Response Schema（只在正确位置替换，不添加顶层字段）
                    if (method.response) {
                        console.log(`[AI Protocol] ${methodKey}.response 存在, properties:`, Object.keys(method.response.properties || {}));
                        this.stitchSubSchemas(method.response, subSchemas);
                    } else {
                        console.warn(`[AI Protocol] ${methodKey}.response 不存在!`);
                    }

                    // 注意：不再给 payload 添加顶层字段，保持原有的 payload 结构
                    // 空 payload 应该保持为空
                }
            }

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
                warnings: linkedFields.size > 0 ? [`已自动解析并拼接 ${linkedFields.size} 个嵌套子文档`] : [],
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
     * 递归拼接子文档 Schema
     * 改进策略：子文档 Schema 用于"增强"已有字段的定义
     * - 如果主文档字段是空的 object/array，则用子文档 Schema 替换
     * - 如果主文档字段已有 properties，则合并两者（子文档优先）
     */
    private stitchSubSchemas(schema: any, subSchemas: Map<string, any>) {
        if (!schema || typeof schema !== 'object') return;

        // 处理 properties (Object)
        if (schema.properties) {
            for (const key in schema.properties) {
                const propSchema = schema.properties[key];

                // 查找匹配的 key (忽略大小写)
                let matchKey = subSchemas.has(key) ? key : null;
                if (!matchKey) {
                    for (const subKey of subSchemas.keys()) {
                        if (subKey.toLowerCase() === key.toLowerCase()) {
                            matchKey = subKey;
                            break;
                        }
                    }
                }

                if (matchKey) {
                    const subSchema = subSchemas.get(matchKey);

                    // Case 1: Main is Array -> 增强 items
                    if (propSchema.type === 'array') {
                        if (subSchema.type === 'object') {
                            // 子文档是 object，设置为数组的 items
                            if (!propSchema.items || !propSchema.items.properties || Object.keys(propSchema.items.properties || {}).length === 0) {
                                console.log(`[AI Protocol] Enhancing array items for field "${key}" with sub-schema (matched "${matchKey}")`);
                                propSchema.items = subSchema;
                            } else {
                                // 已有 items 定义，合并属性
                                console.log(`[AI Protocol] Merging array items properties for field "${key}" (matched "${matchKey}")`);
                                propSchema.items.properties = {
                                    ...propSchema.items.properties,
                                    ...subSchema.properties
                                };
                                if (subSchema.required) {
                                    propSchema.items.required = [...new Set([
                                        ...(propSchema.items.required || []),
                                        ...subSchema.required
                                    ])];
                                }
                            }
                        } else if (subSchema.type === 'array' && subSchema.items) {
                            // 子文档也是 array，取其 items
                            if (!propSchema.items || !propSchema.items.properties || Object.keys(propSchema.items.properties || {}).length === 0) {
                                console.log(`[AI Protocol] Enhancing array items for field "${key}" from sub-array (matched "${matchKey}")`);
                                propSchema.items = subSchema.items;
                            }
                        }
                    }
                    // Case 2: Main is Object -> 增强 properties
                    else if (propSchema.type === 'object' || !propSchema.type) {
                        const mainHasProperties = propSchema.properties && Object.keys(propSchema.properties).length > 0;
                        const subHasProperties = subSchema.properties && Object.keys(subSchema.properties).length > 0;

                        if (!mainHasProperties && subHasProperties) {
                            // 主文档是空对象，用子文档替换
                            console.log(`[AI Protocol] Replacing empty object field "${key}" with sub-schema (matched "${matchKey}")`);
                            schema.properties[key] = {
                                ...propSchema, // keep description etc
                                ...subSchema,  // overwrite type, properties, required
                                description: propSchema.description || subSchema.description
                            };
                        } else if (mainHasProperties && subHasProperties) {
                            // 两者都有属性，合并（子文档优先）
                            console.log(`[AI Protocol] Merging properties for object field "${key}" (matched "${matchKey}")`);
                            propSchema.properties = {
                                ...propSchema.properties,
                                ...subSchema.properties
                            };
                            if (subSchema.required) {
                                propSchema.required = [...new Set([
                                    ...(propSchema.required || []),
                                    ...subSchema.required
                                ])];
                            }
                        }
                        // 如果主文档有属性但子文档没有，保留主文档的定义
                    }
                } else {
                    // 递归检查子属性
                    this.stitchSubSchemas(propSchema, subSchemas);
                }
            }
        }

        // 处理 items (Array)
        if (schema.items) {
            this.stitchSubSchemas(schema.items, subSchemas);
        }
    }

    /**
     * 递归更新 Payload 示例数据
     */
    private stitchPayloadExample(payload: any, subSchemas: Map<string, any>) {
        if (!payload || typeof payload !== 'object') return;

        for (const key in payload) {
            // 查找匹配的 key (忽略大小写)
            let matchKey = subSchemas.has(key) ? key : null;
            if (!matchKey) {
                for (const subKey of subSchemas.keys()) {
                    if (subKey.toLowerCase() === key.toLowerCase()) {
                        matchKey = subKey;
                        break;
                    }
                }
            }

            if (matchKey) {
                const subSchema = subSchemas.get(matchKey);
                // Generate new example from schema
                const newExample = this.generateExampleFromSchema(subSchema);

                if (newExample !== null) {
                    console.log(`[AI Protocol] Updating payload example for nested field "${key}" (matched "${matchKey}")`);
                    if (Array.isArray(payload[key])) {
                        payload[key] = [newExample];
                    } else {
                        payload[key] = newExample;
                    }
                }
            } else {
                // 递归
                this.stitchPayloadExample(payload[key], subSchemas);
            }
        }
    }

    /**
     * 独立分析数据结构文档，提取 JSON Schema
     */
    private async analyzeDataStructure(name: string, content: string): Promise<any> {
        const prompt = `你是一个数据结构分析专家。请分析以下文档内容，它描述了一个名为 "${name}" 的数据结构。
请提取该数据结构的 JSON Schema 定义。

文档内容:
${content.slice(0, 8000)}

要求：
1. 输出标准的 JSON Schema 对象。
2. **重要：直接输出 ${name} 内部的属性定义，不要再套一层 "${name}" 作为外层容器！**
   例如，如果文档描述了 hardware 对象包含 type、subType、version 字段，
   正确输出: { "type": "object", "properties": { "type": {...}, "subType": {...}, "version": {...} } }
   错误输出: { "type": "object", "properties": { "hardware": { "properties": { "type": {...} } } } }
3. 详细定义 "properties" 中的每个字段。
4. 根据表格中的"必填"列设置 "required" 字段。
5. 字段描述放入 "description"。
6. **类型映射规则（非常重要）**：
   - 如果文档中字段类型描述为 "int", "integer", "long"，必须将 JSON Schema 的 type 设置为 "integer"。
   - 如果文档中字段类型描述为 "float", "double", "number"，必须将 JSON Schema 的 type 设置为 "number"。
   - 严禁将 "int" 类型映射为 "string"。
7. **只输出 JSON Schema，不要包含任何解释文字。**`;

        try {
            const response = await this.callAI([
                { role: 'user', content: prompt }
            ], 60);

            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                let schema = JSON.parse(jsonMatch[0]);

                // 后处理：如果 AI 返回了带 wrapper 的结构，解开它
                // 例如: { properties: { hardware: { properties: {...} } } } -> 取出内层
                if (schema.properties) {
                    const propKeys = Object.keys(schema.properties);
                    // 如果只有一个属性且名称与 name 匹配，说明是 wrapper
                    if (propKeys.length === 1) {
                        const wrapperKey = propKeys[0];
                        if (wrapperKey.toLowerCase() === name.toLowerCase()) {
                            const innerSchema = schema.properties[wrapperKey];
                            if (innerSchema && innerSchema.properties) {
                                console.log(`[AI Protocol] 解开子Schema的wrapper层: ${name}`);
                                // 保留外层的 description，合并到内层
                                if (schema.description && !innerSchema.description) {
                                    innerSchema.description = schema.description;
                                }
                                schema = innerSchema;
                            }
                        }
                    }
                }

                console.log(`[AI Protocol] - ${name} schema:`, JSON.stringify(schema).slice(0, 150) + '...');
                return schema;
            }
        } catch (e) {
            console.error(`Failed to analyze data structure for ${name}`, e);
        }
        return null;
    }

    /**
     * 根据 Schema 生成示例数据
     */
    private generateExampleFromSchema(schema: any): any {
        if (!schema) return null;

        if (schema.default !== undefined) return schema.default;
        if (schema.examples && schema.examples.length > 0) return schema.examples[0];

        if (schema.type === 'object' && schema.properties) {
            const obj: any = {};
            for (const key in schema.properties) {
                obj[key] = this.generateExampleFromSchema(schema.properties[key]);
            }
            return obj;
        }

        if (schema.type === 'array') {
            if (schema.items) {
                return [this.generateExampleFromSchema(schema.items)];
            }
            return [];
        }

        if (schema.type === 'string') return "example_string";
        if (schema.type === 'number' || schema.type === 'integer') return 0;
        if (schema.type === 'boolean') return false;

        return null;
    }

    /**
     * 创建默认协议对象
     */
    private createDefaultProtocol(namespace: string, warnings: string[] = []): AIGeneratedProtocol {
        return {
            namespace,
            description: '生成失败或未找到文档',
            methods: {},
            confidence: 0,
            warnings
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

                console.warn(`[AI] Attempt ${attempt + 1} failed: ${error.message} `);
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
                        const cookieString = result.cookies.map((c: any) => `${c.name}=${c.value} `).join('; ');
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
     * HTML 转 Markdown，保留表格结构
     * 这样 AI 可以更好地理解文档的层级关系
     */
    private htmlToMarkdown(html: string): string {
        let markdown = html;

        // 移除脚本和样式
        markdown = markdown
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

        // 处理标题
        markdown = markdown
            .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
            .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
            .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
            .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');

        // 处理表格 - 提取并格式化为 Markdown 表格
        const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
        markdown = markdown.replace(tableRegex, (_, tableContent) => {
            const rows: string[][] = [];
            const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
            let rowMatch;

            while ((rowMatch = rowRegex.exec(tableContent)) !== null) {
                const cells: string[] = [];
                const cellRegex = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
                let cellMatch;

                while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
                    // 提取单元格内容，保留链接信息
                    let cellContent = cellMatch[1]
                        .replace(/<br\s*\/?>/gi, ' ')
                        .replace(/<a[^>]+href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, '[$2]($1)')
                        .replace(/<ac:link[^>]*>[\s\S]*?<ri:page[^>]+ri:content-title="([^"]+)"[^>]*\/>[\s\S]*?<ac:link-body>([^<]*)<\/ac:link-body>[\s\S]*?<\/ac:link>/gi, '[$2](wiki:$1)')
                        .replace(/<[^>]+>/g, '')
                        .replace(/&nbsp;/g, ' ')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&amp;/g, '&')
                        .replace(/\s+/g, ' ')
                        .trim();
                    cells.push(cellContent);
                }

                if (cells.length > 0) {
                    rows.push(cells);
                }
            }

            // 构建 Markdown 表格
            if (rows.length === 0) return '';

            let mdTable = '\n';
            const maxCols = Math.max(...rows.map(r => r.length));

            // 表头
            if (rows.length > 0) {
                mdTable += '| ' + rows[0].map(c => c || ' ').join(' | ') + ' |\n';
                mdTable += '| ' + Array(maxCols).fill('---').join(' | ') + ' |\n';

                // 数据行
                for (let i = 1; i < rows.length; i++) {
                    const row = rows[i];
                    while (row.length < maxCols) row.push('');
                    mdTable += '| ' + row.join(' | ') + ' |\n';
                }
            }

            return mdTable + '\n';
        });

        // 处理段落和换行
        markdown = markdown
            .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');

        // 移除剩余 HTML 标签
        markdown = markdown
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)));

        // 清理多余空行
        markdown = markdown
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        return markdown;
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
