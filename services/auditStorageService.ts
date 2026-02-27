/**
 * Audit Storage Service - 协议审计模块持久化存储服务
 * 
 * 负责持久化存储：
 * 1. 协议库列表（Projects/Suites）
 * 2. 每个协议库中的所有协议
 * 3. 测试结果历史记录
 * 
 * 特性：
 * - 本地缓存自动过期（2周后自动清理）
 * - 支持后端数据库同步（可选）
 */

// Storage Keys
const STORAGE_KEYS = {
    PROJECTS: 'iot_nexus_audit_projects',
    SUITES: 'iot_nexus_test_suites',
    TEST_HISTORY: 'iot_nexus_test_history',
    ACTIVE_PROJECT_ID: 'iot_nexus_active_project',
    TARGET_DEVICE_ID: 'iot_nexus_target_device',
} as const;

// 缓存过期时间：2周（毫秒）
const CACHE_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

// 带时间戳的存储包装器
interface CacheWrapper<T> {
    data: T;
    timestamp: number;  // 存储时间
    version: number;    // 数据版本，用于后续升级
}

// 当前缓存数据版本
const CACHE_VERSION = 1;

// Types (mirroring ProtocolAudit.tsx types for storage)
export interface StoredMethodTest {
    enabled: boolean;
    payload: string;
    schema: string;
    testCases?: any[];
    lastResult?: any;
}

export interface StoredProtocolDefinition {
    id: string;
    namespace: string;
    name: string;
    description?: string;
    category?: string;
    docUrl?: string;
    methods: {
        [key: string]: StoredMethodTest | undefined;
    };
    reviewStatus?: 'UNVERIFIED' | 'VERIFIED';
    executionPlan?: any; // 用于持久化存取 TestExecutionPlan
}

export interface StoredAuditProject {
    id: string;
    name: string;
    deviceId?: string;
    targetDeviceName?: string;
    protocols: StoredProtocolDefinition[];
    createdAt: number;
    updatedAt: number;
    status: 'ACTIVE' | 'ARCHIVED';
    progress: number;
}

export interface StoredTestSuite {
    id: string;
    name: string;
    description?: string;
    protocols: StoredProtocolDefinition[];
    createdAt: number;
    updatedAt: number;
    executionConfig?: {
        timeout: number;
        retryCount: number;
        stopOnFail: boolean;
    };
}

export interface StoredTestResult {
    protocolId: string;
    namespace: string;
    method: string;
    status: 'PASS' | 'FAIL' | 'TIMEOUT' | 'PENDING';
    duration: number;
    response: any;
    error?: string;
    testCaseId?: string;
    testCaseName?: string;
    request?: any;
    expectedSchema?: any;
}

export interface StoredTestRun {
    id: string;
    suiteId: string;
    suiteName: string;
    deviceId: string;
    deviceName: string;
    startTime: number;
    endTime?: number;
    status: 'RUNNING' | 'COMPLETED' | 'FAILED';
    results: StoredTestResult[];
    triggerBy?: string;
    summary: {
        total: number;
        passed: number;
        failed: number;
        timeout: number;
    };
}

// ==================== Projects Storage ====================

/**
 * 保存所有协议库项目（带缓存时间戳）
 */
export function saveProjects(projects: StoredAuditProject[]): void {
    try {
        const wrapper: CacheWrapper<StoredAuditProject[]> = {
            data: projects,
            timestamp: Date.now(),
            version: CACHE_VERSION
        };
        localStorage.setItem(STORAGE_KEYS.PROJECTS, JSON.stringify(wrapper));
    } catch (error) {
        console.error('[AuditStorage] Failed to save projects:', error);
    }
}

/**
 * 加载所有协议库项目（检查过期，2周后自动清理）
 */
export function loadProjects(): StoredAuditProject[] {
    try {
        const saved = localStorage.getItem(STORAGE_KEYS.PROJECTS);
        if (saved) {
            const parsed = JSON.parse(saved);

            // 兼容旧格式（直接存储数组）
            if (Array.isArray(parsed)) {
                // 旧格式，迁移到新格式
                saveProjects(parsed);
                return parsed;
            }

            // 新格式（带时间戳的包装器）
            const wrapper = parsed as CacheWrapper<StoredAuditProject[]>;
            const age = Date.now() - wrapper.timestamp;

            // 检查是否过期（2周）
            if (age > CACHE_EXPIRY_MS) {
                console.log('[AuditStorage] Projects cache expired, clearing...');
                localStorage.removeItem(STORAGE_KEYS.PROJECTS);
                return [];
            }

            return Array.isArray(wrapper.data) ? wrapper.data : [];
        }
    } catch (error) {
        console.error('[AuditStorage] Failed to load projects:', error);
    }
    return [];
}

/**
 * 保存单个项目（更新或添加）
 */
export function saveProject(project: StoredAuditProject): void {
    const projects = loadProjects();
    const existingIndex = projects.findIndex(p => p.id === project.id);

    if (existingIndex >= 0) {
        projects[existingIndex] = { ...project, updatedAt: Date.now() };
    } else {
        projects.push(project);
    }

    saveProjects(projects);
}

/**
 * 删除项目
 */
export function deleteProject(projectId: string): void {
    const projects = loadProjects();
    saveProjects(projects.filter(p => p.id !== projectId));

    // 同时删除该项目相关的测试历史
    const history = loadTestHistory();
    saveTestHistory(history.filter(h => h.suiteId !== projectId));
}

// ==================== Suites Storage ====================

/**
 * 保存测试套件列表
 */
export function saveSuites(suites: StoredTestSuite[]): void {
    try {
        localStorage.setItem(STORAGE_KEYS.SUITES, JSON.stringify(suites));
    } catch (error) {
        console.error('[AuditStorage] Failed to save suites:', error);
    }
}

/**
 * 加载测试套件列表
 */
export function loadSuites(): StoredTestSuite[] {
    try {
        const saved = localStorage.getItem(STORAGE_KEYS.SUITES);
        if (saved) {
            const suites = JSON.parse(saved);
            return Array.isArray(suites) ? suites : [];
        }
    } catch (error) {
        console.error('[AuditStorage] Failed to load suites:', error);
    }
    return [];
}

/**
 * 保存单个套件
 */
export function saveSuite(suite: StoredTestSuite): void {
    const suites = loadSuites();
    const existingIndex = suites.findIndex(s => s.id === suite.id);

    if (existingIndex >= 0) {
        suites[existingIndex] = { ...suite, updatedAt: Date.now() };
    } else {
        suites.push(suite);
    }

    saveSuites(suites);
}

/**
 * 删除套件
 */
export function deleteSuite(suiteId: string): void {
    const suites = loadSuites();
    saveSuites(suites.filter(s => s.id !== suiteId));
}

// ==================== Protocols Storage ====================

/**
 * 更新项目中的协议列表
 */
export function updateProjectProtocols(projectId: string, protocols: StoredProtocolDefinition[]): void {
    const projects = loadProjects();
    const projectIndex = projects.findIndex(p => p.id === projectId);

    if (projectIndex >= 0) {
        projects[projectIndex].protocols = protocols;
        projects[projectIndex].updatedAt = Date.now();

        // 计算进度（已验证的协议比例）
        const verifiedCount = protocols.filter(p => p.reviewStatus === 'VERIFIED').length;
        projects[projectIndex].progress = protocols.length > 0
            ? Math.round((verifiedCount / protocols.length) * 100)
            : 0;

        saveProjects(projects);
    }
}

/**
 * 添加协议到项目
 */
export function addProtocolToProject(projectId: string, protocol: StoredProtocolDefinition): void {
    const projects = loadProjects();
    const project = projects.find(p => p.id === projectId);

    if (project) {
        // 检查是否已存在
        const existingIndex = project.protocols.findIndex(p => p.id === protocol.id);
        if (existingIndex >= 0) {
            project.protocols[existingIndex] = protocol;
        } else {
            project.protocols.push(protocol);
        }
        project.updatedAt = Date.now();
        saveProjects(projects);
    }
}

/**
 * 从项目中删除协议
 */
export function deleteProtocolFromProject(projectId: string, protocolId: string): void {
    const projects = loadProjects();
    const project = projects.find(p => p.id === projectId);

    if (project) {
        project.protocols = project.protocols.filter(p => p.id !== protocolId);
        project.updatedAt = Date.now();
        saveProjects(projects);
    }
}

// ==================== Test History Storage ====================

/**
 * 保存测试历史（带缓存时间戳）
 */
export function saveTestHistory(history: StoredTestRun[]): void {
    try {
        // 限制保存的历史记录数量，避免存储过大
        const limitedHistory = history.slice(0, 100);
        const wrapper: CacheWrapper<StoredTestRun[]> = {
            data: limitedHistory,
            timestamp: Date.now(),
            version: CACHE_VERSION
        };
        localStorage.setItem(STORAGE_KEYS.TEST_HISTORY, JSON.stringify(wrapper));
    } catch (error) {
        console.error('[AuditStorage] Failed to save test history:', error);
        // 如果存储满了，删除一部分旧记录重试
        try {
            const limitedHistory = history.slice(0, 50);
            const wrapper: CacheWrapper<StoredTestRun[]> = {
                data: limitedHistory,
                timestamp: Date.now(),
                version: CACHE_VERSION
            };
            localStorage.setItem(STORAGE_KEYS.TEST_HISTORY, JSON.stringify(wrapper));
        } catch (retryError) {
            console.error('[AuditStorage] Failed to save test history after retry:', retryError);
        }
    }
}

/**
 * 加载测试历史（检查过期，2周后自动清理）
 */
export function loadTestHistory(): StoredTestRun[] {
    try {
        const saved = localStorage.getItem(STORAGE_KEYS.TEST_HISTORY);
        if (saved) {
            const parsed = JSON.parse(saved);

            // 兼容旧格式（直接存储数组）
            if (Array.isArray(parsed)) {
                // 旧格式，迁移到新格式
                saveTestHistory(parsed);
                return parsed;
            }

            // 新格式（带时间戳的包装器）
            const wrapper = parsed as CacheWrapper<StoredTestRun[]>;
            const age = Date.now() - wrapper.timestamp;

            // 检查是否过期（2周）
            if (age > CACHE_EXPIRY_MS) {
                console.log('[AuditStorage] Test history cache expired, clearing...');
                localStorage.removeItem(STORAGE_KEYS.TEST_HISTORY);
                return [];
            }

            return Array.isArray(wrapper.data) ? wrapper.data : [];
        }
    } catch (error) {
        console.error('[AuditStorage] Failed to load test history:', error);
    }
    return [];
}

/**
 * 添加测试运行记录
 */
export function addTestRun(testRun: StoredTestRun): void {
    const history = loadTestHistory();
    // 插入到开头
    history.unshift(testRun);
    saveTestHistory(history);
}

/**
 * 更新测试运行记录
 */
export function updateTestRun(testRunId: string, updates: Partial<StoredTestRun>): void {
    const history = loadTestHistory();
    const index = history.findIndex(h => h.id === testRunId);

    if (index >= 0) {
        history[index] = { ...history[index], ...updates };
        saveTestHistory(history);
    }
}

/**
 * 删除单个测试运行记录
 */
export function deleteTestRun(testRunId: string): void {
    const history = loadTestHistory();
    saveTestHistory(history.filter(h => h.id !== testRunId));
}

/**
 * 清除所有测试历史
 */
export function clearTestHistory(): void {
    localStorage.removeItem(STORAGE_KEYS.TEST_HISTORY);
}

/**
 * 获取特定套件的测试历史
 */
export function getTestHistoryBySuite(suiteId: string): StoredTestRun[] {
    const history = loadTestHistory();
    return history.filter(h => h.suiteId === suiteId);
}

// ==================== Settings Storage ====================

/**
 * 保存活动项目ID
 */
export function saveActiveProjectId(projectId: string | null): void {
    if (projectId) {
        localStorage.setItem(STORAGE_KEYS.ACTIVE_PROJECT_ID, projectId);
    } else {
        localStorage.removeItem(STORAGE_KEYS.ACTIVE_PROJECT_ID);
    }
}

/**
 * 加载活动项目ID
 */
export function loadActiveProjectId(): string | null {
    return localStorage.getItem(STORAGE_KEYS.ACTIVE_PROJECT_ID);
}

/**
 * 保存目标设备ID
 */
export function saveTargetDeviceId(deviceId: string): void {
    localStorage.setItem(STORAGE_KEYS.TARGET_DEVICE_ID, deviceId);
}

/**
 * 加载目标设备ID
 */
export function loadTargetDeviceId(): string {
    return localStorage.getItem(STORAGE_KEYS.TARGET_DEVICE_ID) || '';
}

// ==================== Migration Helpers ====================

/**
 * 迁移旧的存储格式到新格式
 */
export function migrateOldStorage(): void {
    try {
        // 检查是否有旧格式的 suites 数据
        const oldSuites = localStorage.getItem('iot_nexus_test_suites');
        const existingProjects = loadProjects();

        if (oldSuites && existingProjects.length === 0) {
            const suites = JSON.parse(oldSuites) as StoredTestSuite[];

            // 将旧的 suites 转换为 projects
            const newProjects: StoredAuditProject[] = suites.map(suite => ({
                id: suite.id,
                name: suite.name,
                protocols: suite.protocols,
                createdAt: suite.createdAt,
                updatedAt: suite.updatedAt,
                status: 'ACTIVE' as const,
                progress: 0
            }));

            if (newProjects.length > 0) {
                saveProjects(newProjects);
                console.log('[AuditStorage] Migrated old suites to projects');
            }
        }
    } catch (error) {
        console.error('[AuditStorage] Migration failed:', error);
    }
}

// ==================== Debug Helpers ====================

/**
 * 获取存储使用情况
 */
export function getStorageStats(): { projects: number; suites: number; testHistory: number; totalSize: string } {
    const projectsSize = (localStorage.getItem(STORAGE_KEYS.PROJECTS) || '').length;
    const suitesSize = (localStorage.getItem(STORAGE_KEYS.SUITES) || '').length;
    const historySize = (localStorage.getItem(STORAGE_KEYS.TEST_HISTORY) || '').length;

    const totalBytes = projectsSize + suitesSize + historySize;
    const totalSize = totalBytes < 1024
        ? `${totalBytes} B`
        : totalBytes < 1024 * 1024
            ? `${(totalBytes / 1024).toFixed(2)} KB`
            : `${(totalBytes / 1024 / 1024).toFixed(2)} MB`;

    return {
        projects: loadProjects().length,
        suites: loadSuites().length,
        testHistory: loadTestHistory().length,
        totalSize
    };
}

/**
 * 清除所有审计相关存储
 */
export function clearAllAuditStorage(): void {
    Object.values(STORAGE_KEYS).forEach(key => {
        localStorage.removeItem(key);
    });
    console.log('[AuditStorage] All audit storage cleared');
}
