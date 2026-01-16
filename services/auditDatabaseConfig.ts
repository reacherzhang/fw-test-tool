/**
 * Audit Database Configuration - 数据库连接配置
 * 
 * 请根据你的后端数据库服务配置以下参数
 * 支持 REST API / GraphQL / 直连数据库等多种方式
 */

export interface DatabaseConfig {
    // 是否启用数据库同步（设为 true 后数据将同时保存到本地缓存和后端数据库）
    enabled: boolean;

    // 后端 API 基础地址
    baseUrl: string;

    // API 认证方式
    auth: {
        type: 'none' | 'apiKey' | 'bearer' | 'basic';
        // API Key（type='apiKey' 时使用）
        apiKey?: string;
        apiKeyHeader?: string;  // 默认 'X-API-Key'
        // Bearer Token（type='bearer' 时使用）
        token?: string;
        // Basic Auth（type='basic' 时使用）
        username?: string;
        password?: string;
    };

    // API 端点配置
    endpoints: {
        // 协议库项目 CRUD
        projects: {
            list: string;       // GET 获取列表
            get: string;        // GET 获取单个，使用 :id 占位符
            create: string;     // POST 创建
            update: string;     // PUT 更新，使用 :id 占位符
            delete: string;     // DELETE 删除，使用 :id 占位符
        };
        // 测试历史记录 CRUD
        testHistory: {
            list: string;       // GET 获取列表
            get: string;        // GET 获取单个
            create: string;     // POST 创建
            delete: string;     // DELETE 删除
            clear: string;      // DELETE 清空所有
        };
    };

    // 请求超时时间（毫秒）
    timeout: number;

    // 同步策略
    syncStrategy: {
        // 本地优先：先保存本地，异步同步到后端（推荐，离线可用）
        // 后端优先：先保存后端，成功后保存本地（数据一致性强）
        mode: 'local-first' | 'remote-first';
        // 保存失败时是否重试
        retryOnFail: boolean;
        // 重试次数
        maxRetries: number;
        // 重试间隔（毫秒）
        retryDelay: number;
    };
}

// ==================== 默认配置（请根据需要修改） ====================

export const databaseConfig: DatabaseConfig = {
    // 【重要】设为 true 以启用数据库同步
    enabled: false,

    // 后端 API 地址（示例）
    baseUrl: 'http://localhost:3001/api/v1/audit',

    // API 认证配置
    auth: {
        type: 'none',   // 'none' | 'apiKey' | 'bearer' | 'basic'

        // API Key 认证
        // apiKey: 'your-api-key-here',
        // apiKeyHeader: 'X-API-Key',

        // Bearer Token 认证
        // token: 'your-jwt-token-here',

        // Basic Auth 认证
        // username: 'admin',
        // password: 'password',
    },

    // API 端点配置
    endpoints: {
        projects: {
            list: '/projects',
            get: '/projects/:id',
            create: '/projects',
            update: '/projects/:id',
            delete: '/projects/:id',
        },
        testHistory: {
            list: '/test-history',
            get: '/test-history/:id',
            create: '/test-history',
            delete: '/test-history/:id',
            clear: '/test-history',
        },
    },

    // 请求超时（10秒）
    timeout: 10000,

    // 同步策略
    syncStrategy: {
        mode: 'local-first',    // 本地优先，保证离线可用
        retryOnFail: true,
        maxRetries: 3,
        retryDelay: 1000,
    },
};

// ==================== 环境变量覆盖（可选） ====================

// 支持通过环境变量覆盖配置（用于不同环境部署）
if (typeof process !== 'undefined' && process.env) {
    if (process.env.AUDIT_DB_ENABLED === 'true') {
        databaseConfig.enabled = true;
    }
    if (process.env.AUDIT_DB_BASE_URL) {
        databaseConfig.baseUrl = process.env.AUDIT_DB_BASE_URL;
    }
    if (process.env.AUDIT_DB_API_KEY) {
        databaseConfig.auth.type = 'apiKey';
        databaseConfig.auth.apiKey = process.env.AUDIT_DB_API_KEY;
    }
    if (process.env.AUDIT_DB_TOKEN) {
        databaseConfig.auth.type = 'bearer';
        databaseConfig.auth.token = process.env.AUDIT_DB_TOKEN;
    }
}
