/**
 * Audit Database Configuration - 数据库连接配置
 * 
 * 适用于直接连接 MySQL 数据库的场景
 */

export interface DatabaseConfig {
    // 是否启用数据库同步
    enabled: boolean;

    // 数据库连接配置
    connection: {
        host: string;
        port: number;
        user: string;
        password?: string;
        database: string;
    };

    // 请求超时时间（毫秒）
    timeout: number;

    // 同步策略
    syncStrategy: {
        mode: 'local-first' | 'remote-first';
        retryOnFail: boolean;
        maxRetries: number;
        retryDelay: number;
    };
}

// ==================== 默认配置（请修改此处） ====================

export const databaseConfig: DatabaseConfig = {
    // 【重要】设为 true 以启用数据库同步
    enabled: true,

    // 数据库连接信息
    connection: {
        host: '47.108.183.147', // 数据库地址
        port: 3306,            // 端口
        user: 'root',          // 用户名
        password: 's9yBmj3CraDpKLaGAN',          // 密码
        database: 'iot_nexus_audit', // 数据库名
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

if (typeof process !== 'undefined' && process.env) {
    if (process.env.AUDIT_DB_ENABLED === 'true') {
        databaseConfig.enabled = true;
    }
    if (process.env.AUDIT_DB_HOST) {
        databaseConfig.connection.host = process.env.AUDIT_DB_HOST;
    }
    if (process.env.AUDIT_DB_PORT) {
        databaseConfig.connection.port = parseInt(process.env.AUDIT_DB_PORT, 10);
    }
    if (process.env.AUDIT_DB_USER) {
        databaseConfig.connection.user = process.env.AUDIT_DB_USER;
    }
    if (process.env.AUDIT_DB_PASSWORD) {
        databaseConfig.connection.password = process.env.AUDIT_DB_PASSWORD;
    }
    if (process.env.AUDIT_DB_NAME) {
        databaseConfig.connection.database = process.env.AUDIT_DB_NAME;
    }
}
