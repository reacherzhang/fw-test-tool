/**
 * Confluence 文档索引服务
 * 
 * 功能：
 * 1. 从父页面递归获取所有子页面
 * 2. 构建文档索引（标题 + pageId + 层级）
 * 3. AI 智能匹配 namespace 到最相关文档
 * 4. 提取文档内容生成 payload/schema
 */

// 文档索引项
export interface DocIndexItem {
    pageId: string;
    title: string;
    url: string;
    parentId?: string;
    depth: number;          // 层级深度
    children: string[];     // 子页面 ID 列表
}

// 文档索引缓存
export interface DocIndex {
    rootPageId: string;
    rootPageTitle: string;
    items: Map<string, DocIndexItem>;
    lastUpdated: number;
}

// 匹配结果
export interface DocMatchResult {
    namespace: string;
    matched: boolean;
    document?: {
        pageId: string;
        title: string;
        url: string;
        confidence: number;
        matchReason: string;
    };
    candidates?: Array<{
        pageId: string;
        title: string;
        score: number;
    }>;
}

// 配置
export interface DocIndexConfig {
    confluenceBaseUrl: string;
    rootPageIds: string[];      // 支持多个根页面
    maxDepth: number;           // 最大递归深度
    cacheExpiry: number;        // 缓存过期时间（毫秒）
}

// 默认配置
export const DEFAULT_DOC_INDEX_CONFIG: DocIndexConfig = {
    confluenceBaseUrl: 'https://jira.meross.cn/doc',
    rootPageIds: ['69701229'],  // 设备通用消息指令集-新版
    maxDepth: 5,
    cacheExpiry: 24 * 60 * 60 * 1000,  // 24小时
};

/**
 * Confluence 文档索引服务类
 */
export class ConfluenceDocIndexService {
    private config: DocIndexConfig;
    private index: DocIndex | null = null;
    private aiConfig: any;
    private abortController: AbortController | null = null;

    constructor(config: Partial<DocIndexConfig> = {}, aiConfig?: any) {
        this.config = { ...DEFAULT_DOC_INDEX_CONFIG, ...config };
        this.aiConfig = aiConfig;
    }

    /**
     * 取消当前操作
     */
    abort() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }

    /**
     * 构建或获取文档索引
     */
    async getIndex(forceRefresh: boolean = false): Promise<DocIndex> {
        // 检查缓存（如果缓存为空或过期，需要重新构建）
        if (!forceRefresh && this.index && this.index.items.size > 0) {
            const age = Date.now() - this.index.lastUpdated;
            if (age < this.config.cacheExpiry) {
                console.log(`[DocIndex] Using cached index (${this.index.items.size} items)`);
                return this.index;
            }
        }

        // 清除空的或过期的缓存
        if (this.index && this.index.items.size === 0) {
            console.log('[DocIndex] Clearing empty cached index...');
            localStorage.removeItem('confluence_doc_index');
            this.index = null;
        }

        // 重新构建索引
        console.log('[DocIndex] Building document index...');
        this.abortController = new AbortController();
        const items = new Map<string, DocIndexItem>();

        try {
            for (const rootPageId of this.config.rootPageIds) {
                await this.fetchPageTree(rootPageId, items, 0);
            }
        } catch (error: any) {
            // 如果是认证错误，向上抛出让调用方处理
            if (error.code === 'CONFLUENCE_AUTH_ERROR') {
                console.error('[DocIndex] Authentication error:', error.message);
                throw error;
            }
            // 其他错误只记录日志
            console.error('[DocIndex] Error building index:', error);
        }

        this.index = {
            rootPageId: this.config.rootPageIds[0],
            rootPageTitle: items.get(this.config.rootPageIds[0])?.title || 'Root',
            items,
            lastUpdated: Date.now(),
        };

        console.log(`[DocIndex] Index built with ${items.size} items`);

        // 保存到 localStorage
        this.saveIndexToCache();

        return this.index;
    }

    /**
     * 递归获取页面树
     */
    private async fetchPageTree(
        pageId: string,
        items: Map<string, DocIndexItem>,
        depth: number,
        parentId?: string
    ): Promise<void> {
        if (this.abortController?.signal.aborted) return;

        if (depth > this.config.maxDepth) {
            return;
        }

        try {
            // 获取页面及其子页面信息
            const baseUrl = this.config.confluenceBaseUrl.replace(/\/$/, '');
            const apiUrl = `${baseUrl}/rest/api/content/${pageId}?expand=children.page`;

            const response = await this.confluenceFetch(apiUrl);

            // 检测认证失败
            if (response.status === 401) {
                const errorMessage = response.data?.message || 'Confluence 认证失败，请先在浏览器中登录';
                const error = new Error(errorMessage);
                (error as any).code = 'CONFLUENCE_AUTH_ERROR';
                (error as any).details = response.data;
                throw error;
            }

            if (!response.ok || !response.data) {
                console.warn(`[DocIndex] Failed to fetch page ${pageId}`);
                return;
            }

            const page = response.data;

            // 添加到索引
            const item: DocIndexItem = {
                pageId: page.id,
                title: page.title,
                url: `${baseUrl}/pages/viewpage.action?pageId=${page.id}`,
                parentId,
                depth,
                children: [],
            };

            items.set(page.id, item);

            // 递归处理子页面
            const children = page.children?.page?.results || [];

            for (const child of children) {
                if (this.abortController?.signal.aborted) return;

                item.children.push(child.id);
                await this.fetchPageTree(child.id, items, depth + 1, page.id);

                // 避免请求过快
                await this.delay(100);
            }

        } catch (error: any) {
            // 如果是认证错误，直接向上抛出
            if (error.code === 'CONFLUENCE_AUTH_ERROR') {
                throw error;
            }
            console.error(`[DocIndex] Error fetching page ${pageId}:`, error);
        }
    }

    /**
     * 根据 namespace 匹配最佳文档
     */
    async matchDocument(namespace: string): Promise<DocMatchResult> {
        const index = await this.getIndex();

        // 1. 先尝试精确匹配
        const exactMatch = this.findExactMatch(namespace, index);
        if (exactMatch) {
            return {
                namespace,
                matched: true,
                document: {
                    ...exactMatch,
                    confidence: 1.0,
                    matchReason: '标题精确匹配',
                },
            };
        }

        // 2. 模糊匹配 - 计算相似度得分
        const candidates = this.findFuzzyMatches(namespace, index);

        if (candidates.length === 0) {
            return {
                namespace,
                matched: false,
                candidates: [],
            };
        }

        // 3. 如果有多个候选，使用 AI 选择最佳
        if (candidates.length > 1 && this.aiConfig?.apiKey) {
            const aiResult = await this.aiSelectBestMatch(namespace, candidates);
            if (aiResult) {
                return {
                    namespace,
                    matched: true,
                    document: aiResult,
                    candidates,
                };
            }
        }

        // 返回得分最高的
        const best = candidates[0];
        return {
            namespace,
            matched: best.score > 0.3,
            document: best.score > 0.3 ? {
                pageId: best.pageId,
                title: best.title,
                url: `${this.config.confluenceBaseUrl}/pages/viewpage.action?pageId=${best.pageId}`,
                confidence: best.score,
                matchReason: '标题相似度匹配',
            } : undefined,
            candidates,
        };
    }

    /**
     * 批量匹配多个 namespace
     */
    async matchDocuments(
        namespaces: string[],
        onProgress?: (current: number, total: number, namespace: string, result: DocMatchResult) => void
    ): Promise<Map<string, DocMatchResult>> {
        const results = new Map<string, DocMatchResult>();

        // 先构建索引
        console.log('[DocIndex] Building index for batch matching...');
        await this.getIndex();

        for (let i = 0; i < namespaces.length; i++) {
            const namespace = namespaces[i];
            const result = await this.matchDocument(namespace);
            results.set(namespace, result);

            if (onProgress) {
                onProgress(i + 1, namespaces.length, namespace, result);
            }

            // 避免请求过快
            await this.delay(50);
        }

        return results;
    }

    /**
     * 精确匹配
     */
    private findExactMatch(namespace: string, index: DocIndex): { pageId: string; title: string; url: string } | null {
        // 转义正则特殊字符
        const escapedNamespace = namespace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // 使用单词边界 \b 确保精确匹配，避免 Wifi 匹配到 WifiX
        // 忽略大小写
        const regex = new RegExp(`\\b${escapedNamespace}\\b`, 'i');

        for (const item of index.items.values()) {
            const title = item.title;
            const normalizedTitle = title.toLowerCase();

            // 过滤掉包含 "废弃" 的文档
            if (normalizedTitle.includes('废弃') || normalizedTitle.includes('deprecated')) {
                continue;
            }

            // 正则精确匹配
            if (regex.test(title)) {
                return { pageId: item.pageId, title: item.title, url: item.url };
            }
        }

        return null;
    }

    /**
     * 模糊匹配
     */
    private findFuzzyMatches(
        namespace: string,
        index: DocIndex
    ): Array<{ pageId: string; title: string; score: number }> {
        const candidates: Array<{ pageId: string; title: string; score: number }> = [];

        // 提取 namespace 关键词
        const parts = namespace.split('.');
        const keywords = parts.map(p => p.toLowerCase());
        const lastPart = parts[parts.length - 1]?.toLowerCase() || '';

        // 预编译正则 (带边界)
        const escaped = namespace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const fullMatchRegex = new RegExp(`\\b${escaped}\\b`, 'i');

        // 预编译关键词正则
        const keywordRegexes = keywords.map(k => {
            const kEscaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`\\b${kEscaped}\\b`, 'i');
        });

        const lastPartEscaped = lastPart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const lastPartRegex = new RegExp(`\\b${lastPartEscaped}\\b`, 'i');

        for (const item of index.items.values()) {
            const title = item.title.toLowerCase();

            // 过滤掉包含 "废弃" 的文档
            if (title.includes('废弃') || title.includes('deprecated')) {
                continue;
            }

            let score = 0;

            // 1. 关键词匹配 (带边界)
            for (const regex of keywordRegexes) {
                if (regex.test(title)) {
                    score += 0.2;
                }
            }

            // 2. 最后一个部分权重更高 (带边界)
            if (lastPartRegex.test(title)) {
                score += 0.3;
            }

            // 3. 完整 namespace 匹配 (带边界检查)
            if (fullMatchRegex.test(item.title)) {
                score += 0.5;
            }

            // 6. 惩罚机制：如果标题包含 "Namespace + 后缀"（如搜 Wifi 遇到 WifiX），大幅扣分
            // 这通常意味着匹配到了相似但不同的协议
            const superstringRegex = new RegExp(`\\b${escaped}[a-zA-Z0-9_]+\\b`, 'i');
            if (superstringRegex.test(item.title)) {
                score -= 0.5; // 强力惩罚
            }

            // 4. 标题长度惩罚（太长的标题可能不是具体协议文档）
            if (item.title.length > 50) {
                score *= 0.8;
            }

            // 5. 深度奖励（更深的页面通常是具体协议）
            if (item.depth >= 3) {
                score *= 1.2;
            }

            if (score > 0.1) {
                candidates.push({
                    pageId: item.pageId,
                    title: item.title,
                    score: Math.min(score, 1.0),
                });
            }
        }

        // 按得分排序
        candidates.sort((a, b) => b.score - a.score);

        return candidates.slice(0, 10);
    }

    /**
     * AI 选择最佳匹配
     */
    private async aiSelectBestMatch(
        namespace: string,
        candidates: Array<{ pageId: string; title: string; score: number }>
    ): Promise<{ pageId: string; title: string; url: string; confidence: number; matchReason: string } | null> {
        if (!this.aiConfig?.apiKey) {
            return null;
        }

        const prompt = `你是一个协议文档匹配专家。请从候选文档中找出与目标协议 "${namespace}" **精确对应** 的文档。

规则：
1. **严格匹配**：文档标题必须代表 "${namespace}" 本身。
2. **拒绝变体**：如果文档是目标协议的变体（例如目标是 "Wifi"，候选是 "WifiX"、"WifiList"），**绝对不要选择**。
3. **拒绝父级**：如果文档是目标协议的父级目录（例如目标是 "Config.Wifi"，候选是 "Config"），不要选择。

候选文档:
${candidates.map((c, i) => `${i + 1}. "${c.title}"`).join('\n')}

请只回复最相关文档的编号（1-${candidates.length}）。
如果没有**完全符合**的文档，必须回复 "0"。`;

        try {
            const response = await this.callAI(prompt);
            const index = parseInt(response.trim()) - 1;

            if (index >= 0 && index < candidates.length) {
                const selected = candidates[index];
                return {
                    pageId: selected.pageId,
                    title: selected.title,
                    url: `${this.config.confluenceBaseUrl}/pages/viewpage.action?pageId=${selected.pageId}`,
                    confidence: Math.max(selected.score, 0.7),
                    matchReason: 'AI 智能匹配',
                };
            }
        } catch (error) {
            console.error('[DocIndex] AI selection failed:', error);
        }

        return null;
    }

    /**
     * 获取文档内容
     */
    async fetchDocumentContent(pageId: string): Promise<string> {
        try {
            const baseUrl = this.config.confluenceBaseUrl.replace(/\/$/, '');
            const apiUrl = `${baseUrl}/rest/api/content/${pageId}?expand=body.storage`;

            const response = await this.confluenceFetch(apiUrl);

            if (!response.ok || !response.data) {
                throw new Error('获取页面内容失败');
            }

            const htmlContent = response.data.body?.storage?.value || '';
            return this.htmlToText(htmlContent);
        } catch (error) {
            console.error(`[DocIndex] Failed to fetch content for ${pageId}:`, error);
            return '';
        }
    }

    /**
     * 获取文档原始 HTML 内容
     */
    async fetchDocumentHtml(pageId: string): Promise<string> {
        try {
            const baseUrl = this.config.confluenceBaseUrl.replace(/\/$/, '');
            const apiUrl = `${baseUrl}/rest/api/content/${pageId}?expand=body.storage`;

            const response = await this.confluenceFetch(apiUrl);

            if (!response.ok || !response.data) {
                throw new Error('获取页面内容失败');
            }

            return response.data.body?.storage?.value || '';
        } catch (error) {
            console.error(`[DocIndex] Failed to fetch HTML for ${pageId}:`, error);
            return '';
        }
    }

    /**
     * 获取索引统计信息
     */
    getStats(): { totalPages: number; lastUpdated: Date | null; cacheStatus: string } {
        if (!this.index) {
            return { totalPages: 0, lastUpdated: null, cacheStatus: 'empty' };
        }

        const age = Date.now() - this.index.lastUpdated;
        const cacheStatus = age < this.config.cacheExpiry ? 'valid' : 'expired';

        return {
            totalPages: this.index.items.size,
            lastUpdated: new Date(this.index.lastUpdated),
            cacheStatus,
        };
    }

    /**
     * 保存索引到 localStorage
     */
    private saveIndexToCache(): void {
        if (!this.index) return;

        try {
            const serialized = {
                ...this.index,
                items: Array.from(this.index.items.entries()),
            };
            localStorage.setItem('confluence_doc_index', JSON.stringify(serialized));
        } catch (error) {
            console.warn('[DocIndex] Failed to save index to cache:', error);
        }
    }

    /**
     * 从 localStorage 加载索引
     */
    loadIndexFromCache(): boolean {
        try {
            const saved = localStorage.getItem('confluence_doc_index');
            if (saved) {
                const parsed = JSON.parse(saved);
                const age = Date.now() - parsed.lastUpdated;

                if (age < this.config.cacheExpiry) {
                    const items = new Map(parsed.items);
                    // 不加载空索引
                    if (items.size === 0) {
                        console.log('[DocIndex] Cached index is empty, will rebuild');
                        localStorage.removeItem('confluence_doc_index');
                        return false;
                    }
                    this.index = {
                        ...parsed,
                        items,
                    };
                    console.log(`[DocIndex] Loaded index from cache (${this.index!.items.size} items)`);
                    return true;
                }
            }
        } catch (error) {
            console.warn('[DocIndex] Failed to load index from cache:', error);
        }
        return false;
    }

    /**
     * Confluence API 请求 (带重试和超时)
     */
    private async confluenceFetch(url: string, retries = 2): Promise<{ ok: boolean; status: number; data: any }> {
        // 1. 检查取消
        if (this.abortController?.signal.aborted) {
            console.log('[DocIndex] Request aborted before start');
            return { ok: false, status: 0, data: null };
        }

        const headers: Record<string, string> = {
            'Accept': 'application/json',
            'X-Atlassian-Token': 'no-check',
        };

        console.log(`[DocIndex] Fetching: ${url} (retries left: ${retries})`);

        // 2. 创建 Abort Promise
        const abortPromise = new Promise<any>((_, reject) => {
            const signal = this.abortController?.signal;
            if (signal?.aborted) {
                reject(new Error('Aborted'));
            } else {
                signal?.addEventListener('abort', () => reject(new Error('Aborted')));
            }
        });

        // 优先使用 Electron 原生请求（绕过 CORS）
        if ((window as any).electronAPI?.nativeRequest) {
            try {
                // 获取 Cookie
                if ((window as any).electronAPI?.confluenceGetCookies) {
                    const result = await (window as any).electronAPI.confluenceGetCookies({ baseUrl: this.config.confluenceBaseUrl });
                    if (result?.success && Array.isArray(result.cookies) && result.cookies.length > 0) {
                        headers['Cookie'] = result.cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
                    }
                }

                const requestPromise = (window as any).electronAPI.nativeRequest({
                    url,
                    method: 'GET',
                    headers,
                    followRedirects: true,
                    maxRedirects: 5,
                    timeout: 5000, // 5秒超时
                });

                // 使用 Promise.race 实现可中断等待
                const result = await Promise.race([requestPromise, abortPromise]);

                // 检查是否被重定向到 LDAP 登录页面
                const finalUrl = result.finalUrl || result.url || url;
                const isLdapRedirect = finalUrl.includes('ldap.meross.cn') ||
                    (typeof result.text === 'string' && result.text.includes('ldap.meross.cn'));

                if (isLdapRedirect) {
                    console.warn('[DocIndex] Detected LDAP redirect - authentication required');
                    return {
                        ok: false,
                        status: 401,
                        data: {
                            error: 'LDAP_AUTH_REQUIRED',
                            message: 'Confluence 访问失败：被重定向到 LDAP 登录页面，请先在浏览器中登录 Confluence'
                        }
                    };
                }

                // 检查是否被重定向到其他登录页面
                if (typeof result.text === 'string' && result.text.includes('<!DOCTYPE')) {
                    console.warn('[DocIndex] Received HTML response (likely auth redirect)');
                    return {
                        ok: false,
                        status: 401,
                        data: {
                            error: 'AUTH_REQUIRED',
                            message: 'Confluence 访问失败：认证已过期，请先在浏览器中重新登录 Confluence'
                        }
                    };
                }

                console.log(`[DocIndex] Response status: ${result.status}`);

                return {
                    ok: result.status >= 200 && result.status < 300,
                    status: result.status,
                    data: result.data,
                };
            } catch (error: any) {
                if (error.message === 'Aborted') {
                    console.log('[DocIndex] Request aborted by user');
                    return { ok: false, status: 0, data: null };
                }

                console.error(`[DocIndex] Native request error: ${error.message}`);

                // 如果是超时或网络错误，且还有重试次数，则重试
                if (retries > 0 && (error.message?.includes('timeout') || error.message?.includes('socket'))) {
                    // 检查是否已取消
                    if (this.abortController?.signal.aborted) return { ok: false, status: 0, data: null };

                    console.log(`[DocIndex] Retrying... (${retries} attempts left)`);
                    await this.delay(1000); // 等待1秒后重试
                    return this.confluenceFetch(url, retries - 1);
                }
            }
        }

        // 回退到浏览器 fetch
        try {
            console.log('[DocIndex] Falling back to browser fetch...');

            // 使用 AbortController
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            // 合并取消信号
            const onAbort = () => controller.abort();
            this.abortController?.signal.addEventListener('abort', onAbort);

            try {
                const response = await fetch(url, {
                    method: 'GET',
                    headers,
                    credentials: 'include',
                    signal: controller.signal,
                });

                clearTimeout(timeoutId);
                this.abortController?.signal.removeEventListener('abort', onAbort);

                const contentType = response.headers.get('content-type');
                if (contentType && !contentType.includes('application/json')) {
                    console.warn('[DocIndex] Received non-JSON response');
                    return { ok: false, status: 401, data: null };
                }

                const data = await response.json();
                return { ok: response.ok, status: response.status, data };
            } catch (error) {
                clearTimeout(timeoutId);
                this.abortController?.signal.removeEventListener('abort', onAbort);
                throw error;
            }
        } catch (error: any) {
            if (error.name === 'AbortError') {
                if (this.abortController?.signal.aborted) {
                    console.log('[DocIndex] Fetch aborted by user');
                } else {
                    console.log('[DocIndex] Fetch timeout');
                }
                return { ok: false, status: 0, data: null };
            }
            console.error('[DocIndex] Fetch error:', error);
        }

        return { ok: false, status: 0, data: null };
    }

    /**
     * 调用 AI API
     */
    private async callAI(prompt: string): Promise<string> {
        if (!this.aiConfig?.apiKey) {
            throw new Error('AI API key not configured');
        }

        const url = `${this.aiConfig.apiEndpoint || 'https://api.openai.com/v1'}/chat/completions`;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.aiConfig.apiKey}`,
            },
            body: JSON.stringify({
                model: this.aiConfig.model || 'gpt-4-turbo',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 100,
            }),
        });

        if (!response.ok) {
            throw new Error(`AI API error: ${response.status}`);
        }

        const data = await response.json();
        return data.choices?.[0]?.message?.content || '';
    }

    /**
     * HTML 转纯文本
     */
    private htmlToText(html: string): string {
        return html
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
    }

    /**
     * 延迟函数 (可被 abort 信号中断)
     */
    private delay(ms: number): Promise<void> {
        return new Promise((resolve, reject) => {
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

// 单例实例
let indexServiceInstance: ConfluenceDocIndexService | null = null;

/**
 * 获取索引服务实例
 */
export function getDocIndexService(config?: Partial<DocIndexConfig>, aiConfig?: any): ConfluenceDocIndexService {
    if (!indexServiceInstance) {
        indexServiceInstance = new ConfluenceDocIndexService(config, aiConfig);
        // 尝试从缓存加载
        indexServiceInstance.loadIndexFromCache();
    }
    return indexServiceInstance;
}

/**
 * 重置索引服务（用于更换配置）
 */
export function resetDocIndexService(): void {
    indexServiceInstance = null;
    localStorage.removeItem('confluence_doc_index');
}
