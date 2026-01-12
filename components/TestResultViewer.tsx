/**
 * TestResultViewer - 测试结果查看器组件
 * 
 * 功能：
 * 1. 完整展示请求/响应数据（左右对比布局）
 * 2. 期望值与实际值的 Side-by-Side Diff 高亮
 * 3. Schema 验证错误详情
 * 4. 批量测试汇总面板
 */

import React, { useState, useMemo } from 'react';
import {
    X, Copy, Check, ChevronDown, ChevronRight, AlertTriangle,
    CheckCircle, XCircle, Clock, ArrowRight, Eye, EyeOff,
    Download, RefreshCw, Maximize2, Minimize2, BarChart3,
    ArrowLeftRight, FileText
} from 'lucide-react';

// ==================== 类型定义 ====================

export interface TestRequest {
    topic: string;
    message: {
        header: {
            messageId: string;
            namespace: string;
            method: string;
            payloadVersion: number;
            from: string;
            timestamp: number;
            sign: string;
            triggerSrc: string;
            uuid: string;
        };
        payload: any;
    };
    sentAt: number;
}

export interface TestResponse {
    header?: {
        messageId?: string;
        namespace?: string;
        method?: string;
        [key: string]: any;
    };
    payload?: any;
    receivedAt?: number;
}

export interface SchemaValidationError {
    path: string;
    message: string;
    keyword: string;
    expected?: any;
    actual?: any;
}

export interface DetailedTestResult {
    id?: string;
    protocolId?: string;
    namespace?: string;
    method?: string;
    status: 'PASS' | 'FAIL' | 'TIMEOUT' | 'PENDING';
    duration: number;
    request?: any;
    response?: any;
    expectedSchema?: any;
    schemaErrors?: SchemaValidationError[];
    error?: string;
    retryCount?: number;
    startTime?: number;
    endTime?: number;
}

// 批量测试结果
export interface BatchTestResult {
    id?: string;
    suiteId: string;
    suiteName: string;
    deviceName: string;
    startTime: number;
    endTime?: number;
    status?: 'RUNNING' | 'COMPLETED' | 'FAILED';
    results: DetailedTestResult[];
    summary: {
        total: number;
        passed: number;
        failed: number;
        timeout: number;
    };
}

// ==================== Side-by-Side Diff 组件 ====================

interface DiffLine {
    lineNumber: { left?: number; right?: number };
    type: 'unchanged' | 'added' | 'removed' | 'modified';
    leftContent?: string;
    rightContent?: string;
}

/**
 * 将 JSON 转为带行号的字符串数组
 */
const jsonToLines = (obj: any): string[] => {
    if (obj === undefined || obj === null) return ['null'];
    try {
        return JSON.stringify(obj, null, 2).split('\n');
    } catch {
        return [String(obj)];
    }
};

/**
 * 简单的 LCS 差异算法
 */
const computeDiff = (leftLines: string[], rightLines: string[]): DiffLine[] => {
    const result: DiffLine[] = [];
    let leftIdx = 0;
    let rightIdx = 0;
    let leftLineNum = 1;
    let rightLineNum = 1;

    // 使用简单的逐行比较算法
    while (leftIdx < leftLines.length || rightIdx < rightLines.length) {
        const leftLine = leftLines[leftIdx];
        const rightLine = rightLines[rightIdx];

        if (leftIdx >= leftLines.length) {
            // 左边已结束，剩余的都是新增
            result.push({
                lineNumber: { right: rightLineNum++ },
                type: 'added',
                rightContent: rightLine
            });
            rightIdx++;
        } else if (rightIdx >= rightLines.length) {
            // 右边已结束，剩余的都是删除
            result.push({
                lineNumber: { left: leftLineNum++ },
                type: 'removed',
                leftContent: leftLine
            });
            leftIdx++;
        } else if (leftLine === rightLine) {
            // 相同
            result.push({
                lineNumber: { left: leftLineNum++, right: rightLineNum++ },
                type: 'unchanged',
                leftContent: leftLine,
                rightContent: rightLine
            });
            leftIdx++;
            rightIdx++;
        } else {
            // 不同 - 尝试向前查找匹配
            let foundInRight = -1;
            let foundInLeft = -1;

            // 在右边查找当前左边的行
            for (let i = rightIdx; i < Math.min(rightIdx + 5, rightLines.length); i++) {
                if (rightLines[i] === leftLine) {
                    foundInRight = i;
                    break;
                }
            }

            // 在左边查找当前右边的行
            for (let i = leftIdx; i < Math.min(leftIdx + 5, leftLines.length); i++) {
                if (leftLines[i] === rightLine) {
                    foundInLeft = i;
                    break;
                }
            }

            if (foundInRight !== -1 && (foundInLeft === -1 || foundInRight - rightIdx <= foundInLeft - leftIdx)) {
                // 右边有新增的行
                while (rightIdx < foundInRight) {
                    result.push({
                        lineNumber: { right: rightLineNum++ },
                        type: 'added',
                        rightContent: rightLines[rightIdx]
                    });
                    rightIdx++;
                }
            } else if (foundInLeft !== -1) {
                // 左边有删除的行
                while (leftIdx < foundInLeft) {
                    result.push({
                        lineNumber: { left: leftLineNum++ },
                        type: 'removed',
                        leftContent: leftLines[leftIdx]
                    });
                    leftIdx++;
                }
            } else {
                // 修改的行
                result.push({
                    lineNumber: { left: leftLineNum++, right: rightLineNum++ },
                    type: 'modified',
                    leftContent: leftLine,
                    rightContent: rightLine
                });
                leftIdx++;
                rightIdx++;
            }
        }
    }

    return result;
};

/**
 * Side-by-Side Diff 视图组件
 */
export const SideBySideDiff: React.FC<{
    leftJson: any;
    rightJson: any;
    leftTitle: string;
    rightTitle: string;
}> = ({ leftJson, rightJson, leftTitle, rightTitle }) => {
    const diffLines = useMemo(() => {
        const leftLines = jsonToLines(leftJson);
        const rightLines = jsonToLines(rightJson);
        return computeDiff(leftLines, rightLines);
    }, [leftJson, rightJson]);

    const stats = useMemo(() => {
        return {
            added: diffLines.filter(d => d.type === 'added').length,
            removed: diffLines.filter(d => d.type === 'removed').length,
            modified: diffLines.filter(d => d.type === 'modified').length,
            unchanged: diffLines.filter(d => d.type === 'unchanged').length
        };
    }, [diffLines]);

    const lineColors: Record<DiffLine['type'], { bg: string; border: string; text: string }> = {
        unchanged: { bg: '', border: 'border-transparent', text: 'text-slate-400' },
        added: { bg: 'bg-emerald-500/10', border: 'border-emerald-500', text: 'text-emerald-400' },
        removed: { bg: 'bg-red-500/10', border: 'border-red-500', text: 'text-red-400' },
        modified: { bg: 'bg-amber-500/10', border: 'border-amber-500', text: 'text-amber-400' }
    };

    return (
        <div className="flex flex-col h-full">
            {/* Stats Bar */}
            <div className="flex items-center justify-between px-4 py-2 bg-slate-900/50 border-b border-slate-800">
                <div className="flex items-center gap-4 text-xs">
                    <span className="text-slate-500">Changes:</span>
                    {stats.added > 0 && (
                        <span className="text-emerald-400">+{stats.added} added</span>
                    )}
                    {stats.removed > 0 && (
                        <span className="text-red-400">-{stats.removed} removed</span>
                    )}
                    {stats.modified > 0 && (
                        <span className="text-amber-400">~{stats.modified} modified</span>
                    )}
                    {stats.added === 0 && stats.removed === 0 && stats.modified === 0 && (
                        <span className="text-emerald-400">✓ No differences</span>
                    )}
                </div>
            </div>

            {/* Column Headers */}
            <div className="flex border-b border-slate-700 bg-slate-950/50">
                <div className="flex-1 px-4 py-2 text-xs font-bold text-red-400 uppercase border-r border-slate-700">
                    {leftTitle}
                </div>
                <div className="flex-1 px-4 py-2 text-xs font-bold text-emerald-400 uppercase">
                    {rightTitle}
                </div>
            </div>

            {/* Diff Content */}
            <div className="flex-1 overflow-auto custom-scrollbar">
                <div className="flex min-w-max">
                    {/* Left Column */}
                    <div className="flex-1 border-r border-slate-700 font-mono text-xs">
                        {diffLines.map((line, idx) => {
                            const colors = lineColors[line.type];
                            const showLine = line.type !== 'added';
                            return (
                                <div
                                    key={`left-${idx}`}
                                    className={`flex ${colors.bg} border-l-2 ${colors.border} min-h-[24px]`}
                                >
                                    <div className="w-10 px-2 py-0.5 text-right text-slate-600 bg-slate-900/30 select-none shrink-0">
                                        {line.lineNumber.left || ''}
                                    </div>
                                    <div className="w-6 px-1 py-0.5 text-center text-slate-500 bg-slate-900/20 select-none shrink-0">
                                        {line.type === 'removed' ? '−' : line.type === 'modified' ? '~' : ''}
                                    </div>
                                    <pre className={`flex-1 px-2 py-0.5 whitespace-pre ${showLine ? colors.text : 'text-transparent'}`}>
                                        {showLine ? line.leftContent : ' '}
                                    </pre>
                                </div>
                            );
                        })}
                    </div>

                    {/* Right Column */}
                    <div className="flex-1 font-mono text-xs">
                        {diffLines.map((line, idx) => {
                            const colors = lineColors[line.type];
                            const showLine = line.type !== 'removed';
                            return (
                                <div
                                    key={`right-${idx}`}
                                    className={`flex ${colors.bg} border-l-2 ${colors.border} min-h-[24px]`}
                                >
                                    <div className="w-10 px-2 py-0.5 text-right text-slate-600 bg-slate-900/30 select-none shrink-0">
                                        {line.lineNumber.right || ''}
                                    </div>
                                    <div className="w-6 px-1 py-0.5 text-center text-slate-500 bg-slate-900/20 select-none shrink-0">
                                        {line.type === 'added' ? '+' : line.type === 'modified' ? '~' : ''}
                                    </div>
                                    <pre className={`flex-1 px-2 py-0.5 whitespace-pre ${showLine ? colors.text : 'text-transparent'}`}>
                                        {showLine ? line.rightContent : ' '}
                                    </pre>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
};

// ==================== Phase 2: 三栏对比视图组件 ====================

interface ThreeWayDiffProps {
    requestPayload: any;
    expectedSchema: any;
    actualResponse: any;
}

/**
 * 从 JSON Schema 中提取预期字段
 */
const extractExpectedFieldsFromSchema = (schema: any, prefix = ''): Map<string, { type: string; required: boolean }> => {
    const fields = new Map<string, { type: string; required: boolean }>();
    if (!schema) return fields;

    try {
        const parsed = typeof schema === 'string' ? JSON.parse(schema) : schema;
        const extractFromObject = (obj: any, currentPrefix: string, requiredFields: string[] = []) => {
            if (obj?.properties) {
                Object.entries(obj.properties).forEach(([key, val]: [string, any]) => {
                    const path = currentPrefix ? `${currentPrefix}.${key}` : key;
                    const isRequired = requiredFields.includes(key) || obj.required?.includes(key);
                    fields.set(path, { type: val.type || 'any', required: isRequired });
                    if (val.type === 'object' && val.properties) {
                        extractFromObject(val, path, val.required || []);
                    } else if (val.type === 'array' && val.items?.type === 'object') {
                        fields.set(`${path}[]`, { type: 'object', required: isRequired });
                        extractFromObject(val.items, `${path}[]`, val.items.required || []);
                    }
                });
            }
        };
        extractFromObject(parsed, prefix, parsed.required || []);
    } catch (e) {
        // Invalid schema, ignore
    }
    return fields;
};

/**
 * 从实际响应中提取字段
 */
const extractActualFields = (obj: any, prefix = ''): Map<string, { value: any; type: string }> => {
    const fields = new Map<string, { value: any; type: string }>();
    if (!obj || typeof obj !== 'object') return fields;

    Object.entries(obj).forEach(([k, v]) => {
        const path = prefix ? `${prefix}.${k}` : k;
        const type = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
        fields.set(path, { value: v, type });
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
            extractActualFields(v, path).forEach((val, key) => fields.set(key, val));
        }
    });
    return fields;
};

export const ThreeWayDiff: React.FC<ThreeWayDiffProps> = ({
    requestPayload, expectedSchema, actualResponse
}) => {
    // 从 Schema 提取预期字段
    const expectedFields = useMemo(() => {
        return extractExpectedFieldsFromSchema(expectedSchema);
    }, [expectedSchema]);

    // 从响应提取实际字段
    const actualFields = useMemo(() => {
        const responseData = actualResponse?.payload || actualResponse;
        return extractActualFields(responseData);
    }, [actualResponse]);

    // 计算差异
    type DiffStatus = 'match' | 'missing' | 'type_mismatch' | 'extra';
    interface DiffItem {
        path: string;
        status: DiffStatus;
        expected?: { type: string; required: boolean };
        actual?: { value: any; type: string };
    }

    const diffs = useMemo(() => {
        const result: DiffItem[] = [];

        // 检查预期字段在实际响应中是否存在
        expectedFields.forEach((expected, path) => {
            const actual = actualFields.get(path);
            if (!actual) {
                result.push({ path, status: 'missing', expected });
            } else if (expected.type !== 'any' && expected.type !== actual.type) {
                result.push({ path, status: 'type_mismatch', expected, actual });
            } else {
                result.push({ path, status: 'match', expected, actual });
            }
        });

        // 检查实际响应中多余的字段
        actualFields.forEach((actual, path) => {
            if (!expectedFields.has(path)) {
                result.push({ path, status: 'extra', actual });
            }
        });

        return result.sort((a, b) => a.path.localeCompare(b.path));
    }, [expectedFields, actualFields]);

    // 统计
    const stats = useMemo(() => ({
        match: diffs.filter(d => d.status === 'match').length,
        missing: diffs.filter(d => d.status === 'missing').length,
        typeMismatch: diffs.filter(d => d.status === 'type_mismatch').length,
        extra: diffs.filter(d => d.status === 'extra').length
    }), [diffs]);

    const statusColors: Record<DiffStatus, { bg: string; text: string; icon: string }> = {
        match: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', icon: '✓' },
        missing: { bg: 'bg-red-500/10', text: 'text-red-400', icon: '✗' },
        type_mismatch: { bg: 'bg-amber-500/10', text: 'text-amber-400', icon: '~' },
        extra: { bg: 'bg-blue-500/10', text: 'text-blue-400', icon: '+' }
    };

    return (
        <div className="flex flex-col h-full">
            {/* Stats Bar */}
            <div className="px-4 py-2 bg-slate-900/50 border-b border-slate-800 flex items-center gap-4 text-xs shrink-0">
                <span className="text-slate-500">Fields:</span>
                <span className="text-emerald-400 flex items-center gap-1">
                    <CheckCircle size={12} /> {stats.match} matched
                </span>
                <span className="text-red-400 flex items-center gap-1">
                    <XCircle size={12} /> {stats.missing} missing
                </span>
                <span className="text-amber-400 flex items-center gap-1">
                    <AlertTriangle size={12} /> {stats.typeMismatch} type errors
                </span>
                <span className="text-blue-400 flex items-center gap-1">
                    <FileText size={12} /> {stats.extra} extra
                </span>
            </div>

            {/* Three Column Grid */}
            <div className="flex-1 grid grid-cols-3 overflow-hidden">
                {/* Column 1: Request */}
                <div className="border-r border-slate-700 flex flex-col overflow-hidden">
                    <div className="px-4 py-2 bg-blue-500/10 border-b border-slate-700 shrink-0">
                        <div className="text-xs font-bold text-blue-400 uppercase">Request Payload</div>
                        <div className="text-[10px] text-slate-500">发送的数据</div>
                    </div>
                    <div className="flex-1 overflow-auto custom-scrollbar p-3">
                        <pre className="text-xs font-mono text-blue-300 whitespace-pre-wrap">
                            {JSON.stringify(requestPayload, null, 2)}
                        </pre>
                    </div>
                </div>

                {/* Column 2: Expected (from Schema) */}
                <div className="border-r border-slate-700 flex flex-col overflow-hidden">
                    <div className="px-4 py-2 bg-amber-500/10 border-b border-slate-700 shrink-0">
                        <div className="text-xs font-bold text-amber-400 uppercase">Expected Fields</div>
                        <div className="text-[10px] text-slate-500">预期响应字段</div>
                    </div>
                    <div className="flex-1 overflow-auto custom-scrollbar">
                        {diffs.length === 0 ? (
                            <div className="p-4 text-xs text-slate-500 text-center">No schema defined</div>
                        ) : (
                            <div className="divide-y divide-slate-800">
                                {diffs.filter(d => d.status !== 'extra').map((d, i) => {
                                    const colors = statusColors[d.status];
                                    return (
                                        <div key={i} className={`px-3 py-1.5 ${colors.bg} flex items-center gap-2`}>
                                            <span className={`text-[10px] ${colors.text}`}>{colors.icon}</span>
                                            <span className="text-xs font-mono text-slate-300 flex-1 truncate">{d.path}</span>
                                            <span className="text-[10px] text-slate-500">{d.expected?.type}</span>
                                            {d.expected?.required && (
                                                <span className="text-[10px] text-red-400">*</span>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>

                {/* Column 3: Actual Response */}
                <div className="flex flex-col overflow-hidden">
                    <div className="px-4 py-2 bg-emerald-500/10 border-b border-slate-700 shrink-0">
                        <div className="text-xs font-bold text-emerald-400 uppercase">Actual Response</div>
                        <div className="text-[10px] text-slate-500">实际收到的数据</div>
                    </div>
                    <div className="flex-1 overflow-auto custom-scrollbar p-3">
                        <pre className="text-xs font-mono text-emerald-300 whitespace-pre-wrap">
                            {JSON.stringify(actualResponse?.payload || actualResponse, null, 2)}
                        </pre>
                    </div>
                </div>
            </div>
        </div>
    );
};

// ==================== 批量测试结果汇总面板 ====================

interface BatchTestSummaryPanelProps {
    isOpen: boolean;
    onClose: () => void;
    batchResult: BatchTestResult | null;
    onViewDetail: (result: any) => void;
}

export const BatchTestSummaryPanel: React.FC<BatchTestSummaryPanelProps> = ({
    isOpen,
    onClose,
    batchResult,
    onViewDetail
}) => {
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
    const [filterStatus, setFilterStatus] = useState<'all' | 'PASS' | 'FAIL' | 'TIMEOUT'>('all');

    // 所有 useMemo 必须在 early return 之前，确保 hooks 数量恒定
    const results = batchResult?.results || [];

    // 按 namespace 分组
    const groupedResults = useMemo(() => {
        const groups: Record<string, typeof results> = {};
        results.forEach(r => {
            const ns = r.namespace || 'Unknown';
            if (!groups[ns]) {
                groups[ns] = [];
            }
            groups[ns].push(r);
        });
        return groups;
    }, [results]);

    const filteredGroups = useMemo(() => {
        if (filterStatus === 'all') return groupedResults;
        const filtered: Record<string, typeof results> = {};
        Object.entries(groupedResults).forEach(([ns, items]) => {
            const filteredItems = items.filter(i => i.status === filterStatus);
            if (filteredItems.length > 0) {
                filtered[ns] = filteredItems;
            }
        });
        return filtered;
    }, [groupedResults, filterStatus]);

    // Early return 在所有 hooks 之后
    if (!isOpen || !batchResult) return null;

    const { summary, suiteName, deviceName, startTime, endTime } = batchResult;
    const duration = endTime ? (endTime - startTime) / 1000 : 0;
    const passRate = summary.total > 0 ? Math.round((summary.passed / summary.total) * 100) : 0;

    const toggleGroup = (namespace: string) => {
        setExpandedGroups(prev => {
            const next = new Set(prev);
            if (next.has(namespace)) {
                next.delete(namespace);
            } else {
                next.add(namespace);
            }
            return next;
        });
    };

    const statusConfig = {
        PASS: { icon: CheckCircle, color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30' },
        FAIL: { icon: XCircle, color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/30' },
        TIMEOUT: { icon: Clock, color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/30' },
        PENDING: { icon: Clock, color: 'text-slate-400', bg: 'bg-slate-500/10', border: 'border-slate-500/30' }
    };

    return (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[100]">
            <div className="bg-slate-900 border border-slate-700 rounded-2xl w-[1100px] max-h-[90vh] flex flex-col overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/80 shrink-0">
                    <div className="flex items-center gap-4">
                        <div className="p-2 bg-indigo-500/10 rounded-xl">
                            <BarChart3 size={24} className="text-indigo-400" />
                        </div>
                        <div>
                            <div className="text-lg font-black text-white">{suiteName}</div>
                            <div className="text-xs text-slate-500">
                                Device: {deviceName} • Duration: {duration.toFixed(1)}s
                            </div>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* Summary Stats */}
                <div className="grid grid-cols-5 gap-4 p-6 border-b border-slate-800 bg-slate-950/30">
                    <div className="bg-slate-800/50 rounded-xl p-4 text-center">
                        <div className="text-3xl font-black text-white">{summary.total}</div>
                        <div className="text-xs text-slate-500 uppercase mt-1">Total Tests</div>
                    </div>
                    <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 text-center">
                        <div className="text-3xl font-black text-emerald-400">{summary.passed}</div>
                        <div className="text-xs text-emerald-500 uppercase mt-1">Passed</div>
                    </div>
                    <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-center">
                        <div className="text-3xl font-black text-red-400">{summary.failed}</div>
                        <div className="text-xs text-red-500 uppercase mt-1">Failed</div>
                    </div>
                    <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 text-center">
                        <div className="text-3xl font-black text-amber-400">{summary.timeout}</div>
                        <div className="text-xs text-amber-500 uppercase mt-1">Timeout</div>
                    </div>
                    <div className={`rounded-xl p-4 text-center ${passRate >= 80 ? 'bg-emerald-500/10 border border-emerald-500/20' : passRate >= 50 ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-red-500/10 border border-red-500/20'}`}>
                        <div className={`text-3xl font-black ${passRate >= 80 ? 'text-emerald-400' : passRate >= 50 ? 'text-amber-400' : 'text-red-400'}`}>
                            {passRate}%
                        </div>
                        <div className="text-xs text-slate-500 uppercase mt-1">Pass Rate</div>
                    </div>
                </div>

                {/* Filter Tabs */}
                <div className="flex items-center gap-2 px-6 py-3 border-b border-slate-800 bg-slate-900/50">
                    <span className="text-xs text-slate-500 mr-2">Filter:</span>
                    {(['all', 'PASS', 'FAIL', 'TIMEOUT'] as const).map(status => (
                        <button
                            key={status}
                            onClick={() => setFilterStatus(status)}
                            className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${filterStatus === status
                                ? status === 'all' ? 'bg-indigo-600 text-white' : `${statusConfig[status as keyof typeof statusConfig].bg} ${statusConfig[status as keyof typeof statusConfig].color}`
                                : 'bg-slate-800 text-slate-400 hover:text-white'
                                }`}
                        >
                            {status === 'all' ? 'All' : status}
                        </button>
                    ))}
                </div>

                {/* Results List */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-2">
                    {Object.entries(filteredGroups).map(([namespace, items]) => {
                        const isExpanded = expandedGroups.has(namespace);
                        const groupPassed = items.filter(i => i.status === 'PASS').length;
                        const groupFailed = items.filter(i => i.status === 'FAIL').length;
                        const groupTimeout = items.filter(i => i.status === 'TIMEOUT').length;

                        return (
                            <div key={namespace} className="bg-slate-800/30 rounded-xl overflow-hidden">
                                {/* Group Header */}
                                <div
                                    className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-800/50 transition-colors"
                                    onClick={() => toggleGroup(namespace)}
                                >
                                    {isExpanded ? <ChevronDown size={16} className="text-slate-500" /> : <ChevronRight size={16} className="text-slate-500" />}
                                    <span className="text-sm font-mono text-white flex-1">{namespace}</span>
                                    <div className="flex gap-2">
                                        {groupPassed > 0 && (
                                            <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400">
                                                ✓ {groupPassed}
                                            </span>
                                        )}
                                        {groupFailed > 0 && (
                                            <span className="text-xs px-2 py-0.5 rounded bg-red-500/10 text-red-400">
                                                ✗ {groupFailed}
                                            </span>
                                        )}
                                        {groupTimeout > 0 && (
                                            <span className="text-xs px-2 py-0.5 rounded bg-amber-500/10 text-amber-400">
                                                ⏱ {groupTimeout}
                                            </span>
                                        )}
                                    </div>
                                </div>

                                {/* Group Items */}
                                {isExpanded && (
                                    <div className="border-t border-slate-700/50">
                                        {items.map((item, idx) => {
                                            const cfg = statusConfig[item.status];
                                            const Icon = cfg.icon;
                                            return (
                                                <div
                                                    key={`${item.namespace}-${item.method}-${idx}`}
                                                    className={`flex items-center gap-3 px-4 py-2 ${cfg.bg} border-l-2 ${cfg.border} hover:bg-slate-700/30 cursor-pointer transition-colors`}
                                                    onClick={() => onViewDetail(item)}
                                                >
                                                    <Icon size={14} className={cfg.color} />
                                                    <span className="text-xs font-bold text-slate-300 w-16">{item.method}</span>
                                                    <span className="text-xs text-slate-500 flex-1">
                                                        {item.duration}ms
                                                        {item.error && ` • ${item.error.slice(0, 50)}...`}
                                                    </span>
                                                    <button
                                                        className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            onViewDetail(item);
                                                        }}
                                                    >
                                                        <Eye size={12} /> View
                                                    </button>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between px-6 py-3 border-t border-slate-800 bg-slate-900/50 shrink-0">
                    <div className="text-xs text-slate-500">
                        {Object.keys(filteredGroups).length} protocols • {results.length} total tests
                    </div>
                    <button
                        onClick={onClose}
                        className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold"
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
};

// ==================== 主组件 ====================

interface TestResultViewerProps {
    isOpen: boolean;
    onClose: () => void;
    result: DetailedTestResult | null;
    protocolNamespace?: string;
    protocolMethod?: string;
    onRetry?: () => void;
    // 用于 Diff 对比的预期响应（可选，如果没有则使用 request payload）
    expectedResponse?: any;
}

export const TestResultViewer: React.FC<TestResultViewerProps> = ({
    isOpen,
    onClose,
    result,
    protocolNamespace,
    protocolMethod,
    onRetry,
    expectedResponse
}) => {
    const [activeTab, setActiveTab] = useState<'overview' | 'request' | 'response' | 'diff' | 'schema' | 'threeway'>('overview');
    const [copied, setCopied] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);

    if (!isOpen || !result) return null;

    const statusConfig = {
        PASS: { icon: CheckCircle, color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', label: 'PASSED' },
        FAIL: { icon: XCircle, color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/30', label: 'FAILED' },
        TIMEOUT: { icon: Clock, color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/30', label: 'TIMEOUT' },
        PENDING: { icon: RefreshCw, color: 'text-slate-400', bg: 'bg-slate-500/10', border: 'border-slate-500/30', label: 'PENDING' },
    };

    const status = statusConfig[result.status];
    const StatusIcon = status.icon;

    const handleCopy = (data: any) => {
        navigator.clipboard.writeText(JSON.stringify(data, null, 2));
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    // 准备 Diff 数据
    // 左边：请求发送的 payload（预期）
    // 右边：响应收到的 payload（实际）
    const leftDiffData = expectedResponse || result.request?.message?.payload || {};
    const rightDiffData = result.response?.payload || result.response || {};

    const tabs = [
        { id: 'overview', label: 'Overview', show: true },
        { id: 'request', label: 'Request', show: !!result.request },
        { id: 'response', label: 'Response', show: !!result.response },
        { id: 'diff', label: 'Diff', show: true, icon: ArrowLeftRight },
        { id: 'threeway', label: '3-Way', show: !!result.expectedSchema, icon: BarChart3 },
        { id: 'schema', label: 'Schema', show: !!result.expectedSchema },
    ];

    return (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[100]">
            <div className={`bg-slate-900 border border-slate-700 rounded-2xl flex flex-col overflow-hidden transition-all duration-300 ${isFullscreen ? 'w-[95vw] h-[95vh]' : 'w-[1100px] h-[85vh]'
                }`}>
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/80 shrink-0">
                    <div className="flex items-center gap-4">
                        <div className={`flex items-center gap-2 px-4 py-2 rounded-xl ${status.bg} border ${status.border}`}>
                            <StatusIcon size={18} className={status.color} />
                            <span className={`font-black text-sm ${status.color}`}>{status.label}</span>
                        </div>
                        <div>
                            <div className="text-sm font-bold text-white">{protocolNamespace || 'Unknown Protocol'}</div>
                            <div className="text-xs text-slate-500">
                                Method: {protocolMethod || 'N/A'} • Duration: {result.duration}ms
                                {result.retryCount !== undefined && result.retryCount > 0 && (
                                    <span className="ml-2 text-amber-400">• Retries: {result.retryCount}</span>
                                )}
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {onRetry && result.status !== 'PASS' && (
                            <button
                                onClick={onRetry}
                                className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-lg flex items-center gap-1 transition-colors"
                            >
                                <RefreshCw size={12} /> Retry
                            </button>
                        )}
                        <button
                            onClick={() => setIsFullscreen(!isFullscreen)}
                            className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
                        >
                            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                        </button>
                        <button
                            onClick={onClose}
                            className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
                        >
                            <X size={18} />
                        </button>
                    </div>
                </div>

                {/* Tabs */}
                <div className="flex gap-1 px-4 py-2 border-b border-slate-800 bg-slate-950/30 shrink-0">
                    {tabs.filter(t => t.show).map(tab => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id as any)}
                            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${activeTab === tab.id
                                ? 'bg-indigo-600 text-white'
                                : 'bg-slate-800/50 text-slate-400 hover:text-white hover:bg-slate-800'
                                }`}
                        >
                            {tab.icon && <tab.icon size={12} />}
                            {tab.label}
                        </button>
                    ))}
                </div>

                {/* Content */}
                <div className="flex-1 overflow-hidden flex flex-col">
                    {/* Overview Tab */}
                    {activeTab === 'overview' && (
                        <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-6">
                            {/* Status Summary */}
                            <div className={`p-4 rounded-xl ${status.bg} border ${status.border}`}>
                                <div className="flex items-start gap-4">
                                    <StatusIcon size={32} className={status.color} />
                                    <div className="flex-1">
                                        <div className={`text-lg font-black ${status.color}`}>
                                            Test {status.label}
                                        </div>
                                        <div className="text-sm text-slate-400 mt-1">
                                            {result.status === 'PASS' && 'Response matched expected schema'}
                                            {result.status === 'FAIL' && (result.error || 'Response did not match expected schema')}
                                            {result.status === 'TIMEOUT' && 'Request timed out waiting for response'}
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <div className="text-2xl font-black text-white">{result.duration}ms</div>
                                        <div className="text-xs text-slate-500">Response Time</div>
                                    </div>
                                </div>
                            </div>

                            {/* Schema Errors */}
                            {result.schemaErrors && result.schemaErrors.length > 0 && (
                                <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4">
                                    <div className="flex items-center gap-2 text-red-400 font-bold mb-3">
                                        <AlertTriangle size={16} />
                                        Schema Validation Errors ({result.schemaErrors.length})
                                    </div>
                                    <div className="space-y-2">
                                        {result.schemaErrors.map((err, idx) => (
                                            <div key={idx} className="flex items-start gap-3 bg-slate-900/50 rounded-lg p-3">
                                                <XCircle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
                                                <div className="flex-1 text-sm">
                                                    <div className="font-mono text-amber-400">{err.path}</div>
                                                    <div className="text-slate-400 mt-1">{err.message}</div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Request/Response Preview */}
                            <div className="grid grid-cols-2 gap-4">
                                <div className="bg-slate-950 border border-slate-700 rounded-xl overflow-hidden">
                                    <div className="flex items-center justify-between px-4 py-2 bg-slate-900/50 border-b border-slate-800">
                                        <span className="text-xs font-bold text-blue-400 uppercase">Request Payload</span>
                                        <button
                                            onClick={() => handleCopy(result.request?.message?.payload)}
                                            className="text-slate-500 hover:text-white"
                                        >
                                            {copied ? <Check size={12} /> : <Copy size={12} />}
                                        </button>
                                    </div>
                                    <pre className="p-4 text-xs font-mono text-slate-300 max-h-48 overflow-auto custom-scrollbar">
                                        {result.request?.message?.payload ? JSON.stringify(result.request.message.payload, null, 2) : 'No request data'}
                                    </pre>
                                </div>
                                <div className="bg-slate-950 border border-slate-700 rounded-xl overflow-hidden">
                                    <div className="flex items-center justify-between px-4 py-2 bg-slate-900/50 border-b border-slate-800">
                                        <span className="text-xs font-bold text-emerald-400 uppercase">Response Payload</span>
                                        <button
                                            onClick={() => handleCopy(result.response?.payload)}
                                            className="text-slate-500 hover:text-white"
                                        >
                                            {copied ? <Check size={12} /> : <Copy size={12} />}
                                        </button>
                                    </div>
                                    <pre className="p-4 text-xs font-mono text-slate-300 max-h-48 overflow-auto custom-scrollbar">
                                        {result.response?.payload ? JSON.stringify(result.response.payload, null, 2) : 'No response data'}
                                    </pre>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Request Tab */}
                    {activeTab === 'request' && result.request && (
                        <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-4">
                            <div className="flex items-center justify-between">
                                <h3 className="text-sm font-bold text-white">Request Details</h3>
                                <button
                                    onClick={() => handleCopy(result.request)}
                                    className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs flex items-center gap-1"
                                >
                                    {copied ? <Check size={12} /> : <Copy size={12} />} Copy
                                </button>
                            </div>

                            <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700">
                                <div className="text-xs text-slate-500 uppercase font-bold mb-2">Topic</div>
                                <div className="text-sm text-white font-mono">{result.request.topic}</div>
                            </div>

                            <div className="bg-slate-950 border border-slate-700 rounded-xl overflow-hidden">
                                <div className="px-4 py-2 bg-slate-900/50 border-b border-slate-800">
                                    <span className="text-xs font-bold text-slate-400 uppercase">Full Message</span>
                                </div>
                                <pre className="p-4 text-sm font-mono text-emerald-400 overflow-auto custom-scrollbar max-h-96">
                                    {JSON.stringify(result.request.message, null, 2)}
                                </pre>
                            </div>
                        </div>
                    )}

                    {/* Response Tab */}
                    {activeTab === 'response' && result.response && (
                        <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-4">
                            <div className="flex items-center justify-between">
                                <h3 className="text-sm font-bold text-white">Response Details</h3>
                                <button
                                    onClick={() => handleCopy(result.response)}
                                    className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs flex items-center gap-1"
                                >
                                    {copied ? <Check size={12} /> : <Copy size={12} />} Copy
                                </button>
                            </div>

                            <div className="bg-slate-950 border border-slate-700 rounded-xl overflow-hidden">
                                <div className="px-4 py-2 bg-slate-900/50 border-b border-slate-800">
                                    <span className="text-xs font-bold text-slate-400 uppercase">Full Response</span>
                                </div>
                                <pre className="p-4 text-sm font-mono text-emerald-400 overflow-auto custom-scrollbar max-h-[500px]">
                                    {JSON.stringify(result.response, null, 2)}
                                </pre>
                            </div>
                        </div>
                    )}

                    {/* Diff Tab - Side by Side */}
                    {activeTab === 'diff' && (
                        <div className="flex-1 flex flex-col overflow-hidden">
                            <SideBySideDiff
                                leftJson={leftDiffData}
                                rightJson={rightDiffData}
                                leftTitle="Request Payload (Sent)"
                                rightTitle="Response Payload (Received)"
                            />
                        </div>
                    )}

                    {/* 3-Way Diff Tab */}
                    {activeTab === 'threeway' && (
                        <div className="flex-1 flex flex-col overflow-hidden">
                            <ThreeWayDiff
                                requestPayload={result.request?.message?.payload || {}}
                                expectedSchema={result.expectedSchema}
                                actualResponse={result.response?.payload || result.response || {}}
                            />
                        </div>
                    )}

                    {/* Schema Tab */}
                    {activeTab === 'schema' && result.expectedSchema && (
                        <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-4">
                            <div className="flex items-center justify-between">
                                <h3 className="text-sm font-bold text-white">Expected Response Schema</h3>
                                <button
                                    onClick={() => handleCopy(result.expectedSchema)}
                                    className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs flex items-center gap-1"
                                >
                                    {copied ? <Check size={12} /> : <Copy size={12} />} Copy
                                </button>
                            </div>

                            <div className="bg-slate-950 border border-slate-700 rounded-xl overflow-hidden">
                                <pre className="p-4 text-sm font-mono text-blue-400 overflow-auto custom-scrollbar max-h-[500px]">
                                    {JSON.stringify(result.expectedSchema, null, 2)}
                                </pre>
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between px-6 py-3 border-t border-slate-800 bg-slate-900/50 shrink-0">
                    <div className="flex gap-2">
                        <button
                            onClick={() => handleCopy({
                                namespace: protocolNamespace,
                                method: protocolMethod,
                                ...result
                            })}
                            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs flex items-center gap-1"
                        >
                            <Copy size={12} /> Copy Full Result
                        </button>
                        <button
                            onClick={() => {
                                const data = JSON.stringify({
                                    namespace: protocolNamespace,
                                    method: protocolMethod,
                                    ...result
                                }, null, 2);
                                const blob = new Blob([data], { type: 'application/json' });
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.href = url;
                                a.download = `test_result_${protocolNamespace}_${Date.now()}.json`;
                                a.click();
                                URL.revokeObjectURL(url);
                            }}
                            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs flex items-center gap-1"
                        >
                            <Download size={12} /> Export JSON
                        </button>
                    </div>
                    <button
                        onClick={onClose}
                        className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold"
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
};

export default TestResultViewer;
