/**
 * ExecutionPlanEditor - 协议测试执行计划编辑器
 * 
 * 功能：
 * 1. 切换默认/自定义执行模式
 * 2. 添加/编辑/删除/排序执行步骤
 * 3. 各类型步骤的配置表单
 * 4. 快速模板一键生成
 */

import React, { useState } from 'react';
import {
    Plus, Trash2, GripVertical, Send, Clock, Hand, Edit3, Link,
    ChevronDown, ChevronRight, ArrowDown, Settings, Zap,
    AlertTriangle, Check, X, ArrowUp, Terminal
} from 'lucide-react';

// ==================== 类型定义 ====================

/** 测试步骤类型 */
export type StepType =
    | 'send_request'    // 发送请求并等待 ACK
    | 'wait_push'       // 等待设备主动 PUSH
    | 'delay'           // 固定延时等待
    | 'manual_action'   // 手动操作（暂停等待用户确认）
    | 'manual_input'    // 手动输入/修改 payload 字段值
    | 'prerequisite'    // 执行前置协议
    | 'wait_serial';    // 串口监控（用于无网络交互，设备直接主动上报的情况）

/** 手动输入字段定义 */
export interface ManualField {
    path: string;           // JSON 路径，如 "toggle.0.channel"
    label: string;          // 显示标签，如 "通道号"
    type: 'string' | 'number' | 'boolean';
    defaultValue?: any;     // 默认值
    hint?: string;          // 输入提示
}

/** 步骤配置 */
export interface StepConfig {
    // send_request
    method?: 'GET' | 'SET' | 'PUSH' | 'SYNC' | 'DELETE';
    payloadOverride?: string;
    validateSchema?: boolean;

    // wait_push
    pushNamespace?: string;

    // delay
    duration?: number;

    // manual_action
    instruction?: string;
    confirmText?: string;
    timeoutWarning?: number;

    // manual_input
    fields?: ManualField[];
    targetMethod?: 'GET' | 'SET' | 'PUSH' | 'SYNC' | 'DELETE';

    // prerequisite
    protocolId?: string;
    protocolNamespace?: string;
    prerequisiteMethod?: 'GET' | 'SET' | 'PUSH' | 'SYNC' | 'DELETE';
    failAction?: 'stop' | 'continue';

    // wait_serial
    serialNamespace?: string;
    serialMatchRegex?: string;
}

/** 单个测试步骤 */
export interface TestStep {
    id: string;
    type: StepType;
    order: number;
    config: StepConfig;
    description?: string;
    timeout?: number;
    continueOnFail?: boolean;
}

/** 测试执行计划 */
export interface TestExecutionPlan {
    enabled: boolean;
    steps: TestStep[];
    description?: string;
    totalTimeout?: number;
}

// ==================== 常量 ====================

const STEP_TYPE_INFO: Record<StepType, { icon: React.ReactNode; label: string; color: string; description: string }> = {
    send_request: { icon: <Send size={14} />, label: '发送请求', color: 'text-blue-400', description: '发送 GET/SET/DELETE/SYNC 请求并等待响应' },
    wait_push: { icon: <ArrowDown size={14} />, label: '等待 PUSH', color: 'text-purple-400', description: '等待设备主动推送消息' },
    delay: { icon: <Clock size={14} />, label: '延时等待', color: 'text-cyan-400', description: '固定时间延时' },
    manual_action: { icon: <Hand size={14} />, label: '手动操作', color: 'text-amber-400', description: '暂停等待人工操作设备' },
    manual_input: { icon: <Edit3 size={14} />, label: '手动输入', color: 'text-emerald-400', description: '执行前修改 payload 字段值' },
    prerequisite: { icon: <Link size={14} />, label: '前置协议', color: 'text-rose-400', description: '先执行其他协议' },
    wait_serial: { icon: <Terminal size={14} />, label: '串口监控', color: 'text-orange-400', description: '监控串口日志以验证设备主动请求' },
};

const METHOD_COLORS: Record<string, { bg: string; text: string }> = {
    GET: { bg: 'bg-blue-500', text: 'text-blue-400' },
    SET: { bg: 'bg-amber-500', text: 'text-amber-400' },
    PUSH: { bg: 'bg-purple-500', text: 'text-purple-400' },
    SYNC: { bg: 'bg-cyan-500', text: 'text-cyan-400' },
    DELETE: { bg: 'bg-red-500', text: 'text-red-400' },
};

interface QuickTemplate {
    name: string;
    description: string;
    steps: Omit<TestStep, 'id'>[];
}

const QUICK_TEMPLATES: QuickTemplate[] = [
    {
        name: '仅 GET',
        description: '发送 GET 请求验证响应',
        steps: [
            { type: 'send_request', order: 0, config: { method: 'GET', validateSchema: true } },
        ],
    },
    {
        name: 'SET → GET',
        description: '设置后验证',
        steps: [
            { type: 'send_request', order: 0, config: { method: 'SET', validateSchema: true } },
            { type: 'send_request', order: 1, config: { method: 'GET', validateSchema: true } },
        ],
    },
    {
        name: 'SET → PUSH → GET',
        description: '设置后等待推送再验证',
        steps: [
            { type: 'send_request', order: 0, config: { method: 'SET', validateSchema: true } },
            { type: 'delay', order: 1, config: { duration: 2000 }, description: '等待设备处理' },
            { type: 'wait_push', order: 2, config: { validateSchema: true }, timeout: 15000 },
            { type: 'send_request', order: 3, config: { method: 'GET', validateSchema: true } },
        ],
    },
    {
        name: 'SET → 手动 → GET',
        description: '设置后需要手动操作',
        steps: [
            { type: 'send_request', order: 0, config: { method: 'SET', validateSchema: true } },
            { type: 'manual_action', order: 1, config: { instruction: '请执行手动操作', confirmText: '已完成，继续' } },
            { type: 'send_request', order: 2, config: { method: 'GET', validateSchema: true } },
        ],
    },
    {
        name: '输入 → SET → PUSH → GET → DELETE',
        description: '完整 CRUD 带手动输入',
        steps: [
            { type: 'manual_input', order: 0, config: { fields: [], targetMethod: 'SET' }, description: '输入测试参数' },
            { type: 'send_request', order: 1, config: { method: 'SET', validateSchema: true } },
            { type: 'delay', order: 2, config: { duration: 3000 }, description: '等待设备处理' },
            { type: 'wait_push', order: 3, config: { validateSchema: true }, timeout: 15000 },
            { type: 'send_request', order: 4, config: { method: 'GET', validateSchema: true } },
            { type: 'send_request', order: 5, config: { method: 'DELETE', validateSchema: true } },
        ],
    },
    {
        name: '完整 CRUD',
        description: 'SET → PUSH → GET → DELETE',
        steps: [
            { type: 'send_request', order: 0, config: { method: 'SET', validateSchema: true } },
            { type: 'wait_push', order: 1, config: { validateSchema: true }, timeout: 10000 },
            { type: 'send_request', order: 2, config: { method: 'GET', validateSchema: true } },
            { type: 'send_request', order: 3, config: { method: 'DELETE', validateSchema: true } },
        ],
    },
];

// ==================== Props ====================

interface ProtocolRef {
    id: string;
    namespace: string;
    name: string;
}

interface ExecutionPlanEditorProps {
    plan?: TestExecutionPlan;
    protocol: ProtocolRef & { methods: Record<string, any> };
    allProtocols: ProtocolRef[];
    onChange: (plan: TestExecutionPlan) => void;
}

// ==================== Helper ====================

function generateStepId(): string {
    return `step_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

function getDefaultStepConfig(type: StepType): StepConfig {
    switch (type) {
        case 'send_request': return { method: 'GET', validateSchema: true };
        case 'wait_push': return { validateSchema: true };
        case 'delay': return { duration: 3000 };
        case 'manual_action': return { instruction: '请执行手动操作', confirmText: '已完成，继续' };
        case 'manual_input': return { fields: [], targetMethod: 'SET' };
        case 'prerequisite': return { prerequisiteMethod: 'GET', failAction: 'stop' };
        case 'wait_serial': return { serialNamespace: '' };
    }
}

function getDefaultTimeout(type: StepType): number | undefined {
    switch (type) {
        case 'send_request': return 5000;
        case 'wait_push': return 15000;
        case 'wait_serial': return 30000;
        default: return undefined;
    }
}

// ==================== 步骤配置表单子组件 ====================

function SendRequestConfig({ step, onChange }: { step: TestStep; onChange: (s: TestStep) => void }) {
    const methods = ['GET', 'SET', 'SYNC', 'DELETE'] as const;
    return (
        <div className="space-y-2">
            <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 w-16 shrink-0">Method:</span>
                <div className="flex gap-1">
                    {methods.map(m => (
                        <button key={m}
                            onClick={() => onChange({ ...step, config: { ...step.config, method: m } })}
                            className={`px-2 py-0.5 rounded text-xs font-bold transition-colors ${step.config.method === m
                                ? `${METHOD_COLORS[m].bg} text-white`
                                : 'bg-slate-800 text-slate-500 hover:text-slate-300'
                                }`}
                        >{m}</button>
                    ))}
                </div>
            </div>
            <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 w-16 shrink-0">超时:</span>
                <input type="number" value={step.timeout || 5000}
                    onChange={e => onChange({ ...step, timeout: parseInt(e.target.value) || 5000 })}
                    className="w-24 bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-xs text-white"
                />
                <span className="text-xs text-slate-600">ms</span>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={step.config.validateSchema !== false}
                    onChange={e => onChange({ ...step, config: { ...step.config, validateSchema: e.target.checked } })}
                    className="rounded border-slate-600"
                />
                <span className="text-xs text-slate-400">校验响应 Schema</span>
            </label>
        </div>
    );
}

function WaitPushConfig({ step, onChange }: { step: TestStep; onChange: (s: TestStep) => void }) {
    return (
        <div className="space-y-2">
            <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 w-16 shrink-0">超时:</span>
                <input type="number" value={step.timeout || 15000}
                    onChange={e => onChange({ ...step, timeout: parseInt(e.target.value) || 15000 })}
                    className="w-24 bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-xs text-white"
                />
                <span className="text-xs text-slate-600">ms</span>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={step.config.validateSchema !== false}
                    onChange={e => onChange({ ...step, config: { ...step.config, validateSchema: e.target.checked } })}
                    className="rounded border-slate-600"
                />
                <span className="text-xs text-slate-400">校验 PUSH Schema</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={step.continueOnFail === true}
                    onChange={e => onChange({ ...step, continueOnFail: e.target.checked })}
                    className="rounded border-slate-600"
                />
                <span className="text-xs text-slate-400">超时后继续执行</span>
            </label>
        </div>
    );
}

function DelayConfig({ step, onChange }: { step: TestStep; onChange: (s: TestStep) => void }) {
    return (
        <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 w-16 shrink-0">等待:</span>
            <input type="number" value={step.config.duration || 3000}
                onChange={e => onChange({ ...step, config: { ...step.config, duration: parseInt(e.target.value) || 1000 } })}
                className="w-24 bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-xs text-white"
            />
            <span className="text-xs text-slate-600">ms</span>
            <span className="text-xs text-slate-700 ml-2">({((step.config.duration || 3000) / 1000).toFixed(1)}秒)</span>
        </div>
    );
}

function ManualActionConfig({ step, onChange }: { step: TestStep; onChange: (s: TestStep) => void }) {
    return (
        <div className="space-y-2">
            <div className="flex items-start gap-2">
                <span className="text-xs text-slate-500 w-16 shrink-0 pt-1">提示语:</span>
                <textarea value={step.config.instruction || ''}
                    onChange={e => onChange({ ...step, config: { ...step.config, instruction: e.target.value } })}
                    placeholder="请将设备断电后重新上电..."
                    className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white resize-none h-14"
                />
            </div>
            <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 w-16 shrink-0">按钮:</span>
                <input type="text" value={step.config.confirmText || '已完成，继续'}
                    onChange={e => onChange({ ...step, config: { ...step.config, confirmText: e.target.value } })}
                    className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-xs text-white"
                />
            </div>
        </div>
    );
}

function ManualInputConfig({ step, protocol, onChange }: { step: TestStep; protocol: any; onChange: (s: TestStep) => void }) {
    const fields = step.config.fields || [];
    const methods = ['GET', 'SET', 'SYNC', 'DELETE'] as const;
    const uId = React.useId();

    const getAvailablePaths = () => {
        const methodPayload = protocol?.methods?.[step.config.targetMethod || 'SET']?.payload;
        if (!methodPayload) return [];
        try {
            const obj = JSON.parse(methodPayload);
            const paths: string[] = [];
            const extract = (current: any, prefix: string) => {
                if (current && typeof current === 'object' && !Array.isArray(current)) {
                    for (const key in current) {
                        extract(current[key], prefix ? `${prefix}.${key}` : key);
                    }
                } else if (Array.isArray(current)) {
                    current.forEach((item, idx) => {
                        extract(item, `${prefix}.${idx}`);
                    });
                } else {
                    if (prefix) paths.push(prefix);
                }
            };
            extract(obj, '');
            return paths;
        } catch {
            return [];
        }
    };

    const availablePaths = getAvailablePaths();

    const addField = () => {
        const newFields = [...fields, { path: '', label: '', type: 'string' as const, defaultValue: '' }];
        onChange({ ...step, config: { ...step.config, fields: newFields } });
    };

    const updateField = (idx: number, updates: Partial<ManualField>) => {
        const newFields = fields.map((f, i) => i === idx ? { ...f, ...updates } : f);
        onChange({ ...step, config: { ...step.config, fields: newFields } });
    };

    const removeField = (idx: number) => {
        onChange({ ...step, config: { ...step.config, fields: fields.filter((_, i) => i !== idx) } });
    };

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 w-16 shrink-0">应用到:</span>
                <div className="flex gap-1">
                    {methods.map(m => (
                        <button key={m}
                            onClick={() => onChange({ ...step, config: { ...step.config, targetMethod: m } })}
                            className={`px-2 py-0.5 rounded text-xs font-bold transition-colors ${step.config.targetMethod === m
                                ? `${METHOD_COLORS[m].bg} text-white`
                                : 'bg-slate-800 text-slate-500 hover:text-slate-300'
                                }`}
                        >{m}</button>
                    ))}
                </div>
            </div>

            <div className="space-y-1.5">
                <span className="text-xs text-slate-500">字段列表:</span>
                {fields.map((field, idx) => (
                    <div key={idx} className="flex items-center gap-1.5 pl-2 relative">
                        <div className="flex-1">
                            <input
                                list={`paths-${uId}-${idx}`}
                                value={field.path}
                                placeholder="JSON路径 (如 key.userId)"
                                onChange={e => updateField(idx, { path: e.target.value })}
                                className="w-full bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-white font-mono"
                            />
                            <datalist id={`paths-${uId}-${idx}`}>
                                {availablePaths.map(p => <option key={p} value={p} />)}
                            </datalist>
                        </div>
                        <input value={field.label} placeholder="标签"
                            onChange={e => updateField(idx, { label: e.target.value })}
                            className="w-20 bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-white"
                        />
                        <select value={field.type}
                            onChange={e => updateField(idx, { type: e.target.value as ManualField['type'] })}
                            className="w-20 bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-xs text-white"
                        >
                            <option value="string">string</option>
                            <option value="number">number</option>
                            <option value="boolean">boolean</option>
                        </select>
                        <input value={field.defaultValue ?? ''} placeholder="默认值"
                            onChange={e => updateField(idx, { defaultValue: e.target.value })}
                            className="w-20 bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-white"
                        />
                        <button onClick={() => removeField(idx)} className="text-slate-600 hover:text-red-400 transition-colors">
                            <X size={12} />
                        </button>
                    </div>
                ))}
                <button onClick={addField} className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 pl-2">
                    <Plus size={12} /> 添加字段
                </button>
            </div>
        </div>
    );
}

function PrerequisiteConfig({ step, allProtocols, onChange }: { step: TestStep; allProtocols: ProtocolRef[]; onChange: (s: TestStep) => void }) {
    const methods = ['GET', 'SET', 'SYNC', 'DELETE'] as const;
    return (
        <div className="space-y-2">
            <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 w-16 shrink-0">协议:</span>
                <select value={step.config.protocolId || ''}
                    onChange={e => {
                        const proto = allProtocols.find(p => p.id === e.target.value);
                        onChange({
                            ...step, config: {
                                ...step.config,
                                protocolId: e.target.value,
                                protocolNamespace: proto?.namespace || ''
                            }
                        });
                    }}
                    className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-xs text-white"
                >
                    <option value="">选择前置协议...</option>
                    {allProtocols.map(p => (
                        <option key={p.id} value={p.id}>{p.namespace}</option>
                    ))}
                </select>
            </div>
            <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 w-16 shrink-0">Method:</span>
                <div className="flex gap-1">
                    {methods.map(m => (
                        <button key={m}
                            onClick={() => onChange({ ...step, config: { ...step.config, prerequisiteMethod: m } })}
                            className={`px-2 py-0.5 rounded text-xs font-bold transition-colors ${step.config.prerequisiteMethod === m
                                ? `${METHOD_COLORS[m].bg} text-white`
                                : 'bg-slate-800 text-slate-500 hover:text-slate-300'
                                }`}
                        >{m}</button>
                    ))}
                </div>
            </div>
            <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 w-16 shrink-0">失败时:</span>
                <select value={step.config.failAction || 'stop'}
                    onChange={e => onChange({ ...step, config: { ...step.config, failAction: e.target.value as 'stop' | 'continue' } })}
                    className="bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-xs text-white"
                >
                    <option value="stop">终止整个流程</option>
                    <option value="continue">继续执行</option>
                </select>
            </div>
        </div>
    );
}

function WaitSerialConfig({ step, onChange }: { step: TestStep; onChange: (s: TestStep) => void }) {
    return (
        <div className="space-y-2">
            <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 w-16 shrink-0">命名空间:</span>
                <input type="text" value={step.config.serialNamespace || ''} placeholder="留空则匹配当前协议 Namespace"
                    onChange={e => onChange({ ...step, config: { ...step.config, serialNamespace: e.target.value } })}
                    className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-xs text-white"
                />
            </div>
            <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 w-16 shrink-0">正则匹配:</span>
                <input type="text" value={step.config.serialMatchRegex || ''} placeholder="可选，如 &quot;method&quot;:&quot;SET&quot;"
                    onChange={e => onChange({ ...step, config: { ...step.config, serialMatchRegex: e.target.value } })}
                    className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-xs text-white font-mono"
                />
            </div>
            <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 w-16 shrink-0">超时:</span>
                <input type="number" value={step.timeout || 30000}
                    onChange={e => onChange({ ...step, timeout: parseInt(e.target.value) || 30000 })}
                    className="w-24 bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-xs text-white"
                />
                <span className="text-xs text-slate-600">ms</span>
            </div>
        </div>
    );
}

// ==================== 步骤卡片 ====================

function StepCard({
    step, index, total, protocol, allProtocols, onUpdate, onDelete, onMoveUp, onMoveDown, expanded, onToggleExpand
}: {
    step: TestStep;
    index: number;
    total: number;
    protocol: any;
    allProtocols: ProtocolRef[];
    onUpdate: (step: TestStep) => void;
    onDelete: () => void;
    onMoveUp: () => void;
    onMoveDown: () => void;
    expanded: boolean;
    onToggleExpand: () => void;
}) {
    const typeInfo = STEP_TYPE_INFO[step.type];

    // 生成步骤摘要
    const getSummary = (): string => {
        switch (step.type) {
            case 'send_request': return `${step.config.method || 'GET'}${step.timeout ? ` (${step.timeout}ms)` : ''}`;
            case 'wait_push': return `超时 ${step.timeout || 15000}ms`;
            case 'delay': return `${step.config.duration || 3000}ms (${((step.config.duration || 3000) / 1000).toFixed(1)}秒)`;
            case 'manual_action': return step.config.instruction || '等待手动操作';
            case 'manual_input': return `${(step.config.fields || []).length} 个字段 → ${step.config.targetMethod || 'SET'}`;
            case 'prerequisite': return step.config.protocolNamespace || '未选择';
            case 'wait_serial': return `等待 ${step.config.serialNamespace || '当前协议'} (超时 ${(step.timeout || 30000) / 1000}s)`;
            default: return '';
        }
    };

    return (
        <div className="group">
            {/* 连接线 */}
            {index > 0 && (
                <div className="flex justify-center py-0.5">
                    <div className="w-px h-3 bg-slate-700" />
                </div>
            )}
            <div className={`border rounded-lg transition-all ${expanded ? 'border-indigo-500/50 bg-slate-900/80' : 'border-slate-800 bg-slate-900/40 hover:border-slate-700'}`}>
                {/* 头部 */}
                <div className="flex items-center gap-2 px-3 py-2 cursor-pointer" onClick={onToggleExpand}>
                    {/* 拖拽区域 + 序号 */}
                    <div className="flex items-center gap-1.5 shrink-0">
                        <div className="flex flex-col gap-0.5 opacity-0 group-hover:opacity-50 transition-opacity">
                            <button onClick={e => { e.stopPropagation(); onMoveUp(); }} disabled={index === 0}
                                className="text-slate-500 hover:text-white disabled:opacity-20 disabled:cursor-not-allowed">
                                <ArrowUp size={10} />
                            </button>
                            <button onClick={e => { e.stopPropagation(); onMoveDown(); }} disabled={index === total - 1}
                                className="text-slate-500 hover:text-white disabled:opacity-20 disabled:cursor-not-allowed">
                                <ArrowDown size={10} />
                            </button>
                        </div>
                        <span className="text-xs text-slate-600 font-mono w-4 text-center">{index + 1}</span>
                    </div>

                    {/* 类型图标和标签 */}
                    <span className={typeInfo.color}>{typeInfo.icon}</span>
                    <span className={`text-xs font-bold ${typeInfo.color}`}>{typeInfo.label}</span>

                    {/* 摘要 */}
                    <span className="text-xs text-slate-500 truncate flex-1">{getSummary()}</span>

                    {/* 展开/收起 */}
                    <span className="text-slate-600">
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </span>

                    {/* 删除按钮 */}
                    <button onClick={e => { e.stopPropagation(); onDelete(); }}
                        className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-red-400 transition-all">
                        <Trash2 size={12} />
                    </button>
                </div>

                {/* 展开的配置区域 */}
                {expanded && (
                    <div className="px-3 pb-3 pt-1 border-t border-slate-800/50">
                        {/* 步骤描述 */}
                        <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs text-slate-500 w-16 shrink-0">描述:</span>
                            <input value={step.description || ''} placeholder="步骤描述（可选）"
                                onChange={e => onUpdate({ ...step, description: e.target.value })}
                                className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-xs text-white"
                            />
                        </div>

                        {/* 类型特定配置 */}
                        {step.type === 'send_request' && <SendRequestConfig step={step} onChange={onUpdate} />}
                        {step.type === 'wait_push' && <WaitPushConfig step={step} onChange={onUpdate} />}
                        {step.type === 'delay' && <DelayConfig step={step} onChange={onUpdate} />}
                        {step.type === 'manual_action' && <ManualActionConfig step={step} onChange={onUpdate} />}
                        {step.type === 'manual_input' && <ManualInputConfig step={step} protocol={protocol} onChange={onUpdate} />}
                        {step.type === 'prerequisite' && <PrerequisiteConfig step={step} allProtocols={allProtocols} onChange={onUpdate} />}
                        {step.type === 'wait_serial' && <WaitSerialConfig step={step} onChange={onUpdate} />}

                        {/* 通用：失败后继续 */}
                        {step.type !== 'delay' && step.type !== 'manual_action' && step.type !== 'manual_input' && (
                            <label className="flex items-center gap-2 cursor-pointer mt-2 pt-2 border-t border-slate-800/50">
                                <input type="checkbox" checked={step.continueOnFail === true}
                                    onChange={e => onUpdate({ ...step, continueOnFail: e.target.checked })}
                                    className="rounded border-slate-600"
                                />
                                <span className="text-xs text-slate-400">失败后继续执行后续步骤</span>
                            </label>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

// ==================== 添加步骤选择器 ====================

function StepTypeSelector({ onSelect, onClose }: { onSelect: (type: StepType) => void; onClose: () => void }) {
    const types: StepType[] = ['send_request', 'wait_push', 'wait_serial', 'delay', 'manual_action', 'manual_input', 'prerequisite'];
    return (
        <div className="border border-slate-700 rounded-lg bg-slate-900 shadow-xl p-2 space-y-1">
            <div className="text-xs text-slate-500 font-bold px-2 py-1">选择步骤类型</div>
            {types.map(type => {
                const info = STEP_TYPE_INFO[type];
                return (
                    <button key={type} onClick={() => onSelect(type)}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-800 transition-colors text-left"
                    >
                        <span className={info.color}>{info.icon}</span>
                        <div>
                            <div className={`text-xs font-bold ${info.color}`}>{info.label}</div>
                            <div className="text-[10px] text-slate-600">{info.description}</div>
                        </div>
                    </button>
                );
            })}
            <div className="pt-1 border-t border-slate-800">
                <button onClick={onClose} className="w-full text-xs text-slate-500 hover:text-slate-300 py-1 transition-colors">取消</button>
            </div>
        </div>
    );
}

// ==================== 主组件 ====================

export function ExecutionPlanEditor({ plan, protocol, allProtocols, onChange }: ExecutionPlanEditorProps) {
    const currentPlan: TestExecutionPlan = plan || { enabled: false, steps: [] };
    const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
    const [showAddSelector, setShowAddSelector] = useState(false);
    const [showTemplates, setShowTemplates] = useState(false);

    const updatePlan = (updates: Partial<TestExecutionPlan>) => {
        onChange({ ...currentPlan, ...updates });
    };

    const addStep = (type: StepType) => {
        const newStep: TestStep = {
            id: generateStepId(),
            type,
            order: currentPlan.steps.length,
            config: getDefaultStepConfig(type),
            timeout: getDefaultTimeout(type),
        };
        updatePlan({ steps: [...currentPlan.steps, newStep] });
        setExpandedStepId(newStep.id);
        setShowAddSelector(false);
    };

    const updateStep = (updated: TestStep) => {
        updatePlan({ steps: currentPlan.steps.map(s => s.id === updated.id ? updated : s) });
    };

    const deleteStep = (id: string) => {
        const newSteps = currentPlan.steps.filter(s => s.id !== id).map((s, i) => ({ ...s, order: i }));
        updatePlan({ steps: newSteps });
        if (expandedStepId === id) setExpandedStepId(null);
    };

    const moveStep = (id: string, direction: 'up' | 'down') => {
        const steps = [...currentPlan.steps];
        const idx = steps.findIndex(s => s.id === id);
        if (idx === -1) return;
        if (direction === 'up' && idx === 0) return;
        if (direction === 'down' && idx === steps.length - 1) return;

        const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
        [steps[idx], steps[swapIdx]] = [steps[swapIdx], steps[idx]];
        updatePlan({ steps: steps.map((s, i) => ({ ...s, order: i })) });
    };

    const applyTemplate = (template: QuickTemplate) => {
        const steps: TestStep[] = template.steps.map((s, i) => ({
            ...s,
            id: generateStepId(),
            order: i,
        }));
        updatePlan({ enabled: true, steps });
        setShowTemplates(false);
    };

    return (
        <div className="flex-1 flex flex-col overflow-hidden bg-slate-950">
            {/* 模式切换头部 */}
            <div className="px-4 py-3 border-b border-slate-800 bg-slate-900/50 shrink-0">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">执行模式</span>
                        <div className="flex items-center gap-3">
                            <label className="flex items-center gap-1.5 cursor-pointer">
                                <input type="radio" name="planMode" checked={!currentPlan.enabled}
                                    onChange={() => updatePlan({ enabled: false })}
                                    className="text-indigo-500"
                                />
                                <span className={`text-xs ${!currentPlan.enabled ? 'text-white font-bold' : 'text-slate-500'}`}>
                                    默认 (自动遍历 method)
                                </span>
                            </label>
                            <label className="flex items-center gap-1.5 cursor-pointer">
                                <input type="radio" name="planMode" checked={currentPlan.enabled}
                                    onChange={() => updatePlan({ enabled: true })}
                                    className="text-indigo-500"
                                />
                                <span className={`text-xs ${currentPlan.enabled ? 'text-white font-bold' : 'text-slate-500'}`}>
                                    自定义执行流程
                                </span>
                            </label>
                        </div>
                    </div>
                    {currentPlan.enabled && currentPlan.steps.length > 0 && (
                        <span className="text-xs text-slate-600">{currentPlan.steps.length} 个步骤</span>
                    )}
                </div>
            </div>

            {/* 内容区域 */}
            <div className="flex-1 overflow-auto">
                {!currentPlan.enabled ? (
                    /* 默认模式说明 */
                    <div className="flex flex-col items-center justify-center h-full text-center px-8">
                        <Settings size={36} className="text-slate-700 mb-3" />
                        <h3 className="text-sm font-bold text-slate-400 mb-2">默认执行模式</h3>
                        <p className="text-xs text-slate-600 max-w-md leading-relaxed">
                            按 GET → SET → SYNC → DELETE 顺序自动执行已启用的 method。
                            SET 成功后自动等待 PUSH (10秒超时)。
                        </p>
                        <p className="text-xs text-slate-700 mt-3">
                            切换到「自定义执行流程」可配置任意执行顺序、手动操作暂停、手动输入参数等。
                        </p>
                    </div>
                ) : (
                    /* 自定义模式 - 步骤列表 */
                    <div className="p-4 space-y-0">
                        {currentPlan.steps.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-12 text-center">
                                <Zap size={28} className="text-slate-700 mb-3" />
                                <p className="text-xs text-slate-500 mb-4">还没有执行步骤，添加步骤或使用快速模板开始</p>
                            </div>
                        ) : (
                            currentPlan.steps.map((step, idx) => (
                                <StepCard
                                    key={step.id}
                                    step={step}
                                    index={idx}
                                    total={currentPlan.steps.length}
                                    protocol={protocol}
                                    allProtocols={allProtocols}
                                    onUpdate={updateStep}
                                    onDelete={() => deleteStep(step.id)}
                                    onMoveUp={() => moveStep(step.id, 'up')}
                                    onMoveDown={() => moveStep(step.id, 'down')}
                                    expanded={expandedStepId === step.id}
                                    onToggleExpand={() => setExpandedStepId(expandedStepId === step.id ? null : step.id)}
                                />
                            ))
                        )}

                        {/* 添加步骤 */}
                        <div className="flex justify-center pt-3">
                            {showAddSelector ? (
                                <StepTypeSelector onSelect={addStep} onClose={() => setShowAddSelector(false)} />
                            ) : (
                                <button onClick={() => setShowAddSelector(true)}
                                    className="flex items-center gap-1.5 px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white rounded-lg text-xs font-bold border border-slate-700 border-dashed transition-colors"
                                >
                                    <Plus size={14} /> 添加步骤
                                </button>
                            )}
                        </div>

                        {/* 快速模板 */}
                        <div className="pt-4 mt-4 border-t border-slate-800">
                            <button onClick={() => setShowTemplates(!showTemplates)}
                                className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 font-bold transition-colors"
                            >
                                <Zap size={12} />
                                快速模板
                                {showTemplates ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            </button>
                            {showTemplates && (
                                <div className="grid grid-cols-2 gap-2 mt-2">
                                    {QUICK_TEMPLATES.map((tpl, i) => (
                                        <button key={i} onClick={() => applyTemplate(tpl)}
                                            className="text-left px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg hover:border-indigo-500/50 hover:bg-slate-800/50 transition-colors"
                                        >
                                            <div className="text-xs font-bold text-slate-300">{tpl.name}</div>
                                            <div className="text-[10px] text-slate-600 mt-0.5">{tpl.description}</div>
                                            <div className="text-[10px] text-slate-700 mt-1 font-mono">
                                                {tpl.steps.map(s => STEP_TYPE_INFO[s.type].label).join(' → ')}
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* 提示：使用模板会覆盖 */}
                        {showTemplates && currentPlan.steps.length > 0 && (
                            <div className="flex items-center gap-1.5 text-xs text-amber-500/70 mt-2">
                                <AlertTriangle size={12} /> 使用模板将替换当前所有步骤
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

// ==================== 手动输入弹窗组件 ====================

interface ManualInputDialogProps {
    fields: ManualField[];
    protocolName: string;
    targetMethod: string;
    stepIndex: number;
    totalSteps: number;
    onConfirm: (values: Record<string, any>) => void;
}

export function ManualInputDialog({ fields, protocolName, targetMethod, stepIndex, totalSteps, onConfirm }: ManualInputDialogProps) {
    const [inputValues, setInputValues] = useState<Record<string, any>>(() => {
        const defaults: Record<string, any> = {};
        fields.forEach(f => {
            defaults[f.path] = f.defaultValue ?? '';
        });
        return defaults;
    });

    return (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[250]">
            <div className="bg-slate-900 border border-emerald-500/30 rounded-2xl p-8 w-[480px] flex flex-col shadow-2xl">
                <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-full bg-emerald-500/10 border-2 border-emerald-500/30 flex items-center justify-center">
                        <Edit3 size={20} className="text-emerald-400" />
                    </div>
                    <div>
                        <h3 className="text-lg font-bold text-white">输入测试参数</h3>
                        <p className="text-xs text-slate-500">
                            {protocolName} · 步骤 {stepIndex}/{totalSteps} · 应用到 {targetMethod}
                        </p>
                    </div>
                </div>
                <div className="space-y-3 mb-6">
                    {fields.map((field, idx) => (
                        <div key={idx} className="flex items-center gap-3">
                            <label className="text-xs text-slate-400 w-28 shrink-0 text-right truncate" title={field.label || field.path || '无相对路径'}>
                                {field.label || field.path || '未填写路径'}
                            </label>
                            {field.type === 'boolean' ? (
                                <select
                                    value={String(inputValues[field.path])}
                                    onChange={e => setInputValues(prev => ({ ...prev, [field.path]: e.target.value }))}
                                    className="flex-1 bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-white"
                                >
                                    <option value="true">true</option>
                                    <option value="false">false</option>
                                </select>
                            ) : (
                                <input
                                    type={field.type === 'number' ? 'number' : 'text'}
                                    value={inputValues[field.path] ?? ''}
                                    onChange={e => setInputValues(prev => ({ ...prev, [field.path]: e.target.value }))}
                                    placeholder={field.hint || `输入 ${field.label || field.path}`}
                                    className="flex-1 bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-white font-mono focus:border-emerald-500 outline-none transition-colors"
                                />
                            )}
                        </div>
                    ))}
                </div>
                <button
                    onClick={() => onConfirm(inputValues)}
                    className="w-full py-2.5 bg-emerald-500 hover:bg-emerald-400 text-black font-bold rounded-lg text-sm transition-colors"
                >
                    确认并继续
                </button>
            </div>
        </div>
    );
}

export default ExecutionPlanEditor;
