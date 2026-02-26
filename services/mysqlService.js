import { ipcMain, app } from 'electron';
import mysql from 'mysql2/promise';
import { readFileSync } from 'fs';
import { join } from 'path';

// 获取客户端版本号
let clientVersion = 'Unknown';
try {
    const pkgPath = join(app.getAppPath(), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    clientVersion = pkg.version || 'Unknown';
} catch (e) {
    console.warn('[MySQL] Failed to read client version:', e.message);
}

let pool = null;

// Helper to format date as MySQL DATETIME string in local time (UTC+8)
const toMysqlDateTime = (timestamp) => {
    if (!timestamp) return null;
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = ('0' + (date.getMonth() + 1)).slice(-2);
    const day = ('0' + date.getDate()).slice(-2);
    const hours = ('0' + date.getHours()).slice(-2);
    const minutes = ('0' + date.getMinutes()).slice(-2);
    const seconds = ('0' + date.getSeconds()).slice(-2);
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};

/**
 * 初始化数据库连接池
 */
export async function initDatabase(config) {
    // 如果连接池已存在，尝试复用
    if (pool) {
        try {
            // 尝试获取一个连接来验证池是否可用
            const connection = await pool.getConnection();
            connection.release();
            // console.log('[MySQL] Reusing existing connection pool');
            return { success: true };
        } catch (error) {
            console.warn('[MySQL] Existing pool is invalid, recreating:', error.message);
            // 如果池不可用，尝试关闭它（忽略错误）并继续重建
            try { await pool.end(); } catch (e) { }
            pool = null;
        }
    }

    try {
        console.log(`[MySQL] [${new Date().toISOString()}] Initializing connection pool to ${config.host}:${config.port} (${config.user})`);

        pool = mysql.createPool({
            host: config.host,
            port: config.port,
            user: config.user,
            password: config.password,
            database: config.database,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            connectTimeout: 20000 // 增加连接超时时间
        });

        // 测试连接
        const connection = await pool.getConnection();
        console.log(`[MySQL] [${new Date().toISOString()}] Connected successfully to database:`, config.database);
        connection.release();
        return { success: true };
    } catch (error) {
        console.error(`[MySQL] [${new Date().toISOString()}] Connection failed:`, {
            code: error.code,
            errno: error.errno,
            syscall: error.syscall,
            address: error.address,
            port: error.port,
            message: error.message
        });
        return {
            success: false,
            error: `Connection failed: [${error.code}] ${error.message} (Host: ${config.host})`
        };
    }
}

/**
 * 确保 client_status 表存在 (在 audit_db 中)
 */
async function ensureClientStatusTable() {
    if (!pool) return;
    try {
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS client_status (
                trigger_by VARCHAR(100) PRIMARY KEY,
                client_version VARCHAR(50) DEFAULT '',
                meross_email VARCHAR(200) DEFAULT '',
                meross_user_id VARCHAR(100) DEFAULT '',
                meross_region VARCHAR(100) DEFAULT '',
                http_domain VARCHAR(200) DEFAULT '',
                mqtt_domain VARCHAR(200) DEFAULT '',
                device_name VARCHAR(200) DEFAULT '',
                device_uuid VARCHAR(200) DEFAULT '',
                device_type VARCHAR(100) DEFAULT '',
                device_firmware VARCHAR(100) DEFAULT '',
                device_hardware VARCHAR(100) DEFAULT '',
                device_mac VARCHAR(100) DEFAULT '',
                device_ip VARCHAR(50) DEFAULT '',
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        console.log('[MySQL] client_status table ensured');
    } catch (e) {
        console.warn('[MySQL] Failed to create client_status table:', e.message);
    }
}

/**
 * 写入客户端状态到数据库
 */
async function reportClientStatus(triggerBy, type, data) {
    if (!pool || !triggerBy) return { success: false, error: 'Not ready' };
    try {
        // 确保表存在
        await ensureClientStatusTable();

        if (type === 'launch') {
            await pool.execute(`
                INSERT INTO client_status (trigger_by, client_version, updated_at)
                VALUES (?, ?, NOW())
                ON DUPLICATE KEY UPDATE client_version = VALUES(client_version), updated_at = NOW()
            `, [triggerBy, data.client_version || clientVersion]);
        } else if (type === 'login') {
            await pool.execute(`
                INSERT INTO client_status (trigger_by, meross_email, meross_user_id, meross_region, http_domain, mqtt_domain, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, NOW())
                ON DUPLICATE KEY UPDATE
                    meross_email = VALUES(meross_email),
                    meross_user_id = VALUES(meross_user_id),
                    meross_region = VALUES(meross_region),
                    http_domain = VALUES(http_domain),
                    mqtt_domain = VALUES(mqtt_domain),
                    updated_at = NOW()
            `, [
                triggerBy,
                data.email || '', data.userId || '', data.region || '',
                data.httpDomain || '', data.mqttDomain || ''
            ]);
        } else if (type === 'device') {
            await pool.execute(`
                INSERT INTO client_status (trigger_by, device_name, device_uuid, device_type, device_firmware, device_hardware, device_mac, device_ip, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
                ON DUPLICATE KEY UPDATE
                    device_name = VALUES(device_name),
                    device_uuid = VALUES(device_uuid),
                    device_type = VALUES(device_type),
                    device_firmware = VALUES(device_firmware),
                    device_hardware = VALUES(device_hardware),
                    device_mac = VALUES(device_mac),
                    device_ip = VALUES(device_ip),
                    updated_at = NOW()
            `, [
                triggerBy,
                data.name || '', data.uuid || '', data.type || '',
                data.firmware || '', data.hardware || '',
                data.mac || '', data.ip || ''
            ]);
        }
        console.log(`[MySQL] Client status '${type}' reported for ${triggerBy}`);
        return { success: true };
    } catch (e) {
        console.error('[MySQL] reportClientStatus error:', e.message);
        return { success: false, error: e.message };
    }
}

/**
 * 注册 IPC 处理程序
 */
export function registerDatabaseHandlers() {
    // 初始化连接
    ipcMain.handle('db:connect', async (event, config) => {
        const result = await initDatabase(config);
        if (result.success) {
            // 数据库连接成功后，自动建表并写入版本号
            await ensureClientStatusTable();
        }
        return result;
    });

    // 客户端状态上报 (直接写数据库)
    ipcMain.handle('db:reportStatus', async (event, { triggerBy, type, data }) => {
        return await reportClientStatus(triggerBy, type, data);
    });

    // 通用查询接口 (仅供内部服务使用，慎用)
    ipcMain.handle('db:query', async (event, sql, params) => {
        if (!pool) return { success: false, error: 'Database not connected' };
        try {
            const [rows] = await pool.execute(sql, params);
            return { success: true, data: rows };
        } catch (error) {
            console.error('[MySQL] Query error:', error);
            return { success: false, error: error.message };
        }
    });
    // ==================== Projects CRUD ====================

    // 获取所有项目
    ipcMain.handle('db:getProjects', async () => {
        if (!pool) return [];
        try {
            const [rows] = await pool.execute('SELECT * FROM projects ORDER BY updated_at DESC');
            // 转换下划线命名为驼峰
            return rows.map(row => ({
                id: row.id,
                name: row.name,
                description: row.description,
                status: row.status,
                createdAt: new Date(row.created_at).getTime(),
                updatedAt: new Date(row.updated_at).getTime(),
                deviceConfig: row.device_config ? JSON.parse(row.device_config) : undefined,
                // 注意：protocols 需要单独查询或联表查询，这里简化处理，列表页可能不需要全部 protocols
                protocols: []
            }));
        } catch (error) {
            console.error('[MySQL] getProjects error:', error);
            return [];
        }
    });

    // 保存项目 (Insert or Update)
    ipcMain.handle('db:saveProject', async (event, project) => {
        console.log('[MySQL] Received saveProject request:', project.id, project.name);
        if (!pool) {
            console.error('[MySQL] Pool not initialized, cannot save project');
            return false;
        }
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            // 1. 保存项目基本信息
            // Use explicit date string to ensure local time (UTC+8) is stored
            const sql = `
        INSERT INTO projects (id, name, description, status, created_at, updated_at, device_config)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        description = VALUES(description),
        status = VALUES(status),
        updated_at = VALUES(updated_at),
        device_config = VALUES(device_config)
      `;

            await connection.execute(sql, [
                project.id,
                project.name,
                project.description || '',
                project.status,
                toMysqlDateTime(project.createdAt),
                toMysqlDateTime(project.updatedAt),
                project.deviceConfig ? JSON.stringify(project.deviceConfig) : null
            ]);

            // 2. 保存协议 (先删除旧的，再插入新的 - 简单粗暴但有效)
            // 注意：这种方式在大数据量下效率较低，但保证了一致性
            await connection.execute('DELETE FROM protocols WHERE project_id = ?', [project.id]);

            if (project.protocols && project.protocols.length > 0) {
                const protocolValues = project.protocols.map(p => [
                    p.id,
                    project.id,
                    p.namespace,
                    p.name,
                    p.description || '',
                    p.reviewStatus || 'UNVERIFIED',
                    JSON.stringify(p.methods || {}),
                    JSON.stringify(p.tags || []),
                    p.sourceId || null
                ]);

                // 批量插入
                const protocolSql = `
          INSERT INTO protocols (id, project_id, namespace, name, description, review_status, methods, tags, source_id)
          VALUES ?
        `;
                await connection.query(protocolSql, [protocolValues]);
            }

            await connection.commit();
            console.log('[MySQL] Project saved successfully:', project.id);
            return true;
        } catch (error) {
            await connection.rollback();
            console.error('[MySQL] saveProject error:', error);
            return false;
        } finally {
            connection.release();
        }
    });

    // 删除项目
    ipcMain.handle('db:deleteProject', async (event, projectId) => {
        if (!pool) return false;
        try {
            // 外键约束会自动删除关联的 protocols，如果没有设置级联删除，需要手动删
            await pool.execute('DELETE FROM projects WHERE id = ?', [projectId]);
            return true;
        } catch (error) {
            console.error('[MySQL] deleteProject error:', error);
            return false;
        }
    });

    // 获取项目详情（包含协议）
    ipcMain.handle('db:getProjectWithProtocols', async (event, projectId) => {
        if (!pool) return null;
        try {
            // 1. 获取项目信息
            const [projectRows] = await pool.execute('SELECT * FROM projects WHERE id = ?', [projectId]);
            if (projectRows.length === 0) return null;

            const project = projectRows[0];

            // 2. 获取协议信息
            const [protocolRows] = await pool.execute('SELECT * FROM protocols WHERE project_id = ?', [projectId]);

            const protocols = protocolRows.map(row => ({
                id: row.id,
                namespace: row.namespace,
                name: row.name,
                description: row.description,
                reviewStatus: row.review_status,
                methods: JSON.parse(row.methods || '{}'),
                tags: JSON.parse(row.tags || '[]'),
                sourceId: row.source_id
            }));

            return {
                id: project.id,
                name: project.name,
                description: project.description,
                status: project.status,
                createdAt: new Date(project.created_at).getTime(),
                updatedAt: new Date(project.updated_at).getTime(),
                deviceConfig: project.device_config ? JSON.parse(project.device_config) : undefined,
                protocols: protocols
            };
        } catch (error) {
            console.error('[MySQL] getProjectWithProtocols error:', error);
            return null;
        }
    });

    // ==================== Test History CRUD ====================

    // 保存测试记录
    ipcMain.handle('db:saveTestRun', async (event, testRun) => {
        if (!pool) return false;
        try {
            const sql = `
        INSERT INTO test_runs (id, project_id, start_time, end_time, summary, trigger_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `;
            // 将 results 详情合并到 summary 中保存，前端需要从 summary.results 获取每个协议的详细数据
            const summaryWithResults = {
                ...testRun.summary,
                clientVersion: clientVersion,
                results: (testRun.results || []).map(r => ({
                    protocolId: r.protocolId,
                    namespace: r.namespace,
                    method: r.method,
                    status: r.status,
                    duration: r.duration,
                    error: r.error,
                    request: r.request,
                    response: r.response,
                    expectedSchema: r.expectedSchema,
                    schemaErrors: r.schemaErrors,
                    testCaseId: r.testCaseId,
                    testCaseName: r.testCaseName,
                    startTime: r.startTime
                }))
            };
            await pool.execute(sql, [
                testRun.id,
                testRun.projectId || testRun.suiteId, // 兼容 suiteId
                toMysqlDateTime(testRun.startTime),
                toMysqlDateTime(testRun.endTime),
                JSON.stringify(summaryWithResults),
                testRun.triggerBy || 'User'
            ]);
            return true;
        } catch (error) {
            console.error('[MySQL] saveTestRun error:', error);
            return false;
        }
    });
    ipcMain.handle('db:getTestHistory', async () => {
        if (!pool) return [];
        try {
            const [rows] = await pool.execute('SELECT * FROM test_runs ORDER BY start_time DESC LIMIT 100');
            return rows.map(row => {
                const summaryData = JSON.parse(row.summary || '{}');
                return {
                    id: row.id,
                    projectId: row.project_id,
                    startTime: new Date(row.start_time).getTime(),
                    endTime: new Date(row.end_time).getTime(),
                    summary: summaryData,
                    results: summaryData.results || [],
                    triggerBy: row.trigger_by
                };
            });
        } catch (error) {
            console.error('[MySQL] getTestHistory error:', error);
            return [];
        }
    });

    // 删除测试记录
    ipcMain.handle('db:deleteTestRun', async (event, testRunId) => {
        if (!pool) return false;
        try {
            await pool.execute('DELETE FROM test_runs WHERE id = ?', [testRunId]);
            return true;
        } catch (error) {
            console.error('[MySQL] deleteTestRun error:', error);
            return false;
        }
    });
}
