/**
 * ProtocolAudit 增强功能模块
 * 包含：协议模板库、搜索筛选、批量导入、详细结果分析等功能
 */

import React, { useState, useMemo } from 'react';
import {
    Search, Filter, Library, Plus, Check, Folder, ChevronDown, ChevronRight,
    Eye, AlertTriangle, CheckCircle, XCircle, FileText, Copy, X
} from 'lucide-react';

// ==================== 类型定义 ====================

// 协议分类
export type ProtocolCategory = 'System' | 'Control' | 'Hub' | 'Config' | 'Digest' | 'Other';

// 预置协议模板
export interface ProtocolTemplateItem {
    namespace: string;
    category: ProtocolCategory;
    description: string;
    methods: ('GET' | 'SET' | 'PUSH')[];
    defaultPayload?: Record<string, any>;
}

// 详细的Schema验证错误
export interface SchemaError {
    path: string;           // 'payload.togglex.channel'
    expected: string;       // 'number'
    actual: string;         // 'undefined'
    message: string;        // 'required field missing'
    keyword: string;        // 'required' | 'type' | 'const' etc.
}

// 详细的测试结果
export interface DetailedTestResult {
    status: 'PASS' | 'FAIL' | 'TIMEOUT' | 'PENDING';
    duration: number;
    response?: any;
    error?: string;
    schemaErrors?: SchemaError[];
    retryCount?: number;
}

// ==================== 协议模板库 ====================

export const PROTOCOL_TEMPLATE_LIBRARY: ProtocolTemplateItem[] = [
    // System 类
    { namespace: 'Appliance.System.All', category: 'System', description: '获取设备完整状态', methods: ['GET'] },
    { namespace: 'Appliance.System.Ability', category: 'System', description: '获取设备能力集', methods: ['GET'] },
    { namespace: 'Appliance.System.Hardware', category: 'System', description: '获取硬件信息', methods: ['GET'] },
    { namespace: 'Appliance.System.Firmware', category: 'System', description: '获取固件信息', methods: ['GET'] },
    { namespace: 'Appliance.System.Time', category: 'System', description: '设备时间设置', methods: ['GET', 'SET'] },
    { namespace: 'Appliance.System.Clock', category: 'System', description: '设备时钟', methods: ['GET', 'SET', 'PUSH'] },
    { namespace: 'Appliance.System.Online', category: 'System', description: '设备在线状态', methods: ['GET', 'PUSH'] },
    { namespace: 'Appliance.System.Report', category: 'System', description: '设备状态上报', methods: ['PUSH'] },
    { namespace: 'Appliance.System.Debug', category: 'System', description: '调试信息', methods: ['GET', 'SET'] },
    { namespace: 'Appliance.System.Runtime', category: 'System', description: '运行时信息', methods: ['GET'] },
    { namespace: 'Appliance.System.Position', category: 'System', description: '设备位置', methods: ['GET', 'SET'] },
    { namespace: 'Appliance.System.DNDMode', category: 'System', description: '免打扰模式', methods: ['GET', 'SET', 'PUSH'] },
    // Control 类
    { namespace: 'Appliance.Control.ToggleX', category: 'Control', description: '开关控制', methods: ['GET', 'SET', 'PUSH'], defaultPayload: { togglex: { channel: 0, onoff: 1 } } },
    { namespace: 'Appliance.Control.Toggle', category: 'Control', description: '简单开关控制', methods: ['GET', 'SET', 'PUSH'] },
    { namespace: 'Appliance.Control.Bind', category: 'Control', description: '绑定控制', methods: ['GET', 'SET'] },
    { namespace: 'Appliance.Control.Unbind', category: 'Control', description: '解绑控制', methods: ['SET'] },
    { namespace: 'Appliance.Control.Upgrade', category: 'Control', description: 'OTA升级控制', methods: ['SET', 'PUSH'] },
    { namespace: 'Appliance.Control.Timer', category: 'Control', description: '定时器控制', methods: ['GET', 'SET', 'PUSH'] },
    { namespace: 'Appliance.Control.TriggerX', category: 'Control', description: '触发器控制', methods: ['GET', 'SET'] },
    { namespace: 'Appliance.Control.ConsumptionX', category: 'Control', description: '电量统计', methods: ['GET', 'PUSH'] },
    { namespace: 'Appliance.Control.Electricity', category: 'Control', description: '实时电参', methods: ['GET', 'PUSH'] },
    { namespace: 'Appliance.Control.Light', category: 'Control', description: '灯光控制', methods: ['GET', 'SET', 'PUSH'] },
    { namespace: 'Appliance.Control.Spray', category: 'Control', description: '喷雾控制', methods: ['GET', 'SET', 'PUSH'] },
    { namespace: 'Appliance.Control.Fan', category: 'Control', description: '风扇控制', methods: ['GET', 'SET', 'PUSH'] },
    { namespace: 'Appliance.Control.Thermostat', category: 'Control', description: '温控器控制', methods: ['GET', 'SET', 'PUSH'] },
    // Hub 类
    { namespace: 'Appliance.Hub.Online', category: 'Hub', description: '子设备在线状态', methods: ['GET', 'PUSH'] },
    { namespace: 'Appliance.Hub.ToggleX', category: 'Hub', description: '子设备开关', methods: ['GET', 'SET', 'PUSH'] },
    { namespace: 'Appliance.Hub.Sensor.All', category: 'Hub', description: '传感器数据', methods: ['GET', 'PUSH'] },
    { namespace: 'Appliance.Hub.Sensor.Temperature', category: 'Hub', description: '温度传感器', methods: ['GET', 'PUSH'] },
    { namespace: 'Appliance.Hub.Sensor.Humidity', category: 'Hub', description: '湿度传感器', methods: ['GET', 'PUSH'] },
    { namespace: 'Appliance.Hub.Mts100.All', category: 'Hub', description: 'MTS100温控器', methods: ['GET', 'PUSH'] },
    { namespace: 'Appliance.Hub.Mts100.Mode', category: 'Hub', description: 'MTS100模式', methods: ['GET', 'SET', 'PUSH'] },
    { namespace: 'Appliance.Hub.Battery', category: 'Hub', description: '子设备电池', methods: ['GET', 'PUSH'] },
    { namespace: 'Appliance.Hub.SubdeviceList', category: 'Hub', description: '子设备列表', methods: ['GET'] },
    // Config 类
    { namespace: 'Appliance.Config.Key', category: 'Config', description: '配置密钥', methods: ['GET', 'SET'] },
    { namespace: 'Appliance.Config.Wifi', category: 'Config', description: 'WiFi配置', methods: ['GET', 'SET'] },
    { namespace: 'Appliance.Config.WifiList', category: 'Config', description: 'WiFi列表', methods: ['GET', 'SET'] },
    { namespace: 'Appliance.Config.Trace', category: 'Config', description: '调试追踪', methods: ['GET', 'SET'] },
    // Digest 类
    { namespace: 'Appliance.Digest.TimerX', category: 'Digest', description: '定时器摘要', methods: ['GET'] },
    { namespace: 'Appliance.Digest.TriggerX', category: 'Digest', description: '触发器摘要', methods: ['GET'] },
    { namespace: 'Appliance.Digest.Hub', category: 'Digest', description: 'Hub摘要', methods: ['GET'] },
];

// ==================== 辅助函数 ====================

/**
 * 从 namespace 推断协议分类
 */
export const getCategoryFromNamespace = (namespace: string): ProtocolCategory => {
    const parts = namespace.split('.');
    if (parts.length >= 2) {
        const category = parts[1];
        if (['System', 'Control', 'Hub', 'Config', 'Digest'].includes(category)) {
            return category as ProtocolCategory;
        }
    }
    return 'Other';
};

/**
 * 分类颜色配置
 */
export const CATEGORY_COLORS: Record<ProtocolCategory, { bg: string; text: string; border: string }> = {
    System: { bg: 'bg-blue-500/10', text: 'text-blue-400', border: 'border-blue-500/30' },
    Control: { bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/30' },
    Hub: { bg: 'bg-purple-500/10', text: 'text-purple-400', border: 'border-purple-500/30' },
    Config: { bg: 'bg-cyan-500/10', text: 'text-cyan-400', border: 'border-cyan-500/30' },
    Digest: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/30' },
    Other: { bg: 'bg-slate-500/10', text: 'text-slate-400', border: 'border-slate-500/30' },
};

/**
 * 解析 AJV 错误为友好格式
 */
export const parseSchemaErrors = (ajvErrors: any[]): SchemaError[] => {
    if (!ajvErrors) return [];
    return ajvErrors.map(err => ({
        path: err.instancePath?.replace(/^\//, '').replace(/\//g, '.') || 'root',
        expected: err.params?.type || err.params?.allowedValues?.join(' | ') || String(err.params?.limit) || 'expected',
        actual: String(err.data) || 'undefined',
        message: err.message || 'Validation failed',
        keyword: err.keyword || 'unknown',
    }));
};

// ==================== 协议模板库选择器组件 ====================

interface ProtocolTemplateLibraryProps {
    isOpen: boolean;
    onClose: () => void;
    onSelect: (templates: ProtocolTemplateItem[]) => void;
    existingNamespaces: string[];
}

export const ProtocolTemplateLibrary: React.FC<ProtocolTemplateLibraryProps> = ({
    isOpen,
    onClose,
    onSelect,
    existingNamespaces
}) => {
    const [searchQuery, setSearchQuery] = useState('');
    const [categoryFilter, setCategoryFilter] = useState<ProtocolCategory | 'All'>('All');
    const [selectedTemplates, setSelectedTemplates] = useState<Set<string>>(new Set());
    const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(['System', 'Control']));

    // 按分类分组
    const groupedTemplates = useMemo(() => {
        const groups: Record<ProtocolCategory, ProtocolTemplateItem[]> = {
            System: [], Control: [], Hub: [], Config: [], Digest: [], Other: []
        };

        PROTOCOL_TEMPLATE_LIBRARY.forEach(t => {
            // 搜索过滤
            if (searchQuery && !t.namespace.toLowerCase().includes(searchQuery.toLowerCase()) &&
                !t.description.toLowerCase().includes(searchQuery.toLowerCase())) {
                return;
            }
            // 分类过滤
            if (categoryFilter !== 'All' && t.category !== categoryFilter) {
                return;
            }
            groups[t.category].push(t);
        });

        return groups;
    }, [searchQuery, categoryFilter]);

    const toggleCategory = (category: string) => {
        setExpandedCategories(prev => {
            const next = new Set(prev);
            if (next.has(category)) {
                next.delete(category);
            } else {
                next.add(category);
            }
            return next;
        });
    };

    const toggleTemplate = (namespace: string) => {
        setSelectedTemplates(prev => {
            const next = new Set(prev);
            if (next.has(namespace)) {
                next.delete(namespace);
            } else {
                next.add(namespace);
            }
            return next;
        });
    };

    const handleConfirm = () => {
        const selected = PROTOCOL_TEMPLATE_LIBRARY.filter(t => selectedTemplates.has(t.namespace));
        onSelect(selected);
        setSelectedTemplates(new Set());
        onClose();
    };

    if (!isOpen) return null;

    const categories: ProtocolCategory[] = ['System', 'Control', 'Hub', 'Config', 'Digest', 'Other'];

    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[80]">
            <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-[800px] max-h-[80vh] flex flex-col">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-lg font-black text-white flex items-center gap-2">
                        <Library className="text-indigo-400" size={20} />
                        协议模板库
                    </h3>
                    <button onClick={onClose} className="p-2 text-slate-400 hover:text-white">
                        <X size={20} />
                    </button>
                </div>

                <p className="text-sm text-slate-400 mb-4">
                    从模板库中快速添加常用协议。已选择 <span className="text-indigo-400 font-bold">{selectedTemplates.size}</span> 个协议。
                </p>

                {/* 搜索和筛选 */}
                <div className="flex gap-3 mb-4">
                    <div className="flex-1 relative">
                        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                        <input
                            type="text"
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                            placeholder="搜索协议..."
                            className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-10 pr-4 py-2 text-sm text-white outline-none focus:border-indigo-500"
                        />
                    </div>
                    <select
                        value={categoryFilter}
                        onChange={e => setCategoryFilter(e.target.value as ProtocolCategory | 'All')}
                        className="bg-slate-950 border border-slate-700 rounded-lg px-4 py-2 text-sm text-white outline-none"
                    >
                        <option value="All">全部分类</option>
                        {categories.map(cat => (
                            <option key={cat} value={cat}>{cat}</option>
                        ))}
                    </select>
                </div>

                {/* 协议列表 */}
                <div className="flex-1 overflow-y-auto custom-scrollbar border border-slate-700 rounded-xl bg-slate-950 p-2">
                    {categories.map(category => {
                        const templates = groupedTemplates[category];
                        if (templates.length === 0) return null;

                        const isExpanded = expandedCategories.has(category);
                        const colors = CATEGORY_COLORS[category];

                        return (
                            <div key={category} className="mb-2">
                                <button
                                    onClick={() => toggleCategory(category)}
                                    className={`w-full flex items-center gap-2 p-2 rounded-lg ${colors.bg} hover:opacity-80 transition-opacity`}
                                >
                                    {isExpanded ? <ChevronDown size={16} className={colors.text} /> : <ChevronRight size={16} className={colors.text} />}
                                    <Folder size={16} className={colors.text} />
                                    <span className={`text-sm font-bold ${colors.text}`}>{category}</span>
                                    <span className="text-xs text-slate-500 ml-auto">{templates.length} 个协议</span>
                                </button>

                                {isExpanded && (
                                    <div className="ml-4 mt-1 space-y-1">
                                        {templates.map(template => {
                                            const isSelected = selectedTemplates.has(template.namespace);
                                            const isExisting = existingNamespaces.includes(template.namespace);

                                            return (
                                                <div
                                                    key={template.namespace}
                                                    onClick={() => !isExisting && toggleTemplate(template.namespace)}
                                                    className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-all ${isExisting
                                                            ? 'opacity-50 cursor-not-allowed bg-slate-800/50'
                                                            : isSelected
                                                                ? 'bg-indigo-500/20 border border-indigo-500/50'
                                                                : 'bg-slate-900/50 hover:bg-slate-800/50'
                                                        }`}
                                                >
                                                    <div className={`w-5 h-5 rounded flex items-center justify-center border ${isSelected ? 'bg-indigo-500 border-indigo-500' : 'border-slate-600'
                                                        }`}>
                                                        {isSelected && <Check size={12} className="text-white" />}
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="text-sm font-mono text-white truncate">{template.namespace}</div>
                                                        <div className="text-xs text-slate-500">{template.description}</div>
                                                    </div>
                                                    <div className="flex gap-1">
                                                        {template.methods.map(m => (
                                                            <span key={m} className={`text-[10px] px-1.5 py-0.5 rounded ${m === 'GET' ? 'bg-blue-500/20 text-blue-400' :
                                                                    m === 'SET' ? 'bg-amber-500/20 text-amber-400' :
                                                                        'bg-purple-500/20 text-purple-400'
                                                                }`}>{m}</span>
                                                        ))}
                                                    </div>
                                                    {isExisting && (
                                                        <span className="text-xs text-emerald-500">已存在</span>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>

                {/* 底部操作 */}
                <div className="flex justify-between items-center mt-4 pt-4 border-t border-slate-800">
                    <button
                        onClick={() => {
                            const allNamespaces = PROTOCOL_TEMPLATE_LIBRARY
                                .filter(t => !existingNamespaces.includes(t.namespace))
                                .map(t => t.namespace);
                            setSelectedTemplates(new Set(allNamespaces));
                        }}
                        className="text-xs text-indigo-400 hover:text-indigo-300"
                    >
                        全选未添加的
                    </button>
                    <div className="flex gap-3">
                        <button onClick={onClose} className="px-4 py-2 text-slate-400 hover:text-white">
                            取消
                        </button>
                        <button
                            onClick={handleConfirm}
                            disabled={selectedTemplates.size === 0}
                            className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-bold"
                        >
                            添加 {selectedTemplates.size} 个协议
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

// ==================== 协议搜索栏组件 ====================

interface ProtocolSearchBarProps {
    searchQuery: string;
    onSearchChange: (query: string) => void;
    categoryFilter: ProtocolCategory | 'All';
    onCategoryChange: (category: ProtocolCategory | 'All') => void;
    onOpenTemplateLibrary: () => void;
}

export const ProtocolSearchBar: React.FC<ProtocolSearchBarProps> = ({
    searchQuery,
    onSearchChange,
    categoryFilter,
    onCategoryChange,
    onOpenTemplateLibrary
}) => {
    const categories: (ProtocolCategory | 'All')[] = ['All', 'System', 'Control', 'Hub', 'Config', 'Digest', 'Other'];

    return (
        <div className="flex gap-2 mb-3">
            <div className="flex-1 relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                    type="text"
                    value={searchQuery}
                    onChange={e => onSearchChange(e.target.value)}
                    placeholder="搜索协议..."
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-9 pr-3 py-2 text-xs text-white outline-none focus:border-indigo-500"
                />
            </div>
            <select
                value={categoryFilter}
                onChange={e => onCategoryChange(e.target.value as ProtocolCategory | 'All')}
                className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-2 text-xs text-white outline-none w-24"
            >
                {categories.map(cat => (
                    <option key={cat} value={cat}>{cat === 'All' ? '全部' : cat}</option>
                ))}
            </select>
            <button
                onClick={onOpenTemplateLibrary}
                className="px-3 py-2 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/30 text-indigo-400 rounded-lg text-xs font-bold flex items-center gap-1"
                title="从模板库添加"
            >
                <Library size={14} />
            </button>
        </div>
    );
};

// ==================== 详细结果面板组件 ====================

interface DetailedResultPanelProps {
    isOpen: boolean;
    onClose: () => void;
    result: {
        protocolId: string;
        namespace: string;
        method: string;
        result: DetailedTestResult;
        expectedSchema: any;
    } | null;
}

export const DetailedResultPanel: React.FC<DetailedResultPanelProps> = ({
    isOpen,
    onClose,
    result
}) => {
    const [activeTab, setActiveTab] = useState<'response' | 'schema' | 'errors'>('response');

    if (!isOpen || !result) return null;

    const { namespace, method, result: testResult, expectedSchema } = result;
    const statusColors = {
        PASS: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/30' },
        FAIL: { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/30' },
        TIMEOUT: { bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/30' },
        PENDING: { bg: 'bg-slate-500/10', text: 'text-slate-400', border: 'border-slate-500/30' },
    };
    const colors = statusColors[testResult.status];

    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[80]">
            <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-[900px] max-h-[85vh] flex flex-col">
                {/* Header */}
                <div className="flex justify-between items-start mb-4">
                    <div>
                        <h3 className="text-lg font-black text-white flex items-center gap-2">
                            <Eye className="text-indigo-400" size={20} />
                            测试结果详情
                        </h3>
                        <p className="text-sm text-slate-400 mt-1 font-mono">{namespace}</p>
                    </div>
                    <div className="flex items-center gap-3">
                        <span className={`px-3 py-1 rounded-lg text-sm font-bold ${colors.bg} ${colors.text} border ${colors.border}`}>
                            {testResult.status}
                        </span>
                        <span className="text-sm text-slate-400">{testResult.duration}ms</span>
                        <button onClick={onClose} className="p-2 text-slate-400 hover:text-white">
                            <X size={20} />
                        </button>
                    </div>
                </div>

                {/* Tabs */}
                <div className="flex gap-2 border-b border-slate-700 pb-2 mb-4">
                    <button
                        onClick={() => setActiveTab('response')}
                        className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${activeTab === 'response' ? 'bg-indigo-500 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'
                            }`}
                    >
                        响应数据
                    </button>
                    <button
                        onClick={() => setActiveTab('schema')}
                        className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${activeTab === 'schema' ? 'bg-indigo-500 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'
                            }`}
                    >
                        期望 Schema
                    </button>
                    {testResult.schemaErrors && testResult.schemaErrors.length > 0 && (
                        <button
                            onClick={() => setActiveTab('errors')}
                            className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${activeTab === 'errors' ? 'bg-red-500 text-white' : 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
                                }`}
                        >
                            验证错误 ({testResult.schemaErrors.length})
                        </button>
                    )}
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto custom-scrollbar">
                    {activeTab === 'response' && (
                        <div className="space-y-4">
                            {testResult.response ? (
                                <pre className="bg-slate-950 border border-slate-700 rounded-xl p-4 text-sm font-mono text-emerald-400 overflow-x-auto">
                                    {JSON.stringify(testResult.response, null, 2)}
                                </pre>
                            ) : (
                                <div className="text-center text-slate-500 py-8">
                                    {testResult.status === 'TIMEOUT' ? '请求超时，未收到响应' : '无响应数据'}
                                </div>
                            )}
                            {testResult.error && testResult.status !== 'PASS' && (
                                <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
                                    <div className="flex items-center gap-2 text-red-400 font-bold mb-2">
                                        <AlertTriangle size={16} />
                                        错误信息
                                    </div>
                                    <pre className="text-sm font-mono text-red-300 whitespace-pre-wrap">
                                        {testResult.error}
                                    </pre>
                                </div>
                            )}
                        </div>
                    )}

                    {activeTab === 'schema' && (
                        <pre className="bg-slate-950 border border-slate-700 rounded-xl p-4 text-sm font-mono text-blue-400 overflow-x-auto">
                            {JSON.stringify(expectedSchema, null, 2)}
                        </pre>
                    )}

                    {activeTab === 'errors' && testResult.schemaErrors && (
                        <div className="space-y-3">
                            {testResult.schemaErrors.map((err, idx) => (
                                <div key={idx} className="bg-red-500/5 border border-red-500/20 rounded-xl p-4">
                                    <div className="flex items-start gap-3">
                                        <XCircle size={18} className="text-red-400 flex-shrink-0 mt-0.5" />
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-bold text-white mb-1">{err.message}</div>
                                            <div className="text-xs space-y-1">
                                                <div className="text-slate-400">
                                                    路径: <span className="text-amber-400 font-mono">{err.path}</span>
                                                </div>
                                                <div className="text-slate-400">
                                                    期望: <span className="text-emerald-400 font-mono">{err.expected}</span>
                                                </div>
                                                <div className="text-slate-400">
                                                    实际: <span className="text-red-400 font-mono">{err.actual}</span>
                                                </div>
                                                <div className="text-slate-400">
                                                    规则: <span className="text-blue-400 font-mono">{err.keyword}</span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex justify-end mt-4 pt-4 border-t border-slate-800">
                    <button
                        onClick={() => {
                            navigator.clipboard.writeText(JSON.stringify({
                                namespace,
                                method,
                                result: testResult,
                                schema: expectedSchema
                            }, null, 2));
                        }}
                        className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm flex items-center gap-2"
                    >
                        <Copy size={14} />
                        复制完整结果
                    </button>
                </div>
            </div>
        </div>
    );
};

// ==================== 批量导入选择器组件 ====================

interface BatchImportSelectorProps {
    packets: any[];
    selectedIndices: Set<number>;
    onSelectionChange: (indices: Set<number>) => void;
    onImport: () => void;
    onCancel: () => void;
}

export const BatchImportSelector: React.FC<BatchImportSelectorProps> = ({
    packets,
    selectedIndices,
    onSelectionChange,
    onImport,
    onCancel
}) => {
    const togglePacket = (index: number) => {
        const next = new Set(selectedIndices);
        if (next.has(index)) {
            next.delete(index);
        } else {
            next.add(index);
        }
        onSelectionChange(next);
    };

    const toggleAll = () => {
        if (selectedIndices.size === packets.length) {
            onSelectionChange(new Set());
        } else {
            onSelectionChange(new Set(packets.map((_, i) => i)));
        }
    };

    // 按 namespace 分组统计
    const groupedCount = useMemo(() => {
        const counts: Record<string, number> = {};
        packets.forEach((p, i) => {
            if (selectedIndices.has(i)) {
                const ns = p.header?.namespace || 'Unknown';
                counts[ns] = (counts[ns] || 0) + 1;
            }
        });
        return counts;
    }, [packets, selectedIndices]);

    const uniqueNamespaces = Object.keys(groupedCount).length;

    return (
        <div className="bg-indigo-500/10 border border-indigo-500/30 rounded-xl p-3 mb-3">
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                    <input
                        type="checkbox"
                        checked={selectedIndices.size === packets.length && packets.length > 0}
                        onChange={toggleAll}
                        className="w-4 h-4 rounded"
                    />
                    <span className="text-sm font-bold text-indigo-400">
                        批量导入模式
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400">
                        已选 {selectedIndices.size} 条 ({uniqueNamespaces} 个协议)
                    </span>
                    <button
                        onClick={onCancel}
                        className="px-2 py-1 text-xs text-slate-400 hover:text-white"
                    >
                        取消
                    </button>
                    <button
                        onClick={onImport}
                        disabled={selectedIndices.size === 0}
                        className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded text-xs font-bold"
                    >
                        导入选中
                    </button>
                </div>
            </div>

            {/* 选中的协议预览 */}
            {uniqueNamespaces > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                    {Object.entries(groupedCount).slice(0, 5).map(([ns, count]) => (
                        <span key={ns} className="text-[10px] px-2 py-0.5 bg-slate-800 rounded text-slate-300 font-mono">
                            {ns.split('.').pop()} {count > 1 && `(${count})`}
                        </span>
                    ))}
                    {uniqueNamespaces > 5 && (
                        <span className="text-[10px] px-2 py-0.5 bg-slate-800 rounded text-slate-500">
                            +{uniqueNamespaces - 5} 更多
                        </span>
                    )}
                </div>
            )}
        </div>
    );
};
