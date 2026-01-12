/**
 * TestStatisticsDashboard - 测试统计仪表盘
 * 
 * 功能：
 * 1. 测试历史趋势图
 * 2. 通过率统计
 * 3. 最慢测试排行
 * 4. 失败协议分析
 * 5. 设备覆盖率
 */

import React, { useState, useMemo } from 'react';
import {
    BarChart3, TrendingUp, TrendingDown, Clock, CheckCircle,
    XCircle, AlertTriangle, Zap, Target, Activity, ChevronDown,
    ChevronRight, RefreshCw, Calendar, Filter, Download, X
} from 'lucide-react';

// ==================== 类型定义 ====================

export interface TestRunHistory {
    id: string;
    suiteId: string;
    suiteName: string;
    deviceId: string;
    deviceName: string;
    startTime: number;
    endTime?: number;
    status: 'RUNNING' | 'COMPLETED' | 'FAILED';
    results: Array<{
        protocolId: string;
        namespace: string;
        method: string;
        status: 'PASS' | 'FAIL' | 'TIMEOUT' | 'PENDING';
        duration: number;
        response?: any;
        error?: string;
    }>;
    summary: {
        total: number;
        passed: number;
        failed: number;
        timeout: number;
    };
}

interface StatisticsDashboardProps {
    isOpen: boolean;
    onClose: () => void;
    testHistory: TestRunHistory[];
    onClearHistory?: () => void;
}

// ==================== 辅助组件 ====================

/**
 * 迷你条形图
 */
const MiniBarChart: React.FC<{
    data: Array<{ value: number; color: string }>;
    height?: number;
}> = ({ data, height = 40 }) => {
    const maxValue = Math.max(...data.map(d => d.value), 1);

    return (
        <div className="flex items-end gap-1" style={{ height }}>
            {data.map((item, idx) => (
                <div
                    key={idx}
                    className="flex-1 rounded-t transition-all hover:opacity-80"
                    style={{
                        height: `${(item.value / maxValue) * 100}%`,
                        minHeight: item.value > 0 ? 4 : 0,
                        backgroundColor: item.color
                    }}
                    title={`${item.value}`}
                />
            ))}
        </div>
    );
};

/**
 * 进度环
 */
const ProgressRing: React.FC<{
    value: number;
    size?: number;
    strokeWidth?: number;
    color?: string;
}> = ({ value, size = 80, strokeWidth = 8, color = '#10b981' }) => {
    const radius = (size - strokeWidth) / 2;
    const circumference = radius * 2 * Math.PI;
    const offset = circumference - (value / 100) * circumference;

    return (
        <div className="relative" style={{ width: size, height: size }}>
            <svg width={size} height={size} className="transform -rotate-90">
                <circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    fill="none"
                    stroke="rgba(255,255,255,0.1)"
                    strokeWidth={strokeWidth}
                />
                <circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    fill="none"
                    stroke={color}
                    strokeWidth={strokeWidth}
                    strokeDasharray={circumference}
                    strokeDashoffset={offset}
                    strokeLinecap="round"
                    className="transition-all duration-500"
                />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-xl font-black text-white">{Math.round(value)}%</span>
            </div>
        </div>
    );
};

/**
 * 趋势指示器
 */
const TrendIndicator: React.FC<{
    current: number;
    previous: number;
    suffix?: string;
}> = ({ current, previous, suffix = '%' }) => {
    const diff = current - previous;
    const isPositive = diff >= 0;

    if (previous === 0) return null;

    return (
        <div className={`flex items-center gap-1 text-xs ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
            {isPositive ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            <span>{isPositive ? '+' : ''}{diff.toFixed(1)}{suffix}</span>
        </div>
    );
};

// ==================== 主组件 ====================

export const TestStatisticsDashboard: React.FC<StatisticsDashboardProps> = ({
    isOpen,
    onClose,
    testHistory,
    onClearHistory
}) => {
    const [timeRange, setTimeRange] = useState<'24h' | '7d' | '30d' | 'all'>('7d');
    const [expandedSection, setExpandedSection] = useState<string | null>('overview');

    // 过滤时间范围内的测试
    const filteredHistory = useMemo(() => {
        if (timeRange === 'all') return testHistory;

        const now = Date.now();
        const ranges: Record<string, number> = {
            '24h': 24 * 60 * 60 * 1000,
            '7d': 7 * 24 * 60 * 60 * 1000,
            '30d': 30 * 24 * 60 * 60 * 1000
        };

        return testHistory.filter(t => now - t.startTime < ranges[timeRange]);
    }, [testHistory, timeRange]);

    // 计算统计数据
    const stats = useMemo(() => {
        const totalTests = filteredHistory.reduce((sum, run) => sum + run.summary.total, 0);
        const totalPassed = filteredHistory.reduce((sum, run) => sum + run.summary.passed, 0);
        const totalFailed = filteredHistory.reduce((sum, run) => sum + run.summary.failed, 0);
        const totalTimeout = filteredHistory.reduce((sum, run) => sum + run.summary.timeout, 0);
        const passRate = totalTests > 0 ? (totalPassed / totalTests) * 100 : 0;

        // 按天分组统计（最近7天）
        const dailyStats: Array<{ date: string; passed: number; failed: number; timeout: number }> = [];
        const today = new Date();
        for (let i = 6; i >= 0; i--) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            const dateStr = date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });

            const dayStart = new Date(date.setHours(0, 0, 0, 0)).getTime();
            const dayEnd = new Date(date.setHours(23, 59, 59, 999)).getTime();

            const dayRuns = filteredHistory.filter(r => r.startTime >= dayStart && r.startTime <= dayEnd);
            dailyStats.push({
                date: dateStr,
                passed: dayRuns.reduce((sum, r) => sum + r.summary.passed, 0),
                failed: dayRuns.reduce((sum, r) => sum + r.summary.failed, 0),
                timeout: dayRuns.reduce((sum, r) => sum + r.summary.timeout, 0)
            });
        }

        // 最慢的测试
        const allResults = filteredHistory.flatMap(run =>
            run.results.map(r => ({
                ...r,
                suiteName: run.suiteName,
                deviceName: run.deviceName,
                runTime: run.startTime
            }))
        );
        const slowestTests = [...allResults]
            .sort((a, b) => b.duration - a.duration)
            .slice(0, 5);

        // 失败最多的协议
        const failureMap: Record<string, { namespace: string; method: string; count: number; lastError?: string }> = {};
        allResults.filter(r => r.status !== 'PASS').forEach(r => {
            const key = `${r.namespace}:${r.method}`;
            if (!failureMap[key]) {
                failureMap[key] = { namespace: r.namespace, method: r.method, count: 0 };
            }
            failureMap[key].count++;
            failureMap[key].lastError = r.error;
        });
        const topFailures = Object.values(failureMap)
            .sort((a, b) => b.count - a.count)
            .slice(0, 5);

        // 设备测试覆盖
        const deviceStats: Record<string, { name: string; runs: number; passRate: number }> = {};
        filteredHistory.forEach(run => {
            if (!deviceStats[run.deviceId]) {
                deviceStats[run.deviceId] = { name: run.deviceName, runs: 0, passRate: 0 };
            }
            deviceStats[run.deviceId].runs++;
            const rate = run.summary.total > 0 ? run.summary.passed / run.summary.total : 0;
            deviceStats[run.deviceId].passRate = (deviceStats[run.deviceId].passRate * (deviceStats[run.deviceId].runs - 1) + rate * 100) / deviceStats[run.deviceId].runs;
        });

        // 计算上一时间段的通过率用于趋势对比
        const previousPassRate = (() => {
            if (timeRange === 'all') return passRate;
            const now = Date.now();
            const ranges: Record<string, number> = {
                '24h': 24 * 60 * 60 * 1000,
                '7d': 7 * 24 * 60 * 60 * 1000,
                '30d': 30 * 24 * 60 * 60 * 1000
            };
            const previousHistory = testHistory.filter(t =>
                now - t.startTime >= ranges[timeRange] &&
                now - t.startTime < ranges[timeRange] * 2
            );
            const prevTotal = previousHistory.reduce((sum, run) => sum + run.summary.total, 0);
            const prevPassed = previousHistory.reduce((sum, run) => sum + run.summary.passed, 0);
            return prevTotal > 0 ? (prevPassed / prevTotal) * 100 : passRate;
        })();

        return {
            totalRuns: filteredHistory.length,
            totalTests,
            totalPassed,
            totalFailed,
            totalTimeout,
            passRate,
            previousPassRate,
            dailyStats,
            slowestTests,
            topFailures,
            deviceStats: Object.values(deviceStats),
            avgDuration: allResults.length > 0
                ? allResults.reduce((sum, r) => sum + r.duration, 0) / allResults.length
                : 0
        };
    }, [filteredHistory, testHistory, timeRange]);

    if (!isOpen) return null;

    const toggleSection = (section: string) => {
        setExpandedSection(expandedSection === section ? null : section);
    };

    return (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[100]">
            <div className="bg-slate-900 border border-slate-700 rounded-2xl w-[1200px] max-h-[90vh] flex flex-col overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/80 shrink-0">
                    <div className="flex items-center gap-4">
                        <div className="p-2 bg-indigo-500/10 rounded-xl">
                            <BarChart3 size={24} className="text-indigo-400" />
                        </div>
                        <div>
                            <div className="text-lg font-black text-white">Test Statistics Dashboard</div>
                            <div className="text-xs text-slate-500">
                                {stats.totalRuns} test runs • {stats.totalTests} total tests
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        {/* Time Range Filter */}
                        <div className="flex gap-1 bg-slate-800 rounded-lg p-1">
                            {(['24h', '7d', '30d', 'all'] as const).map(range => (
                                <button
                                    key={range}
                                    onClick={() => setTimeRange(range)}
                                    className={`px-3 py-1 rounded text-xs font-bold transition-all ${timeRange === range
                                        ? 'bg-indigo-600 text-white'
                                        : 'text-slate-400 hover:text-white'
                                        }`}
                                >
                                    {range === 'all' ? 'All' : range}
                                </button>
                            ))}
                        </div>
                        {onClearHistory && testHistory.length > 0 && (
                            <button
                                onClick={onClearHistory}
                                className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg text-xs font-bold"
                            >
                                Clear History
                            </button>
                        )}
                        <button
                            onClick={onClose}
                            className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
                        >
                            <X size={18} />
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-6">
                    {/* No Data */}
                    {testHistory.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-20 text-slate-500">
                            <Activity size={48} className="mb-4 opacity-50" />
                            <div className="text-lg font-bold">No Test History</div>
                            <div className="text-sm">Run some tests to see statistics here</div>
                        </div>
                    ) : (
                        <>
                            {/* Overview Cards */}
                            <div className="grid grid-cols-5 gap-4">
                                {/* Pass Rate */}
                                <div className="col-span-1 bg-gradient-to-br from-indigo-500/10 to-purple-500/10 border border-indigo-500/20 rounded-xl p-4 flex flex-col items-center">
                                    <ProgressRing
                                        value={stats.passRate}
                                        color={stats.passRate >= 80 ? '#10b981' : stats.passRate >= 50 ? '#f59e0b' : '#ef4444'}
                                    />
                                    <div className="text-xs text-slate-400 mt-2">Pass Rate</div>
                                    <TrendIndicator current={stats.passRate} previous={stats.previousPassRate} />
                                </div>

                                {/* Total Tests */}
                                <div className="bg-slate-800/50 rounded-xl p-4">
                                    <div className="flex items-center gap-2 text-slate-400 mb-2">
                                        <Target size={14} />
                                        <span className="text-xs uppercase font-bold">Total Tests</span>
                                    </div>
                                    <div className="text-3xl font-black text-white">{stats.totalTests}</div>
                                    <div className="text-xs text-slate-500 mt-1">{stats.totalRuns} runs</div>
                                </div>

                                {/* Passed */}
                                <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4">
                                    <div className="flex items-center gap-2 text-emerald-400 mb-2">
                                        <CheckCircle size={14} />
                                        <span className="text-xs uppercase font-bold">Passed</span>
                                    </div>
                                    <div className="text-3xl font-black text-emerald-400">{stats.totalPassed}</div>
                                    <div className="text-xs text-emerald-500/70 mt-1">
                                        {stats.totalTests > 0 ? ((stats.totalPassed / stats.totalTests) * 100).toFixed(1) : 0}%
                                    </div>
                                </div>

                                {/* Failed */}
                                <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
                                    <div className="flex items-center gap-2 text-red-400 mb-2">
                                        <XCircle size={14} />
                                        <span className="text-xs uppercase font-bold">Failed</span>
                                    </div>
                                    <div className="text-3xl font-black text-red-400">{stats.totalFailed}</div>
                                    <div className="text-xs text-red-500/70 mt-1">
                                        {stats.totalTests > 0 ? ((stats.totalFailed / stats.totalTests) * 100).toFixed(1) : 0}%
                                    </div>
                                </div>

                                {/* Avg Duration */}
                                <div className="bg-slate-800/50 rounded-xl p-4">
                                    <div className="flex items-center gap-2 text-slate-400 mb-2">
                                        <Clock size={14} />
                                        <span className="text-xs uppercase font-bold">Avg Duration</span>
                                    </div>
                                    <div className="text-3xl font-black text-white">{Math.round(stats.avgDuration)}</div>
                                    <div className="text-xs text-slate-500 mt-1">milliseconds</div>
                                </div>
                            </div>

                            {/* Daily Trend Chart */}
                            <div className="bg-slate-800/30 rounded-xl p-6 border border-slate-700">
                                <div className="flex items-center justify-between mb-4">
                                    <div className="text-sm font-bold text-white">Daily Test Results (Last 7 Days)</div>
                                </div>
                                <div className="flex items-end gap-2 h-32">
                                    {stats.dailyStats.map((day, idx) => {
                                        const total = day.passed + day.failed + day.timeout;
                                        const passedHeight = total > 0 ? (day.passed / Math.max(...stats.dailyStats.map(d => d.passed + d.failed + d.timeout), 1)) * 100 : 0;
                                        const failedHeight = total > 0 ? (day.failed / Math.max(...stats.dailyStats.map(d => d.passed + d.failed + d.timeout), 1)) * 100 : 0;
                                        const timeoutHeight = total > 0 ? (day.timeout / Math.max(...stats.dailyStats.map(d => d.passed + d.failed + d.timeout), 1)) * 100 : 0;

                                        return (
                                            <div key={idx} className="flex-1 flex flex-col items-center">
                                                <div className="w-full flex flex-col gap-0.5" style={{ height: 100 }}>
                                                    <div
                                                        className="w-full bg-emerald-500 rounded-t transition-all"
                                                        style={{ height: `${passedHeight}%`, minHeight: passedHeight > 0 ? 2 : 0 }}
                                                        title={`Passed: ${day.passed}`}
                                                    />
                                                    <div
                                                        className="w-full bg-red-500 transition-all"
                                                        style={{ height: `${failedHeight}%`, minHeight: failedHeight > 0 ? 2 : 0 }}
                                                        title={`Failed: ${day.failed}`}
                                                    />
                                                    <div
                                                        className="w-full bg-amber-500 rounded-b transition-all"
                                                        style={{ height: `${timeoutHeight}%`, minHeight: timeoutHeight > 0 ? 2 : 0 }}
                                                        title={`Timeout: ${day.timeout}`}
                                                    />
                                                </div>
                                                <div className="text-[10px] text-slate-500 mt-2">{day.date}</div>
                                            </div>
                                        );
                                    })}
                                </div>
                                <div className="flex gap-4 justify-center mt-4">
                                    <div className="flex items-center gap-2 text-xs text-slate-400">
                                        <div className="w-3 h-3 bg-emerald-500 rounded" />
                                        Passed
                                    </div>
                                    <div className="flex items-center gap-2 text-xs text-slate-400">
                                        <div className="w-3 h-3 bg-red-500 rounded" />
                                        Failed
                                    </div>
                                    <div className="flex items-center gap-2 text-xs text-slate-400">
                                        <div className="w-3 h-3 bg-amber-500 rounded" />
                                        Timeout
                                    </div>
                                </div>
                            </div>

                            {/* Two Column Layout */}
                            <div className="grid grid-cols-2 gap-6">
                                {/* Slowest Tests */}
                                <div className="bg-slate-800/30 rounded-xl p-4 border border-slate-700">
                                    <div
                                        className="flex items-center justify-between cursor-pointer"
                                        onClick={() => toggleSection('slowest')}
                                    >
                                        <div className="flex items-center gap-2 text-sm font-bold text-white">
                                            <Zap size={14} className="text-amber-400" />
                                            Slowest Tests
                                        </div>
                                        {expandedSection === 'slowest' ? <ChevronDown size={16} className="text-slate-500" /> : <ChevronRight size={16} className="text-slate-500" />}
                                    </div>
                                    {expandedSection === 'slowest' && (
                                        <div className="mt-4 space-y-2">
                                            {stats.slowestTests.length === 0 ? (
                                                <div className="text-xs text-slate-500 text-center py-4">No test data</div>
                                            ) : (
                                                stats.slowestTests.map((test, idx) => (
                                                    <div key={idx} className="flex items-center gap-3 p-2 bg-slate-900/50 rounded-lg">
                                                        <div className="w-6 h-6 flex items-center justify-center bg-amber-500/10 text-amber-400 rounded-full text-xs font-bold">
                                                            {idx + 1}
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <div className="text-xs font-mono text-white truncate">{test.namespace}</div>
                                                            <div className="text-[10px] text-slate-500">{test.method}</div>
                                                        </div>
                                                        <div className="text-sm font-bold text-amber-400">{test.duration}ms</div>
                                                    </div>
                                                ))
                                            )}
                                        </div>
                                    )}
                                </div>

                                {/* Top Failures */}
                                <div className="bg-slate-800/30 rounded-xl p-4 border border-slate-700">
                                    <div
                                        className="flex items-center justify-between cursor-pointer"
                                        onClick={() => toggleSection('failures')}
                                    >
                                        <div className="flex items-center gap-2 text-sm font-bold text-white">
                                            <AlertTriangle size={14} className="text-red-400" />
                                            Top Failing Protocols
                                        </div>
                                        {expandedSection === 'failures' ? <ChevronDown size={16} className="text-slate-500" /> : <ChevronRight size={16} className="text-slate-500" />}
                                    </div>
                                    {expandedSection === 'failures' && (
                                        <div className="mt-4 space-y-2">
                                            {stats.topFailures.length === 0 ? (
                                                <div className="text-xs text-emerald-400 text-center py-4">✓ No failures!</div>
                                            ) : (
                                                stats.topFailures.map((failure, idx) => (
                                                    <div key={idx} className="flex items-center gap-3 p-2 bg-red-500/5 border border-red-500/10 rounded-lg">
                                                        <div className="w-6 h-6 flex items-center justify-center bg-red-500/10 text-red-400 rounded-full text-xs font-bold">
                                                            {failure.count}
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <div className="text-xs font-mono text-white truncate">{failure.namespace}</div>
                                                            <div className="text-[10px] text-slate-500">{failure.method}</div>
                                                        </div>
                                                        <XCircle size={14} className="text-red-400" />
                                                    </div>
                                                ))
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Device Coverage */}
                            {stats.deviceStats.length > 0 && (
                                <div className="bg-slate-800/30 rounded-xl p-4 border border-slate-700">
                                    <div className="text-sm font-bold text-white mb-4">Device Test Coverage</div>
                                    <div className="grid grid-cols-3 gap-4">
                                        {stats.deviceStats.map((device, idx) => (
                                            <div key={idx} className="flex items-center gap-3 p-3 bg-slate-900/50 rounded-lg">
                                                <div className="w-10 h-10 flex items-center justify-center bg-indigo-500/10 text-indigo-400 rounded-lg">
                                                    <Activity size={18} />
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <div className="text-xs font-bold text-white truncate">{device.name}</div>
                                                    <div className="text-[10px] text-slate-500">{device.runs} runs</div>
                                                </div>
                                                <div className={`text-sm font-bold ${device.passRate >= 80 ? 'text-emerald-400' : device.passRate >= 50 ? 'text-amber-400' : 'text-red-400'}`}>
                                                    {device.passRate.toFixed(0)}%
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Recent Runs */}
                            <div className="bg-slate-800/30 rounded-xl p-4 border border-slate-700">
                                <div className="text-sm font-bold text-white mb-4">Recent Test Runs</div>
                                <div className="space-y-2 max-h-48 overflow-y-auto custom-scrollbar">
                                    {filteredHistory.slice(0, 10).map((run, idx) => {
                                        const passRate = run.summary.total > 0
                                            ? (run.summary.passed / run.summary.total) * 100
                                            : 0;
                                        return (
                                            <div key={run.id || idx} className="flex items-center gap-3 p-2 bg-slate-900/50 rounded-lg">
                                                <div className={`w-2 h-2 rounded-full ${passRate === 100 ? 'bg-emerald-500' : passRate >= 80 ? 'bg-amber-500' : 'bg-red-500'}`} />
                                                <div className="flex-1 min-w-0">
                                                    <div className="text-xs font-bold text-white truncate">{run.suiteName}</div>
                                                    <div className="text-[10px] text-slate-500">{run.deviceName}</div>
                                                </div>
                                                <div className="text-xs text-slate-400">
                                                    {new Date(run.startTime).toLocaleString('zh-CN', {
                                                        month: 'short',
                                                        day: 'numeric',
                                                        hour: '2-digit',
                                                        minute: '2-digit'
                                                    })}
                                                </div>
                                                <div className="flex gap-1 text-[10px]">
                                                    <span className="px-1.5 py-0.5 bg-emerald-500/10 text-emerald-400 rounded">
                                                        ✓{run.summary.passed}
                                                    </span>
                                                    {run.summary.failed > 0 && (
                                                        <span className="px-1.5 py-0.5 bg-red-500/10 text-red-400 rounded">
                                                            ✗{run.summary.failed}
                                                        </span>
                                                    )}
                                                    {run.summary.timeout > 0 && (
                                                        <span className="px-1.5 py-0.5 bg-amber-500/10 text-amber-400 rounded">
                                                            ⏱{run.summary.timeout}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between px-6 py-3 border-t border-slate-800 bg-slate-900/50 shrink-0">
                    <div className="text-xs text-slate-500">
                        Data from {timeRange === 'all' ? 'all time' : `last ${timeRange}`}
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

export default TestStatisticsDashboard;
