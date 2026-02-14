/**
 * Audit Database Service - 后端数据库同步服务
 * 
 * 功能：
 * 1. 与后端数据库同步协议库项目和测试历史
 * 2. 支持本地优先和后端优先两种同步策略
 * 3. 自动重试机制
 * 4. 与本地缓存配合使用
 * 
 * 修改：适配 Electron IPC 直接调用 MySQL
 */

import { databaseConfig, DatabaseConfig } from './auditDatabaseConfig';
import {
    StoredAuditProject,
    StoredTestRun,
    saveProjects as saveProjectsLocal,
    loadProjects as loadProjectsLocal,
    saveTestHistory as saveTestHistoryLocal,
    loadTestHistory as loadTestHistoryLocal,
} from './auditStorageService';

// ==================== IPC Bridge Helper ====================

// 声明 window.electron 类型 (假设 preload.js 已经暴露了 ipcRenderer)
declare global {
    interface Window {
        electron?: {
            ipcRenderer: {
                invoke(channel: string, ...args: any[]): Promise<any>;
            };
        };
    }
}

/**
 * 调用 Electron 主进程的数据库方法
 */
async function invokeDB(channel: string, ...args: any[]): Promise<any> {
    if (typeof window === 'undefined' || !window.electron) {
        console.warn('[AuditDB] Electron IPC not available (web mode or not ready?)');
        return null;
    }
    try {
        return await window.electron.ipcRenderer.invoke(channel, ...args);
    } catch (e) {
        console.error(`[AuditDB] Failed to invoke ${channel}:`, e);
        return null;
    }
}

/**
 * 初始化数据库连接
 */
export async function connectToDatabase(): Promise<boolean> {
    if (!databaseConfig.enabled) return false;

    try {
        const result = await invokeDB('db:connect', databaseConfig.connection);
        if (result && result.success) {
            console.log('[AuditDB] Connected to MySQL');
            return true;
        } else {
            console.error('[AuditDB] Connection failed:', result?.error);
            return false;
        }
    } catch (error) {
        console.error('[AuditDB] Connection error:', error);
        return false;
    }
}

// ==================== Projects API ====================

/**
 * 从后端获取所有项目
 */
export async function fetchProjectsFromDB(): Promise<StoredAuditProject[]> {
    if (!databaseConfig.enabled) return [];

    try {
        // 确保连接
        await connectToDatabase();

        const projects = await invokeDB('db:getProjects');
        return Array.isArray(projects) ? projects : [];
    } catch (error) {
        console.error('[AuditDB] Error fetching projects:', error);
        return [];
    }
}

/**
 * 获取单个项目详情（包含协议）
 * 注意：这是新加的方法，用于按需加载协议
 */
export async function fetchProjectDetailsFromDB(projectId: string): Promise<StoredAuditProject | null> {
    if (!databaseConfig.enabled) return null;

    try {
        return await invokeDB('db:getProjectWithProtocols', projectId);
    } catch (error) {
        console.error('[AuditDB] Error fetching project details:', error);
        return null;
    }
}

/**
 * 保存项目到后端
 */
export async function saveProjectToDB(project: StoredAuditProject): Promise<boolean> {
    if (!databaseConfig.enabled) return false;

    try {
        return await invokeDB('db:saveProject', project);
    } catch (error) {
        console.error('[AuditDB] Error saving project:', error);
        return false;
    }
}

/**
 * 批量保存项目到后端
 */
export async function saveAllProjectsToDB(projects: StoredAuditProject[]): Promise<boolean> {
    if (!databaseConfig.enabled) return false;

    try {
        // 确保连接
        await connectToDatabase();

        const results = await Promise.all(projects.map(p => saveProjectToDB(p)));
        return results.every(r => r);
    } catch (error) {
        console.error('[AuditDB] Error saving all projects:', error);
        return false;
    }
}

/**
 * 从后端删除项目
 */
export async function deleteProjectFromDB(projectId: string): Promise<boolean> {
    if (!databaseConfig.enabled) return false;

    try {
        return await invokeDB('db:deleteProject', projectId);
    } catch (error) {
        console.error('[AuditDB] Error deleting project:', error);
        return false;
    }
}

// ==================== Test History API ====================

/**
 * 从后端获取测试历史
 */
export async function fetchTestHistoryFromDB(): Promise<StoredTestRun[]> {
    if (!databaseConfig.enabled) return [];

    try {
        await connectToDatabase();
        const history = await invokeDB('db:getTestHistory');
        return Array.isArray(history) ? history : [];
    } catch (error) {
        console.error('[AuditDB] Error fetching test history:', error);
        return [];
    }
}

/**
 * 保存测试记录到后端
 */
export async function saveTestRunToDB(testRun: StoredTestRun): Promise<boolean> {
    if (!databaseConfig.enabled) return false;

    try {
        return await invokeDB('db:saveTestRun', testRun);
    } catch (error) {
        console.error('[AuditDB] Error saving test run:', error);
        return false;
    }
}

/**
 * 从后端删除测试记录
 * (目前 MySQL Service 尚未实现此具体方法，暂留空或实现通用删除)
 */
export async function deleteTestRunFromDB(testRunId: string): Promise<boolean> {
    if (!databaseConfig.enabled) return false;

    try {
        return await invokeDB('db:deleteTestRun', testRunId);
    } catch (error) {
        console.error('[AuditDB] Error deleting test run:', error);
        return false;
    }
}

/**
 * 清空后端所有测试历史
 */
export async function clearTestHistoryFromDB(): Promise<boolean> {
    // TODO: Implement db:clearTestHistory in mysqlService.js
    console.warn('[AuditDB] clearTestHistoryFromDB not implemented for MySQL yet');
    return false;
}

// ==================== Sync Functions (Local + Remote) ====================

/**
 * 保存项目（本地 + 后端同步）
 */
export async function syncSaveProjects(projects: StoredAuditProject[]): Promise<void> {
    // 始终保存本地
    saveProjectsLocal(projects);

    if (databaseConfig.enabled) {
        // 异步保存到 MySQL
        saveAllProjectsToDB(projects).then(success => {
            if (success) console.log('[AuditDB] Synced projects to MySQL');
            else console.warn('[AuditDB] Failed to sync projects to MySQL');
        });
    }
}

/**
 * 加载项目（优先本地，后端作为备份/同步源）
 */
export async function syncLoadProjects(): Promise<StoredAuditProject[]> {
    // 1. 加载本地
    let localProjects = loadProjectsLocal();

    // 2. 尝试从 MySQL 加载并合并
    if (databaseConfig.enabled) {
        try {
            const remoteProjects = await fetchProjectsFromDB();
            if (remoteProjects.length > 0) {
                // 简单合并策略：如果远程有，就用远程的（假设远程是中心源）
                // 或者保留本地较新的。这里为了简单，我们假设远程是 Truth。
                // 但注意：remoteProjects 可能不包含 protocols 详情（为了性能）。
                // 所以我们只更新元数据，protocols 只有在打开项目时才加载。

                // 这里我们做一个简单的 ID 映射合并
                const merged = [...localProjects];
                remoteProjects.forEach(rp => {
                    const index = merged.findIndex(lp => lp.id === rp.id);
                    if (index >= 0) {
                        // 更新元数据，保留本地的 protocols (防止被空数组覆盖)
                        merged[index] = {
                            ...rp,
                            protocols: merged[index].protocols // 保留本地协议详情
                        };
                    } else {
                        // 新项目
                        merged.push(rp);
                    }
                });

                localProjects = merged;
                saveProjectsLocal(localProjects); // 更新本地缓存
            }
        } catch (error) {
            console.error('[AuditDB] Sync load failed:', error);
        }
    }

    return localProjects;
}

/**
 * 保存测试历史
 */
export async function syncSaveTestHistory(history: StoredTestRun[]): Promise<void> {
    saveTestHistoryLocal(history);
    if (databaseConfig.enabled && history.length > 0) {
        console.log('[AuditDB] Syncing latest test run to MySQL:', history[0].id);
        // 只同步最新的一条
        saveTestRunToDB(history[0]).then(success => {
            if (success) console.log('[AuditDB] Test run saved to MySQL');
            else console.warn('[AuditDB] Failed to save test run to MySQL');
        });
    }
}

/**
 * 加载测试历史
 */
export async function syncLoadTestHistory(): Promise<StoredTestRun[]> {
    let localHistory = loadTestHistoryLocal();
    if (databaseConfig.enabled) {
        const remoteHistory = await fetchTestHistoryFromDB();
        if (remoteHistory.length > 0) {
            // Use remote history as the source of truth to ensure consistency
            // This fixes the issue where local storage has stale/ghost records not in DB
            localHistory = remoteHistory;
            localHistory.sort((a, b) => b.startTime - a.startTime);
            saveTestHistoryLocal(localHistory);
        }
    }
    return localHistory;
}

// ==================== Status & Debug ====================

export async function checkDatabaseConnection(): Promise<{
    enabled: boolean;
    connected: boolean;
    error?: string;
}> {
    if (!databaseConfig.enabled) return { enabled: false, connected: false };
    const success = await connectToDatabase();
    return {
        enabled: true,
        connected: success,
        error: success ? undefined : 'Connection failed'
    };
}

export function getSyncStatus() {
    return {
        enabled: databaseConfig.enabled,
        mode: databaseConfig.syncStrategy.mode,
        host: databaseConfig.connection.host
    };
}

