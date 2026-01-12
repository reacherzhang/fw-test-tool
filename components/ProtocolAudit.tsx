import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    ShieldCheck, Play, Plus, Trash2, ChevronRight, ChevronDown, ChevronLeft,
    CheckCircle, XCircle, AlertTriangle, Edit3, FolderOpen,
    RefreshCw, Copy, Zap, ArrowRight, Download, Upload, FileJson,
    Package, Clock, History, Send, Check, X, Wand2, BarChart3, FileText, MoreVertical, Settings, Search,
    CheckCircle2, HelpCircle, AlertCircle, Circle, Info
} from 'lucide-react';
import Ajv from 'ajv';
import { CloudSession, Device } from '../types';
import { md5 } from './AuthScreen';
import { ProtocolGenerator } from './ProtocolGenerator';
import { TestResultViewer, BatchTestSummaryPanel, DetailedTestResult, TestRequest, TestResponse, SchemaValidationError, BatchTestResult, SideBySideDiff } from './TestResultViewer';
import { TestStatisticsDashboard, TestRunHistory } from './TestStatisticsDashboard';
import { TestCaseEditor, TestCase } from './TestCaseEditor';

// --- Types & Interfaces ---

interface MethodTest {
    enabled: boolean;
    payload: string; // JSON string
    schema: string;  // JSON schema string
    testCases?: TestCase[];
    lastResult?: DetailedTestResult;
}

interface ProtocolDefinition {
    id: string;
    namespace: string;
    name: string;
    description?: string;
    methods: {
        [key in RequestMethod]?: MethodTest;
    };
    reviewStatus?: 'UNVERIFIED' | 'VERIFIED';
}

type RequestMethod = 'GET' | 'SET' | 'PUSH' | 'SYNC' | 'DELETE';
type AckMethod = 'GETACK' | 'SETACK' | 'PUSHACK' | 'SYNCACK' | 'DELETEACK';
const ALL_METHODS: RequestMethod[] = ['GET', 'SET', 'PUSH', 'SYNC', 'DELETE'];
const REQUEST_METHODS: RequestMethod[] = ['GET', 'SET', 'SYNC', 'DELETE']; // Active request methods (not PUSH)
const METHOD_TO_ACK: Record<RequestMethod, AckMethod> = {
    'GET': 'GETACK',
    'SET': 'SETACK',
    'PUSH': 'PUSHACK',
    'SYNC': 'SYNCACK',
    'DELETE': 'DELETEACK'
};

// Method color configuration for consistent styling
const METHOD_COLORS: Record<RequestMethod, { bg: string; text: string; bgLight: string }> = {
    'GET': { bg: 'bg-blue-500', text: 'text-blue-400', bgLight: 'bg-blue-500/20' },
    'SET': { bg: 'bg-amber-500', text: 'text-amber-400', bgLight: 'bg-amber-500/20' },
    'PUSH': { bg: 'bg-purple-500', text: 'text-purple-400', bgLight: 'bg-purple-500/20' },
    'SYNC': { bg: 'bg-cyan-500', text: 'text-cyan-400', bgLight: 'bg-cyan-500/20' },
    'DELETE': { bg: 'bg-red-500', text: 'text-red-400', bgLight: 'bg-red-500/20' }
};

// Helper function to get method style classes
const getMethodColorClasses = (method: string): string => {
    const colors = METHOD_COLORS[method as RequestMethod];
    if (colors) {
        return `${colors.bgLight} ${colors.text}`;
    }
    return 'bg-slate-500/20 text-slate-400'; // Default fallback
};

// Helper function to get active tab color for method buttons
const getMethodActiveTabClasses = (method: string): string => {
    const colors = METHOD_COLORS[method as RequestMethod];
    if (colors) {
        return `${colors.bg} text-white`;
    }
    return 'bg-slate-500 text-white'; // Default fallback
};

interface TestExecutionConfig {
    timeout: number;
    retryCount: number;
    stopOnFail: boolean;
}

const DEFAULT_EXECUTION_CONFIG: TestExecutionConfig = {
    timeout: 5000,
    retryCount: 0,
    stopOnFail: false
};

interface ProtocolTestSuite {
    id: string;
    name: string;
    description?: string;
    protocols: ProtocolDefinition[];
    createdAt: number;
    updatedAt: number;
    executionConfig?: TestExecutionConfig;
}

interface TestRun {
    id: string;
    suiteId: string;
    suiteName: string;
    deviceId: string;
    deviceName: string;
    startTime: number;
    endTime?: number;
    status: 'RUNNING' | 'COMPLETED' | 'FAILED';
    results: {
        protocolId: string;
        namespace: string;
        method: string;
        status: 'PASS' | 'FAIL' | 'TIMEOUT' | 'PENDING';
        duration: number;
        response: any;
        error?: string;
        testCaseId?: string;
        testCaseName?: string;
    }[];
    summary: {
        total: number;
        passed: number;
        failed: number;
        timeout: number;
    };
}

interface DetailedTestLog {
    id: string;
    timestamp: number;
    timeStr: string;
    type: 'TX' | 'RX' | 'INFO' | 'ERROR';
    message: string;
    details?: {
        protocol?: string;
        method?: string;
        status?: 'PASS' | 'FAIL' | 'TIMEOUT';
        duration?: number;
        requestPayload?: any;
        responsePayload?: any;
        error?: string;
        schemaErrors?: any[];
    };
}

// FieldConfig interface for schema field configuration
interface FieldConfig {
    required: boolean;
    type: string;
    value: any;
}

interface FieldPath {
    path: string;
    type: string;
    sample: any;
}

// --- Constants ---

const DEFAULT_SUITE: ProtocolTestSuite = {
    id: 'default_suite',
    name: 'Default Suite',
    protocols: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    executionConfig: DEFAULT_EXECUTION_CONFIG
};

interface ProtocolTemplate {
    name: string;
    description: string;
    namespace: string;
    methods: RequestMethod[];
    category: 'control' | 'system' | 'config' | 'ota' | 'sensor';
    presets?: {
        [method in RequestMethod]?: {
            payload: string;
            schema: string;
        };
    };
}

const PROTOCOL_TEMPLATES: ProtocolTemplate[] = [
    // Control 类
    {
        name: 'Toggle 控制',
        description: '单通道开关控制',
        namespace: 'Appliance.Control.Toggle',
        category: 'control',
        methods: ['GET', 'SET'],
        presets: {
            GET: { payload: '{}', schema: '{"type":"object","properties":{"payload":{"type":"object","properties":{"toggle":{"type":"object","properties":{"onoff":{"type":"number"},"channel":{"type":"number"}}}}}}}' },
            SET: { payload: '{"toggle":{"onoff":1,"channel":0}}', schema: '{"type":"object"}' }
        }
    },
    {
        name: 'ToggleX 多通道',
        description: '多通道开关控制',
        namespace: 'Appliance.Control.ToggleX',
        category: 'control',
        methods: ['GET', 'SET'],
        presets: {
            GET: { payload: '{}', schema: '{"type":"object","properties":{"payload":{"type":"object","properties":{"togglex":{"type":"array"}}}}}' },
            SET: { payload: '{"togglex":[{"channel":0,"onoff":1}]}', schema: '{"type":"object"}' }
        }
    },
    {
        name: 'Bind 绑定控制',
        description: '设备绑定操作',
        namespace: 'Appliance.Control.Bind',
        category: 'control',
        methods: ['GET', 'SET']
    },
    // System 类
    {
        name: 'System All',
        description: '获取完整系统信息',
        namespace: 'Appliance.System.All',
        category: 'system',
        methods: ['GET'],
        presets: {
            GET: { payload: '{}', schema: '{"type":"object","properties":{"payload":{"type":"object","properties":{"all":{"type":"object"}}}}}' }
        }
    },
    {
        name: 'System Ability',
        description: '获取设备能力列表',
        namespace: 'Appliance.System.Ability',
        category: 'system',
        methods: ['GET']
    },
    {
        name: 'System Online',
        description: '设备在线状态',
        namespace: 'Appliance.System.Online',
        category: 'system',
        methods: ['GET', 'PUSH']
    },
    // Config 类
    {
        name: 'Config Key',
        description: '设备密钥配置',
        namespace: 'Appliance.Config.Key',
        category: 'config',
        methods: ['GET', 'SET']
    },
    {
        name: 'Config Wifi',
        description: 'WiFi 配置',
        namespace: 'Appliance.Config.Wifi',
        category: 'config',
        methods: ['GET', 'SET']
    },
    // OTA 类
    {
        name: 'OTA Firmware',
        description: '固件升级',
        namespace: 'Appliance.System.Firmware',
        category: 'ota',
        methods: ['GET', 'SET']
    },
    {
        name: 'OTA Progress',
        description: '升级进度推送',
        namespace: 'Appliance.System.FirmwareProgress',
        category: 'ota',
        methods: ['PUSH']
    },
    // Sensor 类
    {
        name: 'Sensor Temp',
        description: '温度传感器数据',
        namespace: 'Appliance.Sensor.Temperature',
        category: 'sensor',
        methods: ['GET', 'PUSH']
    },
    {
        name: 'Sensor Humidity',
        description: '湿度传感器数据',
        namespace: 'Appliance.Sensor.Humidity',
        category: 'sensor',
        methods: ['GET', 'PUSH']
    }
];

// --- Helper Functions ---

const generateSchemaFromJson = (json: any, includeRequired: boolean = true): any => {
    if (json === null) return { type: 'null' };
    if (Array.isArray(json)) {
        const itemsSchema = json.length > 0 ? generateSchemaFromJson(json[0], includeRequired) : {};
        return { type: 'array', items: itemsSchema };
    }
    if (typeof json === 'object') {
        const properties: any = {};
        const required: string[] = [];
        for (const key in json) {
            properties[key] = generateSchemaFromJson(json[key], includeRequired);
            if (includeRequired) {
                required.push(key);
            }
        }
        const result: any = { type: 'object', properties };
        if (includeRequired && required.length > 0) {
            result.required = required;
        }
        return result;
    }
    return { type: typeof json };
};

const extractFieldPaths = (obj: any, prefix = ''): FieldPath[] => {
    let paths: FieldPath[] = [];
    for (const key in obj) {
        const newPath = prefix ? `${prefix}.${key}` : key;
        const value = obj[key];
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            paths = paths.concat(extractFieldPaths(value, newPath));
        } else {
            paths.push({
                path: newPath,
                type: Array.isArray(value) ? 'array' : typeof value,
                sample: value
            });
        }
    }
    return paths;
};

const analyzeSchemaError = (error: any, data: any): string => {
    const path = error.instancePath || 'root';
    const keyword = error.keyword;
    const params = error.params;
    const message = error.message;

    let friendlyMessage = `Error at ${path}: ${message}`;

    if (keyword === 'required') {
        friendlyMessage = `Missing required field: '${params.missingProperty}' at ${path}`;
    } else if (keyword === 'type') {
        // Get actual type
        let actualType = 'undefined';
        try {
            const parts = path.split('/').filter((p: string) => p);
            let current = data;
            for (const part of parts) {
                if (current === undefined) break;
                current = current[part];
            }
            actualType = typeof current;
            if (Array.isArray(current)) actualType = 'array';
            if (current === null) actualType = 'null';
        } catch (e) { }
        friendlyMessage = `Type mismatch at ${path}: expected ${params.type}, got ${actualType}`;
    } else if (keyword === 'enum') {
        friendlyMessage = `Invalid value at ${path}: must be one of [${params.allowedValues.join(', ')}]`;
    } else if (keyword === 'additionalProperties') {
        friendlyMessage = `Unexpected field: '${params.additionalProperty}' at ${path}`;
    }

    return friendlyMessage;
};

const analyzeSchemaErrors = (errors: any[], data: any): string[] => {
    if (!errors || errors.length === 0) return [];
    return errors.map(err => analyzeSchemaError(err, data));
};

const buildFieldTree = (selection: Record<string, FieldConfig>, prefix = ''): FieldTreeNode[] => {
    // Group paths by first segment
    const groups: Record<string, string[]> = {};
    Object.keys(selection).forEach(path => {
        if (prefix && !path.startsWith(prefix + '.')) return;
        const relativePath = prefix ? path.slice(prefix.length + 1) : path;
        const firstSegment = relativePath.split('.')[0];
        if (!firstSegment) return;
        const fullPath = prefix ? `${prefix}.${firstSegment}` : firstSegment;
        if (!groups[firstSegment]) groups[firstSegment] = [];
        groups[firstSegment].push(path);
    });

    return Object.entries(groups).map(([key, paths]) => {
        const fullPath = prefix ? `${prefix}.${key}` : key;
        const directPath = paths.find(p => p === fullPath);
        const config = directPath ? selection[directPath] : undefined;
        const hasChildren = paths.some(p => p.startsWith(fullPath + '.'));
        return {
            key,
            path: fullPath,
            fullPath,
            value: config?.value,
            config,
            children: hasChildren ? buildFieldTree(selection, fullPath) : undefined
        };
    });
};

const applyRequiredFields = (schema: any, selection: any): any => {
    if (!schema || typeof schema !== 'object') return schema;
    // Placeholder: Return schema as is for now to prevent crash
    return schema;
};

// --- Components ---

// FieldTreeItem - supports both simple and extended usage
interface FieldTreeNode {
    key: string;
    path: string;
    fullPath: string;
    value: any;
    config?: FieldConfig;
    children?: FieldTreeNode[];
}

interface FieldTreeItemProps {
    // Simple mode props
    item?: any;
    onSelect?: (path: string, value: any) => void;
    // Extended mode props
    node?: FieldTreeNode;
    level?: number;
    onUpdate?: (path: string, updates: Partial<FieldConfig>) => void;
    onDelete?: (path: string) => void;
    onRename?: (oldPath: string, newPath: string) => void;
    onAdd?: (parentPath: string) => void;
}

const FieldTreeItem: React.FC<FieldTreeItemProps> = (props) => {
    const [expanded, setExpanded] = useState(true);
    const [isRenaming, setIsRenaming] = useState(false);
    const [tempName, setTempName] = useState('');

    // Simple mode
    if (props.item && props.onSelect) {
        const { item, onSelect } = props;
        return (
            <div className="ml-2">
                <div className="flex items-center gap-1 hover:bg-slate-800 rounded px-1 py-0.5 cursor-pointer" onClick={() => {
                    if (item.children) setExpanded(!expanded);
                    else onSelect(item.path, item.value);
                }}>
                    {item.children ? (
                        expanded ? <ChevronDown size={12} className="text-slate-500" /> : <ChevronRight size={12} className="text-slate-500" />
                    ) : <div className="w-3" />}
                    <span className="text-xs font-mono text-indigo-300">{item.key}</span>
                    {!item.children && (
                        <span className="text-xs font-mono text-slate-500 ml-2 truncate max-w-[100px]">{JSON.stringify(item.value)}</span>
                    )}
                </div>
                {expanded && item.children && (
                    <div className="border-l border-slate-700 ml-1.5">
                        {item.children.map((child: any) => (
                            <FieldTreeItem key={child.path} item={child} onSelect={onSelect} />
                        ))}
                    </div>
                )}
            </div>
        );
    }

    // Extended mode
    const { node, level = 0, onUpdate, onDelete, onRename, onAdd } = props;
    if (!node) return null;

    const hasChildren = node.children && node.children.length > 0;
    const config = node.config || { required: false, type: 'any', value: null };

    const handleRename = () => {
        if (isRenaming && tempName.trim() && tempName !== node.key && onRename) {
            const pathParts = node.fullPath.split('.');
            pathParts[pathParts.length - 1] = tempName.trim();
            const newPath = pathParts.join('.');
            onRename(node.fullPath, newPath);
        }
        setIsRenaming(false);
    };

    return (
        <div className={`${level > 0 ? 'ml-4 border-l border-slate-700/50' : ''}`}>
            <div className={`flex items-center gap-2 p-1.5 rounded hover:bg-slate-800/50 group ${level > 0 ? 'ml-1' : ''}`}>
                {/* Expand/Collapse */}
                <button
                    onClick={() => setExpanded(!expanded)}
                    className={`shrink-0 ${hasChildren ? 'text-slate-500 hover:text-slate-300' : 'invisible'}`}
                >
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>

                {/* Key Name */}
                {isRenaming ? (
                    <input
                        className="bg-slate-900 border border-indigo-500 rounded px-1 text-xs font-mono text-white outline-none w-24"
                        value={tempName}
                        onChange={e => setTempName(e.target.value)}
                        onBlur={handleRename}
                        onKeyDown={e => e.key === 'Enter' && handleRename()}
                        autoFocus
                    />
                ) : (
                    <span
                        className="text-xs font-mono text-indigo-300 cursor-pointer hover:text-indigo-200"
                        onDoubleClick={() => {
                            setTempName(node.key);
                            setIsRenaming(true);
                        }}
                    >
                        {node.key}
                    </span>
                )}

                {/* Type Badge */}
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400 shrink-0">
                    {config.type}
                </span>

                {/* Required Checkbox */}
                {onUpdate && !hasChildren && (
                    <label className="flex items-center gap-1 text-[10px] text-slate-500">
                        <input
                            type="checkbox"
                            checked={config.required}
                            onChange={e => onUpdate(node.fullPath, { required: e.target.checked })}
                            className="w-3 h-3 accent-indigo-500"
                        />
                        必填
                    </label>
                )}

                {/* Value Preview */}
                {!hasChildren && config.value !== undefined && (
                    <span className="text-[10px] text-slate-500 truncate max-w-[80px]">
                        {JSON.stringify(config.value)}
                    </span>
                )}

                {/* Actions */}
                <div className="ml-auto flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {hasChildren && onAdd && (
                        <button
                            onClick={() => onAdd(node.fullPath)}
                            className="text-emerald-400 hover:text-emerald-300 p-0.5"
                            title="添加子字段"
                        >
                            <Plus size={12} />
                        </button>
                    )}
                    {onDelete && (
                        <button
                            onClick={() => onDelete(node.fullPath)}
                            className="text-red-400 hover:text-red-300 p-0.5"
                            title="删除字段"
                        >
                            <Trash2 size={12} />
                        </button>
                    )}
                </div>
            </div>

            {/* Children */}
            {expanded && hasChildren && (
                <div>
                    {node.children!.map(child => (
                        <FieldTreeItem
                            key={child.fullPath}
                            node={child}
                            level={level + 1}
                            onUpdate={onUpdate}
                            onDelete={onDelete}
                            onRename={onRename}
                            onAdd={onAdd}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};

const KeyValueEditor: React.FC<{ value: string, onChange: (val: string) => void }> = ({ value, onChange }) => {
    const [pairs, setPairs] = useState<{ key: string, value: string, type: 'string' | 'number' | 'boolean' | 'object' }[]>([]);

    useEffect(() => {
        try {
            const json = JSON.parse(value || '{}');
            const newPairs = Object.entries(json).map(([k, v]) => ({
                key: k,
                value: typeof v === 'object' ? JSON.stringify(v) : String(v),
                type: typeof v === 'object' ? 'object' : typeof v as any
            }));
            setPairs(newPairs);
        } catch (e) {
            // Invalid JSON, ignore
        }
    }, [value]);

    const updateJson = (newPairs: typeof pairs) => {
        const obj: any = {};
        newPairs.forEach(p => {
            if (!p.key) return;
            if (p.type === 'number') obj[p.key] = Number(p.value);
            else if (p.type === 'boolean') obj[p.key] = p.value === 'true';
            else if (p.type === 'object') {
                try { obj[p.key] = JSON.parse(p.value); } catch { obj[p.key] = p.value; }
            }
            else obj[p.key] = p.value;
        });
        onChange(JSON.stringify(obj, null, 2));
    };

    const addPair = () => {
        const newPairs = [...pairs, { key: '', value: '', type: 'string' as const }];
        setPairs(newPairs);
        updateJson(newPairs);
    };

    const removePair = (index: number) => {
        const newPairs = pairs.filter((_, i) => i !== index);
        setPairs(newPairs);
        updateJson(newPairs);
    };

    const updatePair = (index: number, field: 'key' | 'value' | 'type', val: string) => {
        const newPairs = [...pairs];
        (newPairs[index] as any)[field] = val;
        setPairs(newPairs);
        updateJson(newPairs);
    };

    return (
        <div className="space-y-2">
            {pairs.map((pair, i) => (
                <div key={i} className="flex gap-2 items-center">
                    <input
                        value={pair.key}
                        onChange={e => updatePair(i, 'key', e.target.value)}
                        placeholder="Key"
                        className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-white outline-none focus:border-indigo-500"
                    />
                    <select
                        value={pair.type}
                        onChange={e => updatePair(i, 'type', e.target.value)}
                        className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-400 outline-none"
                    >
                        <option value="string">String</option>
                        <option value="number">Number</option>
                        <option value="boolean">Boolean</option>
                        <option value="object">Object</option>
                    </select>
                    <input
                        value={pair.value}
                        onChange={e => updatePair(i, 'value', e.target.value)}
                        placeholder="Value"
                        className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-white outline-none focus:border-indigo-500"
                    />
                    <button onClick={() => removePair(i)} className="text-slate-500 hover:text-red-400">
                        <Trash2 size={14} />
                    </button>
                </div>
            ))}
            <button onClick={addPair} className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1">
                <Plus size={12} /> Add Field
            </button>
        </div>
    );
};

// Log Item Component
const LogItem: React.FC<{ log: DetailedTestLog }> = ({ log }) => {
    const [expanded, setExpanded] = useState(false);
    const hasDetails = !!log.details;

    return (
        <div className="border-b border-slate-800 last:border-0">
            <div
                className={`flex items-start gap-3 p-2 font-mono text-xs cursor-pointer hover:bg-slate-800/50 transition-colors ${expanded ? 'bg-slate-800/30' : ''}`}
                onClick={() => hasDetails && setExpanded(!expanded)}
            >
                <div className={`mt-0.5 shrink-0 ${hasDetails ? 'text-slate-500' : 'opacity-0'}`}>
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </div>
                <div className="text-slate-500 shrink-0 select-none">{log.timeStr}</div>
                <div className={`font-bold shrink-0 w-12 ${log.type === 'TX' ? 'text-blue-400' : log.type === 'RX' ? 'text-emerald-400' : log.type === 'ERROR' ? 'text-red-400' : 'text-slate-400'}`}>
                    {log.type}
                </div>
                <div className="flex-1 break-all text-slate-300">
                    {log.message}
                </div>
                {log.details?.status && (
                    <div className={`shrink-0 px-2 py-0.5 rounded text-[10px] font-bold ${log.details.status === 'PASS' ? 'bg-emerald-500/20 text-emerald-400' : log.details.status === 'FAIL' ? 'bg-red-500/20 text-red-400' : 'bg-amber-500/20 text-amber-400'}`}>
                        {log.details.status}
                    </div>
                )}
            </div>

            {expanded && log.details && (
                <div className="pl-12 pr-4 pb-3 text-xs">
                    <div className="bg-slate-950 rounded-lg border border-slate-800 overflow-hidden">
                        {/* Summary Grid */}
                        <div className="grid grid-cols-2 gap-4 p-3 border-b border-slate-800 bg-slate-900/50">
                            {log.details.protocol && (
                                <div>
                                    <span className="text-slate-500 block mb-1">Protocol</span>
                                    <span className="text-slate-300 font-mono">{log.details.protocol}</span>
                                </div>
                            )}
                            {log.details.method && (
                                <div>
                                    <span className="text-slate-500 block mb-1">Method</span>
                                    <span className="text-slate-300 font-mono">{log.details.method}</span>
                                </div>
                            )}
                            {log.details.duration !== undefined && (
                                <div>
                                    <span className="text-slate-500 block mb-1">Duration</span>
                                    <span className="text-slate-300 font-mono">{log.details.duration}ms</span>
                                </div>
                            )}
                            {log.details.error && (
                                <div className="col-span-2">
                                    <span className="text-slate-500 block mb-1">Error</span>
                                    <span className="text-red-400 font-mono">{log.details.error}</span>
                                </div>
                            )}
                        </div>

                        {/* Payloads & Diff */}
                        {log.details.status === 'FAIL' && log.details.requestPayload && log.details.responsePayload ? (
                            <div className="p-3">
                                <div className="text-slate-500 mb-2 font-bold">Diff (Expected vs Actual)</div>
                                <SideBySideDiff
                                    leftJson={log.details.requestPayload}
                                    rightJson={log.details.responsePayload}
                                    leftTitle="Request (Expected Structure)"
                                    rightTitle="Response (Actual)"
                                />
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-800">
                                {log.details.requestPayload && (
                                    <div className="p-3">
                                        <div className="text-slate-500 mb-2 font-bold">Request Payload</div>
                                        <pre className="font-mono text-[10px] text-blue-300 overflow-x-auto custom-scrollbar">
                                            {JSON.stringify(log.details.requestPayload, null, 2)}
                                        </pre>
                                    </div>
                                )}
                                {log.details.responsePayload && (
                                    <div className="p-3">
                                        <div className="text-slate-500 mb-2 font-bold">Response Payload</div>
                                        <pre className="font-mono text-[10px] text-emerald-300 overflow-x-auto custom-scrollbar">
                                            {JSON.stringify(log.details.responsePayload, null, 2)}
                                        </pre>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Schema Errors */}
                        {log.details.schemaErrors && log.details.schemaErrors.length > 0 && (
                            <div className="p-3 border-t border-slate-800 bg-red-500/5">
                                <div className="text-red-400 mb-2 font-bold flex items-center gap-2">
                                    <AlertTriangle size={14} /> Schema Validation Errors
                                </div>
                                <div className="space-y-2">
                                    {log.details.schemaErrors.map((err: any, idx: number) => (
                                        <div key={idx} className="text-red-300 font-mono text-[10px] bg-red-500/10 p-2 rounded border border-red-500/20">
                                            {typeof err === 'string' ? err : JSON.stringify(err)}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

interface ProtocolAuditProps {
    session: CloudSession;
    devices: Device[];
    mqttConnected: boolean;
    appid: string;
    onMqttPublish: (topic: string, message: string) => void;
    onMqttSubscribe: (topic: string) => void;
    onLog: (message: string) => void;
    lastMqttMessage?: { topic: string; message: string; timestamp: number };
}

export const ProtocolAudit: React.FC<ProtocolAuditProps> = ({
    session, devices, mqttConnected, appid, onMqttPublish, onMqttSubscribe, onLog, lastMqttMessage
}) => {
    // State
    const [suites, setSuites] = useState<ProtocolTestSuite[]>([DEFAULT_SUITE]);
    const [selectedSuiteId, setSelectedSuiteId] = useState<string | null>(DEFAULT_SUITE.id);
    const [selectedProtocolId, setSelectedProtocolId] = useState<string | null>(null);
    const [isAddingSuite, setIsAddingSuite] = useState(false);
    const [editingSuiteId, setEditingSuiteId] = useState<string | null>(null);
    const [isAddingProtocol, setIsAddingProtocol] = useState(false);
    const [newSuiteName, setNewSuiteName] = useState('');
    const [newSuite, setNewSuite] = useState<{ name: string; description: string }>({ name: '', description: '' });
    const [newProtocol, setNewProtocol] = useState<ProtocolDefinition>({
        id: '',
        namespace: '',
        name: '',
        methods: ALL_METHODS.reduce((acc, m) => ({ ...acc, [m]: { enabled: false, requestPayload: {}, responseSchema: {} } }), {} as any)
    });
    const [targetDeviceId, setTargetDeviceId] = useState<string>('');
    const [testLogs, setTestLogs] = useState<DetailedTestLog[]>([]);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [isRunning, setIsRunning] = useState(false);
    const [currentRun, setCurrentRun] = useState<TestRun | null>(null);
    const [expandedSuites, setExpandedSuites] = useState<Set<string>>(new Set([DEFAULT_SUITE.id]));
    const [expandedProtocols, setExpandedProtocols] = useState<Set<string>>(new Set());
    const [currentMethodIndex, setCurrentMethodIndex] = useState(0);
    const [wizardStep, setWizardStep] = useState(1);
    const [editMode, setEditMode] = useState<'json' | 'keyvalue'>('json');
    const [showResultViewer, setShowResultViewer] = useState(false);
    const [viewingResult, setViewingResult] = useState<{ result: DetailedTestResult, namespace: string, method: string, protocolId: string } | null>(null);
    const [viewingFromBatch, setViewingFromBatch] = useState(false);
    const [showBatchSummary, setShowBatchSummary] = useState(false);
    const [batchTestResult, setBatchTestResult] = useState<BatchTestResult | null>(null);
    const [testHistory, setTestHistory] = useState<TestRun[]>([]);
    const [showStatsDashboard, setShowStatsDashboard] = useState(false);
    const [showProtocolGenerator, setShowProtocolGenerator] = useState(false);
    const [runningTest, setRunningTest] = useState<string | null>(null); // protocolId:method
    const [verificationErrorSuiteId, setVerificationErrorSuiteId] = useState<string | null>(null);
    const [unverifiedProtocolsModal, setUnverifiedProtocolsModal] = useState<{ show: boolean; protocols: ProtocolDefinition[] }>({ show: false, protocols: [] });

    // Toast message system (replaces alert)
    const [toastMessage, setToastMessage] = useState<{ show: boolean; type: 'error' | 'success' | 'warning' | 'info'; message: string }>({ show: false, type: 'info', message: '' });
    const showToast = useCallback((type: 'error' | 'success' | 'warning' | 'info', message: string) => {
        setToastMessage({ show: true, type, message });
        setTimeout(() => setToastMessage(prev => ({ ...prev, show: false })), 4000);
    }, []);

    // P1 Optimization: Test Progress Tracking
    const [testProgress, setTestProgress] = useState<{ current: number; total: number; currentProtocol: string; startTime: number } | null>(null);

    // Stop test control
    const stopTestRef = useRef(false);

    // Batch selection for protocols
    const [selectedProtocols, setSelectedProtocols] = useState<Set<string>>(new Set());

    // P1 Optimization: Execution Config Modal
    const [showExecutionConfigModal, setShowExecutionConfigModal] = useState(false);
    const [tempExecutionConfig, setTempExecutionConfig] = useState<TestExecutionConfig>(DEFAULT_EXECUTION_CONFIG);

    // Report Export
    const [showReportModal, setShowReportModal] = useState(false);
    const [jenkinsUrl, setJenkinsUrl] = useState('');

    // JSON Extract
    const [showJsonToSchemaModal, setShowJsonToSchemaModal] = useState(false);
    const [jsonExampleInput, setJsonExampleInput] = useState('');
    const [jsonExtractMode, setJsonExtractMode] = useState<'payload' | 'schema'>('payload');

    // Required Fields Selection
    const [showRequiredFieldsModal, setShowRequiredFieldsModal] = useState(false);
    const [generatedSchema, setGeneratedSchema] = useState<any>(null);
    const [selectedRequiredFields, setSelectedRequiredFields] = useState<Set<string>>(new Set());

    // Search
    const [searchTerm, setSearchTerm] = useState('');
    const [fieldConfigSelection, setFieldConfigSelection] = useState<Record<string, any>>({});

    // Phase 1 Optimization: Template Category Filter
    const [templateCategory, setTemplateCategory] = useState<'all' | 'control' | 'system' | 'config' | 'ota' | 'sensor'>('all');

    // Phase 1 Optimization: Log Panel
    const [logPanelExpanded, setLogPanelExpanded] = useState(true);
    const [logFilter, setLogFilter] = useState<'all' | 'TX' | 'RX' | 'ERROR' | 'INFO'>('all');
    const logContainerRef = useRef<HTMLDivElement>(null);

    // Phase 2 Optimization: Auto Scroll & Tabs
    const [autoScroll, setAutoScroll] = useState(true);
    const [rightPanelTab, setRightPanelTab] = useState<'overview' | 'edit' | 'results' | 'review'>('overview');
    const [viewingRunId, setViewingRunId] = useState<string | null>(null);

    // Protocol Status Helper
    type ProtocolStatus = 'verified_passed' | 'verified_failed' | 'unverified' | 'never_tested';
    const getProtocolStatus = (protocol: ProtocolDefinition): ProtocolStatus => {
        const hasBeenTested = Object.values(protocol.methods).some(m => m?.lastResult !== undefined);
        if (!hasBeenTested) return 'never_tested';
        const allPassed = Object.values(protocol.methods).every(m => !m?.enabled || m?.lastResult?.status === 'PASS');
        if (protocol.reviewStatus === 'VERIFIED') {
            return allPassed ? 'verified_passed' : 'verified_failed';
        }
        return 'unverified';
    };
    const STATUS_CONFIG: Record<ProtocolStatus, { color: string; bgHover: string; title: string }> = {
        verified_passed: { color: 'bg-emerald-500', bgHover: 'hover:bg-emerald-500/10', title: 'Verified & Passed' },
        verified_failed: { color: 'bg-red-500', bgHover: 'hover:bg-red-500/10', title: 'Verified but Failed' },
        unverified: { color: 'bg-amber-500', bgHover: 'hover:bg-amber-500/10', title: 'Unverified' },
        never_tested: { color: 'bg-slate-500', bgHover: 'hover:bg-slate-500/10', title: 'Never Tested' }
    };

    const selectedSuite = suites.find(s => s.id === selectedSuiteId);
    const targetDevice = devices.find(d => d.id === targetDeviceId);

    // Refs
    const lastMessageRef = useRef(lastMqttMessage);
    useEffect(() => {
        if (lastMqttMessage) {
            let msgPreview = 'N/A';
            try {
                if (typeof lastMqttMessage.message === 'string') {
                    msgPreview = lastMqttMessage.message.substring(0, 50);
                } else {
                    msgPreview = JSON.stringify(lastMqttMessage.message || '').substring(0, 50);
                }
            } catch (e) {
                msgPreview = String(lastMqttMessage.message);
            }
            console.log('[ProtocolAudit] lastMqttMessage updated:', lastMqttMessage.topic, msgPreview);
        }
        lastMessageRef.current = lastMqttMessage;
    }, [lastMqttMessage]);

    // Add Test Log
    const addTestLog = useCallback((type: 'TX' | 'RX' | 'INFO' | 'ERROR', message: string, details?: DetailedTestLog['details']) => {
        const now = new Date();
        const timeStr = now.toLocaleTimeString('en-GB', { hour12: false }) + '.' + now.getMilliseconds().toString().padStart(3, '0');
        setTestLogs(prev => [{
            id: Math.random().toString(36).substr(2, 9),
            timestamp: Date.now(),
            timeStr,
            type,
            message,
            details
        }, ...prev].slice(0, 100));
    }, []);

    // Load/Save
    useEffect(() => {
        const saved = localStorage.getItem('iot_nexus_test_suites');
        if (saved) {
            try {
                setSuites(JSON.parse(saved));
            } catch (e) { }
        }
    }, []);

    useEffect(() => {
        localStorage.setItem('iot_nexus_test_suites', JSON.stringify(suites));
    }, [suites]);

    // Auto Scroll Log
    useEffect(() => {
        if (autoScroll && logContainerRef.current) {
            logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
        }
    }, [testLogs, autoScroll]);

    // Auto Switch Tab
    useEffect(() => {
        if (selectedProtocolId) setRightPanelTab('edit');
    }, [selectedProtocolId]);

    // Suite Actions
    // Suite Actions
    const startEditingSuite = (suite: ProtocolTestSuite) => {
        setNewSuite({ name: suite.name, description: suite.description || '' });
        setEditingSuiteId(suite.id);
        setIsAddingSuite(true);
    };

    const updateSuite = () => {
        if (!newSuite.name.trim() || !editingSuiteId) return;
        setSuites(prev => prev.map(s =>
            s.id === editingSuiteId
                ? { ...s, name: newSuite.name, description: newSuite.description, updatedAt: Date.now() }
                : s
        ));
        setEditingSuiteId(null);
        setIsAddingSuite(false);
        setNewSuite({ name: '', description: '' });
    };

    const addNewSuite = () => {
        if (!newSuite.name.trim()) return;
        const suite: ProtocolTestSuite = {
            id: `suite_${Date.now()}`,
            name: newSuite.name,
            description: newSuite.description,
            protocols: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            executionConfig: DEFAULT_EXECUTION_CONFIG
        };
        setSuites([...suites, suite]);
        setNewSuite({ name: '', description: '' });
        setIsAddingSuite(false);
        setSelectedSuiteId(suite.id);
    };

    const resetProtocolWizard = () => {
        setNewProtocol({
            id: '',
            namespace: '',
            name: '',
            methods: ALL_METHODS.reduce((acc, m) => ({ ...acc, [m]: { enabled: false, requestPayload: {}, responseSchema: {} } }), {} as any)
        });
        setWizardStep(1);
        setCurrentMethodIndex(0);
        setRightPanelTab('overview');
    };

    const deleteSuite = (id: string) => {
        if (confirm('Are you sure you want to delete this suite?')) {
            setSuites(suites.filter(s => s.id !== id));
            if (selectedSuiteId === id) setSelectedSuiteId(null);
        }
    };

    const importSuite = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const suite = JSON.parse(ev.target?.result as string);
                if (suite.protocols) {
                    setSuites([...suites, { ...suite, id: `suite_${Date.now()}` }]);
                }
            } catch (e) {
                setErrorMessage('Invalid suite file');
            }
        };
        reader.readAsText(file);
    };

    const exportSuite = (suite: ProtocolTestSuite) => {
        const data = JSON.stringify(suite, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${suite.name.replace(/\s+/g, '_')}_suite.json`;
        a.click();
        URL.revokeObjectURL(url);
    };

    // Protocol Actions
    const addProtocolToSuite = () => {
        if (!selectedSuiteId || !newProtocol.namespace) return;

        // Validate JSON
        try {
            for (const m of Object.keys(newProtocol.methods)) {
                const mc = newProtocol.methods[m as RequestMethod];
                if (mc?.payload) JSON.parse(mc.payload);
                if (mc?.schema) JSON.parse(mc.schema);
            }
        } catch (e) {
            setErrorMessage('Invalid JSON in payload or schema');
            return;
        }

        setSuites(suites.map(s => {
            if (s.id !== selectedSuiteId) return s;
            const exists = s.protocols.find(p => p.id === newProtocol.id);
            if (exists) {
                // Check if meaningful changes occurred to reset verification status
                // Exclude reviewStatus from comparison to avoid circular logic if we were to include it
                const { reviewStatus: r1, ...p1 } = exists;
                const { reviewStatus: r2, ...p2 } = newProtocol;
                const hasChanges = JSON.stringify(p1) !== JSON.stringify(p2);

                const updatedProtocol = {
                    ...newProtocol,
                    reviewStatus: hasChanges ? 'UNVERIFIED' : newProtocol.reviewStatus
                };

                return {
                    ...s,
                    protocols: s.protocols.map(p => p.id === newProtocol.id ? updatedProtocol : p)
                };
            }
            return {
                ...s,
                protocols: [...s.protocols, { ...newProtocol, id: `proto_${Date.now()}`, reviewStatus: 'UNVERIFIED' }]
            };
        }));
        setRightPanelTab('overview');
        setNewProtocol({ id: '', namespace: '', name: '', methods: {} });
    };

    const startEditingProtocol = (protocol: ProtocolDefinition) => {
        setNewProtocol(JSON.parse(JSON.stringify(protocol))); // Deep copy
        setSelectedProtocolId(protocol.id);
        setRightPanelTab('edit');
    };

    const deleteProtocol = (protocolId: string) => {
        if (!selectedSuiteId) return;
        if (confirm('Delete this protocol?')) {
            setSuites(suites.map(s => {
                if (s.id !== selectedSuiteId) return s;
                return { ...s, protocols: s.protocols.filter(p => p.id !== protocolId) };
            }));
        }
    };

    const updateProtocolMethod = (protocolId: string, method: RequestMethod, updates: Partial<MethodTest>) => {
        if (!selectedSuiteId) return;
        setSuites(suites.map(s => {
            if (s.id !== selectedSuiteId) return s;
            return {
                ...s,
                protocols: s.protocols.map(p => {
                    if (p.id !== protocolId) return p;
                    return {
                        ...p,
                        reviewStatus: 'UNVERIFIED', // Reset status on method update
                        methods: {
                            ...p.methods,
                            [method]: { ...p.methods[method], ...updates }
                        }
                    };
                })
            };
        }));
    };

    const getEnabledMethods = () => {
        if (!newProtocol) return [];
        return (Object.keys(newProtocol.methods) as RequestMethod[]).filter(m => newProtocol.methods[m]?.enabled);
    };

    // Protocol Generator Handler
    const handleGeneratedProtocols = (protocols: ProtocolDefinition[]) => {
        const newSuiteId = `suite_${Date.now()}`;
        const newSuite: ProtocolTestSuite = {
            id: newSuiteId,
            name: `Generated Suite ${new Date().toLocaleTimeString()}`,
            description: `Auto-generated from device ability at ${new Date().toLocaleString()}`,
            protocols: protocols,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            executionConfig: DEFAULT_EXECUTION_CONFIG
        };

        setSuites(prev => [...prev, newSuite]);
        setSelectedSuiteId(newSuiteId);
        setExpandedSuites(prev => new Set(prev).add(newSuiteId));
        setShowProtocolGenerator(false);
        addTestLog('INFO', `Generated new suite with ${protocols.length} protocols`);
    };

    const fetchDeviceAbility = async (): Promise<any> => {
        if (!targetDevice || !mqttConnected || !session) {
            addTestLog('ERROR', 'Cannot fetch ability: Device not connected or no session');
            return null;
        }

        addTestLog('INFO', `Fetching ability from device: ${targetDevice.name}`);

        return new Promise((resolve) => {
            const messageId = md5(crypto.randomUUID()).toLowerCase();
            const timestamp = Math.floor(Date.now() / 1000);
            const sign = md5(messageId + session.key + String(timestamp));

            const message = {
                header: {
                    from: `/app/${session.uid}-${appid}/subscribe`,
                    messageId,
                    method: 'GET',
                    namespace: 'Appliance.System.Ability',
                    payloadVersion: 1,
                    sign,
                    timestamp,
                    triggerSrc: 'iOT-Nexus-Audit'
                },
                payload: {}
            };

            const topic = `/appliance/${targetDevice.id}/subscribe`;

            // Set timeout
            const timeoutId = setTimeout(() => {
                clearInterval(intervalId);
                addTestLog('ERROR', 'Ability fetch timeout (10s)');
                resolve(null);
            }, 10000);

            // Listen for response by polling lastMessageRef
            const intervalId = setInterval(() => {
                const lastMsg = lastMessageRef.current;
                if (!lastMsg) return;

                // App.tsx 直接设置解析后的对象: { header, payload, _receivedAt }
                // 也可能是旧格式: { topic, message, timestamp }
                const receivedAt = (lastMsg as any)._receivedAt || lastMsg.timestamp;
                if (!receivedAt || receivedAt < Date.now() - 10000) return;

                try {
                    // 处理两种可能的格式
                    let parsed: any;
                    if ((lastMsg as any).header && (lastMsg as any).payload) {
                        // App.tsx 直接设置的解析后对象
                        parsed = lastMsg;
                    } else if (lastMsg.message) {
                        // 旧格式: { topic, message, timestamp }
                        parsed = typeof lastMsg.message === 'string'
                            ? JSON.parse(lastMsg.message)
                            : lastMsg.message;
                    } else {
                        return;
                    }

                    // Check if this is our response (namespace match or messageId match)
                    if (parsed?.header?.namespace === 'Appliance.System.Ability' &&
                        (parsed?.header?.messageId === messageId || parsed?.header?.method === 'GETACK')) {
                        clearTimeout(timeoutId);
                        clearInterval(intervalId);
                        const abilityCount = Object.keys(parsed?.payload?.ability || {}).length;
                        addTestLog('RX', `Received ability response with ${abilityCount} namespaces`);
                        resolve(parsed);
                    }
                } catch (e) {
                    // Not JSON, ignore
                }
            }, 100);

            // Subscribe to user ACK topic first
            const ackTopic = `/app/${session.uid}-${appid}/subscribe`;
            onMqttSubscribe?.(ackTopic);
            addTestLog('INFO', `Subscribed to ACK topic: ${ackTopic}`);

            // Publish request
            addTestLog('TX', `Sending Appliance.System.Ability GET to ${targetDevice.name}`);
            onMqttPublish?.(topic, JSON.stringify(message));
        });
    };

    // Test Execution
    const runSingleTest = async (protocol: ProtocolDefinition, methodName: RequestMethod, showViewer: boolean = false, testCase?: TestCase): Promise<DetailedTestResult> => {
        if (!targetDevice || !mqttConnected) {
            addTestLog('ERROR', 'Target device not connected');
            return { status: 'FAIL', duration: 0, error: 'Device not connected' };
        }

        const methodConfig = protocol.methods[methodName];
        if (!methodConfig) return { status: 'FAIL', duration: 0, error: 'Method not configured' };

        // Determine payload
        let payloadStr = methodConfig.payload;
        if (testCase) {
            payloadStr = JSON.stringify(testCase.requestPayload);
        }

        let payload: any;
        try {
            payload = JSON.parse(payloadStr || '{}');
        } catch (e) {
            addTestLog('ERROR', `Invalid JSON payload for ${protocol.namespace}`, {
                protocol: protocol.namespace,
                method: methodName,
                status: 'FAIL',
                error: 'Invalid JSON payload'
            });
            return { status: 'FAIL', duration: 0, error: 'Invalid JSON payload' };
        }

        // Prepare Request
        // Use standard messageId format (md5 of random uuid)
        const requestId = md5(Math.random().toString(36)).toLowerCase();

        // Standard Meross Topic Structure
        // App publishes to device's subscribe topic
        const topic = `/appliance/${targetDevice.id}/subscribe`;
        // App expects ACK on its own subscribe topic
        const replyTopic = `/app/${session.uid}-${appid}/subscribe`;

        // Add signature/timestamp
        const ts = Math.floor(Date.now() / 1000);
        // Use standard signature generation: md5(messageId + key + timestamp)
        // Matches logic in ProtocolLab.tsx and fetchDeviceAbility
        const sign = md5(requestId + session.key + String(ts)).toLowerCase();

        const finalPayload = {
            header: {
                messageId: requestId,
                namespace: protocol.namespace,
                method: methodName,
                payloadVersion: 1,
                from: replyTopic,
                timestamp: ts,
                timestampMs: Date.now(),
                sign: sign
            },
            payload: payload
        };

        addTestLog('TX', `Sending ${methodName} to ${protocol.namespace}`, {
            protocol: protocol.namespace,
            method: methodName,
            requestPayload: finalPayload
        });

        // Subscribe to our specific ACK topic
        onMqttSubscribe(replyTopic);

        // Execution Config
        const config = selectedSuite?.executionConfig || DEFAULT_EXECUTION_CONFIG;
        const maxRetries = config.retryCount || 0;
        const timeoutMs = config.timeout || 5000;

        let retryCount = 0;
        let lastResult: DetailedTestResult | null = null;

        while (retryCount <= maxRetries) {
            if (retryCount > 0) {
                addTestLog('INFO', `Retry attempt ${retryCount}/${maxRetries} for ${protocol.namespace}`);
            }

            const startTime = Date.now();
            try {
                // Clear previous message to avoid reading stale data
                const startMessage = lastMessageRef.current;

                onMqttPublish(topic, JSON.stringify(finalPayload));

                // Wait for response
                const response = await new Promise<any>((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs);
                    const interval = setInterval(() => {
                        const current = lastMessageRef.current;

                        // Check if we have a new message
                        if (current && current !== startMessage) {
                            let receivedId = 'N/A';
                            try { receivedId = JSON.parse(current.message)?.header?.messageId; } catch (e) { }

                            console.log('[ProtocolAudit] Poll Debug:', {
                                expectedTopic: replyTopic,
                                receivedTopic: current.topic,
                                expectedId: requestId,
                                receivedId: receivedId
                            });
                            try {
                                const json = JSON.parse(current.message);
                                console.log('[ProtocolAudit] Parsed JSON messageId:', json.header?.messageId, 'Expected:', requestId);

                                // STRATEGY 1: Match by messageId (Most reliable)
                                if (json.header && json.header.messageId === requestId) {
                                    console.log('[ProtocolAudit] Matched response by messageId:', requestId);
                                    clearInterval(interval);
                                    clearTimeout(timer);
                                    resolve(json);
                                    return;
                                }

                                // STRATEGY 2: Match by Topic + Namespace (Fallback)
                                if (current.topic === replyTopic) {
                                    // Log mismatch for debugging
                                    if (json.header?.messageId !== requestId) {
                                        console.warn('[ProtocolAudit] Topic matched but messageId mismatch. Expected:', requestId, 'Got:', json.header?.messageId);
                                    }

                                    // Fallback: accept if namespace matches (for devices that don't return messageId correctly)
                                    if (json.header && json.header.namespace === protocol.namespace) {
                                        console.log('[ProtocolAudit] Accepting response based on namespace match');
                                        clearInterval(interval);
                                        clearTimeout(timer);
                                        resolve(json);
                                        return;
                                    }
                                }
                            } catch (e) {
                                // Ignore invalid JSON
                            }
                        }
                    }, 50);
                });

                const endTime = Date.now();
                const duration = endTime - startTime;

                // Validate Schema
                let schemaErrors: any[] = [];
                let status: 'PASS' | 'FAIL' = 'PASS';
                let errorMsg = undefined;

                if (methodConfig.schema) {
                    try {
                        const schema = JSON.parse(methodConfig.schema);
                        const validate = new Ajv().compile(schema);
                        const valid = validate(response);
                        if (!valid) {
                            status = 'FAIL';
                            schemaErrors = validate.errors || [];
                            errorMsg = 'Schema validation failed';
                        }
                    } catch (e) {
                        status = 'FAIL';
                        errorMsg = 'Invalid schema definition';
                    }
                }

                const detailedResult: DetailedTestResult = {
                    status,
                    duration,
                    response,
                    error: errorMsg,
                    schemaErrors,
                    request: {
                        method: methodName,
                        topic,
                        payload: finalPayload,
                        timestamp: startTime
                    }
                };

                addTestLog(status === 'PASS' ? 'RX' : 'ERROR', status === 'PASS' ? `Received ${methodName} response` : `Validation failed for ${protocol.namespace}`, {
                    protocol: protocol.namespace,
                    method: methodName,
                    status,
                    duration,
                    requestPayload: finalPayload,
                    responsePayload: response,
                    error: errorMsg,
                    schemaErrors: schemaErrors.length > 0 ? analyzeSchemaErrors(schemaErrors, response) : undefined
                });

                if (status === 'PASS') {
                    if (showViewer) {
                        setViewingResult({
                            result: detailedResult,
                            namespace: protocol.namespace,
                            method: methodName,
                            protocolId: protocol.id
                        });
                        setShowResultViewer(true);
                    }
                    return detailedResult;
                } else {
                    lastResult = detailedResult;
                    throw new Error(errorMsg || 'Test Failed');
                }

            } catch (e: any) {
                const endTime = Date.now();
                const duration = endTime - startTime;
                const isTimeout = e.message === 'TIMEOUT';

                if (!lastResult) {
                    lastResult = {
                        status: isTimeout ? 'TIMEOUT' : 'FAIL',
                        duration,
                        error: e.message
                    };
                }

                addTestLog('ERROR', `${isTimeout ? 'Timeout' : 'Failed'}: ${e.message}`, {
                    protocol: protocol.namespace,
                    method: methodName,
                    status: isTimeout ? 'TIMEOUT' : 'FAIL',
                    duration,
                    requestPayload: finalPayload,
                    error: e.message
                });

                if (retryCount < maxRetries) {
                    retryCount++;
                    await new Promise(r => setTimeout(r, 1000)); // Wait before retry
                    continue;
                }
            }
            break;
        }

        return lastResult || { status: 'FAIL', duration: 0, error: 'Unknown error' };
    };
    const stopTests = () => {
        stopTestRef.current = true;
        setIsRunning(false);
        setRunningTest(null);
        showToast('info', '测试已停止');
    };

    const runAllTests = async () => {
        if (!selectedSuite || !targetDevice || !mqttConnected) {
            showToast('warning', '请选择测试库、目标设备并确保 MQTT 已连接');
            return;
        }

        stopTestRef.current = false;

        // Determine protocols to run
        const protocolsToRun = selectedProtocols.size > 0
            ? selectedSuite.protocols.filter(p => selectedProtocols.has(p.id))
            : selectedSuite.protocols;

        if (protocolsToRun.length === 0) {
            showToast('warning', '没有可运行的协议');
            return;
        }

        // 审核门禁：检查是否所有待运行协议都已审核通过
        const unverifiedProtocols = protocolsToRun.filter(p => p.reviewStatus !== 'VERIFIED');
        if (unverifiedProtocols.length > 0) {
            setVerificationErrorSuiteId(selectedSuite.id);
            setUnverifiedProtocolsModal({ show: true, protocols: unverifiedProtocols });
            addTestLog('ERROR', `测试被阻断：${unverifiedProtocols.length} 个协议尚未审核通过`);
            // 5秒后清除高亮
            setTimeout(() => setVerificationErrorSuiteId(null), 5000);
            return;
        }

        setIsRunning(true);
        setTestLogs([]);
        addTestLog('INFO', `开始执行测试库: ${selectedSuite.name} (${protocolsToRun.length} 个协议)`);

        const run: TestRun = {
            id: `run_${Date.now()}`,
            suiteId: selectedSuite.id,
            suiteName: selectedSuite.name,
            deviceId: targetDevice.id,
            deviceName: targetDevice.name,
            startTime: Date.now(),
            status: 'RUNNING',
            results: [],
            summary: { total: 0, passed: 0, failed: 0, timeout: 0 }
        };
        setCurrentRun(run);

        // Batch result container
        const batchResult: BatchTestResult = {
            id: run.id,
            suiteId: selectedSuite.id,
            suiteName: selectedSuite.name,
            deviceName: targetDevice.name,
            startTime: Date.now(),
            status: 'RUNNING',
            results: [],
            summary: { total: 0, passed: 0, failed: 0, timeout: 0 }
        };
        setBatchTestResult(batchResult);

        // 获取 stopOnFail 配置
        const stopOnFail = selectedSuite.executionConfig?.stopOnFail || false;
        let shouldStop = false;

        // P0 优化: 计算总测试数量用于进度显示
        let totalTests = 0;
        let currentTestIndex = 0;
        for (const p of protocolsToRun) {
            for (const m of REQUEST_METHODS) {
                const mc = p.methods[m];
                if (!mc?.enabled) continue;
                const cases = mc.testCases || [];
                totalTests += cases.length > 0 ? cases.length : 1;
            }
        }

        setTestProgress({
            current: 0,
            total: totalTests,
            currentProtocol: '',
            startTime: Date.now()
        });

        outerLoop: for (const protocol of protocolsToRun) {
            if (stopTestRef.current) break;
            for (const methodName of REQUEST_METHODS) {
                if (stopTestRef.current) break;
                const methodConfig = protocol.methods[methodName];
                if (!methodConfig?.enabled) continue;

                const testCases = methodConfig.testCases || [];

                if (testCases.length > 0) {
                    // Run Test Cases
                    for (const testCase of testCases) {
                        if (stopTestRef.current) break;
                        setRunningTest(`${protocol.id}:${methodName}:${testCase.id}`);
                        currentTestIndex++;
                        setTestProgress(prev => prev ? { ...prev, current: currentTestIndex, currentProtocol: `${protocol.namespace} ${methodName} [${testCase.name}]` } : null);

                        run.summary.total++;
                        batchResult.summary.total++;

                        const result = await runSingleTest(protocol, methodName, false, testCase);

                        run.results.push({
                            protocolId: protocol.id,
                            namespace: protocol.namespace,
                            method: methodName,
                            status: result.status,
                            duration: result.duration,
                            response: result.response,
                            error: result.error,
                            testCaseId: testCase.id,
                            testCaseName: testCase.name
                        });

                        // result 本身就是 DetailedTestResult，直接 push
                        batchResult.results.push(result);

                        if (result.status === 'PASS') {
                            run.summary.passed++;
                            batchResult.summary.passed++;
                        } else if (result.status === 'FAIL') {
                            run.summary.failed++;
                            batchResult.summary.failed++;
                        } else if (result.status === 'TIMEOUT') {
                            run.summary.timeout++;
                            batchResult.summary.timeout++;
                        }

                        // Update test case lastResult
                        setSuites(prev => prev.map(s => {
                            if (s.id !== selectedSuite.id) return s;
                            return {
                                ...s,
                                protocols: s.protocols.map(p => {
                                    if (p.id !== protocol.id) return p;
                                    const mConfig = p.methods[methodName];
                                    if (!mConfig) return p;
                                    return {
                                        ...p,
                                        methods: {
                                            ...p.methods,
                                            [methodName]: {
                                                ...mConfig,
                                                testCases: (mConfig.testCases || []).map(tc => tc.id === testCase.id ? { ...tc, lastResult: result } : tc)
                                            }
                                        }
                                    };
                                })
                            };
                        }));

                        setCurrentRun({ ...run });
                        setBatchTestResult({ ...batchResult });

                        // 检查是否需要停止
                        // 检查是否需要停止
                        if (stopOnFail && result.status !== 'PASS') {
                            shouldStop = true;
                            addTestLog('INFO', '检测到失败，停止后续测试');
                            break outerLoop;
                        }

                        if (stopTestRef.current) {
                            addTestLog('INFO', '用户停止测试');
                            break outerLoop;
                        }

                        await new Promise(r => setTimeout(r, 200));
                    }
                } else {
                    // Run Default Test
                    if (stopTestRef.current) break;
                    setRunningTest(`${protocol.id}:${methodName}`);
                    currentTestIndex++;
                    setTestProgress(prev => prev ? { ...prev, current: currentTestIndex, currentProtocol: `${protocol.namespace} ${methodName}` } : null);

                    run.summary.total++;
                    batchResult.summary.total++;

                    const result = await runSingleTest(protocol, methodName, false);

                    run.results.push({
                        protocolId: protocol.id,
                        namespace: protocol.namespace,
                        method: methodName,
                        status: result.status,
                        duration: result.duration,
                        response: result.response,
                        error: result.error
                    });

                    // result 本身就是 DetailedTestResult，直接 push
                    batchResult.results.push(result);

                    if (result.status === 'PASS') {
                        run.summary.passed++;
                        batchResult.summary.passed++;
                    } else if (result.status === 'FAIL') {
                        run.summary.failed++;
                        batchResult.summary.failed++;
                    } else if (result.status === 'TIMEOUT') {
                        run.summary.timeout++;
                        batchResult.summary.timeout++;
                    }

                    updateProtocolMethod(protocol.id, methodName, { lastResult: result });

                    setCurrentRun({ ...run });
                    setBatchTestResult({ ...batchResult });

                    // 检查是否需要停止
                    if (stopOnFail && result.status !== 'PASS') {
                        shouldStop = true;
                        addTestLog('INFO', '检测到失败，停止后续测试');
                        break outerLoop;
                    }

                    await new Promise(r => setTimeout(r, 200));
                }
            }
        }

        run.endTime = Date.now();
        run.status = run.summary.failed > 0 || run.summary.timeout > 0 ? 'FAILED' : 'COMPLETED';

        batchResult.endTime = Date.now();
        batchResult.status = run.status;

        setCurrentRun(run);
        setBatchTestResult(batchResult);
        setTestHistory(prev => [...prev, run]);
        setRunningTest(null);
        setIsRunning(false);
        setTestProgress(null); // 清除进度追踪

        addTestLog('INFO', `测试完成: ${run.summary.passed}/${run.summary.total} 通过`);

        // Show summary panel
        setShowBatchSummary(true);
    };

    // --- Report Export ---

    const exportReport = (format: 'json' | 'junit' | 'html') => {
        if (!currentRun) return;

        let data: string;
        let filename: string;
        let mimeType: string;

        if (format === 'json') {
            data = JSON.stringify(currentRun, null, 2);
            filename = `test_report_${currentRun.id}.json`;
            mimeType = 'application/json';
        } else if (format === 'junit') {
            data = generateJUnitXML(currentRun);
            filename = `test_report_${currentRun.id}.xml`;
            mimeType = 'application/xml';
        } else {
            // P1 优化: HTML 报告生成
            data = generateHTMLReport(currentRun);
            filename = `test_report_${currentRun.id}.html`;
            mimeType = 'text/html';
        }

        const blob = new Blob([data], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    };

    // P1 优化: 生成 HTML 测试报告
    const generateJUnitXML = (run: TestRun): string => {
        const duration = run.endTime ? run.endTime - run.startTime : 0;
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        xml += `<testsuites name="Protocol Audit" time="${duration / 1000}" tests="${run.summary.total}" failures="${run.summary.failed}">\n`;
        xml += `  <testsuite name="All Tests" time="${duration / 1000}" tests="${run.summary.total}" failures="${run.summary.failed}">\n`;

        run.results.forEach(result => {
            xml += `    <testcase name="${result.method} ${result.namespace}" classname="${result.namespace}" time="${result.duration / 1000}">\n`;
            if (result.status === 'FAIL') {
                xml += `      <failure message="Test failed">${result.error || 'Unknown error'}</failure>\n`;
            } else if (result.status === 'TIMEOUT') {
                xml += `      <failure message="Test timed out">Timeout</failure>\n`;
            }
            xml += `    </testcase>\n`;
        });

        xml += `  </testsuite>\n`;
        xml += `</testsuites>`;
        return xml;
    };

    const generateHTMLReport = (run: TestRun): string => {
        const passRate = run.summary.total > 0 ? ((run.summary.passed / run.summary.total) * 100).toFixed(1) : '0';
        const duration = run.endTime ? ((run.endTime - run.startTime) / 1000).toFixed(2) : 'N/A';

        const resultRows = run.results.map(r => {
            const statusColor = r.status === 'PASS' ? '#10b981' : r.status === 'FAIL' ? '#ef4444' : '#f59e0b';
            const statusBg = r.status === 'PASS' ? '#10b98120' : r.status === 'FAIL' ? '#ef444420' : '#f59e0b20';
            return `
                <tr>
                    <td style="padding: 12px; border-bottom: 1px solid #334155;">${r.namespace}</td>
                    <td style="padding: 12px; border-bottom: 1px solid #334155;"><code>${r.method}</code></td>
                    <td style="padding: 12px; border-bottom: 1px solid #334155;">
                        <span style="background: ${statusBg}; color: ${statusColor}; padding: 4px 12px; border-radius: 9999px; font-weight: bold; font-size: 12px;">
                            ${r.status}
                        </span>
                    </td>
                    <td style="padding: 12px; border-bottom: 1px solid #334155; color: #94a3b8;">${r.duration}ms</td>
                    <td style="padding: 12px; border-bottom: 1px solid #334155; color: #f87171; font-size: 12px;">${r.error || '-'}</td>
                </tr>
            `;
        }).join('');

        return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>测试报告 - ${run.suiteName}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; line-height: 1.6; }
        .container { max-width: 1200px; margin: 0 auto; padding: 40px 20px; }
        h1 { font-size: 2.5rem; margin-bottom: 8px; background: linear-gradient(to right, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .subtitle { color: #64748b; margin-bottom: 32px; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 40px; }
        .stat-card { background: #1e293b; border-radius: 16px; padding: 24px; border: 1px solid #334155; }
        .stat-value { font-size: 2rem; font-weight: bold; }
        .stat-label { color: #94a3b8; font-size: 14px; }
        .pass { color: #10b981; }
        .fail { color: #ef4444; }
        .timeout { color: #f59e0b; }
        table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 16px; overflow: hidden; border: 1px solid #334155; }
        th { text-align: left; padding: 16px 12px; background: #334155; color: #e2e8f0; font-weight: 600; }
        code { background: #334155; padding: 2px 8px; border-radius: 4px; font-size: 13px; }
        .footer { text-align: center; color: #64748b; margin-top: 40px; font-size: 14px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🧪 协议测试报告</h1>
        <p class="subtitle">测试库: ${run.suiteName} | 设备: ${run.deviceName} | 时间: ${new Date(run.startTime).toLocaleString('zh-CN')}</p>
        
        <div class="stats">
            <div class="stat-card">
                <div class="stat-value">${run.summary.total}</div>
                <div class="stat-label">总测试数</div>
            </div>
            <div class="stat-card">
                <div class="stat-value pass">${run.summary.passed}</div>
                <div class="stat-label">通过</div>
            </div>
            <div class="stat-card">
                <div class="stat-value fail">${run.summary.failed}</div>
                <div class="stat-label">失败</div>
            </div>
            <div class="stat-card">
                <div class="stat-value timeout">${run.summary.timeout}</div>
                <div class="stat-label">超时</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" style="color: #818cf8;">${passRate}%</div>
                <div class="stat-label">通过率</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" style="color: #a78bfa;">${duration}s</div>
                <div class="stat-label">总耗时</div>
            </div>
        </div>
        
        <h2 style="margin-bottom: 20px; color: #e2e8f0;">📋 详细结果</h2>
        <table>
            <thead>
                <tr>
                    <th>协议 Namespace</th>
                    <th>方法</th>
                    <th>状态</th>
                    <th>耗时</th>
                    <th>错误信息</th>
                </tr>
            </thead>
            <tbody>
                ${resultRows}
            </tbody>
        </table>
        
        <p class="footer">Generated by IOT Nexus Core Protocol Audit Tool</p>
    </div>
</body>
</html>`;
    };

    const sendToJenkins = async () => {
        if (!currentRun || !jenkinsUrl.trim()) {
            showToast('warning', '请输入 Jenkins Webhook URL');
            return;
        }

        try {
            const response = await fetch(jenkinsUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(currentRun)
            });

            if (response.ok) {
                showToast('success', '报告已成功发送到 Jenkins');
                setShowReportModal(false);
            } else {
                showToast('error', `发送失败: ${response.status} ${response.statusText}`);
            }
        } catch (e: any) {
            showToast('error', `Error: ${e.message}`);
        }
    };

    return (
        <div className="flex flex-col h-full overflow-hidden">
            {/* Toast Message */}
            {toastMessage.show && (
                <div className={`fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[200] flex items-center gap-3 px-6 py-4 rounded-xl shadow-2xl border transition-all duration-300 ${toastMessage.type === 'error' ? 'bg-red-900/95 border-red-500/50 text-red-100' :
                    toastMessage.type === 'success' ? 'bg-emerald-900/90 border-emerald-500/50 text-emerald-100' :
                        toastMessage.type === 'warning' ? 'bg-amber-900/90 border-amber-500/50 text-amber-100' :
                            'bg-blue-900/90 border-blue-500/50 text-blue-100'
                    }`}>
                    {toastMessage.type === 'error' && <AlertTriangle size={18} />}
                    {toastMessage.type === 'success' && <CheckCircle2 size={18} />}
                    {toastMessage.type === 'warning' && <AlertTriangle size={18} />}
                    {toastMessage.type === 'info' && <Info size={18} />}
                    <span className="text-sm font-medium">{toastMessage.message}</span>
                    <button onClick={() => setToastMessage(prev => ({ ...prev, show: false }))} className="ml-2 opacity-70 hover:opacity-100">
                        <X size={16} />
                    </button>
                </div>
            )}
            {/* Main Content Area */}
            {/* Main Content Area */}
            <div className="flex-1 flex gap-4 p-4 min-h-0 overflow-hidden">
                {/* Left Panel - Tree View - Full Height */}
                <div className="w-96 bg-slate-900 border border-slate-700 rounded-2xl flex flex-col shrink-0 overflow-hidden h-full">
                    {/* Toolbar */}
                    <div className="p-3 border-b border-slate-800 flex gap-2">
                        <button
                            onClick={() => setIsAddingSuite(true)}
                            className="p-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg transition-colors"
                            title="New Suite"
                        >
                            <Plus size={16} />
                        </button>
                        <label className="p-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg transition-colors cursor-pointer" title="Import Suite">
                            <Upload size={16} />
                            <input type="file" accept=".json" className="hidden" onChange={importSuite} />
                        </label>
                        <button
                            onClick={() => setShowProtocolGenerator(true)}
                            disabled={!mqttConnected || !targetDevice}
                            className="flex-1 px-3 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-lg text-xs font-bold flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                            title="Auto Generate from Device Ability"
                        >
                            <Wand2 size={14} /> Auto Gen
                        </button>
                    </div>

                    {/* Device Selector - Moved from right panel */}
                    <div className="px-3 py-2 border-b border-slate-800">
                        <select
                            value={targetDeviceId}
                            onChange={(e) => setTargetDeviceId(e.target.value)}
                            className="w-full bg-slate-800 text-white text-sm rounded-lg px-3 py-2 outline-none border border-slate-700 focus:border-indigo-500"
                        >
                            <option value="">Select Device...</option>
                            {devices.map(d => (
                                <option key={d.id} value={d.id}>{d.name} ({d.ip})</option>
                            ))}
                        </select>
                    </div>

                    {/* P1 优化: Tree View 搜索框 */}
                    <div className="px-3 py-2 border-b border-slate-800">
                        <div className="relative">
                            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                            <input
                                value={searchTerm}
                                onChange={e => setSearchTerm(e.target.value)}
                                placeholder="搜索协议..."
                                className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-300 outline-none focus:border-indigo-500 transition-colors"
                            />
                            {searchTerm && (
                                <button
                                    onClick={() => setSearchTerm('')}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                                >
                                    <XCircle size={12} />
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Tree View */}
                    <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
                        <div className="text-[10px] font-bold text-slate-500 uppercase px-2 py-1 mb-1">Test Suites</div>
                        {suites.map(suite => {
                            // P1 优化: 搜索过滤逻辑
                            const isSuiteMatch = !searchTerm || suite.name.toLowerCase().includes(searchTerm.toLowerCase());
                            const matchingProtocols = suite.protocols.filter(p =>
                                !searchTerm ||
                                p.namespace.toLowerCase().includes(searchTerm.toLowerCase()) ||
                                p.name.toLowerCase().includes(searchTerm.toLowerCase())
                            );

                            // 如果 Suite 匹配，显示所有协议；否则只显示匹配的协议
                            const displayProtocols = isSuiteMatch ? suite.protocols : matchingProtocols;

                            // 如果 Suite 不匹配且没有匹配的协议，则隐藏
                            if (!isSuiteMatch && matchingProtocols.length === 0) {
                                return null;
                            }

                            const isError = verificationErrorSuiteId === suite.id;
                            // 如果有搜索词，默认展开所有匹配的 Suite
                            const isExpanded = expandedSuites.has(suite.id) || isError || !!searchTerm;
                            const isSelected = selectedSuiteId === suite.id && !selectedProtocolId;

                            return (
                                <div key={suite.id} className="select-none">
                                    {/* Suite Node */}
                                    <div
                                        className={`group flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${isSelected ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-slate-800 hover:text-white'} ${isError ? 'ring-1 ring-red-500 bg-red-500/10' : ''}`}
                                        onClick={() => {
                                            setSelectedSuiteId(suite.id);
                                            setSelectedProtocolId(null);
                                            // Auto select all protocols in suite
                                            const newSelected = new Set<string>();
                                            suite.protocols.forEach(p => newSelected.add(p.id));
                                            setSelectedProtocols(newSelected);

                                            // Auto expand on click
                                            setExpandedSuites(prev => {
                                                const next = new Set(prev);
                                                next.add(suite.id);
                                                return next;
                                            });
                                        }}
                                    >
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setExpandedSuites(prev => {
                                                    const next = new Set(prev);
                                                    if (next.has(suite.id)) next.delete(suite.id);
                                                    else next.add(suite.id);
                                                    return next;
                                                });
                                            }}
                                            className={`p-0.5 rounded hover:bg-white/10 ${isSelected ? 'text-white' : 'text-slate-500'}`}
                                        >
                                            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                        </button>

                                        {/* Batch Select All for Suite */}
                                        <div onClick={e => e.stopPropagation()} className="flex items-center">
                                            <input
                                                type="checkbox"
                                                checked={suite.protocols.length > 0 && suite.protocols.every(p => selectedProtocols.has(p.id))}
                                                onChange={(e) => {
                                                    const newSelected = new Set(selectedProtocols);
                                                    if (e.target.checked) {
                                                        suite.protocols.forEach(p => newSelected.add(p.id));
                                                    } else {
                                                        suite.protocols.forEach(p => newSelected.delete(p.id));
                                                    }
                                                    setSelectedProtocols(newSelected);
                                                }}
                                                className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-800 accent-indigo-500 cursor-pointer"
                                            />
                                        </div>

                                        <FolderOpen size={16} className={isSelected ? 'text-white' : 'text-indigo-400'} />

                                        <span className="flex-1 text-sm font-medium truncate">{suite.name}</span>

                                        {/* Suite Actions (Hover) */}
                                        <div className={`flex items-center opacity-0 group-hover:opacity-100 transition-opacity ${isSelected ? 'text-white' : 'text-slate-400'}`}>
                                            <button onClick={(e) => { e.stopPropagation(); startEditingSuite(suite); }} className="p-1 hover:text-indigo-300" title="Edit">
                                                <Edit3 size={12} />
                                            </button>
                                            <button onClick={(e) => { e.stopPropagation(); exportSuite(suite); }} className="p-1 hover:text-emerald-300" title="Export">
                                                <Download size={12} />
                                            </button>
                                            <button onClick={(e) => { e.stopPropagation(); deleteSuite(suite.id); }} className="p-1 hover:text-red-300" title="Delete">
                                                <Trash2 size={12} />
                                            </button>
                                        </div>
                                    </div>

                                    {/* Protocols (Children) */}
                                    {isExpanded && (
                                        <div className="ml-4 pl-2 border-l border-slate-800 mt-1 space-y-0.5">
                                            {displayProtocols.map(protocol => {
                                                const isProtoSelected = selectedProtocolId === protocol.id;
                                                const protoStatus = getProtocolStatus(protocol);
                                                const statusCfg = STATUS_CONFIG[protoStatus];

                                                const StatusIcon = {
                                                    'verified_passed': CheckCircle2,
                                                    'verified_failed': AlertCircle,
                                                    'unverified': AlertTriangle,
                                                    'never_tested': CheckCircle2 // Changed to CheckCircle2 for verified
                                                }[protoStatus] || Circle;

                                                const statusColor = {
                                                    'verified_passed': 'text-emerald-500',
                                                    'verified_failed': 'text-red-500',
                                                    'unverified': 'text-red-500',
                                                    'never_tested': 'text-emerald-500' // Changed to green for verified but untested
                                                }[protoStatus] || 'text-slate-600';

                                                return (
                                                    <div
                                                        key={protocol.id}
                                                        className={`group/proto flex items-center gap-2 px-2 py-2 rounded-md cursor-pointer transition-colors ${isProtoSelected ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30' : `text-slate-400 ${statusCfg.bgHover} hover:text-slate-200 border border-transparent`
                                                            }`}
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setSelectedSuiteId(suite.id);
                                                            startEditingProtocol(protocol);
                                                        }}
                                                    >
                                                        {/* Batch Selection Checkbox */}
                                                        <div onClick={e => e.stopPropagation()} className="flex items-center">
                                                            <input
                                                                type="checkbox"
                                                                checked={selectedProtocols.has(protocol.id)}
                                                                onChange={(e) => {
                                                                    const newSelected = new Set(selectedProtocols);
                                                                    if (e.target.checked) newSelected.add(protocol.id);
                                                                    else newSelected.delete(protocol.id);
                                                                    setSelectedProtocols(newSelected);
                                                                }}
                                                                className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-800 accent-indigo-500 cursor-pointer"
                                                            />
                                                        </div>

                                                        <StatusIcon size={14} className={`${statusColor} shrink-0`} />
                                                        {/* <FileText size={14} /> Removed generic icon, status icon is enough */}
                                                        <span className="flex-1 text-sm font-mono truncate" title={protocol.namespace}>{protocol.namespace}</span>
                                                        {/* Quick Run Button */}
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                if (targetDevice && mqttConnected) {
                                                                    REQUEST_METHODS.forEach(async (m) => {
                                                                        if (protocol.methods[m]?.enabled) {
                                                                            setRunningTest(`${protocol.id}:${m}`);
                                                                            await runSingleTest(protocol, m, true);
                                                                            setRunningTest(null);
                                                                        }
                                                                    });
                                                                } else {
                                                                    addTestLog('ERROR', 'Please connect device first');
                                                                }
                                                            }}
                                                            className="opacity-0 group-hover/proto:opacity-100 p-1 text-slate-500 hover:text-emerald-400 transition-all"
                                                            title="Quick Run Test"
                                                        >
                                                            {runningTest?.startsWith(protocol.id) ? (
                                                                <RefreshCw size={12} className="animate-spin" />
                                                            ) : (
                                                                <Play size={12} />
                                                            )}
                                                        </button>
                                                    </div>
                                                );
                                            })}
                                            {suite.protocols.length === 0 && (
                                                <div className="text-[10px] text-slate-600 italic px-2 py-1">No protocols</div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    {/* Footer Actions */}
                    <div className="p-2 border-t border-slate-800">
                        <button
                            onClick={() => setShowStatsDashboard(true)}
                            className="w-full py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg text-xs font-bold flex items-center justify-center gap-2 transition-colors"
                        >
                            <BarChart3 size={14} /> Statistics Report
                        </button>
                    </div>
                </div>

                {/* Right Panel - Editor & Results & Log */}
                <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-slate-900 border border-slate-700 rounded-2xl">
                    {/* Top Section: Editor/Results */}
                    <div className="flex-1 overflow-hidden flex flex-col">
                        {selectedSuite ? (
                            <>
                                {/* Header */}
                                <div className="flex justify-between items-start shrink-0 p-4">
                                    <div>
                                        <h1 className="text-xl font-black text-white">{selectedSuite.name}</h1>
                                        {selectedSuite.description && <p className="text-sm text-slate-500 mt-1">{selectedSuite.description}</p>}
                                    </div>
                                    <div className="flex gap-2">
                                        {/* 测试配置按钮 */}
                                        <button
                                            onClick={() => {
                                                setTempExecutionConfig(selectedSuite.executionConfig || DEFAULT_EXECUTION_CONFIG);
                                                setShowExecutionConfigModal(true);
                                            }}
                                            className="p-2 bg-slate-700 hover:bg-slate-600 text-white rounded-xl flex items-center gap-1"
                                            title={`超时: ${(selectedSuite.executionConfig?.timeout || DEFAULT_EXECUTION_CONFIG.timeout) / 1000}s, 重试: ${selectedSuite.executionConfig?.retryCount || 0}次`}
                                        >
                                            <Settings size={16} />
                                            <span className="text-xs text-slate-400">
                                                {(selectedSuite.executionConfig?.timeout || DEFAULT_EXECUTION_CONFIG.timeout) / 1000}s
                                                {(selectedSuite.executionConfig?.retryCount || 0) > 0 && ` ×${selectedSuite.executionConfig?.retryCount}`}
                                            </span>
                                        </button>
                                        {!selectedProtocolId && (
                                            isRunning ? (
                                                <button onClick={stopTests} className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-bold uppercase flex items-center gap-2">
                                                    <XCircle size={14} /> Stop
                                                </button>
                                            ) : (
                                                <button
                                                    onClick={runAllTests}
                                                    disabled={!mqttConnected || selectedSuite.protocols.length === 0 || selectedProtocols.size === 0}
                                                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold uppercase flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                                >
                                                    <Play size={14} /> {selectedProtocols.size > 0 ? `Run Selected (${selectedProtocols.size})` : 'Select Protocols'}
                                                </button>
                                            )
                                        )}
                                        {currentRun && (
                                            <button onClick={() => setShowReportModal(true)} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold uppercase flex items-center gap-2">
                                                <FileJson size={14} /> Export Report
                                            </button>
                                        )}
                                        <button onClick={() => setIsAddingProtocol(true)} className="p-2 bg-slate-700 hover:bg-slate-600 text-white rounded-xl"><Plus size={18} /></button>
                                    </div>
                                </div>

                                {/* Tab Bar - Dynamic based on selection */}
                                <div className="flex gap-1 px-4 border-b border-slate-800 mb-2 shrink-0">
                                    {selectedProtocolId ? (
                                        // Protocol selected - Only show Edit tab
                                        <button
                                            className="px-4 py-2 border-b-2 border-indigo-500 text-indigo-400 text-sm font-bold"
                                        >
                                            Edit Protocol
                                        </button>
                                    ) : (
                                        // Suite selected - Show Overview and Results
                                        <>
                                            {(['overview', 'results'] as const).map(tab => (
                                                <button
                                                    key={tab}
                                                    onClick={() => setRightPanelTab(tab)}
                                                    className={`px-4 py-2 border-b-2 transition-colors text-sm font-bold ${rightPanelTab === tab ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
                                                >
                                                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                                                </button>
                                            ))}
                                        </>
                                    )}
                                </div>

                                {/* Overview Tab */}
                                {rightPanelTab === 'overview' && (
                                    <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-4">
                                        {/* Current Run Summary */}
                                        {currentRun && (
                                            <div className={`p-4 rounded-xl border flex items-center justify-between ${currentRun.status === 'COMPLETED' ? 'bg-emerald-500/10 border-emerald-500/30' : currentRun.status === 'FAILED' ? 'bg-red-500/10 border-red-500/30' : 'bg-blue-500/10 border-blue-500/30'}`}>
                                                <div className="flex items-center gap-4">
                                                    {currentRun.status === 'COMPLETED' && <CheckCircle size={24} className="text-emerald-400" />}
                                                    {currentRun.status === 'FAILED' && <XCircle size={24} className="text-red-400" />}
                                                    {currentRun.status === 'RUNNING' && <RefreshCw size={24} className="text-blue-400 animate-spin" />}
                                                    <div>
                                                        <div className="text-base font-bold text-white">{currentRun.status === 'RUNNING' ? 'Testing...' : currentRun.status === 'COMPLETED' ? 'All Tests Passed' : 'Some Tests Failed'}</div>
                                                        <div className="text-xs text-slate-400">Device: {currentRun.deviceName}</div>
                                                        {/* Progress */}
                                                        {testProgress && currentRun.status === 'RUNNING' && (
                                                            <div className="mt-2">
                                                                <div className="flex items-center gap-2 text-xs text-slate-300">
                                                                    <span className="font-mono">{testProgress.current}/{testProgress.total}</span>
                                                                    <span className="text-slate-500">|</span>
                                                                    <span className="truncate max-w-[200px]">{testProgress.currentProtocol}</span>
                                                                    {testProgress.current > 0 && (
                                                                        <>
                                                                            <span className="text-slate-500">|</span>
                                                                            <span className="text-slate-400">
                                                                                ~{Math.ceil(((Date.now() - testProgress.startTime) / testProgress.current) * (testProgress.total - testProgress.current) / 1000)}s 剩余
                                                                            </span>
                                                                        </>
                                                                    )}
                                                                </div>
                                                                <div className="w-full bg-slate-700 rounded-full h-1.5 mt-1.5">
                                                                    <div
                                                                        className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
                                                                        style={{ width: `${(testProgress.current / testProgress.total) * 100}%` }}
                                                                    />
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-4 text-sm">
                                                    <span className="text-emerald-400 font-bold">{currentRun.summary.passed} Pass</span>
                                                    <span className="text-red-400 font-bold">{currentRun.summary.failed} Fail</span>
                                                    <span className="text-amber-400 font-bold">{currentRun.summary.timeout} Timeout</span>
                                                </div>
                                            </div>
                                        )}

                                        {/* Suite Overview Cards */}
                                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                                            {/* Total Protocols */}
                                            <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4">
                                                <div className="text-3xl font-black text-white">{selectedSuite.protocols.length}</div>
                                                <div className="text-xs text-slate-400 mt-1">Total Protocols</div>
                                            </div>

                                            {/* Verified Count */}
                                            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4">
                                                <div className="text-3xl font-black text-emerald-400">
                                                    {selectedSuite.protocols.filter(p => p.reviewStatus === 'VERIFIED').length}
                                                </div>
                                                <div className="text-xs text-emerald-400/70 mt-1">Verified</div>
                                            </div>

                                            {/* Unverified Count */}
                                            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
                                                <div className="text-3xl font-black text-amber-400">
                                                    {selectedSuite.protocols.filter(p => p.reviewStatus !== 'VERIFIED').length}
                                                </div>
                                                <div className="text-xs text-amber-400/70 mt-1">Pending Review</div>
                                            </div>

                                            {/* Test Pass Rate */}
                                            <div className="bg-indigo-500/10 border border-indigo-500/30 rounded-xl p-4">
                                                <div className="text-3xl font-black text-indigo-400">
                                                    {(() => {
                                                        const tested = selectedSuite.protocols.filter(p =>
                                                            Object.values(p.methods).some(m => m?.lastResult !== undefined)
                                                        );
                                                        if (tested.length === 0) return '--';
                                                        const passed = tested.filter(p =>
                                                            Object.values(p.methods).every(m => !m?.enabled || m?.lastResult?.status === 'PASS')
                                                        ).length;
                                                        return Math.round((passed / tested.length) * 100) + '%';
                                                    })()}
                                                </div>
                                                <div className="text-xs text-indigo-400/70 mt-1">Pass Rate</div>
                                            </div>
                                        </div>

                                        {/* Method Distribution */}
                                        <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4">
                                            <h4 className="text-sm font-bold text-slate-300 mb-3">Method Distribution</h4>
                                            <div className="flex gap-6">
                                                {ALL_METHODS.map(method => {
                                                    const count = selectedSuite.protocols.filter(p => p.methods[method]?.enabled).length;
                                                    return (
                                                        <div key={method} className="flex items-center gap-2">
                                                            <div className={`w-3 h-3 rounded ${METHOD_COLORS[method]?.bg || 'bg-slate-500'}`} />
                                                            <span className="text-sm font-bold text-white">{method}</span>
                                                            <span className="text-sm text-slate-400">({count})</span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>

                                        {/* Empty State */}
                                        {selectedSuite.protocols.length === 0 && (
                                            <div className="flex-1 flex flex-col items-center justify-center text-slate-500 py-12">
                                                <FolderOpen size={48} className="mb-4 opacity-30" />
                                                <p className="text-sm">This test suite has no protocols yet</p>
                                                <p className="text-xs mt-2 text-slate-600">Click "Auto Gen" or "+" to add protocols</p>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* Protocol Edit/Review Panel - Only show when a protocol is selected */}
                                {selectedProtocolId && (
                                    <div className="flex-1 overflow-hidden flex flex-col bg-slate-900/50 rounded-xl m-4 border border-slate-800 relative">
                                        {/* Consolidated Header & Tabs */}
                                        <div className="flex items-center justify-between px-4 border-b border-slate-800 shrink-0 h-12 bg-slate-900/50">
                                            {/* Left: Tabs */}
                                            <div className="flex gap-1 h-full">
                                                {(['edit', 'review'] as const).map(tab => (
                                                    <button
                                                        key={tab}
                                                        onClick={() => setRightPanelTab(tab)}
                                                        className={`px-5 h-full border-b-2 transition-colors text-sm font-bold uppercase tracking-wider ${(rightPanelTab === tab || (rightPanelTab === 'overview' && tab === 'edit'))
                                                            ? 'border-indigo-500 text-indigo-400'
                                                            : 'border-transparent text-slate-500 hover:text-slate-300'
                                                            }`}
                                                    >
                                                        {tab === 'edit' ? 'Edit' : 'Review & Run'}
                                                    </button>
                                                ))}
                                            </div>

                                            {/* Right: Protocol Info & Close */}
                                            <div className="flex items-center gap-4">
                                                <span className="text-sm font-mono text-slate-400">{newProtocol.namespace || 'Protocol'}</span>
                                                <span className={`text-xs font-bold px-2 py-1 rounded ${newProtocol.reviewStatus === 'VERIFIED' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'}`}>
                                                    {newProtocol.reviewStatus === 'VERIFIED' ? 'Verified' : 'Pending'}
                                                </span>
                                                <div className="w-px h-4 bg-slate-700" />
                                                <button
                                                    onClick={() => {
                                                        setSelectedProtocolId(null);
                                                        setRightPanelTab('overview');
                                                    }}
                                                    className="text-slate-500 hover:text-white transition-colors"
                                                    title="Close"
                                                >
                                                    <X size={18} />
                                                </button>
                                            </div>
                                        </div>

                                        {/* Edit Content */}
                                        {(rightPanelTab === 'edit' || rightPanelTab === 'overview') && (
                                            <div className="flex-1 overflow-hidden flex flex-col p-4">
                                                {/* Step Progress */}
                                                {/* Step Progress & Actions */}
                                                <div className="flex items-center justify-between gap-4 mb-2 shrink-0 bg-slate-900/30 p-2 rounded-lg border border-slate-800/50">
                                                    {/* Steps */}
                                                    <div className="flex items-center gap-2">
                                                        <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${wizardStep >= 1 ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-slate-400'}`}>1</div>
                                                        <div className={`w-8 h-0.5 rounded ${wizardStep >= 2 ? 'bg-indigo-600' : 'bg-slate-700'}`} />
                                                        <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${wizardStep >= 2 ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-slate-400'}`}>2</div>
                                                    </div>

                                                    {/* Actions */}
                                                    <div className="flex items-center gap-3">
                                                        {/* Cancel button removed */}
                                                        {wizardStep > 1 && (
                                                            <button
                                                                onClick={() => setWizardStep(s => s - 1)}
                                                                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm font-bold uppercase"
                                                            >
                                                                Back
                                                            </button>
                                                        )}
                                                        {wizardStep === 1 ? (
                                                            <button
                                                                onClick={() => {
                                                                    if (!newProtocol.namespace.trim()) {
                                                                        setErrorMessage('请输入 Namespace');
                                                                        return;
                                                                    }
                                                                    if (!getEnabledMethods().length) {
                                                                        setErrorMessage('请至少选择一个 Method');
                                                                        return;
                                                                    }
                                                                    setWizardStep(2);
                                                                    setCurrentMethodIndex(0);
                                                                }}
                                                                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-bold uppercase"
                                                            >
                                                                Next
                                                            </button>
                                                        ) : (
                                                            <button
                                                                onClick={addProtocolToSuite}
                                                                className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-bold uppercase"
                                                            >
                                                                {newProtocol.id ? 'Save' : 'Create'}
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>

                                                {errorMessage && (
                                                    <div className="bg-red-500/10 border border-red-500/50 p-4 mb-4 rounded-lg flex items-center justify-between mx-1">
                                                        <div className="flex items-center gap-2 text-red-400">
                                                            <AlertTriangle size={20} />
                                                            <span className="font-bold">{errorMessage}</span>
                                                        </div>
                                                        <button onClick={() => setErrorMessage(null)} className="text-red-400 hover:text-red-300">
                                                            <X size={20} />
                                                        </button>
                                                    </div>
                                                )}

                                                <div className="flex-1 overflow-y-auto custom-scrollbar">
                                                    {/* Step 1: Basic Info & Method Selection */}
                                                    {wizardStep === 1 && (
                                                        <div className="space-y-4">
                                                            <div>
                                                                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Namespace *</label>
                                                                <div className="flex gap-2">
                                                                    <input
                                                                        value={newProtocol.namespace}
                                                                        onChange={e => setNewProtocol(p => ({ ...p, namespace: e.target.value }))}
                                                                        placeholder="例如：Appliance.Control.ToggleX"
                                                                        className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-4 py-3 text-sm text-white font-mono outline-none focus:border-indigo-500"
                                                                    />
                                                                    {/* P1 优化: 智能校验提示 */}
                                                                    {!/^[A-Z][a-zA-Z0-9]*(\.[A-Z][a-zA-Z0-9]*)+$/.test(newProtocol.namespace) && newProtocol.namespace && (
                                                                        <div className="absolute left-0 -bottom-6 text-xs text-amber-500 flex items-center gap-1">
                                                                            <AlertTriangle size={12} />
                                                                            <span>Namespace 格式建议: Appliance.Module.Function (大驼峰命名)</span>
                                                                        </div>
                                                                    )}
                                                                    {/* P1 优化: 模板选择按钮 */}
                                                                    <div className="relative group">
                                                                        <button className="h-full px-4 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg border border-slate-700 flex items-center gap-2 text-sm font-bold transition-colors">
                                                                            <FolderOpen size={16} /> 模板
                                                                        </button>
                                                                        <div className="absolute right-0 top-full mt-2 w-80 bg-slate-900 border border-slate-700 rounded-xl shadow-xl overflow-hidden hidden group-hover:block z-50">
                                                                            {/* Phase 1: Category Tabs */}
                                                                            <div className="p-2 bg-slate-800/50 border-b border-slate-700">
                                                                                <div className="text-xs font-bold text-slate-400 uppercase mb-2">选择协议模板</div>
                                                                                <div className="flex gap-1 flex-wrap">
                                                                                    {(['all', 'control', 'system', 'config', 'ota', 'sensor'] as const).map(cat => (
                                                                                        <button
                                                                                            key={cat}
                                                                                            onClick={(e) => { e.stopPropagation(); setTemplateCategory(cat); }}
                                                                                            className={`px-2 py-1 text-[10px] rounded ${templateCategory === cat
                                                                                                ? 'bg-indigo-600 text-white'
                                                                                                : 'bg-slate-700 text-slate-400 hover:text-white'
                                                                                                }`}
                                                                                        >
                                                                                            {cat === 'all' ? '全部' : cat.toUpperCase()}
                                                                                        </button>
                                                                                    ))}
                                                                                </div>
                                                                            </div>
                                                                            <div className="max-h-64 overflow-y-auto custom-scrollbar p-1">
                                                                                {PROTOCOL_TEMPLATES
                                                                                    .filter(tpl => templateCategory === 'all' || tpl.category === templateCategory)
                                                                                    .map(tpl => {
                                                                                        const catColors: Record<string, string> = {
                                                                                            control: 'bg-blue-500',
                                                                                            system: 'bg-emerald-500',
                                                                                            config: 'bg-amber-500',
                                                                                            ota: 'bg-purple-500',
                                                                                            sensor: 'bg-cyan-500'
                                                                                        };
                                                                                        return (
                                                                                            <button
                                                                                                key={tpl.namespace}
                                                                                                onClick={() => {
                                                                                                    const methods: any = {};
                                                                                                    ALL_METHODS.forEach(m => {
                                                                                                        if (tpl.methods.includes(m)) {
                                                                                                            const preset = tpl.presets?.[m];
                                                                                                            methods[m] = {
                                                                                                                enabled: true,
                                                                                                                payload: preset?.payload || '{}',
                                                                                                                schema: preset?.schema || '{}'
                                                                                                            };
                                                                                                        } else {
                                                                                                            methods[m] = { enabled: false, payload: '{}', schema: '{}' };
                                                                                                        }
                                                                                                    });
                                                                                                    setNewProtocol(p => ({
                                                                                                        ...p,
                                                                                                        namespace: tpl.namespace,
                                                                                                        name: tpl.namespace,
                                                                                                        description: tpl.description,
                                                                                                        methods
                                                                                                    }));
                                                                                                    addTestLog('INFO', `Applied template: ${tpl.name}`);
                                                                                                }}
                                                                                                className="w-full text-left p-2 hover:bg-slate-800 rounded-lg group/item"
                                                                                            >
                                                                                                <div className="flex items-center gap-2">
                                                                                                    <span className={`w-2 h-2 rounded-full ${catColors[tpl.category]}`} />
                                                                                                    <span className="text-sm font-bold text-white group-hover/item:text-indigo-400">{tpl.name}</span>
                                                                                                </div>
                                                                                                <div className="text-xs text-slate-500 font-mono truncate ml-4">{tpl.namespace}</div>
                                                                                            </button>
                                                                                        );
                                                                                    })}
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                            {/* Display Name field removed as per user request */}
                                                            <div>
                                                                <label className="text-xs font-bold text-slate-400 uppercase mb-2 block">选择支持的 Methods *</label>
                                                                <div className="flex flex-wrap gap-3">
                                                                    {ALL_METHODS.map(method => {
                                                                        const methodDesc: Record<RequestMethod, string> = {
                                                                            GET: '查询 → GETACK',
                                                                            SET: '设置 → SETACK',
                                                                            PUSH: '设备推送',
                                                                            SYNC: '同步 → SYNCACK',
                                                                            DELETE: '删除 → DELETEACK'
                                                                        };
                                                                        const isEnabled = newProtocol.methods[method]?.enabled || false;
                                                                        return (
                                                                            <label
                                                                                key={method}
                                                                                className={`inline-flex items-center gap-2.5 px-3 py-2 rounded-lg border cursor-pointer transition-all ${isEnabled
                                                                                    ? `${METHOD_COLORS[method]?.bgLight} border-current ${METHOD_COLORS[method]?.text}`
                                                                                    : 'bg-slate-800/50 border-slate-700 hover:border-slate-500 text-slate-400'
                                                                                    }`}
                                                                            >
                                                                                <input
                                                                                    type="checkbox"
                                                                                    checked={isEnabled}
                                                                                    onChange={e => setNewProtocol(p => ({
                                                                                        ...p,
                                                                                        methods: {
                                                                                            ...p.methods,
                                                                                            [method]: { ...(p.methods[method] || { requestPayload: {}, responseSchema: {} }), enabled: e.target.checked }
                                                                                        }
                                                                                    }))}
                                                                                    className="w-4 h-4 rounded accent-current"
                                                                                />
                                                                                <span className="text-sm font-bold">{method}</span>
                                                                                <span className="text-xs opacity-70">{methodDesc[method]}</span>
                                                                            </label>
                                                                        );
                                                                    })}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    )}

                                                    {/* Step 2: Configure Each Method */}
                                                    {wizardStep === 2 && (
                                                        <div className="min-h-full flex flex-col">
                                                            {/* Method Tabs */}
                                                            <div className="sticky top-0 z-20 bg-slate-900 flex gap-2 border-b border-slate-700 pb-2 mb-4 pt-1">
                                                                {getEnabledMethods().map((method, idx) => (
                                                                    <button
                                                                        key={method}
                                                                        onClick={() => setCurrentMethodIndex(idx)}
                                                                        className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${currentMethodIndex === idx
                                                                            ? getMethodActiveTabClasses(method)
                                                                            : 'bg-slate-800 text-slate-400 hover:text-white'
                                                                            }`}
                                                                    >
                                                                        {method}
                                                                    </button>
                                                                ))}
                                                            </div>

                                                            {/* Current Method Config */}
                                                            {(() => {
                                                                const methods = getEnabledMethods();
                                                                const currentMethod = methods[currentMethodIndex];
                                                                if (!currentMethod) return null;
                                                                const methodConfig = newProtocol.methods[currentMethod];
                                                                if (!methodConfig) return null;

                                                                return (
                                                                    <div className="flex-1 flex flex-col gap-4">
                                                                        {/* Edit Mode Toggle */}
                                                                        <div className="flex items-center gap-2">
                                                                            <span className="text-xs text-slate-500">编辑模式:</span>
                                                                            <button
                                                                                onClick={() => setEditMode('json')}
                                                                                className={`px-3 py-1 text-xs rounded-lg ${editMode === 'json' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'}`}
                                                                            >
                                                                                JSON
                                                                            </button>
                                                                            <button
                                                                                onClick={() => setEditMode('keyvalue')}
                                                                                className={`px-3 py-1 text-xs rounded-lg ${editMode === 'keyvalue' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'}`}
                                                                            >
                                                                                Key-Value
                                                                            </button>
                                                                        </div>

                                                                        {/* Request Payload - 仅对非 PUSH 方法显示 */}
                                                                        {currentMethod !== 'PUSH' ? (
                                                                            <div className="w-full flex flex-col">
                                                                                <div className="flex items-center justify-between mb-2 shrink-0">
                                                                                    <label className="text-xs font-bold text-slate-400 uppercase">
                                                                                        Request Payload
                                                                                        <span className="text-slate-600 font-normal ml-2">(发送给设备的数据)</span>
                                                                                    </label>
                                                                                    <button
                                                                                        onClick={() => {
                                                                                            setJsonExampleInput('');
                                                                                            setJsonExtractMode('payload');
                                                                                            setShowJsonToSchemaModal(true);
                                                                                        }}
                                                                                        className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
                                                                                    >
                                                                                        <Copy size={12} /> 从示例提取 Payload
                                                                                    </button>
                                                                                </div>
                                                                                {editMode === 'json' ? (
                                                                                    <div className="relative w-full">
                                                                                        <textarea
                                                                                            value={methodConfig.payload}
                                                                                            onChange={e => setNewProtocol(p => ({
                                                                                                ...p,
                                                                                                methods: {
                                                                                                    ...p.methods,
                                                                                                    [currentMethod]: { ...p.methods[currentMethod], payload: e.target.value }
                                                                                                }
                                                                                            }))}
                                                                                            placeholder='{"key": "value"}'
                                                                                            rows={Math.min(Math.max((methodConfig.payload || '').split('\n').length, 2), 20)}
                                                                                            className={`w-full bg-slate-950 border rounded-lg px-4 py-3 text-sm font-mono outline-none resize-y ${(() => { try { JSON.parse(methodConfig.payload); return 'border-slate-700 text-emerald-400 focus:border-indigo-500'; } catch { return 'border-red-500/50 text-red-400 focus:border-red-500'; } })()}`}
                                                                                        />
                                                                                        {(() => {
                                                                                            try { JSON.parse(methodConfig.payload); return null; }
                                                                                            catch {
                                                                                                return (
                                                                                                    <div className="absolute right-4 bottom-4 text-red-500 text-xs flex items-center gap-1 bg-slate-900/90 px-2 py-1 rounded border border-red-500/30 pointer-events-none">
                                                                                                        <AlertTriangle size={12} /> JSON 格式错误
                                                                                                    </div>
                                                                                                );
                                                                                            }
                                                                                        })()}
                                                                                    </div>
                                                                                ) : (
                                                                                    <div className="min-h-[100px] max-h-[500px] bg-slate-950 border border-slate-700 rounded-lg p-3 space-y-2 overflow-y-auto custom-scrollbar resize-y">
                                                                                        <KeyValueEditor
                                                                                            value={methodConfig.payload}
                                                                                            onChange={(v) => setNewProtocol(p => ({
                                                                                                ...p,
                                                                                                methods: {
                                                                                                    ...p.methods,
                                                                                                    [currentMethod]: { ...p.methods[currentMethod], payload: v }
                                                                                                }
                                                                                            }))}
                                                                                        />
                                                                                    </div>
                                                                                )}
                                                                            </div>
                                                                        ) : (
                                                                            <div className="bg-purple-500/10 border border-purple-500/30 rounded-lg p-4">
                                                                                <p className="text-sm text-purple-300">
                                                                                    <span className="font-bold">PUSH</span> 是设备主动推送的消息类型，不需要配置 Request Payload。
                                                                                </p>
                                                                                <p className="text-xs text-purple-400 mt-2">
                                                                                    只需配置 Expected Response Schema 来验证设备推送的消息格式。
                                                                                </p>
                                                                            </div>
                                                                        )}

                                                                        {/* Expected Response Schema */}
                                                                        <div className="w-full flex flex-col">
                                                                            <div className="flex items-center justify-between mb-2 shrink-0">
                                                                                <label className="text-xs font-bold text-slate-400 uppercase">
                                                                                    Expected Response Schema
                                                                                    <span className="text-slate-600 font-normal ml-2">(用于验证设备响应)</span>
                                                                                </label>
                                                                                <button
                                                                                    onClick={() => {
                                                                                        setJsonExampleInput('');
                                                                                        setJsonExtractMode('schema');
                                                                                        setShowJsonToSchemaModal(true);
                                                                                    }}
                                                                                    className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                                                                                >
                                                                                    <Zap size={12} /> 从 JSON 示例生成
                                                                                </button>
                                                                            </div>
                                                                            {editMode === 'json' ? (
                                                                                <div className="relative w-full">
                                                                                    <textarea
                                                                                        value={methodConfig.schema}
                                                                                        onChange={e => setNewProtocol(p => ({
                                                                                            ...p,
                                                                                            methods: {
                                                                                                ...p.methods,
                                                                                                [currentMethod]: { ...p.methods[currentMethod], schema: e.target.value }
                                                                                            }
                                                                                        }))}
                                                                                        placeholder='{"type": "object", "required": ["header", "payload"]}'
                                                                                        rows={Math.min(Math.max((methodConfig.schema || '').split('\n').length, 2), 20)}
                                                                                        className={`w-full bg-slate-950 border rounded-lg px-4 py-3 text-sm font-mono outline-none resize-y ${(() => { try { JSON.parse(methodConfig.schema); return 'border-slate-700 text-emerald-400 focus:border-indigo-500'; } catch { return 'border-red-500/50 text-red-400 focus:border-red-500'; } })()}`}
                                                                                    />
                                                                                    {(() => {
                                                                                        try { JSON.parse(methodConfig.schema); return null; }
                                                                                        catch {
                                                                                            return (
                                                                                                <div className="absolute right-4 bottom-4 text-red-500 text-xs flex items-center gap-1 bg-slate-900/90 px-2 py-1 rounded border border-red-500/30 pointer-events-none">
                                                                                                    <AlertTriangle size={12} /> JSON 格式错误
                                                                                                </div>
                                                                                            );
                                                                                        }
                                                                                    })()}
                                                                                    <p className="text-[10px] text-slate-600 mt-1 shrink-0 absolute bottom-[-20px] left-0">
                                                                                        💡 提示：点击「从 JSON 示例生成」，粘贴协议文档中的响应 JSON 即可自动生成 Schema
                                                                                    </p>
                                                                                </div>
                                                                            ) : (
                                                                                <div className="min-h-[100px] max-h-[500px] bg-slate-950 border border-slate-700 rounded-lg p-3 overflow-y-auto custom-scrollbar resize-y">
                                                                                    {Object.keys(fieldConfigSelection).length === 0 ? (
                                                                                        <div className="h-full flex flex-col items-center justify-center text-slate-500">
                                                                                            <p>Schema 为空或解析失败</p>
                                                                                            <button
                                                                                                onClick={() => setEditMode('json')}
                                                                                                className="mt-2 text-indigo-400 hover:text-indigo-300 underline"
                                                                                            >
                                                                                                切换回 JSON 模式查看
                                                                                            </button>
                                                                                        </div>
                                                                                    ) : (
                                                                                        <div className="space-y-1">
                                                                                            {buildFieldTree(fieldConfigSelection).map(node => (
                                                                                                <FieldTreeItem
                                                                                                    key={node.fullPath}
                                                                                                    node={node}
                                                                                                    level={0}
                                                                                                    onUpdate={(path, updates) => {
                                                                                                        const newSelection = {
                                                                                                            ...fieldConfigSelection,
                                                                                                            [path]: { ...fieldConfigSelection[path], ...updates }
                                                                                                        };
                                                                                                        setFieldConfigSelection(newSelection);

                                                                                                        // Sync back to protocol schema
                                                                                                        const newSchema = applyRequiredFields(generatedSchema, newSelection);
                                                                                                        setNewProtocol(p => ({
                                                                                                            ...p,
                                                                                                            methods: {
                                                                                                                ...p.methods,
                                                                                                                [currentMethod]: {
                                                                                                                    ...p.methods[currentMethod],
                                                                                                                    schema: JSON.stringify(newSchema, null, 2)
                                                                                                                }
                                                                                                            }
                                                                                                        }));
                                                                                                    }}
                                                                                                    onRename={(oldPath, newPath) => {
                                                                                                        if (fieldConfigSelection[newPath]) {
                                                                                                            showToast('warning', 'Field name already exists');
                                                                                                            return;
                                                                                                        }
                                                                                                        const newSelection = { ...fieldConfigSelection };
                                                                                                        // Rename entry and all children
                                                                                                        Object.keys(newSelection).forEach(key => {
                                                                                                            if (key === oldPath || key.startsWith(oldPath + '.')) {
                                                                                                                const suffix = key.substring(oldPath.length);
                                                                                                                const newKey = newPath + suffix;
                                                                                                                newSelection[newKey] = newSelection[key];
                                                                                                                delete newSelection[key];
                                                                                                            }
                                                                                                        });
                                                                                                        setFieldConfigSelection(newSelection);
                                                                                                        // Sync back
                                                                                                        const newSchema = applyRequiredFields(generatedSchema, newSelection);
                                                                                                        setNewProtocol(p => ({
                                                                                                            ...p,
                                                                                                            methods: {
                                                                                                                ...p.methods,
                                                                                                                [currentMethod]: {
                                                                                                                    ...p.methods[currentMethod],
                                                                                                                    schema: JSON.stringify(newSchema, null, 2)
                                                                                                                }
                                                                                                            }
                                                                                                        }));
                                                                                                    }}
                                                                                                    onAdd={(parentPath) => {
                                                                                                        let newName = 'newField';
                                                                                                        let counter = 1;
                                                                                                        while (fieldConfigSelection[`${parentPath}.${newName}`]) {
                                                                                                            newName = `newField${counter++}`;
                                                                                                        }
                                                                                                        const newPath = `${parentPath}.${newName}`;
                                                                                                        const newSelection = {
                                                                                                            ...fieldConfigSelection,
                                                                                                            [newPath]: { required: false, type: 'string', value: '' }
                                                                                                        };
                                                                                                        setFieldConfigSelection(newSelection);
                                                                                                        // Sync back
                                                                                                        const newSchema = applyRequiredFields(generatedSchema, newSelection);
                                                                                                        setNewProtocol(p => ({
                                                                                                            ...p,
                                                                                                            methods: {
                                                                                                                ...p.methods,
                                                                                                                [currentMethod]: {
                                                                                                                    ...p.methods[currentMethod],
                                                                                                                    schema: JSON.stringify(newSchema, null, 2)
                                                                                                                }
                                                                                                            }
                                                                                                        }));
                                                                                                    }}
                                                                                                    onDelete={(path) => {
                                                                                                        const newSelection = { ...fieldConfigSelection };
                                                                                                        const deleteRecursive = (p: string) => {
                                                                                                            delete newSelection[p];
                                                                                                            Object.keys(newSelection).forEach(k => {
                                                                                                                if (k.startsWith(p + '.')) deleteRecursive(k);
                                                                                                            });
                                                                                                        };
                                                                                                        deleteRecursive(path);
                                                                                                        setFieldConfigSelection(newSelection);

                                                                                                        // Sync back to protocol schema
                                                                                                        const newSchema = applyRequiredFields(generatedSchema, newSelection);
                                                                                                        setNewProtocol(p => ({
                                                                                                            ...p,
                                                                                                            methods: {
                                                                                                                ...p.methods,
                                                                                                                [currentMethod]: {
                                                                                                                    ...p.methods[currentMethod],
                                                                                                                    schema: JSON.stringify(newSchema, null, 2)
                                                                                                                }
                                                                                                            }
                                                                                                        }));
                                                                                                    }}
                                                                                                />
                                                                                            ))}
                                                                                        </div>
                                                                                    )
                                                                                    }
                                                                                </div>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                );
                                                            })()}
                                                        </div>
                                                    )
                                                    }
                                                </div>



                                            </div>
                                        )}

                                        {/* Review & Run Tab Content */}
                                        {rightPanelTab === 'review' && (
                                            <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-4">
                                                {/* Verification Status Card */}
                                                <div className={`p-4 rounded-xl border ${newProtocol.reviewStatus === 'VERIFIED' ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-amber-500/10 border-amber-500/30'}`}>
                                                    <div className="flex items-center justify-between">
                                                        <div className="flex items-center gap-3">
                                                            {newProtocol.reviewStatus === 'VERIFIED' ? (
                                                                <ShieldCheck size={24} className="text-emerald-400" />
                                                            ) : (
                                                                <AlertTriangle size={24} className="text-amber-400" />
                                                            )}
                                                            <div>
                                                                <div className={`text-lg font-bold ${newProtocol.reviewStatus === 'VERIFIED' ? 'text-emerald-400' : 'text-amber-400'}`}>
                                                                    {newProtocol.reviewStatus === 'VERIFIED' ? 'Protocol Verified' : 'Pending Review'}
                                                                </div>
                                                                <div className="text-xs text-slate-400">
                                                                    {newProtocol.reviewStatus === 'VERIFIED'
                                                                        ? '此协议已通过审核，可以运行测试'
                                                                        : '请审核协议配置后标记为已验证'}
                                                                </div>
                                                            </div>
                                                        </div>
                                                        {newProtocol.reviewStatus !== 'VERIFIED' && (
                                                            <button
                                                                onClick={() => {
                                                                    setNewProtocol(p => ({ ...p, reviewStatus: 'VERIFIED' }));
                                                                    // Also update in suites
                                                                    if (selectedSuiteId && newProtocol.id) {
                                                                        setSuites(prev => prev.map(s => {
                                                                            if (s.id !== selectedSuiteId) return s;
                                                                            return {
                                                                                ...s,
                                                                                protocols: s.protocols.map(p =>
                                                                                    p.id === newProtocol.id ? { ...p, reviewStatus: 'VERIFIED' as const } : p
                                                                                ),
                                                                                updatedAt: Date.now()
                                                                            };
                                                                        }));
                                                                    }
                                                                }}
                                                                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold flex items-center gap-2"
                                                            >
                                                                <ShieldCheck size={16} /> Mark as Verified
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>

                                                {/* Protocol Summary */}
                                                <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4">
                                                    <h4 className="text-sm font-bold text-slate-300 mb-3">Protocol Summary</h4>
                                                    <div className="grid grid-cols-2 gap-3 text-sm">
                                                        <div>
                                                            <span className="text-slate-500">Namespace:</span>
                                                            <span className="ml-2 text-white font-mono">{newProtocol.namespace}</span>
                                                        </div>
                                                        <div>
                                                            <span className="text-slate-500">Methods:</span>
                                                            <span className="ml-2">
                                                                {ALL_METHODS.filter(m => newProtocol.methods[m]?.enabled).map(m => (
                                                                    <span key={m} className={`text-xs font-bold px-1.5 py-0.5 rounded mr-1 ${getMethodColorClasses(m)}`}>{m}</span>
                                                                ))}
                                                            </span>
                                                        </div>
                                                    </div>
                                                </div>

                                                {/* Run Test Section */}
                                                <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4">
                                                    <h4 className="text-sm font-bold text-slate-300 mb-3">Run Test</h4>
                                                    <div className="flex items-center gap-4">
                                                        <button
                                                            onClick={async () => {
                                                                const protocol = selectedSuite?.protocols.find(p => p.id === selectedProtocolId);
                                                                if (protocol) {
                                                                    for (const method of ALL_METHODS) {
                                                                        if (protocol.methods[method]?.enabled) {
                                                                            await runSingleTest(protocol, method as RequestMethod);
                                                                        }
                                                                    }
                                                                }
                                                            }}
                                                            disabled={!mqttConnected || !targetDevice || newProtocol.reviewStatus !== 'VERIFIED' || isRunning}
                                                            className="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-bold flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                                        >
                                                            {isRunning ? <RefreshCw size={18} className="animate-spin" /> : <Play size={18} />}
                                                            {isRunning ? 'Running...' : 'Run All Methods'}
                                                        </button>
                                                        {newProtocol.reviewStatus !== 'VERIFIED' && (
                                                            <p className="text-sm text-amber-400">请先审核通过协议后才能运行测试</p>
                                                        )}
                                                    </div>
                                                </div>

                                                {/* Last Test Result */}
                                                {(() => {
                                                    const protocol = selectedSuite?.protocols.find(p => p.id === selectedProtocolId);
                                                    const hasResults = protocol && Object.values(protocol.methods).some(m => m?.lastResult);
                                                    if (!hasResults) return null;
                                                    return (
                                                        <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4">
                                                            <h4 className="text-sm font-bold text-slate-300 mb-3">Last Test Results</h4>
                                                            <div className="space-y-2">
                                                                {ALL_METHODS.map(method => {
                                                                    const result = protocol?.methods[method]?.lastResult;
                                                                    if (!result) return null;
                                                                    return (
                                                                        <div key={method} className="flex items-center justify-between p-2 bg-slate-900/50 rounded-lg">
                                                                            <div className="flex items-center gap-2">
                                                                                <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${getMethodColorClasses(method)}`}>{method}</span>
                                                                            </div>
                                                                            <div className="flex items-center gap-3">
                                                                                <span className={`text-xs font-bold ${result.status === 'PASS' ? 'text-emerald-400' :
                                                                                    result.status === 'FAIL' ? 'text-red-400' :
                                                                                        'text-amber-400'
                                                                                    }`}>
                                                                                    {result.status === 'PASS' ? '✓ Pass' : result.status === 'FAIL' ? '✗ Fail' : '○ Timeout'}
                                                                                </span>
                                                                                <span className="text-xs text-slate-500">{result.duration}ms</span>
                                                                            </div>
                                                                        </div>
                                                                    );
                                                                })}
                                                            </div>
                                                        </div>
                                                    );
                                                })()}
                                            </div>
                                        )}

                                    </div>
                                )}

                                {/* Results Tab - Table View (only when no protocol selected) */}
                                {rightPanelTab === 'results' && !selectedProtocolId && (
                                    <div className="flex-1 overflow-hidden flex flex-col bg-slate-900/50 rounded-xl m-4 border border-slate-800 relative">
                                        {viewingRunId ? (
                                            // Detailed View (Existing Table Logic)
                                            (() => {
                                                const viewingRun = testHistory.find(r => r.id === viewingRunId);
                                                if (!viewingRun) return <div className="p-4 text-slate-500">Run not found</div>;
                                                return (
                                                    <>
                                                        <div className="p-4 border-b border-slate-800 flex justify-between items-center shrink-0">
                                                            <div className="flex items-center gap-3">
                                                                <button
                                                                    onClick={() => setViewingRunId(null)}
                                                                    className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white"
                                                                >
                                                                    <ChevronLeft size={20} />
                                                                </button>
                                                                <div>
                                                                    <h3 className="text-lg font-black text-white">Test Details</h3>
                                                                    <div className="text-xs text-slate-400">
                                                                        {new Date(viewingRun.startTime).toLocaleString()}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                            <div className="flex items-center gap-4">
                                                                <button
                                                                    onClick={() => setShowStatsDashboard(true)}
                                                                    className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-bold"
                                                                >
                                                                    View Statistics
                                                                </button>
                                                            </div>
                                                        </div>

                                                        {/* Table Header */}
                                                        <div className="grid grid-cols-12 gap-2 px-4 py-3 bg-slate-800/50 text-xs font-bold text-slate-400 uppercase border-b border-slate-700/50">
                                                            <div className="col-span-1">ID</div>
                                                            <div className="col-span-4">Protocol Name</div>
                                                            <div className="col-span-1">Method</div>
                                                            <div className="col-span-2">Status</div>
                                                            <div className="col-span-2">Duration</div>
                                                            <div className="col-span-2">Actions</div>
                                                        </div>

                                                        {/* Table Body */}
                                                        <div className="flex-1 overflow-y-auto custom-scrollbar">
                                                            {viewingRun.results.map((result, idx) => (
                                                                <div
                                                                    key={idx}
                                                                    className="grid grid-cols-12 gap-2 px-4 py-3 border-b border-slate-800/50 hover:bg-slate-800/50 transition-colors items-center"
                                                                >
                                                                    {/* ID */}
                                                                    <div className="col-span-1 text-xs font-mono text-slate-500">
                                                                        {(idx + 1).toString().padStart(3, '0')}
                                                                    </div>

                                                                    {/* Protocol Name */}
                                                                    <div className="col-span-4 truncate">
                                                                        <span className="text-sm font-bold text-white">{result.namespace}</span>
                                                                        {result.testCaseName && (
                                                                            <span className="text-xs text-slate-500 ml-2">({result.testCaseName})</span>
                                                                        )}
                                                                    </div>

                                                                    {/* Method */}
                                                                    <div className="col-span-1">
                                                                        <span className={`text-xs font-bold px-2 py-0.5 rounded ${getMethodColorClasses(result.method)}`}>
                                                                            {result.method}
                                                                        </span>
                                                                    </div>

                                                                    {/* Status */}
                                                                    <div className="col-span-2">
                                                                        <span className={`text-xs font-bold px-2 py-0.5 rounded inline-flex items-center gap-1 ${result.status === 'PASS' ? 'bg-emerald-500/20 text-emerald-400' :
                                                                            result.status === 'FAIL' ? 'bg-red-500/20 text-red-400' :
                                                                                'bg-amber-500/20 text-amber-400'
                                                                            }`}>
                                                                            {result.status === 'PASS' ? <CheckCircle size={10} /> :
                                                                                result.status === 'FAIL' ? <XCircle size={10} /> :
                                                                                    <Clock size={10} />}
                                                                            {result.status === 'PASS' ? '成功' : result.status === 'FAIL' ? '失败' : '超时'}
                                                                        </span>
                                                                    </div>

                                                                    {/* Duration */}
                                                                    <div className="col-span-2 text-xs font-mono text-slate-400">
                                                                        {result.duration}ms
                                                                    </div>

                                                                    {/* Actions */}
                                                                    <div className="col-span-2 flex gap-1">
                                                                        <button
                                                                            onClick={() => {
                                                                                setViewingResult({
                                                                                    result: {
                                                                                        ...result,
                                                                                        request: undefined,
                                                                                        expectedSchema: undefined
                                                                                    } as any,
                                                                                    namespace: result.namespace,
                                                                                    method: result.method,
                                                                                    protocolId: result.protocolId
                                                                                });
                                                                                setShowResultViewer(true);
                                                                            }}
                                                                            className="px-2 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-bold"
                                                                        >
                                                                            Details
                                                                        </button>
                                                                        {result.status === 'FAIL' && (
                                                                            <button
                                                                                onClick={() => {
                                                                                    const protocol = selectedSuite?.protocols.find(p => p.id === result.protocolId);
                                                                                    if (protocol) {
                                                                                        startEditingProtocol(protocol);
                                                                                    }
                                                                                }}
                                                                                className="px-2 py-1 bg-slate-600 hover:bg-slate-500 text-white rounded text-xs"
                                                                            >
                                                                                Edit
                                                                            </button>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            ))}
                                                        </div>

                                                        {/* Summary Footer */}
                                                        <div className="px-4 py-3 border-t border-slate-800 bg-slate-800/30 flex justify-between items-center shrink-0">
                                                            <div className="flex gap-4 text-xs">
                                                                <span className="text-slate-400">Total: <b className="text-white">{viewingRun.results.length}</b></span>
                                                                <span className="text-emerald-400">Pass: <b>{viewingRun.summary.passed}</b></span>
                                                                <span className="text-red-400">Fail: <b>{viewingRun.summary.failed}</b></span>
                                                                <span className="text-amber-400">Timeout: <b>{viewingRun.summary.timeout}</b></span>
                                                            </div>
                                                        </div>
                                                    </>
                                                );
                                            })()
                                        ) : (
                                            // History List View
                                            <>
                                                <div className="p-4 border-b border-slate-800 flex justify-between items-center shrink-0">
                                                    <h3 className="text-lg font-black text-white">Test History</h3>
                                                    <div className="text-xs text-slate-400">
                                                        Total Runs: {testHistory.filter(r => r.suiteId === selectedSuite?.id).length}
                                                    </div>
                                                </div>
                                                <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-2">
                                                    {testHistory.filter(r => r.suiteId === selectedSuite?.id).length === 0 ? (
                                                        <div className="flex flex-col items-center justify-center h-full text-slate-500">
                                                            <p>No test history for this suite</p>
                                                        </div>
                                                    ) : (
                                                        testHistory.filter(r => r.suiteId === selectedSuite?.id).slice().reverse().map(run => (
                                                            <div key={run.id} className="flex items-center justify-between p-4 bg-slate-800/50 hover:bg-slate-800 rounded-xl border border-slate-700/50 transition-all group">
                                                                <div className="flex items-center gap-4">
                                                                    <div className={`p-2 rounded-lg ${run.status === 'COMPLETED' ? 'bg-emerald-500/10 text-emerald-400' :
                                                                        run.status === 'FAILED' ? 'bg-red-500/10 text-red-400' :
                                                                            'bg-blue-500/10 text-blue-400'
                                                                        }`}>
                                                                        {run.status === 'COMPLETED' ? <CheckCircle size={20} /> :
                                                                            run.status === 'FAILED' ? <XCircle size={20} /> :
                                                                                <RefreshCw size={20} className="animate-spin" />}
                                                                    </div>
                                                                    <div>
                                                                        <div className="text-sm font-bold text-white flex items-center gap-2">
                                                                            {new Date(run.startTime).toLocaleString()}
                                                                            <span className="text-xs font-normal text-slate-500">({Math.round(((run.endTime || run.startTime) - run.startTime) / 1000)}s)</span>
                                                                        </div>
                                                                        <div className="flex gap-3 text-xs mt-1">
                                                                            <span className="text-emerald-400">{run.summary.passed} Pass</span>
                                                                            <span className="text-red-400">{run.summary.failed} Fail</span>
                                                                            <span className="text-amber-400">{run.summary.timeout} Timeout</span>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                                <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                                    <button
                                                                        onClick={() => setViewingRunId(run.id)}
                                                                        className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold"
                                                                    >
                                                                        Details
                                                                    </button>
                                                                    <button
                                                                        onClick={() => {
                                                                            if (confirm('Delete this test run?')) {
                                                                                setTestHistory(prev => prev.filter(r => r.id !== run.id));
                                                                                if (currentRun?.id === run.id) setCurrentRun(null);
                                                                            }
                                                                        }}
                                                                        className="p-1.5 bg-slate-700 hover:bg-red-500/20 text-slate-400 hover:text-red-400 rounded-lg transition-colors"
                                                                        title="Delete"
                                                                    >
                                                                        <Trash2 size={16} />
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        ))
                                                    )}
                                                </div>
                                            </>
                                        )}
                                    </div>
                                )}

                            </>
                        ) : (
                            <div className="flex-1 flex flex-col items-center justify-center text-slate-600">
                                <ShieldCheck size={64} className="mb-4 opacity-20" />
                                <p className="text-lg font-bold">选择或创建一个测试库</p>
                                <p className="text-sm mt-2">测试库可以复用于同型号的任何设备</p>
                            </div>
                        )
                        }
                    </div>



                    {/* Test Log Panel */}
                    <div className={`shrink-0 border-t border-slate-700 bg-slate-900 transition-all ${logPanelExpanded ? 'h-48' : 'h-10'}`}>
                        {/* Log Panel Header */}
                        <div className="flex items-center justify-between px-4 h-10 border-b border-slate-800">
                            <div className="flex items-center gap-4">
                                <button
                                    onClick={() => setLogPanelExpanded(!logPanelExpanded)}
                                    className="flex items-center gap-2 text-sm font-bold text-slate-300 hover:text-white"
                                >
                                    {logPanelExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                    <span>📝 Test Log</span>
                                    <span className="text-xs text-slate-500">({testLogs.length})</span>
                                </button>

                                {/* Log Filters */}
                                {logPanelExpanded && (
                                    <div className="flex gap-1">
                                        {(['all', 'TX', 'RX', 'ERROR', 'INFO'] as const).map(filter => (
                                            <button
                                                key={filter}
                                                onClick={() => setLogFilter(filter)}
                                                className={`px-2 py-0.5 text-xs rounded ${logFilter === filter
                                                    ? 'bg-indigo-600 text-white'
                                                    : 'bg-slate-800 text-slate-400 hover:text-white'
                                                    }`}
                                            >
                                                {filter}
                                            </button>
                                        ))}
                                    </div>
                                )}

                                {/* Running Indicator */}
                                {testProgress && (
                                    <div className="flex items-center gap-2 px-2 py-1 bg-emerald-500/10 rounded-lg">
                                        <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                                        <span className="text-xs text-emerald-400">
                                            {testProgress.currentProtocol} ({testProgress.current}/{testProgress.total})
                                        </span>
                                    </div>
                                )}
                            </div>

                            <button
                                onClick={() => setTestLogs([])}
                                className="text-xs text-slate-500 hover:text-red-400 transition-colors"
                            >
                                Clear
                            </button>
                        </div>

                        {/* Log Content */}
                        {logPanelExpanded && (
                            <div
                                ref={logContainerRef}
                                className="h-[calc(100%-2.5rem)] overflow-y-auto custom-scrollbar px-2 py-1"
                            >
                                {testLogs
                                    .filter(log => logFilter === 'all' || log.type === logFilter)
                                    .map(log => (
                                        <div
                                            key={log.id}
                                            className={`flex items-start gap-2 px-2 py-1 text-xs font-mono rounded mb-0.5 ${log.type === 'TX' ? 'bg-blue-500/5 text-blue-400' :
                                                log.type === 'RX' ? 'bg-emerald-500/5 text-emerald-400' :
                                                    log.type === 'ERROR' ? 'bg-red-500/10 text-red-400' :
                                                        'bg-slate-800/50 text-slate-400'
                                                }`}
                                        >
                                            <span className="text-slate-600 shrink-0">{log.timeStr}</span>
                                            <span className={`shrink-0 w-12 font-bold ${log.type === 'TX' ? 'text-blue-500' :
                                                log.type === 'RX' ? 'text-emerald-500' :
                                                    log.type === 'ERROR' ? 'text-red-500' : 'text-slate-500'
                                                }`}>[{log.type}]</span>
                                            <span className="flex-1 truncate">{log.message}</span>
                                        </div>
                                    ))
                                }
                                {testLogs.length === 0 && (
                                    <div className="flex items-center justify-center h-full text-slate-600 text-xs">
                                        No logs yet. Run a test to see logs here.
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>


            {/* Add Suite Modal */}
            {
                isAddingSuite && (
                    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
                        <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-[450px]">
                            <h3 className="text-lg font-black text-white mb-4">{editingSuiteId ? '编辑测试库' : '新建测试库'}</h3>
                            <div className="space-y-4">
                                <div>
                                    <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">名称 *</label>
                                    <input
                                        value={newSuite.name}
                                        onChange={e => setNewSuite(p => ({ ...p, name: e.target.value }))}
                                        placeholder="例如：MSS210 V8 智能插座"
                                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-4 py-3 text-sm text-white outline-none focus:border-indigo-500"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">描述</label>
                                    <input
                                        value={newSuite.description}
                                        onChange={e => setNewSuite(p => ({ ...p, description: e.target.value }))}
                                        placeholder="可选的描述信息"
                                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-4 py-3 text-sm text-white outline-none focus:border-indigo-500"
                                    />
                                </div>
                            </div>
                            <div className="flex justify-end gap-3 mt-6">
                                <button onClick={() => { setIsAddingSuite(false); setEditingSuiteId(null); setNewSuite({ name: '', description: '' }); }} className="px-4 py-2 text-slate-400 hover:text-white">取消</button>
                                <button onClick={editingSuiteId ? updateSuite : addNewSuite} className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-bold">{editingSuiteId ? '保存' : '创建'}</button>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* Add Protocol Wizard Modal - Moved to Edit Tab */}

            {/* Unverified Protocols Warning Modal */}
            {unverifiedProtocolsModal.show && (
                <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[100]" onClick={() => setUnverifiedProtocolsModal({ show: false, protocols: [] })}>
                    <div className="bg-slate-900 border-2 border-red-500/50 rounded-2xl p-6 w-[500px] max-h-[80vh] flex flex-col shadow-2xl shadow-red-500/20" onClick={e => e.stopPropagation()}>
                        {/* Header */}
                        <div className="flex items-center gap-4 mb-6">
                            <div className="p-3 bg-red-500/20 rounded-xl">
                                <AlertTriangle size={32} className="text-red-400" />
                            </div>
                            <div>
                                <h3 className="text-xl font-black text-white">无法运行测试</h3>
                                <p className="text-sm text-red-400 mt-1">
                                    {unverifiedProtocolsModal.protocols.length} 个协议尚未通过审核
                                </p>
                            </div>
                        </div>

                        {/* Protocol List */}
                        <div className="flex-1 overflow-y-auto custom-scrollbar mb-6">
                            <p className="text-sm text-slate-400 mb-3">请先审核并验证以下协议后再运行测试：</p>
                            <div className="space-y-2">
                                {unverifiedProtocolsModal.protocols.map(protocol => (
                                    <div
                                        key={protocol.id}
                                        className="flex items-center justify-between p-3 bg-slate-800/50 rounded-xl border border-slate-700 hover:border-amber-500/50 cursor-pointer transition-all group"
                                        onClick={() => {
                                            setUnverifiedProtocolsModal({ show: false, protocols: [] });
                                            startEditingProtocol(protocol);
                                        }}
                                    >
                                        <div className="flex items-center gap-3">
                                            <HelpCircle size={18} className="text-amber-500" />
                                            <div>
                                                <div className="text-sm font-bold text-white">{protocol.namespace}</div>
                                                <div className="text-xs text-slate-500">
                                                    {ALL_METHODS.filter(m => protocol.methods[m]?.enabled).join(', ')}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <span className="text-xs text-amber-400">点击审核</span>
                                            <ArrowRight size={14} className="text-amber-400" />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Footer */}
                        <div className="flex justify-end gap-3 pt-4 border-t border-slate-700">
                            <button
                                onClick={() => setUnverifiedProtocolsModal({ show: false, protocols: [] })}
                                className="px-6 py-3 bg-slate-700 hover:bg-slate-600 text-white rounded-xl font-bold"
                            >
                                关闭
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Report Export Modal */}
            {
                showReportModal && currentRun && (
                    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
                        <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-[500px]">
                            <h3 className="text-lg font-black text-white mb-4">导出测试报告</h3>

                            {/* Summary */}
                            <div className="bg-slate-800/50 rounded-xl p-4 mb-4">
                                <div className="text-sm font-bold text-white mb-2">{currentRun.suiteName}</div>
                                <div className="text-xs text-slate-400 mb-3">
                                    Device: {currentRun.deviceName} · {new Date(currentRun.startTime).toLocaleString()}
                                </div>
                                <div className="flex gap-4 text-sm">
                                    <span className="text-emerald-400">{currentRun.summary.passed} Pass</span>
                                    <span className="text-red-400">{currentRun.summary.failed} Fail</span>
                                    <span className="text-amber-400">{currentRun.summary.timeout} Timeout</span>
                                </div>
                            </div>

                            {/* Export Options */}
                            <div className="space-y-3 mb-4">
                                <button
                                    onClick={() => exportReport('json')}
                                    className="w-full p-3 bg-slate-800 hover:bg-slate-700 rounded-xl flex items-center gap-3 text-left"
                                >
                                    <FileJson size={20} className="text-blue-400" />
                                    <div>
                                        <div className="text-sm font-bold text-white">JSON 格式</div>
                                        <div className="text-xs text-slate-400">完整的测试结果数据</div>
                                    </div>
                                </button>
                                <button
                                    onClick={() => exportReport('junit')}
                                    className="w-full p-3 bg-slate-800 hover:bg-slate-700 rounded-xl flex items-center gap-3 text-left"
                                >
                                    <FileJson size={20} className="text-emerald-400" />
                                    <div>
                                        <div className="text-sm font-bold text-white">JUnit XML 格式</div>
                                        <div className="text-xs text-slate-400">Jenkins 兼容格式</div>
                                    </div>
                                </button>
                                {/* P1 优化: HTML 报告导出 */}
                                <button
                                    onClick={() => exportReport('html')}
                                    className="w-full p-3 bg-slate-800 hover:bg-slate-700 rounded-xl flex items-center gap-3 text-left"
                                >
                                    <FileText size={20} className="text-purple-400" />
                                    <div>
                                        <div className="text-sm font-bold text-white">HTML 报告</div>
                                        <div className="text-xs text-slate-400">可视化报告，适合浏览器查看</div>
                                    </div>
                                </button>
                            </div>

                            {/* Jenkins Upload */}
                            <div className="border-t border-slate-700 pt-4">
                                <div className="text-xs font-bold text-slate-400 uppercase mb-2">上报到 Jenkins</div>
                                <div className="flex gap-2">
                                    <input
                                        value={jenkinsUrl}
                                        onChange={e => setJenkinsUrl(e.target.value)}
                                        placeholder="Jenkins Webhook URL"
                                        className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-indigo-500"
                                    />
                                    <button
                                        onClick={sendToJenkins}
                                        className="px-4 py-2 bg-orange-600 hover:bg-orange-500 text-white rounded-lg font-bold flex items-center gap-2"
                                    >
                                        <Send size={14} /> 发送
                                    </button>
                                </div>
                            </div>

                            <div className="flex justify-end mt-6">
                                <button onClick={() => setShowReportModal(false)} className="px-4 py-2 text-slate-400 hover:text-white">关闭</button>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* JSON Extract Modal (Payload / Schema) */}
            {
                showJsonToSchemaModal && (
                    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[60]">
                        <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-[600px]">
                            <h3 className="text-lg font-black text-white mb-4">
                                {jsonExtractMode === 'payload' ? '从 JSON 示例提取 Payload' : '从 JSON 示例生成 Schema'}
                            </h3>

                            <p className="text-sm text-slate-400 mb-4">
                                {jsonExtractMode === 'payload'
                                    ? '粘贴完整的协议消息 JSON，自动提取其中的 payload 部分。'
                                    : '粘贴协议文档中的 JSON 响应示例，可选择生成完整消息或仅 payload 的 Schema。'
                                }
                            </p>

                            <textarea
                                value={jsonExampleInput}
                                onChange={e => setJsonExampleInput(e.target.value)}
                                placeholder={'粘贴完整 JSON 示例，例如:\n{\n  "header": {"method": "GETACK", ...},\n  "payload": {"time": {"timestamp": 1234567890}}\n}'}
                                className="w-full h-48 bg-slate-950 border border-slate-700 rounded-lg px-4 py-3 text-sm text-emerald-400 font-mono outline-none focus:border-indigo-500 resize-none"
                            />

                            <div className="flex justify-end gap-3 mt-6">
                                <button
                                    onClick={() => setShowJsonToSchemaModal(false)}
                                    className="px-4 py-2 text-slate-400 hover:text-white"
                                >
                                    取消
                                </button>
                                <button
                                    onClick={() => {
                                        try {
                                            const parsed = JSON.parse(jsonExampleInput);
                                            const methods = getEnabledMethods();
                                            const currentMethod = methods[currentMethodIndex];

                                            if (!currentMethod) {
                                                showToast('warning', '请先选择一个 Method');
                                                return;
                                            }

                                            if (jsonExtractMode === 'payload') {
                                                // 提取 payload 部分
                                                const payloadData = parsed.payload !== undefined ? parsed.payload : parsed;
                                                const payloadStr = JSON.stringify(payloadData, null, 2);

                                                setNewProtocol(p => ({
                                                    ...p,
                                                    methods: {
                                                        ...p.methods,
                                                        [currentMethod]: {
                                                            ...p.methods[currentMethod],
                                                            payload: payloadStr
                                                        }
                                                    }
                                                }));
                                                setShowJsonToSchemaModal(false);
                                            } else {
                                                // 生成 Schema - 第一步：解析并准备必填字段选择
                                                const schema = generateSchemaFromJson(parsed, false); // 先不生成 required
                                                const paths = extractFieldPaths(parsed);

                                                // 默认所有字段都非必填，或者根据某种规则预选
                                                const initialSelection: Record<string, FieldConfig> = {};
                                                paths.forEach(p => {
                                                    initialSelection[p.path] = {
                                                        required: false,
                                                        type: p.type,
                                                        value: p.sample
                                                    };
                                                });

                                                setGeneratedSchema(schema);
                                                setFieldConfigSelection(initialSelection);

                                                setShowJsonToSchemaModal(false);
                                                setShowRequiredFieldsModal(true);
                                            }
                                        } catch (e) {
                                            showToast('error', 'JSON 解析失败，请检查格式是否正确');
                                        }
                                    }}
                                    className={`px-6 py-2 ${jsonExtractMode === 'payload' ? 'bg-blue-600 hover:bg-blue-500' : 'bg-emerald-600 hover:bg-emerald-500'} text-white rounded-lg font-bold`}
                                >
                                    {jsonExtractMode === 'payload' ? '提取 Payload' : '生成 Schema'}
                                </button>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* Required Fields Selection Modal */}
            {
                showRequiredFieldsModal && (
                    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[70]">
                        <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-[800px] max-h-[80vh] flex flex-col">
                            <h3 className="text-lg font-black text-white mb-4">选择必填字段与类型</h3>
                            <p className="text-sm text-slate-400 mb-4">
                                Header 字段默认必填且已隐藏。请勾选 Payload 中需要标记为 <span className="text-red-400 font-bold">required</span> 的字段，并确认字段类型。
                            </p>

                            <div className="flex-1 overflow-y-auto custom-scrollbar border border-slate-700 rounded-lg bg-slate-950 p-2">
                                {Object.keys(fieldConfigSelection).length === 0 ? (
                                    <div className="text-center text-slate-500 py-8">没有可供选择的字段</div>
                                ) : (
                                    <div className="space-y-1">
                                        {buildFieldTree(fieldConfigSelection).map(node => (
                                            <FieldTreeItem
                                                key={node.fullPath}
                                                node={node}
                                                level={0}
                                                onUpdate={(path, updates) => {
                                                    setFieldConfigSelection(prev => ({
                                                        ...prev,
                                                        [path]: { ...prev[path], ...updates }
                                                    }));
                                                }}
                                                onDelete={(path) => {
                                                    setFieldConfigSelection(prev => {
                                                        const next = { ...prev };
                                                        const deleteRecursive = (p: string) => {
                                                            delete next[p];
                                                            Object.keys(next).forEach(k => {
                                                                if (k.startsWith(p + '.')) {
                                                                    deleteRecursive(k);
                                                                }
                                                            });
                                                        };
                                                        deleteRecursive(path);
                                                        return next;
                                                    });
                                                }}
                                            />
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="flex justify-between items-center mt-6">
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => {
                                            const allSelected: Record<string, FieldConfig> = {};
                                            Object.keys(fieldConfigSelection).forEach(k => {
                                                allSelected[k] = { ...fieldConfigSelection[k], required: true };
                                            });
                                            setFieldConfigSelection(allSelected);
                                        }}
                                        className="text-xs text-indigo-400 hover:text-indigo-300 font-bold"
                                    >
                                        全选
                                    </button>
                                    <button
                                        onClick={() => {
                                            const noneSelected: Record<string, FieldConfig> = {};
                                            Object.keys(fieldConfigSelection).forEach(k => {
                                                noneSelected[k] = { ...fieldConfigSelection[k], required: false };
                                            });
                                            setFieldConfigSelection(noneSelected);
                                        }}
                                        className="text-xs text-slate-500 hover:text-slate-400"
                                    >
                                        全不选
                                    </button>
                                </div>
                                <div className="flex gap-3">
                                    <button
                                        onClick={() => setShowRequiredFieldsModal(false)}
                                        className="px-4 py-2 text-slate-400 hover:text-white"
                                    >
                                        取消
                                    </button>
                                    <button
                                        onClick={() => {
                                            // Apply required fields and save
                                            const finalSchema = applyRequiredFields(generatedSchema, fieldConfigSelection);
                                            const schemaStr = JSON.stringify(finalSchema, null, 2);

                                            const methods = getEnabledMethods();
                                            const currentMethod = methods[currentMethodIndex];

                                            if (currentMethod) {
                                                setNewProtocol(p => ({
                                                    ...p,
                                                    methods: {
                                                        ...p.methods,
                                                        [currentMethod]: {
                                                            ...p.methods[currentMethod],
                                                            schema: schemaStr
                                                        }
                                                    }
                                                }));
                                            }

                                            setShowRequiredFieldsModal(false);
                                        }}
                                        className="px-6 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold"
                                    >
                                        完成生成
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* Protocol Generator Modal (从 Ability + Confluence 自动生成) */}
            <ProtocolGenerator
                isOpen={showProtocolGenerator}
                onClose={() => setShowProtocolGenerator(false)}
                onGenerate={handleGeneratedProtocols}
                generateSchema={generateSchemaFromJson}
                deviceName={targetDevice?.name}
                onFetchAbility={fetchDeviceAbility}
            />



            {/* Batch Test Summary Panel */}
            <BatchTestSummaryPanel
                isOpen={showBatchSummary}
                onClose={() => setShowBatchSummary(false)}
                batchResult={batchTestResult}
                onViewDetail={(item) => {
                    if (item.detailedResult) {
                        setShowBatchSummary(false);
                        setViewingFromBatch(true);
                        setViewingResult({
                            result: item.detailedResult,
                            namespace: item.namespace,
                            method: item.method,
                            protocolId: item.protocolId
                        });
                        setShowResultViewer(true);
                    }
                }}
            />

            {/* Test Execution Configuration Modal */}
            {
                showExecutionConfigModal && (
                    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={() => setShowExecutionConfigModal(false)}>
                        <div className="bg-slate-900 rounded-2xl p-6 max-w-md w-full mx-4 border border-slate-700" onClick={e => e.stopPropagation()}>
                            <div className="flex justify-between items-center mb-4">
                                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                                    <Settings size={20} className="text-indigo-400" />
                                    测试执行配置
                                </h3>
                                <button onClick={() => setShowExecutionConfigModal(false)} className="text-slate-400 hover:text-white">
                                    <X size={20} />
                                </button>
                            </div>

                            <div className="space-y-4">
                                {/* Timeout Configuration */}
                                <div>
                                    <label className="text-sm text-slate-400 block mb-2">超时时间（秒）</label>
                                    <input
                                        type="number"
                                        value={tempExecutionConfig.timeout / 1000}
                                        onChange={(e) => setTempExecutionConfig(prev => ({ ...prev, timeout: Math.max(1, parseInt(e.target.value) || 8) * 1000 }))}
                                        min={1}
                                        max={60}
                                        className="w-full bg-slate-800 text-white px-4 py-2 rounded-lg border border-slate-700 focus:border-indigo-500 outline-none"
                                    />
                                    <p className="text-xs text-slate-500 mt-1">每个测试的最大等待响应时间，默认 8 秒</p>
                                </div>

                                {/* Retry Configuration */}
                                <div>
                                    <label className="text-sm text-slate-400 block mb-2">失败重试次数</label>
                                    <input
                                        type="number"
                                        value={tempExecutionConfig.retryCount}
                                        onChange={(e) => setTempExecutionConfig(prev => ({ ...prev, retryCount: Math.max(0, Math.min(5, parseInt(e.target.value) || 0)) }))}
                                        min={0}
                                        max={5}
                                        className="w-full bg-slate-800 text-white px-4 py-2 rounded-lg border border-slate-700 focus:border-indigo-500 outline-none"
                                    />
                                    <p className="text-xs text-slate-500 mt-1">测试失败或超时后的重试次数，0 表示不重试</p>
                                </div>

                                {/* Stop on Fail Configuration */}
                                <div className="flex items-center gap-3">
                                    <input
                                        type="checkbox"
                                        id="stopOnFail"
                                        checked={tempExecutionConfig.stopOnFail}
                                        onChange={(e) => setTempExecutionConfig(prev => ({ ...prev, stopOnFail: e.target.checked }))}
                                        className="w-4 h-4 accent-indigo-500"
                                    />
                                    <label htmlFor="stopOnFail" className="text-sm text-slate-300">失败后停止执行</label>
                                </div>
                                <p className="text-xs text-slate-500 -mt-2">启用后，当任意测试失败时立即停止整个测试批次</p>
                            </div>

                            <div className="flex justify-end gap-3 mt-6">
                                <button
                                    onClick={() => setShowExecutionConfigModal(false)}
                                    className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm"
                                >
                                    取消
                                </button>
                                <button
                                    onClick={() => {
                                        if (selectedSuiteId) {
                                            setSuites(prev => prev.map(s =>
                                                s.id === selectedSuiteId
                                                    ? { ...s, executionConfig: tempExecutionConfig, updatedAt: Date.now() }
                                                    : s
                                            ));
                                        }
                                        setShowExecutionConfigModal(false);
                                    }}
                                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm flex items-center gap-2"
                                >
                                    <Check size={16} /> 保存配置
                                </button>
                            </div>
                        </div>
                    </div>
                )
            }



            {/* Test Result Viewer Modal */}
            <TestResultViewer
                isOpen={showResultViewer}
                onClose={() => setShowResultViewer(false)}
                result={viewingResult?.result || null}
                protocolNamespace={viewingResult?.namespace}
                protocolMethod={viewingResult?.method}
                onRetry={() => {
                    if (viewingResult?.protocolId && viewingResult?.method) {
                        const suite = suites.find(s => s.protocols.some(p => p.id === viewingResult.protocolId));
                        const protocol = suite?.protocols.find(p => p.id === viewingResult.protocolId);
                        if (protocol) {
                            runSingleTest(protocol, viewingResult.method as RequestMethod).then(res => {
                                setViewingResult(prev => prev ? { ...prev, result: { ...prev.result, ...res } } : null);
                            });
                        }
                    }
                }}
            />

            {/* Add Protocol Modal */}
            {isAddingProtocol && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={() => setIsAddingProtocol(false)}>
                    <div className="bg-slate-900 rounded-2xl p-6 max-w-md w-full mx-4 border border-slate-700" onClick={e => e.stopPropagation()}>
                        <h3 className="text-lg font-bold text-white mb-4">Add New Protocol</h3>
                        <div className="space-y-4">
                            <div>
                                <label className="text-sm text-slate-400 block mb-2">Namespace *</label>
                                <input
                                    type="text"
                                    value={newProtocol.namespace}
                                    onChange={(e) => setNewProtocol(prev => ({ ...prev, namespace: e.target.value, name: e.target.value }))}
                                    className="w-full bg-slate-800 text-white px-4 py-2 rounded-lg border border-slate-700 focus:border-indigo-500 outline-none"
                                    placeholder="e.g. Appliance.System.All"
                                    autoFocus
                                />
                            </div>
                            <div>
                                <label className="text-sm text-slate-400 block mb-2">Description</label>
                                <textarea
                                    value={newProtocol.description || ''}
                                    onChange={(e) => setNewProtocol(prev => ({ ...prev, description: e.target.value }))}
                                    className="w-full bg-slate-800 text-white px-4 py-2 rounded-lg border border-slate-700 focus:border-indigo-500 outline-none h-24 resize-none"
                                    placeholder="Optional description"
                                />
                            </div>
                        </div>
                        <div className="flex justify-end gap-3 mt-6">
                            <button
                                onClick={() => setIsAddingProtocol(false)}
                                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={() => {
                                    if (!newProtocol.namespace) {
                                        showToast('warning', 'Namespace is required');
                                        return;
                                    }
                                    // Ensure methods structure exists
                                    const methods = newProtocol.methods || ALL_METHODS.reduce((acc, m) => ({ ...acc, [m]: { enabled: false, requestPayload: {}, responseSchema: {} } }), {} as any);

                                    // Update state before adding (since addProtocolToSuite uses state)
                                    // Actually addProtocolToSuite uses current state, so we need to set it first?
                                    // No, setState is async. We can't set then call immediately.
                                    // We should modify addProtocolToSuite to accept params or use a temp state.
                                    // But addProtocolToSuite reads newProtocol directly.
                                    // The input onChange already updated newProtocol.
                                    // So we just need to ensure methods are initialized if empty.

                                    if (Object.keys(newProtocol.methods || {}).length === 0) {
                                        setNewProtocol(prev => ({ ...prev, methods }));
                                        // This won't work immediately for addProtocolToSuite call below.
                                    }

                                    // Let's manually call setSuites logic here or fix addProtocolToSuite later?
                                    // Better: Update addProtocolToSuite to be robust, or just rely on current state.
                                    // The onChange updates newProtocol. So namespace is there.
                                    // Methods might be empty. addProtocolToSuite doesn't validate methods existence, just iterates keys.
                                    // If keys empty, loop doesn't run. That's fine.

                                    addProtocolToSuite();
                                    setIsAddingProtocol(false);
                                }}
                                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-bold"
                            >
                                Create
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Test Statistics Dashboard */}
            <TestStatisticsDashboard
                isOpen={showStatsDashboard}
                onClose={() => setShowStatsDashboard(false)}
                testHistory={testHistory.map((run: TestRun) => ({
                    id: run.id,
                    suiteId: run.suiteId,
                    suiteName: run.suiteName,
                    deviceId: run.deviceId,
                    deviceName: run.deviceName,
                    startTime: run.startTime,
                    endTime: run.endTime,
                    status: run.status,
                    results: run.results.map((r: TestRun['results'][0]) => ({
                        protocolId: r.protocolId,
                        namespace: r.namespace,
                        method: r.method,
                        status: r.status,
                        duration: r.duration || 0,
                        response: r.response,
                        error: r.error
                    })),
                    summary: run.summary
                }))}
                onClearHistory={() => {
                    if (confirm('确定要清除所有测试历史记录吗？')) {
                        setTestHistory([]);
                    }
                }}
            />
        </div>
    );
};
