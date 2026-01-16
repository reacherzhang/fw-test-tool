/**
 * Audit Database Service - 后端数据库同步服务
 * 
 * 功能：
 * 1. 与后端数据库同步协议库项目和测试历史
 * 2. 支持本地优先和后端优先两种同步策略
 * 3. 自动重试机制
 * 4. 与本地缓存配合使用
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

// ==================== HTTP Client ====================

/**
 * 构建请求头
 */
function buildHeaders(config: DatabaseConfig): HeadersInit {
    const headers: HeadersInit = {
        'Content-Type': 'application/json',
    };

    switch (config.auth.type) {
        case 'apiKey':
            if (config.auth.apiKey) {
                headers[config.auth.apiKeyHeader || 'X-API-Key'] = config.auth.apiKey;
            }
            break;
        case 'bearer':
            if (config.auth.token) {
                headers['Authorization'] = `Bearer ${config.auth.token}`;
            }
            break;
        case 'basic':
            if (config.auth.username && config.auth.password) {
                const credentials = btoa(`${config.auth.username}:${config.auth.password}`);
                headers['Authorization'] = `Basic ${credentials}`;
            }
            break;
    }

    return headers;
}

/**
 * 发送 HTTP 请求（带超时和重试）
 */
async function fetchWithRetry(
    url: string,
    options: RequestInit,
    retries: number = databaseConfig.syncStrategy.maxRetries
): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), databaseConfig.timeout);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok && retries > 0 && databaseConfig.syncStrategy.retryOnFail) {
            console.warn(`[AuditDB] Request failed (${response.status}), retrying... (${retries} left)`);
            await new Promise(r => setTimeout(r, databaseConfig.syncStrategy.retryDelay));
            return fetchWithRetry(url, options, retries - 1);
        }

        return response;
    } catch (error) {
        clearTimeout(timeoutId);

        if (retries > 0 && databaseConfig.syncStrategy.retryOnFail) {
            console.warn(`[AuditDB] Request error, retrying... (${retries} left)`, error);
            await new Promise(r => setTimeout(r, databaseConfig.syncStrategy.retryDelay));
            return fetchWithRetry(url, options, retries - 1);
        }

        throw error;
    }
}

/**
 * 替换 URL 中的占位符
 */
function buildUrl(endpoint: string, params: Record<string, string> = {}): string {
    let url = `${databaseConfig.baseUrl}${endpoint}`;
    Object.entries(params).forEach(([key, value]) => {
        url = url.replace(`:${key}`, encodeURIComponent(value));
    });
    return url;
}

// ==================== Projects API ====================

/**
 * 从后端获取所有项目
 */
export async function fetchProjectsFromDB(): Promise<StoredAuditProject[]> {
    if (!databaseConfig.enabled) {
        return [];
    }

    try {
        const url = buildUrl(databaseConfig.endpoints.projects.list);
        const response = await fetchWithRetry(url, {
            method: 'GET',
            headers: buildHeaders(databaseConfig),
        });

        if (response.ok) {
            const data = await response.json();
            return Array.isArray(data) ? data : (data.projects || data.data || []);
        }

        console.error('[AuditDB] Failed to fetch projects:', response.status);
        return [];
    } catch (error) {
        console.error('[AuditDB] Error fetching projects:', error);
        return [];
    }
}

/**
 * 保存项目到后端
 */
export async function saveProjectToDB(project: StoredAuditProject): Promise<boolean> {
    if (!databaseConfig.enabled) {
        return false;
    }

    try {
        // 先检查项目是否存在
        const existingProjects = await fetchProjectsFromDB();
        const exists = existingProjects.some(p => p.id === project.id);

        const endpoint = exists
            ? databaseConfig.endpoints.projects.update
            : databaseConfig.endpoints.projects.create;
        const method = exists ? 'PUT' : 'POST';
        const url = buildUrl(endpoint, { id: project.id });

        const response = await fetchWithRetry(url, {
            method,
            headers: buildHeaders(databaseConfig),
            body: JSON.stringify(project),
        });

        if (response.ok) {
            console.log(`[AuditDB] Project ${exists ? 'updated' : 'created'}:`, project.id);
            return true;
        }

        console.error('[AuditDB] Failed to save project:', response.status);
        return false;
    } catch (error) {
        console.error('[AuditDB] Error saving project:', error);
        return false;
    }
}

/**
 * 批量保存项目到后端
 */
export async function saveAllProjectsToDB(projects: StoredAuditProject[]): Promise<boolean> {
    if (!databaseConfig.enabled) {
        return false;
    }

    try {
        // 逐个保存（可以根据后端支持批量接口优化）
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
    if (!databaseConfig.enabled) {
        return false;
    }

    try {
        const url = buildUrl(databaseConfig.endpoints.projects.delete, { id: projectId });
        const response = await fetchWithRetry(url, {
            method: 'DELETE',
            headers: buildHeaders(databaseConfig),
        });

        if (response.ok) {
            console.log('[AuditDB] Project deleted:', projectId);
            return true;
        }

        console.error('[AuditDB] Failed to delete project:', response.status);
        return false;
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
    if (!databaseConfig.enabled) {
        return [];
    }

    try {
        const url = buildUrl(databaseConfig.endpoints.testHistory.list);
        const response = await fetchWithRetry(url, {
            method: 'GET',
            headers: buildHeaders(databaseConfig),
        });

        if (response.ok) {
            const data = await response.json();
            return Array.isArray(data) ? data : (data.history || data.data || []);
        }

        console.error('[AuditDB] Failed to fetch test history:', response.status);
        return [];
    } catch (error) {
        console.error('[AuditDB] Error fetching test history:', error);
        return [];
    }
}

/**
 * 保存测试记录到后端
 */
export async function saveTestRunToDB(testRun: StoredTestRun): Promise<boolean> {
    if (!databaseConfig.enabled) {
        return false;
    }

    try {
        const url = buildUrl(databaseConfig.endpoints.testHistory.create);
        const response = await fetchWithRetry(url, {
            method: 'POST',
            headers: buildHeaders(databaseConfig),
            body: JSON.stringify(testRun),
        });

        if (response.ok) {
            console.log('[AuditDB] Test run saved:', testRun.id);
            return true;
        }

        console.error('[AuditDB] Failed to save test run:', response.status);
        return false;
    } catch (error) {
        console.error('[AuditDB] Error saving test run:', error);
        return false;
    }
}

/**
 * 从后端删除测试记录
 */
export async function deleteTestRunFromDB(testRunId: string): Promise<boolean> {
    if (!databaseConfig.enabled) {
        return false;
    }

    try {
        const url = buildUrl(databaseConfig.endpoints.testHistory.delete, { id: testRunId });
        const response = await fetchWithRetry(url, {
            method: 'DELETE',
            headers: buildHeaders(databaseConfig),
        });

        if (response.ok) {
            console.log('[AuditDB] Test run deleted:', testRunId);
            return true;
        }

        console.error('[AuditDB] Failed to delete test run:', response.status);
        return false;
    } catch (error) {
        console.error('[AuditDB] Error deleting test run:', error);
        return false;
    }
}

/**
 * 清空后端所有测试历史
 */
export async function clearTestHistoryFromDB(): Promise<boolean> {
    if (!databaseConfig.enabled) {
        return false;
    }

    try {
        const url = buildUrl(databaseConfig.endpoints.testHistory.clear);
        const response = await fetchWithRetry(url, {
            method: 'DELETE',
            headers: buildHeaders(databaseConfig),
        });

        if (response.ok) {
            console.log('[AuditDB] All test history cleared');
            return true;
        }

        console.error('[AuditDB] Failed to clear test history:', response.status);
        return false;
    } catch (error) {
        console.error('[AuditDB] Error clearing test history:', error);
        return false;
    }
}

// ==================== Sync Functions (Local + Remote) ====================

/**
 * 保存项目（本地 + 后端同步）
 * 根据 syncStrategy.mode 决定同步顺序
 */
export async function syncSaveProjects(projects: StoredAuditProject[]): Promise<void> {
    if (databaseConfig.syncStrategy.mode === 'local-first') {
        // 本地优先：先保存本地，异步同步后端
        saveProjectsLocal(projects);
        if (databaseConfig.enabled) {
            saveAllProjectsToDB(projects).catch(err => {
                console.error('[AuditDB] Background sync failed:', err);
            });
        }
    } else {
        // 后端优先：先保存后端，成功后保存本地
        if (databaseConfig.enabled) {
            const success = await saveAllProjectsToDB(projects);
            if (!success) {
                console.warn('[AuditDB] Remote save failed, saving locally only');
            }
        }
        saveProjectsLocal(projects);
    }
}

/**
 * 加载项目（优先本地，后端作为备份/同步源）
 */
export async function syncLoadProjects(): Promise<StoredAuditProject[]> {
    // 先加载本地
    let localProjects = loadProjectsLocal();

    // 如果启用了数据库同步，尝试从后端获取
    if (databaseConfig.enabled) {
        try {
            const remoteProjects = await fetchProjectsFromDB();

            if (remoteProjects.length > 0) {
                // 合并策略：以更新时间更新的为准
                const merged = mergeProjects(localProjects, remoteProjects);

                // 如果有变化，同步保存
                if (JSON.stringify(merged) !== JSON.stringify(localProjects)) {
                    saveProjectsLocal(merged);
                    localProjects = merged;
                }
            }
        } catch (error) {
            console.error('[AuditDB] Failed to sync from remote:', error);
        }
    }

    return localProjects;
}

/**
 * 保存测试历史（本地 + 后端同步）
 */
export async function syncSaveTestHistory(history: StoredTestRun[]): Promise<void> {
    if (databaseConfig.syncStrategy.mode === 'local-first') {
        saveTestHistoryLocal(history);
        if (databaseConfig.enabled && history.length > 0) {
            // 只同步最新的一条
            saveTestRunToDB(history[0]).catch(err => {
                console.error('[AuditDB] Background sync failed:', err);
            });
        }
    } else {
        if (databaseConfig.enabled && history.length > 0) {
            await saveTestRunToDB(history[0]);
        }
        saveTestHistoryLocal(history);
    }
}

/**
 * 加载测试历史（本地 + 后端同步）
 */
export async function syncLoadTestHistory(): Promise<StoredTestRun[]> {
    let localHistory = loadTestHistoryLocal();

    if (databaseConfig.enabled) {
        try {
            const remoteHistory = await fetchTestHistoryFromDB();

            if (remoteHistory.length > 0) {
                const merged = mergeTestHistory(localHistory, remoteHistory);

                if (JSON.stringify(merged) !== JSON.stringify(localHistory)) {
                    saveTestHistoryLocal(merged);
                    localHistory = merged;
                }
            }
        } catch (error) {
            console.error('[AuditDB] Failed to sync test history from remote:', error);
        }
    }

    return localHistory;
}

// ==================== Merge Utilities ====================

/**
 * 合并本地和远程项目（以 updatedAt 更新的为准）
 */
function mergeProjects(
    local: StoredAuditProject[],
    remote: StoredAuditProject[]
): StoredAuditProject[] {
    const merged = new Map<string, StoredAuditProject>();

    // 先添加本地
    local.forEach(p => merged.set(p.id, p));

    // 用远程覆盖（如果更新）
    remote.forEach(remoteProject => {
        const localProject = merged.get(remoteProject.id);
        if (!localProject || remoteProject.updatedAt > localProject.updatedAt) {
            merged.set(remoteProject.id, remoteProject);
        }
    });

    return Array.from(merged.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 合并本地和远程测试历史（去重并按时间排序）
 */
function mergeTestHistory(
    local: StoredTestRun[],
    remote: StoredTestRun[]
): StoredTestRun[] {
    const merged = new Map<string, StoredTestRun>();

    // 添加本地
    local.forEach(h => merged.set(h.id, h));

    // 添加远程（不覆盖本地）
    remote.forEach(h => {
        if (!merged.has(h.id)) {
            merged.set(h.id, h);
        }
    });

    // 按开始时间降序排列，限制100条
    return Array.from(merged.values())
        .sort((a, b) => b.startTime - a.startTime)
        .slice(0, 100);
}

// ==================== Status & Debug ====================

/**
 * 检查数据库连接状态
 */
export async function checkDatabaseConnection(): Promise<{
    enabled: boolean;
    connected: boolean;
    error?: string;
}> {
    if (!databaseConfig.enabled) {
        return { enabled: false, connected: false };
    }

    try {
        const url = buildUrl(databaseConfig.endpoints.projects.list);
        const response = await fetch(url, {
            method: 'GET',
            headers: buildHeaders(databaseConfig),
            signal: AbortSignal.timeout(5000),
        });

        return {
            enabled: true,
            connected: response.ok,
            error: response.ok ? undefined : `HTTP ${response.status}`,
        };
    } catch (error) {
        return {
            enabled: true,
            connected: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

/**
 * 获取同步状态信息
 */
export function getSyncStatus(): {
    enabled: boolean;
    mode: 'local-first' | 'remote-first';
    baseUrl: string;
    authType: string;
} {
    return {
        enabled: databaseConfig.enabled,
        mode: databaseConfig.syncStrategy.mode,
        baseUrl: databaseConfig.baseUrl,
        authType: databaseConfig.auth.type,
    };
}
