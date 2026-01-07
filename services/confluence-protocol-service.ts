/**
 * Confluence 协议文档服务
 * 用于从 Confluence Wiki 自动获取和解析协议文档
 */

// Confluence 配置
export interface ConfluenceConfig {
    baseUrl: string;           // 例如: https://jira.meross.cn/doc
    spaceKey?: string;         // 可选: 例如 DEV, PROTOCOL 等，留空则全局搜索
    accessToken: string;       // Personal Access Token
    email?: string;            // 用于 Basic Auth (Cloud 版本需要)
    username?: string;         // 用于 LDAP 场景: username:token 的 Basic Auth
}

// 解析后的协议文档
export interface ParsedProtocolDoc {
    namespace: string;
    description: string;
    supportedMethods: {
        SET: boolean;
        GET: boolean;
        PUSH: boolean;
        DELETE: boolean;
        SYNC: boolean;
    };
    methods: {
        [key: string]: {
            requestExample?: any;
            responseExample?: any;
            fieldDescriptions?: Array<{
                name: string;
                required: boolean;
                type: string;
                description: string;
            }>;
        };
    };
    rawContent?: string;
    pageUrl?: string;
    parseWarnings: string[];
}

// Confluence 页面搜索结果
export interface ConfluenceSearchResult {
    id: string;
    title: string;
    type: string;
    _links: {
        webui: string;
    };
}

// Confluence API 响应
export interface ConfluencePageContent {
    id: string;
    title: string;
    body: {
        storage: {
            value: string;
        };
        view?: {
            value: string;
        };
    };
    _links: {
        webui: string;
        base: string;
    };
}

/**
 * HTTP 请求函数类型
 * 支持 Electron 原生请求或浏览器 fetch
 */
export type HttpFetcher = (url: string, options: {
    method: string;
    headers: Record<string, string>;
    body?: string;
}) => Promise<{ ok: boolean; status: number; data: any; text?: string }>;

/**
 * Confluence 协议文档服务类
 */
export class ConfluenceProtocolService {
    private config: ConfluenceConfig;
    private fetcher: HttpFetcher;
    private cookies: any[] = []; // 存储 SSO 登录后的 cookies

    constructor(config: ConfluenceConfig, fetcher?: HttpFetcher) {
        // 规范化 baseUrl: 移除末尾斜杠，避免双斜杠问题
        this.config = {
            ...config,
            baseUrl: config.baseUrl.replace(/\/+$/, '')
        };
        // 使用提供的 fetcher，或回退到浏览器 fetch
        this.fetcher = fetcher || this.defaultFetcher.bind(this);
    }

    /**
     * 设置认证 Cookies (用于 SSO 场景)
     */
    public setCookies(cookies: any[]) {
        this.cookies = cookies;
    }

    /**
     * 默认 fetcher (使用浏览器 fetch 或 Electron Native)
     */
    private async defaultFetcher(url: string, options: { method: string, headers?: Record<string, string>, body?: any }): Promise<{ ok: boolean; status: number; data: any; text?: string }> {
        try {
            // 优先使用带 Cookie 的原生请求 (如果已登录 SSO)
            if (this.cookies.length > 0 && window.electronAPI?.nativeRequestWithCookies) {
                // 复制 headers 并移除 Authorization，因为我们使用 Cookie 认证
                const headers = { ...options.headers };
                delete headers['Authorization'];

                const result = await window.electronAPI.nativeRequestWithCookies({
                    url,
                    method: options.method,
                    headers: headers, // 使用移除 Auth 的 headers
                    body: options.body,
                    cookies: this.cookies
                });

                const isOk = result.status >= 200 && result.status < 300;
                return {
                    ok: isOk,
                    status: result.status,
                    data: result.data,
                    text: result.text
                };
            }

            // 其次尝试普通原生请求
            if (window.electronAPI?.nativeRequest) {
                const result = await window.electronAPI.nativeRequest({
                    url,
                    method: options.method,
                    headers: options.headers,
                    body: options.body,
                    followRedirects: true
                });
                const isOk = result.status >= 200 && result.status < 300;
                return {
                    ok: isOk,
                    status: result.status,
                    data: result.data,
                    text: result.text
                };
            }

            // 最后回退到浏览器 fetch
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
        } catch (error: any) {
            throw new Error(`网络请求失败: ${error.message}`);
        }
    }

    /**
     * 获取认证 header
     * 支持三种模式:
     * 1. Cloud: email + token => Basic Auth (email:token)
     * 2. LDAP/SSO: username + token => Basic Auth (username:token)
     * 3. Server: token only => Bearer Token
     */
    private getAuthHeaders(): Record<string, string> {
        if (this.config.email) {
            // Confluence Cloud 版本: email:token
            const credentials = btoa(`${this.config.email}:${this.config.accessToken}`);
            return {
                'Authorization': `Basic ${credentials}`,
                'Content-Type': 'application/json',
            };
        } else if (this.config.username) {
            // LDAP/SSO 场景: username:token (用 username 作为账号，PAT 作为密码)
            const credentials = btoa(`${this.config.username}:${this.config.accessToken}`);
            return {
                'Authorization': `Basic ${credentials}`,
                'Content-Type': 'application/json',
            };
        } else {
            // 标准 Server/Data Center 版本: Bearer token
            return {
                'Authorization': `Bearer ${this.config.accessToken}`,
                'Content-Type': 'application/json',
            };
        }
    }

    /**
     * 搜索协议文档页面
     * 支持两种模式：
     * 1. 有 spaceKey: 在指定 Space 中搜索
     * 2. 无 spaceKey: 全局搜索
     */
    async searchProtocolPage(namespace: string): Promise<ConfluenceSearchResult | null> {
        // 对 namespace 进行 CQL 转义（处理特殊字符如点号）
        const escapedNamespace = namespace.replace(/\./g, '\\\\.');

        // 构建 CQL 查询
        let cql: string;
        if (this.config.spaceKey && this.config.spaceKey.trim()) {
            // 在指定 Space 中搜索
            cql = `space = "${this.config.spaceKey}" AND (title ~ "${escapedNamespace}" OR text ~ "${escapedNamespace}")`;
        } else {
            // 全局搜索（不限制 Space）
            cql = `type = page AND (title ~ "${escapedNamespace}" OR text ~ "${escapedNamespace}")`;
        }

        const url = `${this.config.baseUrl}/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=10`;

        try {
            const response = await this.fetcher(url, {
                method: 'GET',
                headers: this.getAuthHeaders(),
            });

            if (!response.ok) {
                console.error(`Search failed for ${namespace}: ${response.status}`);
                return null;
            }

            const data = response.data;
            if (data && data.results && data.results.length > 0) {
                // 优先匹配策略：
                // 1. 标题完全等于 namespace
                // 2. 标题包含 namespace
                // 3. 第一个搜索结果
                const exactMatch = data.results.find((r: any) => r.title === namespace);
                if (exactMatch) return exactMatch;

                const containsMatch = data.results.find((r: any) =>
                    r.title.includes(namespace)
                );
                return containsMatch || data.results[0];
            }
            return null;
        } catch (error) {
            console.error(`Search error for ${namespace}:`, error);
            return null;
        }
    }

    /**
     * 获取页面内容
     */
    async getPageContent(pageId: string): Promise<ConfluencePageContent | null> {
        const url = `${this.config.baseUrl}/rest/api/content/${pageId}?expand=body.storage,body.view`;

        try {
            const response = await this.fetcher(url, {
                method: 'GET',
                headers: this.getAuthHeaders(),
            });

            if (!response.ok) {
                console.error(`Get page failed: ${response.status}`);
                return null;
            }

            return response.data;
        } catch (error) {
            console.error(`Get page error:`, error);
            return null;
        }
    }

    /**
     * 解析协议文档
     */
    parseProtocolDocument(
        namespace: string,
        htmlContent: string,
        pageUrl: string = ''
    ): ParsedProtocolDoc {
        const warnings: string[] = [];
        const doc: ParsedProtocolDoc = {
            namespace,
            description: '',
            supportedMethods: {
                SET: false,
                GET: false,
                PUSH: false,
                DELETE: false,
                SYNC: false,
            },
            methods: {},
            rawContent: htmlContent,
            pageUrl,
            parseWarnings: warnings,
        };

        // 创建临时 DOM 解析 HTML
        const parser = new DOMParser();
        const htmlDoc = parser.parseFromString(htmlContent, 'text/html');

        // 1. 提取功能说明 (通常在 "功能说明" 标题后面)
        const descriptionSection = this.extractSectionContent(htmlDoc, '功能说明');
        if (descriptionSection) {
            doc.description = descriptionSection.trim();
        } else {
            warnings.push('未找到功能说明');
        }

        // 2. 解析交互方式表格
        const tables = htmlDoc.querySelectorAll('table');
        let methodTableFound = false;

        tables.forEach(table => {
            const headerRow = table.querySelector('tr');
            if (!headerRow) return;

            const headers = Array.from(headerRow.querySelectorAll('th, td')).map(
                cell => cell.textContent?.trim().toUpperCase() || ''
            );

            // 检查是否是交互方式表格 (包含 SET, GET, PUSH 等列)
            if (headers.includes('SET') || headers.includes('GET') || headers.includes('PUSH')) {
                methodTableFound = true;
                const rows = table.querySelectorAll('tr');

                rows.forEach((row, rowIndex) => {
                    if (rowIndex === 0) return; // 跳过表头
                    const cells = row.querySelectorAll('td');
                    const rowName = cells[0]?.textContent?.trim().toLowerCase() || '';

                    // 检查 app 行或 cloud 行
                    if (rowName === 'app' || rowName === 'cloud' || rowName === 'fmware') {
                        headers.forEach((header, colIndex) => {
                            if (colIndex === 0) return;
                            const cellValue = cells[colIndex]?.textContent?.trim() || '';
                            const isSupported = cellValue.includes('√') || cellValue.includes('✓') || cellValue === 'Y';

                            // 只处理请求 method (不处理 ACK 列)
                            if (['SET', 'GET', 'PUSH', 'DELETE', 'SYNC'].includes(header)) {
                                if (isSupported) {
                                    (doc.supportedMethods as any)[header] = true;
                                }
                            }
                        });
                    }
                });
            }
        });

        if (!methodTableFound) {
            warnings.push('未找到交互方式表格，将尝试从示例推断支持的 methods');
        }

        // 3. 提取各 method 的示例
        const methodNames = ['GET', 'SET', 'PUSH', 'DELETE', 'SYNC', 'GETACK', 'SETACK', 'PUSHACK'];

        methodNames.forEach(methodName => {
            // 查找该 method 的示例代码块
            const examples = this.extractMethodExamples(htmlDoc, methodName);

            if (examples.length > 0) {
                // 基础 method 名 (去掉 ACK)
                const baseMethod = methodName.replace('ACK', '');

                if (!doc.methods[baseMethod]) {
                    doc.methods[baseMethod] = {};
                }

                examples.forEach(example => {
                    try {
                        // 清理常见的 HTML/文档特殊字符
                        let cleanedExample = example
                            .replace(/&nbsp;/g, ' ')        // HTML non-breaking space
                            .replace(/&quot;/g, '"')        // HTML quote
                            .replace(/&amp;/g, '&')         // HTML ampersand
                            .replace(/&lt;/g, '<')          // HTML less than
                            .replace(/&gt;/g, '>')          // HTML greater than
                            .replace(/[\u00A0]/g, ' ')      // Unicode non-breaking space
                            .replace(/[\u200B-\u200D\uFEFF]/g, '') // Zero-width chars
                            .replace(/\r\n/g, '\n')         // Normalize line endings
                            .replace(/\r/g, '\n')
                            .trim();

                        // 尝试提取有效的 JSON 部分 (处理代码块中可能有注释的情况)
                        const jsonMatch = cleanedExample.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            cleanedExample = jsonMatch[0];
                        }

                        const parsed = JSON.parse(cleanedExample);
                        const method = parsed.header?.method;

                        if (method?.endsWith('ACK')) {
                            // 这是响应示例
                            doc.methods[baseMethod].responseExample = parsed;
                        } else {
                            // 这是请求示例
                            doc.methods[baseMethod].requestExample = parsed;
                        }

                        // 如果在表格中没找到，但找到了示例，标记为支持
                        if (!methodTableFound && ['GET', 'SET', 'PUSH', 'DELETE', 'SYNC'].includes(baseMethod)) {
                            (doc.supportedMethods as any)[baseMethod] = true;
                        }
                    } catch (e: any) {
                        // 只记录无法解析的情况，且去重
                        const warningMsg = `解析 ${methodName} 示例 JSON 失败: ${e.message?.substring(0, 50) || '未知错误'}`;
                        if (!warnings.includes(warningMsg)) {
                            warnings.push(warningMsg);
                        }
                    }
                });
            }
        });

        // 4. 检查是否有任何 method 被支持
        const hasSupportedMethod = Object.values(doc.supportedMethods).some(v => v);
        if (!hasSupportedMethod) {
            // 默认假设支持 GET
            doc.supportedMethods.GET = true;
            warnings.push('未检测到支持的 methods，默认设置为 GET');
        }

        return doc;
    }

    /**
     * 提取指定标题后的内容
     */
    private extractSectionContent(doc: Document, sectionTitle: string): string | null {
        const headings = doc.querySelectorAll('h1, h2, h3, h4, h5, h6');

        for (let i = 0; i < headings.length; i++) {
            if (headings[i].textContent?.includes(sectionTitle)) {
                // 获取下一个元素直到下一个标题
                let content = '';
                let sibling = headings[i].nextElementSibling;

                while (sibling && !['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(sibling.tagName)) {
                    content += sibling.textContent + ' ';
                    sibling = sibling.nextElementSibling;
                }

                return content.trim();
            }
        }
        return null;
    }

    /**
     * 提取指定 method 的 JSON 示例
     */
    private extractMethodExamples(doc: Document, methodName: string): string[] {
        const examples: string[] = [];

        // 方法1: 查找标题后的代码块
        const headings = doc.querySelectorAll('h1, h2, h3, h4, h5, h6');

        headings.forEach(heading => {
            const text = heading.textContent?.toUpperCase() || '';
            if (text.includes(methodName) || text.includes('示例')) {
                // 查找后续的 pre/code 块
                let sibling = heading.nextElementSibling;
                while (sibling && !['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(sibling.tagName)) {
                    const codeBlocks = sibling.querySelectorAll('pre, code, .code-block');
                    codeBlocks.forEach(block => {
                        const code = block.textContent?.trim() || '';
                        if (code.startsWith('{') && code.includes('header')) {
                            examples.push(code);
                        }
                    });

                    // 也检查元素本身
                    if (sibling.tagName === 'PRE' || sibling.classList?.contains('code-block')) {
                        const code = sibling.textContent?.trim() || '';
                        if (code.startsWith('{') && code.includes('header')) {
                            examples.push(code);
                        }
                    }

                    sibling = sibling.nextElementSibling;
                }
            }
        });

        // 方法2: 查找所有代码块，筛选包含指定 method 的
        if (examples.length === 0) {
            const allCodeBlocks = doc.querySelectorAll('pre, code, .code-block');
            allCodeBlocks.forEach(block => {
                const code = block.textContent?.trim() || '';
                if (code.includes(`"method": "${methodName}"`) ||
                    code.includes(`"method":"${methodName}"`)) {
                    examples.push(code);
                }
            });
        }

        return examples;
    }

    /**
     * 获取页面的所有子页面
     */
    async getChildPages(pageId: string): Promise<Array<{ id: string; title: string; url: string }>> {
        const results: Array<{ id: string; title: string; url: string }> = [];
        let start = 0;
        const limit = 100;
        let hasMore = true;

        while (hasMore) {
            const url = `${this.config.baseUrl}/rest/api/content/${pageId}/child/page?start=${start}&limit=${limit}`;
            try {
                const response = await this.fetcher(url, {
                    method: 'GET',
                    headers: this.getAuthHeaders(),
                });

                if (!response.ok) break;

                const data = response.data;
                if (data && data.results) {
                    data.results.forEach((page: any) => {
                        results.push({
                            id: page.id,
                            title: page.title,
                            url: `${page._links.base}${page._links.webui}`
                        });
                    });

                    if (data.results.length < limit) {
                        hasMore = false;
                    } else {
                        start += limit;
                    }
                } else {
                    hasMore = false;
                }
            } catch (e) {
                console.error('获取子页面失败:', e);
                break;
            }
        }

        return results;
    }

    /**
     * 从 Ability 列表批量获取协议文档
     */
    async fetchProtocolDocs(
        namespaces: string[],
        onProgress?: (current: number, total: number, namespace: string, status: 'loading' | 'success' | 'error') => void,
        manualDocUrls?: Map<string, string>
    ): Promise<Map<string, ParsedProtocolDoc>> {
        const results = new Map<string, ParsedProtocolDoc>();

        for (let i = 0; i < namespaces.length; i++) {
            const namespace = namespaces[i];
            onProgress?.(i + 1, namespaces.length, namespace, 'loading');

            try {
                let htmlContent = '';
                let pageUrl = '';
                let manualUrl = manualDocUrls?.get(namespace);

                if (manualUrl) {
                    // 使用手动指定的 URL
                    let pageId = '';
                    try {
                        const urlObj = new URL(manualUrl);
                        if (urlObj.searchParams.has('pageId')) {
                            pageId = urlObj.searchParams.get('pageId') || '';
                        } else {
                            const match = manualUrl.match(/\/(\d+)(\/|$|\?)/);
                            if (match) pageId = match[1];
                        }
                    } catch { }

                    if (pageId) {
                        const pageContent = await this.getPageContent(pageId);
                        if (pageContent) {
                            htmlContent = pageContent.body.view?.value || pageContent.body.storage.value;
                            pageUrl = `${pageContent._links.base}${pageContent._links.webui}`;
                        }
                    }
                }

                if (!htmlContent) {
                    // 1. 搜索页面 (如果没有手动 URL 或获取失败)
                    const searchResult = await this.searchProtocolPage(namespace);

                    if (!searchResult) {
                        results.set(namespace, {
                            namespace,
                            description: `${namespace} (文档未找到)`,
                            supportedMethods: { SET: false, GET: true, PUSH: false, DELETE: false, SYNC: false },
                            methods: {},
                            parseWarnings: ['文档页面未找到，使用默认配置'],
                        });
                        onProgress?.(i + 1, namespaces.length, namespace, 'error');
                        continue;
                    }

                    // 2. 获取页面内容
                    const pageContent = await this.getPageContent(searchResult.id);

                    if (!pageContent) {
                        results.set(namespace, {
                            namespace,
                            description: `${namespace} (获取内容失败)`,
                            supportedMethods: { SET: false, GET: true, PUSH: false, DELETE: false, SYNC: false },
                            methods: {},
                            parseWarnings: ['获取页面内容失败'],
                        });
                        onProgress?.(i + 1, namespaces.length, namespace, 'error');
                        continue;
                    }

                    htmlContent = pageContent.body.view?.value || pageContent.body.storage.value;
                    pageUrl = `${pageContent._links.base}${pageContent._links.webui}`;
                }

                // 3. 解析文档
                const parsedDoc = this.parseProtocolDocument(namespace, htmlContent, pageUrl);

                results.set(namespace, parsedDoc);
                onProgress?.(i + 1, namespaces.length, namespace, 'success');

                // 添加小延迟
                await new Promise(resolve => setTimeout(resolve, 100));

            } catch (error) {
                console.error(`Error processing ${namespace}:`, error);
                results.set(namespace, {
                    namespace,
                    description: `${namespace} (处理错误)`,
                    supportedMethods: { SET: false, GET: true, PUSH: false, DELETE: false, SYNC: false },
                    methods: {},
                    parseWarnings: [`处理错误: ${error}`],
                });
                onProgress?.(i + 1, namespaces.length, namespace, 'error');
            }
        }

        return results;
    }

    /**
     * 测试 Confluence 连接
     * 如果指定了 Space Key，测试该 Space 是否存在
     * 如果没有指定，只测试基本连接
     */
    async testConnection(): Promise<{ success: boolean; message: string }> {
        try {
            // 先测试基本连接（获取当前用户信息）
            const userUrl = `${this.config.baseUrl}/rest/api/user/current`;
            console.log('[Confluence] Testing connection:', userUrl);

            const userResponse = await this.fetcher(userUrl, {
                method: 'GET',
                headers: this.getAuthHeaders(),
            });

            console.log('[Confluence] Response status:', userResponse.status);

            if (!userResponse.ok) {
                if (userResponse.status === 401) {
                    return { success: false, message: '认证失败 (401)，请检查 Access Token 是否正确' };
                }
                if (userResponse.status === 403) {
                    return { success: false, message: '权限不足 (403)，请检查 Token 是否有 REST API 访问权限' };
                }

                // 检测是否被重定向到登录页面 (LDAP 场景)
                const responseText = userResponse.text || '';
                if (responseText.includes('<!DOCTYPE') || responseText.includes('<html')) {
                    // 检查是否是登录页面
                    if (responseText.toLowerCase().includes('login') ||
                        responseText.toLowerCase().includes('log in') ||
                        responseText.toLowerCase().includes('authenticate') ||
                        responseText.toLowerCase().includes('sso') ||
                        responseText.toLowerCase().includes('ldap')) {
                        return {
                            success: false,
                            message: `认证失败: 被重定向到登录页面。对于 LDAP 认证的 Confluence，请确保:\n` +
                                `1. 在 Confluence 个人设置中生成 Personal Access Token\n` +
                                `2. Token 具有 REST API 访问权限\n` +
                                `3. 尝试在浏览器中直接访问 ${userUrl} 验证 Token`
                        };
                    }
                    return {
                        success: false,
                        message: `服务器返回 HTML 而非 JSON (${userResponse.status})。请检查:\n` +
                            `1. Base URL 是否正确 (当前: ${this.config.baseUrl})\n` +
                            `2. 是否需要添加 /wiki 路径\n` +
                            `3. 服务器是否支持 REST API`
                    };
                }

                return { success: false, message: `连接失败: HTTP ${userResponse.status}` };
            }

            const userData = userResponse.data;

            // 检查响应是否为有效的用户数据
            if (!userData || typeof userData !== 'object') {
                return {
                    success: false,
                    message: '服务器响应格式异常，请检查 URL 是否正确'
                };
            }

            const username = userData?.displayName || userData?.username || userData?.name || 'Unknown';

            // 如果指定了 Space Key，验证它
            if (this.config.spaceKey && this.config.spaceKey.trim()) {
                const spaceUrl = `${this.config.baseUrl}/rest/api/space/${this.config.spaceKey}`;
                const spaceResponse = await this.fetcher(spaceUrl, {
                    method: 'GET',
                    headers: this.getAuthHeaders(),
                });

                if (spaceResponse.ok) {
                    const spaceData = spaceResponse.data;
                    return {
                        success: true,
                        message: `连接成功! 用户: ${username}, Space: ${spaceData?.name || this.config.spaceKey}`
                    };
                } else if (spaceResponse.status === 404) {
                    return { success: false, message: `Space "${this.config.spaceKey}" 不存在，请检查 Space Key` };
                }
            }

            return {
                success: true,
                message: `连接成功! 用户: ${username}${this.config.spaceKey ? '' : ' (全局搜索模式)'}`
            };
        } catch (error: any) {
            console.error('[Confluence] Connection test error:', error);
            return { success: false, message: `网络错误: ${error.message}` };
        }
    }
}

/**
 * 从解析的文档生成 ProtocolDefinition
 */
export function generateProtocolFromDoc(
    doc: ParsedProtocolDoc,
    generateSchema: (json: any, includeRequired?: boolean) => any
): {
    id: string;
    namespace: string;
    name: string;
    description: string;
    methods: Record<string, any>;
    warnings: string[];
} {
    const methods: Record<string, any> = {};
    const warnings = [...doc.parseWarnings];

    // 处理每个支持的 method
    (['GET', 'SET', 'PUSH', 'DELETE', 'SYNC'] as const).forEach(methodName => {
        if (doc.supportedMethods[methodName]) {
            const methodData = doc.methods[methodName];

            let requestPayload = {};
            let responseSchema = { type: 'object', required: ['header', 'payload'] };

            if (methodData?.requestExample?.payload) {
                requestPayload = methodData.requestExample.payload;
            }

            if (methodData?.responseExample) {
                try {
                    responseSchema = generateSchema(methodData.responseExample, true);
                } catch (e) {
                    warnings.push(`${methodName} 响应 Schema 生成失败`);
                }
            } else {
                warnings.push(`${methodName} 无响应示例，使用默认 Schema`);
            }

            methods[methodName] = {
                enabled: true,
                requestPayload,
                responseSchema,
            };
        }
    });

    return {
        id: `${doc.namespace.toLowerCase().replace(/\./g, '_')}_${Date.now()}`,
        namespace: doc.namespace,
        name: doc.namespace.split('.').pop() || doc.namespace,
        description: doc.description || doc.namespace,
        methods,
        warnings,
    };
}
