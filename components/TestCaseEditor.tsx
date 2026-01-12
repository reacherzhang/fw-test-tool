/**
 * TestCaseEditor - 测试用例编辑器
 * 
 * 功能：
 * 1. 添加/编辑/删除测试用例
 * 2. 参数化测试数据
 * 3. 运行单个或所有测试用例
 * 4. 显示测试用例结果
 */

import React, { useState } from 'react';
import {
    Plus, Trash2, Play, Copy, Check, X, ChevronDown, ChevronRight,
    CheckCircle, XCircle, Clock, AlertTriangle, Edit3, Save, Zap
} from 'lucide-react';

// ==================== 类型定义 ====================

export interface TestCase {
    id: string;
    name: string;
    description?: string;
    requestPayload: any;
    expectedBehavior: 'success' | 'error';
    expectedErrorCode?: number;
    lastResult?: {
        status: 'PASS' | 'FAIL' | 'TIMEOUT';
        duration: number;
        response?: any;
        error?: string;
    };
}

interface TestCaseEditorProps {
    testCases: TestCase[];
    basePayload: any;
    onUpdate: (testCases: TestCase[]) => void;
    onRunCase?: (testCase: TestCase) => Promise<TestCase['lastResult']>;
    onRunAll?: () => void;
    disabled?: boolean;
}

// ==================== 主组件 ====================

export const TestCaseEditor: React.FC<TestCaseEditorProps> = ({
    testCases,
    basePayload,
    onUpdate,
    onRunCase,
    onRunAll,
    disabled = false
}) => {
    const [expandedCases, setExpandedCases] = useState<Set<string>>(new Set());
    const [editingCase, setEditingCase] = useState<string | null>(null);
    const [runningCase, setRunningCase] = useState<string | null>(null);

    const toggleCase = (caseId: string) => {
        setExpandedCases(prev => {
            const next = new Set(prev);
            if (next.has(caseId)) {
                next.delete(caseId);
            } else {
                next.add(caseId);
            }
            return next;
        });
    };

    const addNewCase = () => {
        const newCase: TestCase = {
            id: `case_${Date.now()}`,
            name: `Test Case ${testCases.length + 1}`,
            description: '',
            requestPayload: JSON.parse(JSON.stringify(basePayload || {})),
            expectedBehavior: 'success'
        };
        onUpdate([...testCases, newCase]);
        setExpandedCases(prev => new Set(prev).add(newCase.id));
        setEditingCase(newCase.id);
    };

    const deleteCase = (caseId: string) => {
        onUpdate(testCases.filter(c => c.id !== caseId));
    };

    const updateCase = (caseId: string, updates: Partial<TestCase>) => {
        onUpdate(testCases.map(c => c.id === caseId ? { ...c, ...updates } : c));
    };

    const duplicateCase = (testCase: TestCase) => {
        const newCase: TestCase = {
            ...testCase,
            id: `case_${Date.now()}`,
            name: `${testCase.name} (Copy)`,
            lastResult: undefined
        };
        onUpdate([...testCases, newCase]);
        setExpandedCases(prev => new Set(prev).add(newCase.id));
    };

    const runCase = async (testCase: TestCase) => {
        if (!onRunCase || runningCase) return;
        setRunningCase(testCase.id);
        try {
            const result = await onRunCase(testCase);
            updateCase(testCase.id, { lastResult: result });
        } finally {
            setRunningCase(null);
        }
    };

    const statusConfig = {
        PASS: { icon: CheckCircle, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
        FAIL: { icon: XCircle, color: 'text-red-400', bg: 'bg-red-500/10' },
        TIMEOUT: { icon: Clock, color: 'text-amber-400', bg: 'bg-amber-500/10' }
    };

    if (testCases.length === 0 && !disabled) {
        return (
            <div className="flex flex-col items-center justify-center py-6 border border-dashed border-slate-700 rounded-xl bg-slate-900/30">
                <AlertTriangle size={24} className="text-slate-500 mb-2" />
                <div className="text-xs text-slate-500 mb-3">No test cases defined</div>
                <button
                    onClick={addNewCase}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold transition-colors"
                >
                    <Plus size={12} />
                    Add Test Case
                </button>
            </div>
        );
    }

    return (
        <div className="space-y-2">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="text-xs font-bold text-slate-400 uppercase">
                    Test Cases ({testCases.length})
                </div>
                <div className="flex gap-1">
                    {onRunAll && testCases.length > 0 && (
                        <button
                            onClick={onRunAll}
                            disabled={disabled || !!runningCase}
                            className="flex items-center gap-1 px-2 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-700 text-white text-[10px] font-bold rounded transition-colors"
                        >
                            <Zap size={10} />
                            Run All
                        </button>
                    )}
                    {!disabled && (
                        <button
                            onClick={addNewCase}
                            className="flex items-center gap-1 px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] font-bold rounded transition-colors"
                        >
                            <Plus size={10} />
                            Add
                        </button>
                    )}
                </div>
            </div>

            {/* Test Case List */}
            <div className="space-y-1">
                {testCases.map((testCase) => {
                    const isExpanded = expandedCases.has(testCase.id);
                    const isEditing = editingCase === testCase.id;
                    const isRunning = runningCase === testCase.id;
                    const status = testCase.lastResult?.status;
                    const StatusIcon = status ? statusConfig[status].icon : null;

                    return (
                        <div
                            key={testCase.id}
                            className={`bg-slate-800/30 rounded-lg overflow-hidden border ${status === 'PASS' ? 'border-emerald-500/20' :
                                status === 'FAIL' ? 'border-red-500/20' :
                                    status === 'TIMEOUT' ? 'border-amber-500/20' :
                                        'border-slate-700/50'
                                }`}
                        >
                            {/* Case Header */}
                            <div className="flex items-center gap-2 px-3 py-2">
                                <button
                                    onClick={() => toggleCase(testCase.id)}
                                    className="text-slate-500 hover:text-white transition-colors"
                                >
                                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                </button>

                                {/* Status Indicator */}
                                {StatusIcon && (
                                    <StatusIcon size={14} className={statusConfig[status!].color} />
                                )}

                                {/* Name */}
                                {isEditing ? (
                                    <input
                                        type="text"
                                        value={testCase.name}
                                        onChange={(e) => updateCase(testCase.id, { name: e.target.value })}
                                        onBlur={() => setEditingCase(null)}
                                        onKeyDown={(e) => e.key === 'Enter' && setEditingCase(null)}
                                        autoFocus
                                        className="flex-1 bg-slate-900 border border-indigo-500 rounded px-2 py-0.5 text-xs text-white outline-none"
                                    />
                                ) : (
                                    <span
                                        className="flex-1 text-xs font-medium text-white cursor-pointer hover:text-indigo-400"
                                        onClick={() => !disabled && setEditingCase(testCase.id)}
                                    >
                                        {testCase.name}
                                    </span>
                                )}

                                {/* Expected Behavior Badge */}
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${testCase.expectedBehavior === 'success'
                                    ? 'bg-emerald-500/10 text-emerald-400'
                                    : 'bg-red-500/10 text-red-400'
                                    }`}>
                                    {testCase.expectedBehavior === 'success' ? 'SUCCESS' : 'ERROR'}
                                </span>

                                {/* Duration */}
                                {testCase.lastResult?.duration && (
                                    <span className="text-[10px] text-slate-500">
                                        {testCase.lastResult.duration}ms
                                    </span>
                                )}

                                {/* Actions */}
                                <div className="flex gap-1">
                                    {onRunCase && (
                                        <button
                                            onClick={() => runCase(testCase)}
                                            disabled={disabled || isRunning}
                                            className="p-1 text-slate-500 hover:text-emerald-400 disabled:text-slate-600 transition-colors"
                                            title="Run this test case"
                                        >
                                            {isRunning ? (
                                                <div className="animate-spin"><Clock size={12} /></div>
                                            ) : (
                                                <Play size={12} />
                                            )}
                                        </button>
                                    )}
                                    {!disabled && (
                                        <>
                                            <button
                                                onClick={() => duplicateCase(testCase)}
                                                className="p-1 text-slate-500 hover:text-white transition-colors"
                                                title="Duplicate"
                                            >
                                                <Copy size={12} />
                                            </button>
                                            <button
                                                onClick={() => deleteCase(testCase.id)}
                                                className="p-1 text-slate-500 hover:text-red-400 transition-colors"
                                                title="Delete"
                                            >
                                                <Trash2 size={12} />
                                            </button>
                                        </>
                                    )}
                                </div>
                            </div>

                            {/* Expanded Content */}
                            {isExpanded && (
                                <div className="px-3 pb-3 pt-1 border-t border-slate-700/50 space-y-3">
                                    {/* Description */}
                                    <div>
                                        <label className="text-[10px] text-slate-500 uppercase font-bold">Description</label>
                                        <input
                                            type="text"
                                            value={testCase.description || ''}
                                            onChange={(e) => updateCase(testCase.id, { description: e.target.value })}
                                            placeholder="Optional description..."
                                            disabled={disabled}
                                            className="w-full mt-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-white outline-none focus:border-indigo-500 disabled:opacity-50"
                                        />
                                    </div>

                                    {/* Expected Behavior */}
                                    <div className="flex gap-4">
                                        <div className="flex-1">
                                            <label className="text-[10px] text-slate-500 uppercase font-bold">Expected Behavior</label>
                                            <select
                                                value={testCase.expectedBehavior}
                                                onChange={(e) => updateCase(testCase.id, { expectedBehavior: e.target.value as 'success' | 'error' })}
                                                disabled={disabled}
                                                className="w-full mt-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-white outline-none focus:border-indigo-500 disabled:opacity-50"
                                            >
                                                <option value="success">Success Response</option>
                                                <option value="error">Error Response</option>
                                            </select>
                                        </div>
                                        {testCase.expectedBehavior === 'error' && (
                                            <div className="flex-1">
                                                <label className="text-[10px] text-slate-500 uppercase font-bold">Expected Error Code</label>
                                                <input
                                                    type="number"
                                                    value={testCase.expectedErrorCode || ''}
                                                    onChange={(e) => updateCase(testCase.id, { expectedErrorCode: parseInt(e.target.value) || undefined })}
                                                    placeholder="e.g., -1"
                                                    disabled={disabled}
                                                    className="w-full mt-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-white outline-none focus:border-indigo-500 disabled:opacity-50"
                                                />
                                            </div>
                                        )}
                                    </div>

                                    {/* Request Payload */}
                                    <div>
                                        <label className="text-[10px] text-slate-500 uppercase font-bold">Request Payload</label>
                                        <textarea
                                            value={JSON.stringify(testCase.requestPayload, null, 2)}
                                            onChange={(e) => {
                                                try {
                                                    const parsed = JSON.parse(e.target.value);
                                                    updateCase(testCase.id, { requestPayload: parsed });
                                                } catch {
                                                    // Invalid JSON, ignore
                                                }
                                            }}
                                            disabled={disabled}
                                            rows={6}
                                            className="w-full mt-1 bg-slate-950 border border-slate-700 rounded px-3 py-2 text-xs font-mono text-emerald-400 outline-none focus:border-indigo-500 disabled:opacity-50 custom-scrollbar resize-none"
                                        />
                                    </div>

                                    {/* Last Result */}
                                    {testCase.lastResult && (
                                        <div className={`p-2 rounded-lg ${statusConfig[testCase.lastResult.status].bg}`}>
                                            <div className="flex items-center gap-2 mb-1">
                                                {(() => {
                                                    const ResultIcon = statusConfig[testCase.lastResult.status].icon;
                                                    return <ResultIcon size={12} className={statusConfig[testCase.lastResult.status].color} />;
                                                })()}
                                                <span className={`text-xs font-bold ${statusConfig[testCase.lastResult.status].color}`}>
                                                    {testCase.lastResult.status}
                                                </span>
                                                <span className="text-[10px] text-slate-500">
                                                    {testCase.lastResult.duration}ms
                                                </span>
                                            </div>
                                            {testCase.lastResult.error && (
                                                <div className="text-[10px] text-red-400 mt-1">
                                                    Error: {testCase.lastResult.error}
                                                </div>
                                            )}
                                            {testCase.lastResult.response && (
                                                <pre className="text-[10px] font-mono text-slate-400 mt-1 max-h-24 overflow-auto custom-scrollbar">
                                                    {JSON.stringify(testCase.lastResult.response, null, 2)}
                                                </pre>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default TestCaseEditor;
