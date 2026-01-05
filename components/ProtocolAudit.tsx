import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    ShieldCheck, Play, Plus, Trash2, ChevronRight, ChevronDown,
    CheckCircle, XCircle, AlertTriangle, Edit3, FolderOpen,
    RefreshCw, Copy, Zap, ArrowRight, Download, Upload, FileJson,
    Package, Clock, History, Send, Check, X
} from 'lucide-react';
import Ajv from 'ajv';
import { CloudSession, Device } from '../types';
import { md5 } from './AuthScreen';

// --- Types ---

interface MethodTest {
    enabled: boolean;
    requestPayload: any;
    responseSchema: any;
    lastResult?: {
        status: 'PASS' | 'FAIL' | 'TIMEOUT' | 'PENDING';
        response?: any;
        error?: string;
        duration?: number;
    };
}

interface ProtocolDefinition {
    id: string;
    namespace: string;
    name: string;
    description: string;
    methods: {
        SET?: MethodTest;      // 请求: SET → 响应: SETACK
        GET?: MethodTest;      // 请求: GET → 响应: GETACK
        SYNC?: MethodTest;     // 请求: SYNC → 响应: SYNCACK
        DELETE?: MethodTest;   // 请求: DELETE → 响应: DELETEACK
        PUSH?: MethodTest;     // 设备主动推送（无需发送请求）
    };
}

// 所有请求类型的 method（发送给设备）
const REQUEST_METHODS = ['SET', 'GET', 'SYNC', 'DELETE'] as const;
type RequestMethod = typeof REQUEST_METHODS[number];

// 所有 method 类型（包括 PUSH）
const ALL_METHODS = ['SET', 'GET', 'SYNC', 'DELETE', 'PUSH'] as const;
type MethodType = typeof ALL_METHODS[number];

// Method 对应的响应类型
const METHOD_TO_ACK: Record<RequestMethod, string> = {
    SET: 'SETACK',
    GET: 'GETACK',
    SYNC: 'SYNCACK',
    DELETE: 'DELETEACK'
};

// 协议测试库 - 对应一个设备型号，可复用于同型号的任何设备
interface ProtocolTestSuite {
    id: string;
    name: string;           // 例如 "MSS210 V8", "MSS310"
    description: string;
    protocols: ProtocolDefinition[];
    createdAt: number;
    updatedAt: number;
}

// 测试运行记录
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
        status: 'PASS' | 'FAIL' | 'TIMEOUT';
        duration: number;
        response?: any;
        error?: string;
    }[];
    summary: {
        total: number;
        passed: number;
        failed: number;
        timeout: number;
    };
}

interface ProtocolAuditProps {
    session: CloudSession | null;
    devices: Device[];
    mqttConnected: boolean;
    appid?: string;
    onMqttPublish?: (topic: string, message: string) => Promise<any>;
    onLog?: (log: any) => void;
    lastMqttMessage?: any;
}

// --- Initial Data ---

const DEFAULT_SUITE: ProtocolTestSuite = {
    id: 'default_mss210',
    name: 'MSS210 智能插座',
    description: '默认的 MSS210 产品协议测试库',
    protocols: [
        {
            id: 'sys_time',
            namespace: 'Appliance.System.Time',
            name: 'System Time',
            description: '设备时间和时区设置',
            methods: {
                GET: {
                    enabled: true,
                    requestPayload: {},
                    responseSchema: {
                        type: "object",
                        required: ["header", "payload"],
                        properties: {
                            header: { type: "object", properties: { method: { const: "GETACK" } }, required: ["method"] },
                            payload: { type: "object", required: ["time"] }
                        }
                    }
                },
                SET: {
                    enabled: true,
                    requestPayload: {
                        time: {
                            timeRule: [[1667725200, -28800, 0]],
                            timezone: "America/Los_Angeles",
                            timestamp: Math.floor(Date.now() / 1000)
                        }
                    },
                    responseSchema: {
                        type: "object",
                        required: ["header"],
                        properties: {
                            header: { type: "object", properties: { method: { const: "SETACK" } }, required: ["method"] }
                        }
                    }
                }
            }
        },
        {
            id: 'sys_all',
            namespace: 'Appliance.System.All',
            name: 'System All',
            description: '获取设备完整状态',
            methods: {
                GET: {
                    enabled: true,
                    requestPayload: {},
                    responseSchema: {
                        type: "object",
                        required: ["header", "payload"],
                        properties: {
                            header: { type: "object", properties: { method: { const: "GETACK" } } },
                            payload: { type: "object", required: ["all"] }
                        }
                    }
                }
            }
        }
    ],
    createdAt: Date.now(),
    updatedAt: Date.now()
};

// --- Helper ---
const generateSchemaFromJson = (json: any, includeRequired: boolean = false): any => {
    if (json === null) return { type: "null" };
    if (Array.isArray(json)) {
        return { type: "array", items: json.length > 0 ? generateSchemaFromJson(json[0], includeRequired) : {} };
    }
    if (typeof json === 'object') {
        const properties: any = {};
        const required: string[] = [];
        Object.keys(json).forEach(key => {
            properties[key] = generateSchemaFromJson(json[key], includeRequired);
            if (includeRequired) required.push(key);
        });
        const schema: any = { type: "object", properties };
        if (includeRequired && required.length > 0) schema.required = required;
        return schema;
    }
    return { type: typeof json };
};

// Extract all field paths from a JSON object for required fields selection
const extractFieldPaths = (json: any, prefix: string = ''): { path: string; type: string; sample: any }[] => {
    const paths: { path: string; type: string; sample: any }[] = [];
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return paths;

    Object.entries(json).forEach(([key, value]) => {
        const path = prefix ? `${prefix}.${key}` : key;
        const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
        paths.push({ path, type, sample: value });

        if (value && typeof value === 'object' && !Array.isArray(value)) {
            paths.push(...extractFieldPaths(value, path));
        }
    });
    return paths;
};

interface FieldConfig {
    required: boolean;
    type: string;
    value?: any;
}

interface TreeNode {
    key: string;
    fullPath: string;
    config: FieldConfig;
    children: TreeNode[];
}

const buildFieldTree = (configs: Record<string, FieldConfig>): TreeNode[] => {
    const roots: TreeNode[] = [];
    const nodeMap = new Map<string, TreeNode>();

    const sortedKeys = Object.keys(configs).sort();

    // Create nodes
    sortedKeys.forEach(path => {
        if (path === 'header' || path.startsWith('header.') || path === 'payload') return;

        nodeMap.set(path, {
            key: path.split('.').pop() || '',
            fullPath: path,
            config: configs[path],
            children: []
        });
    });

    // Build hierarchy
    sortedKeys.forEach(path => {
        if (!nodeMap.has(path)) return;

        const node = nodeMap.get(path)!;
        const parentPath = path.substring(0, path.lastIndexOf('.'));

        if (nodeMap.has(parentPath)) {
            nodeMap.get(parentPath)!.children.push(node);
        } else {
            roots.push(node);
        }
    });

    return roots;
};

const FieldTreeItem = ({
    node,
    level,
    onUpdate,
    onDelete
}: {
    node: TreeNode;
    level: number;
    onUpdate: (path: string, updates: Partial<FieldConfig>) => void;
    onDelete: (path: string) => void;
}) => {
    const [expanded, setExpanded] = useState(true);
    const hasChildren = node.children.length > 0;

    return (
        <div className="select-none">
            <div
                className={`flex items-center gap-2 p-2 hover:bg-slate-800/50 rounded group border-b border-slate-800/30 last:border-0 transition-colors ${level === 0 ? 'bg-slate-900/30' : ''}`}
                style={{ paddingLeft: `${level * 20 + 8}px` }}
            >
                {/* Expand/Collapse Toggle */}
                <div
                    className={`w-5 h-5 flex items-center justify-center rounded hover:bg-slate-700 cursor-pointer text-slate-500 ${!hasChildren ? 'invisible' : ''}`}
                    onClick={() => setExpanded(!expanded)}
                >
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </div>

                {/* Checkbox & Key */}
                <label className="flex items-center gap-3 cursor-pointer flex-1 min-w-0">
                    <input
                        type="checkbox"
                        checked={node.config.required}
                        onChange={e => onUpdate(node.fullPath, { required: e.target.checked })}
                        className="w-4 h-4 rounded border-slate-600 bg-slate-900 text-indigo-600 focus:ring-indigo-500 flex-shrink-0"
                    />
                    <div className={`font-mono text-sm truncate ${node.config.required ? 'text-white font-bold' : 'text-slate-300'}`} title={node.fullPath}>
                        {node.key}
                    </div>
                </label>

                {/* Type Selector */}
                <div className="w-[100px]">
                    <select
                        value={node.config.type}
                        onChange={e => onUpdate(node.fullPath, { type: e.target.value })}
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-400 outline-none hover:border-indigo-500 focus:border-indigo-500 transition-colors"
                        onClick={e => e.stopPropagation()}
                    >
                        <option value="string">String</option>
                        <option value="number">Number</option>
                        <option value="integer">Integer</option>
                        <option value="boolean">Boolean</option>
                        <option value="object">Object</option>
                        <option value="array">Array</option>
                        <option value="null">Null</option>
                    </select>
                </div>

                {/* Value Input */}
                <div className="flex-1 min-w-0 max-w-[200px]">
                    {node.config.type !== 'object' && node.config.type !== 'array' && node.config.type !== 'null' && (
                        <input
                            type="text"
                            value={node.config.value === undefined ? '' : String(node.config.value)}
                            onChange={e => onUpdate(node.fullPath, { value: e.target.value })}
                            placeholder="Default Value"
                            className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300 font-mono outline-none hover:border-indigo-500 focus:border-indigo-500 transition-colors placeholder:text-slate-600"
                            onClick={e => e.stopPropagation()}
                        />
                    )}
                </div>

                {/* Actions */}
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        onDelete(node.fullPath);
                    }}
                    className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"
                    title="Remove field"
                >
                    <X size={14} />
                </button>
            </div>

            {/* Children */}
            {expanded && hasChildren && (
                <div>
                    {node.children.map(child => (
                        <FieldTreeItem
                            key={child.fullPath}
                            node={child}
                            level={level + 1}
                            onUpdate={onUpdate}
                            onDelete={onDelete}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};

// Apply required fields and types to schema
const applyRequiredFields = (schema: any, fieldConfigs: Record<string, FieldConfig>, prefix: string = ''): any => {
    if (!schema || schema.type !== 'object' || !schema.properties) return schema;

    const newSchema = { ...schema, properties: { ...schema.properties } };
    const required: string[] = [];

    Object.keys(schema.properties).forEach(key => {
        const path = prefix ? `${prefix}.${key}` : key;

        // Header fields and top-level payload are always kept and required
        if (path === 'header' || path.startsWith('header.') || path === 'payload') {
            required.push(key);
            // Recursively apply to nested objects
            if (newSchema.properties[key].type === 'object') {
                newSchema.properties[key] = applyRequiredFields(newSchema.properties[key], fieldConfigs, path);
            }
            return;
        }

        const config = fieldConfigs[path];

        // If field is not in config (and not header/payload), remove it
        if (!config) {
            delete newSchema.properties[key];
            return;
        }

        // Apply configuration
        if (config.required) {
            required.push(key);
        }

        // Update type
        if (config.type && config.type !== newSchema.properties[key].type) {
            newSchema.properties[key] = { ...newSchema.properties[key], type: config.type };
        }

        // Update default value
        if (config.value !== undefined && config.value !== '') {
            let val = config.value;
            // Simple type casting
            if (config.type === 'number' || config.type === 'integer') {
                const num = Number(val);
                if (!isNaN(num)) val = num;
            }
            else if (config.type === 'boolean') val = (String(val) === 'true');

            newSchema.properties[key].default = val;
        }

        // Recursively apply to nested objects
        if (newSchema.properties[key].type === 'object') {
            newSchema.properties[key] = applyRequiredFields(newSchema.properties[key], fieldConfigs, path);
        }
    });

    if (required.length > 0) {
        newSchema.required = required;
    } else {
        delete newSchema.required;
    }

    return newSchema;
};

const generateJUnitXML = (run: TestRun): string => {
    const failures = run.results.filter(r => r.status === 'FAIL').length;
    const errors = run.results.filter(r => r.status === 'TIMEOUT').length;

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<testsuite name="${run.suiteName}" tests="${run.summary.total}" failures="${failures}" errors="${errors}" time="${((run.endTime || Date.now()) - run.startTime) / 1000}">\n`;

    run.results.forEach(r => {
        xml += `  <testcase name="${r.namespace} ${r.method}" classname="${r.namespace}" time="${r.duration / 1000}">\n`;
        if (r.status === 'FAIL') {
            xml += `    <failure message="Schema validation failed">${r.error || ''}</failure>\n`;
        } else if (r.status === 'TIMEOUT') {
            xml += `    <error message="Request timeout">Timeout waiting for response</error>\n`;
        }
        xml += `  </testcase>\n`;
    });

    xml += `</testsuite>`;
    return xml;
};

// --- Key-Value Editor Component ---
interface KVPair {
    id: string;  // 唯一 ID
    key: string;
    value: string;
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    children?: KVPair[];
}

const generateId = () => Math.random().toString(36).substr(2, 9);

const KeyValueEditor: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => {
    const [pairs, setPairs] = useState<KVPair[]>([]);

    // Parse JSON to pairs on mount
    useEffect(() => {
        try {
            const obj = JSON.parse(value);
            if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
                setPairs(objectToPairs(obj));
            }
        } catch (e) {
            setPairs([]);
        }
    }, []);

    const objectToPairs = (obj: any): KVPair[] => {
        return Object.entries(obj).map(([key, val]) => {
            const id = generateId();
            if (val === null) return { id, key, value: 'null', type: 'string' as const };
            if (Array.isArray(val)) return { id, key, value: JSON.stringify(val), type: 'array' as const };
            if (typeof val === 'object') return { id, key, value: '', type: 'object' as const, children: objectToPairs(val) };
            if (typeof val === 'number') return { id, key, value: String(val), type: 'number' as const };
            if (typeof val === 'boolean') return { id, key, value: String(val), type: 'boolean' as const };
            return { id, key, value: String(val), type: 'string' as const };
        });
    };

    const pairsToObject = (p: KVPair[]): any => {
        const obj: any = {};
        p.forEach(pair => {
            if (!pair.key) return; // 跳过空 key
            if (pair.type === 'object' && pair.children) {
                obj[pair.key] = pairsToObject(pair.children);
            } else if (pair.type === 'array') {
                try { obj[pair.key] = JSON.parse(pair.value); } catch { obj[pair.key] = []; }
            } else if (pair.type === 'number') {
                obj[pair.key] = parseFloat(pair.value) || 0;
            } else if (pair.type === 'boolean') {
                obj[pair.key] = pair.value === 'true';
            } else {
                obj[pair.key] = pair.value;
            }
        });
        return obj;
    };

    const syncToParent = (newPairs: KVPair[]) => {
        setPairs(newPairs);
        onChange(JSON.stringify(pairsToObject(newPairs), null, 2));
    };

    // 递归更新指定 path 的 pair
    const updatePairByPath = (pairs: KVPair[], path: string[], updates: Partial<KVPair>): KVPair[] => {
        if (path.length === 0) return pairs;
        const [currentId, ...restPath] = path;

        return pairs.map(p => {
            if (p.id !== currentId) return p;
            if (restPath.length === 0) {
                // 这是目标节点
                return { ...p, ...updates };
            } else {
                // 继续递归
                return { ...p, children: updatePairByPath(p.children || [], restPath, updates) };
            }
        });
    };

    // 递归删除指定 path 的 pair
    const removePairByPath = (pairs: KVPair[], path: string[]): KVPair[] => {
        if (path.length === 0) return pairs;
        const [currentId, ...restPath] = path;

        if (restPath.length === 0) {
            // 删除这个节点
            return pairs.filter(p => p.id !== currentId);
        } else {
            // 继续递归
            return pairs.map(p => {
                if (p.id !== currentId) return p;
                return { ...p, children: removePairByPath(p.children || [], restPath) };
            });
        }
    };

    // 递归添加子节点
    const addChildByPath = (pairs: KVPair[], path: string[]): KVPair[] => {
        if (path.length === 0) return pairs;
        const [currentId, ...restPath] = path;

        return pairs.map(p => {
            if (p.id !== currentId) return p;
            if (restPath.length === 0) {
                // 在这个节点添加子节点
                const newChild: KVPair = { id: generateId(), key: '', value: '', type: 'string' };
                return { ...p, children: [...(p.children || []), newChild] };
            } else {
                return { ...p, children: addChildByPath(p.children || [], restPath) };
            }
        });
    };

    const renderPair = (pair: KVPair, path: string[]) => {
        const currentPath = [...path, pair.id];

        return (
            <div key={pair.id} className="space-y-2">
                <div className="flex items-center gap-2">
                    <input
                        value={pair.key}
                        onChange={e => syncToParent(updatePairByPath(pairs, currentPath, { key: e.target.value }))}
                        placeholder="key"
                        className="w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-white font-mono outline-none"
                    />
                    <span className="text-slate-600">:</span>
                    <select
                        value={pair.type}
                        onChange={e => syncToParent(updatePairByPath(pairs, currentPath, {
                            type: e.target.value as any,
                            children: e.target.value === 'object' ? [] : undefined,
                            value: e.target.value === 'object' ? '' : pair.value
                        }))}
                        className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-400 outline-none"
                    >
                        <option value="string">String</option>
                        <option value="number">Number</option>
                        <option value="boolean">Boolean</option>
                        <option value="object">Object</option>
                        <option value="array">Array</option>
                    </select>
                    {pair.type !== 'object' && (
                        <input
                            value={pair.value}
                            onChange={e => syncToParent(updatePairByPath(pairs, currentPath, { value: e.target.value }))}
                            placeholder="value"
                            className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-emerald-400 font-mono outline-none"
                        />
                    )}
                    <button
                        onClick={() => syncToParent(removePairByPath(pairs, currentPath))}
                        className="text-red-400 hover:text-red-300 px-1"
                    >
                        ×
                    </button>
                </div>
                {pair.type === 'object' && (
                    <div className="ml-4 pl-3 border-l-2 border-slate-700 space-y-2">
                        {pair.children?.map(child => renderPair(child, currentPath))}
                        <button
                            onClick={() => syncToParent(addChildByPath(pairs, currentPath))}
                            className="text-xs text-indigo-400 hover:text-indigo-300"
                        >
                            + Add field
                        </button>
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="space-y-2">
            {pairs.map(pair => renderPair(pair, []))}
            <button
                onClick={() => {
                    const newPair: KVPair = { id: generateId(), key: '', value: '', type: 'string' };
                    syncToParent([...pairs, newPair]);
                }}
                className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
            >
                <Plus size={12} /> Add Field
            </button>
        </div>
    );
};

// --- Component ---

export const ProtocolAudit: React.FC<ProtocolAuditProps> = ({
    session, devices, mqttConnected, appid, onMqttPublish, onLog, lastMqttMessage
}) => {
    // State - Suites
    const [suites, setSuites] = useState<ProtocolTestSuite[]>([DEFAULT_SUITE]);
    const [selectedSuiteId, setSelectedSuiteId] = useState<string | null>(null);
    const [targetDeviceId, setTargetDeviceId] = useState<string>('');

    // State - UI
    const [expandedProtocols, setExpandedProtocols] = useState<Set<string>>(new Set());
    const [expandedMethods, setExpandedMethods] = useState<Set<string>>(new Set(['GET', 'SET']));
    const [isRunning, setIsRunning] = useState(false);
    const [runningTest, setRunningTest] = useState<string | null>(null);

    // State - Editing
    const [editingField, setEditingField] = useState<{ protocolId: string; method: string; field: 'payload' | 'schema' } | null>(null);
    const [editValue, setEditValue] = useState('');
    const [editingProtocolId, setEditingProtocolId] = useState<string | null>(null);
    const [editingSuiteId, setEditingSuiteId] = useState<string | null>(null);
    const [editingSuiteName, setEditingSuiteName] = useState('');

    // State - New Suite/Protocol Modal
    const [isAddingSuite, setIsAddingSuite] = useState(false);
    const [newSuite, setNewSuite] = useState({ name: '', description: '' });

    // State - Add Protocol Wizard
    const [isAddingProtocol, setIsAddingProtocol] = useState(false);
    const [wizardStep, setWizardStep] = useState(1);
    const [newProtocol, setNewProtocol] = useState({
        namespace: '',
        name: '',
        description: '',
        methods: {
            GET: { enabled: false, payload: '{}', schema: '{"type": "object"}' },
            SET: { enabled: false, payload: '{}', schema: '{"type": "object"}' },
            SYNC: { enabled: false, payload: '{}', schema: '{"type": "object"}' },
            DELETE: { enabled: false, payload: '{}', schema: '{"type": "object"}' },
            PUSH: { enabled: false, payload: '{}', schema: '{"type": "object"}' }
        }
    });
    const [currentMethodIndex, setCurrentMethodIndex] = useState(0);
    const [payloadEditMode, setPayloadEditMode] = useState<'json' | 'keyvalue'>('json');

    // State - Test History
    const [testHistory, setTestHistory] = useState<TestRun[]>([]);
    const [currentRun, setCurrentRun] = useState<TestRun | null>(null);

    // State - Logs
    const [testLogs, setTestLogs] = useState<Array<{ time: string; type: 'TX' | 'RX' | 'INFO' | 'ERROR'; message: string }>>([]);

    // State - Report
    const [showReportModal, setShowReportModal] = useState(false);
    const [jenkinsUrl, setJenkinsUrl] = useState('');

    // State - JSON to Schema Modal
    const [showJsonToSchemaModal, setShowJsonToSchemaModal] = useState(false);
    const [jsonExampleInput, setJsonExampleInput] = useState('');
    const [jsonExtractMode, setJsonExtractMode] = useState<'payload' | 'schema'>('schema');

    // Required fields selection for schema
    const [showRequiredFieldsModal, setShowRequiredFieldsModal] = useState(false);
    const [generatedSchema, setGeneratedSchema] = useState<any>(null);
    const [fieldConfigSelection, setFieldConfigSelection] = useState<Record<string, FieldConfig>>({});

    // Refs
    const ajv = useRef(new Ajv({ allErrors: true }));
    const pendingNamespaceRef = useRef<string | null>(null);
    const pendingMethodRef = useRef<string | null>(null);
    const responseResolverRef = useRef<((response: any) => void) | null>(null);

    // Computed
    const selectedSuite = suites.find(s => s.id === selectedSuiteId);
    const targetDevice = devices.find(d => d.id === targetDeviceId);

    // Add log
    const addTestLog = useCallback((type: 'TX' | 'RX' | 'INFO' | 'ERROR', message: string) => {
        const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
        setTestLogs(prev => [...prev.slice(-99), { time, type, message }]);
    }, []);

    // --- Effects ---

    // Load from localStorage
    useEffect(() => {
        const savedSuites = localStorage.getItem('protocol_audit_suites');
        if (savedSuites) {
            try {
                setSuites(JSON.parse(savedSuites));
            } catch (e) { console.error('Failed to load suites', e); }
        }

        const savedHistory = localStorage.getItem('protocol_audit_history');
        if (savedHistory) {
            try {
                setTestHistory(JSON.parse(savedHistory));
            } catch (e) { console.error('Failed to load history', e); }
        }
    }, []);

    // Save to localStorage
    useEffect(() => {
        localStorage.setItem('protocol_audit_suites', JSON.stringify(suites));
    }, [suites]);

    useEffect(() => {
        localStorage.setItem('protocol_audit_history', JSON.stringify(testHistory.slice(-20)));
    }, [testHistory]);

    // Select first device
    useEffect(() => {
        if (devices.length > 0 && !targetDeviceId) {
            setTargetDeviceId(devices[0].id);
        }
    }, [devices, targetDeviceId]);

    // Watch for MQTT responses
    useEffect(() => {
        if (lastMqttMessage && pendingNamespaceRef.current) {
            const msgNamespace = lastMqttMessage.header?.namespace;
            const msgMethod = lastMqttMessage.header?.method;

            const expectedMethod = pendingMethodRef.current &&
                METHOD_TO_ACK[pendingMethodRef.current as RequestMethod];

            addTestLog('RX', `Received: ${msgNamespace} ${msgMethod}`);

            if (msgNamespace === pendingNamespaceRef.current && msgMethod === expectedMethod) {
                addTestLog('INFO', `✓ Response matched!`);
                if (responseResolverRef.current) {
                    responseResolverRef.current(lastMqttMessage);
                    responseResolverRef.current = null;
                    pendingNamespaceRef.current = null;
                    pendingMethodRef.current = null;
                }
            }
        }
    }, [lastMqttMessage, addTestLog]);

    // --- Suite Actions ---

    const addNewSuite = () => {
        if (!newSuite.name.trim()) return;
        const id = `suite_${Date.now()}`;
        setSuites(prev => [...prev, {
            id,
            name: newSuite.name,
            description: newSuite.description,
            protocols: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        }]);
        setNewSuite({ name: '', description: '' });
        setIsAddingSuite(false);
        setSelectedSuiteId(id);
    };

    const deleteSuite = (id: string) => {
        if (confirm('确定删除此测试库？所有协议配置将丢失。')) {
            setSuites(prev => prev.filter(s => s.id !== id));
            if (selectedSuiteId === id) setSelectedSuiteId(null);
        }
    };

    const duplicateSuite = (suite: ProtocolTestSuite) => {
        const newId = `suite_${Date.now()}`;
        setSuites(prev => [...prev, {
            ...suite,
            id: newId,
            name: `${suite.name} (Copy)`,
            createdAt: Date.now(),
            updatedAt: Date.now()
        }]);
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

    const importSuite = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const suite = JSON.parse(e.target?.result as string) as ProtocolTestSuite;
                suite.id = `suite_${Date.now()}`;
                suite.createdAt = Date.now();
                suite.updatedAt = Date.now();
                setSuites(prev => [...prev, suite]);
            } catch (err) {
                alert('导入失败：无效的 JSON 文件');
            }
        };
        reader.readAsText(file);
        event.target.value = '';
    };

    const updateSuiteName = (suiteId: string, newName: string) => {
        if (!newName.trim()) return;
        setSuites(prev => prev.map(s =>
            s.id === suiteId
                ? { ...s, name: newName.trim(), updatedAt: Date.now() }
                : s
        ));
        setEditingSuiteId(null);
        setEditingSuiteName('');
    };

    // --- Protocol Actions ---

    const addProtocolToSuite = () => {
        if (!selectedSuiteId || !newProtocol.namespace.trim()) return;

        // 至少需要选择一个 method
        const enabledMethods = Object.entries(newProtocol.methods).filter(([_, m]) => m.enabled);
        if (enabledMethods.length === 0) {
            alert('请至少选择一个 Method');
            return;
        }

        setSuites(prev => prev.map(s => {
            if (s.id !== selectedSuiteId) return s;

            const isEditing = editingProtocolId !== null;
            const id = isEditing ? editingProtocolId : newProtocol.namespace.toLowerCase().replace(/\./g, '_') + '_' + Date.now();

            // 构建 methods 对象，支持所有类型
            const methods: ProtocolDefinition['methods'] = {};
            ALL_METHODS.forEach(methodName => {
                const methodConfig = newProtocol.methods[methodName];
                if (methodConfig.enabled) {
                    try {
                        methods[methodName] = {
                            enabled: true,
                            requestPayload: methodName === 'PUSH' ? {} : JSON.parse(methodConfig.payload || '{}'),
                            responseSchema: JSON.parse(methodConfig.schema || '{"type": "object"}')
                        };
                    } catch (e) {
                        methods[methodName] = {
                            enabled: true,
                            requestPayload: {},
                            responseSchema: { type: "object" }
                        };
                    }
                }
            });

            const newProto: ProtocolDefinition = {
                id,
                namespace: newProtocol.namespace,
                name: newProtocol.name || newProtocol.namespace.split('.').pop() || 'New Protocol',
                description: newProtocol.description,
                methods
            };

            return {
                ...s,
                protocols: isEditing
                    ? s.protocols.map(p => p.id === editingProtocolId ? newProto : p)
                    : [...s.protocols, newProto],
                updatedAt: Date.now()
            };
        }));

        // 重置向导状态
        resetProtocolWizard();
    };

    // 开始编辑现有协议
    const startEditingProtocol = (protocol: ProtocolDefinition) => {
        setEditingProtocolId(protocol.id);
        setNewProtocol({
            namespace: protocol.namespace,
            name: protocol.name,
            description: protocol.description || '',
            methods: {
                GET: {
                    enabled: !!protocol.methods.GET?.enabled,
                    payload: JSON.stringify(protocol.methods.GET?.requestPayload || {}, null, 2),
                    schema: JSON.stringify(protocol.methods.GET?.responseSchema || { type: "object" }, null, 2)
                },
                SET: {
                    enabled: !!protocol.methods.SET?.enabled,
                    payload: JSON.stringify(protocol.methods.SET?.requestPayload || {}, null, 2),
                    schema: JSON.stringify(protocol.methods.SET?.responseSchema || { type: "object" }, null, 2)
                },
                SYNC: {
                    enabled: !!protocol.methods.SYNC?.enabled,
                    payload: JSON.stringify(protocol.methods.SYNC?.requestPayload || {}, null, 2),
                    schema: JSON.stringify(protocol.methods.SYNC?.responseSchema || { type: "object" }, null, 2)
                },
                DELETE: {
                    enabled: !!protocol.methods.DELETE?.enabled,
                    payload: JSON.stringify(protocol.methods.DELETE?.requestPayload || {}, null, 2),
                    schema: JSON.stringify(protocol.methods.DELETE?.responseSchema || { type: "object" }, null, 2)
                },
                PUSH: {
                    enabled: !!protocol.methods.PUSH?.enabled,
                    payload: '{}',  // PUSH 不需要 payload
                    schema: JSON.stringify(protocol.methods.PUSH?.responseSchema || { type: "object" }, null, 2)
                }
            }
        });
        setWizardStep(1);
        setCurrentMethodIndex(0);
        setIsAddingProtocol(true);
    };

    const resetProtocolWizard = () => {
        setNewProtocol({
            namespace: '',
            name: '',
            description: '',
            methods: {
                GET: { enabled: false, payload: '{}', schema: '{"type": "object"}' },
                SET: { enabled: false, payload: '{}', schema: '{"type": "object"}' },
                SYNC: { enabled: false, payload: '{}', schema: '{"type": "object"}' },
                DELETE: { enabled: false, payload: '{}', schema: '{"type": "object"}' },
                PUSH: { enabled: false, payload: '{}', schema: '{"type": "object"}' }
            }
        });
        setWizardStep(1);
        setCurrentMethodIndex(0);
        setEditingProtocolId(null);
        setIsAddingProtocol(false);
    };

    const getEnabledMethods = () => {
        return ALL_METHODS.filter(m => newProtocol.methods[m].enabled);
    };

    const deleteProtocol = (protocolId: string) => {
        if (!selectedSuiteId) return;
        if (confirm('确定删除此协议？')) {
            setSuites(prev => prev.map(s => {
                if (s.id !== selectedSuiteId) return s;
                return {
                    ...s,
                    protocols: s.protocols.filter(p => p.id !== protocolId),
                    updatedAt: Date.now()
                };
            }));
        }
    };

    const updateProtocolMethod = (protocolId: string, methodName: string, updates: Partial<MethodTest>) => {
        if (!selectedSuiteId) return;
        setSuites(prev => prev.map(s => {
            if (s.id !== selectedSuiteId) return s;
            return {
                ...s,
                protocols: s.protocols.map(p => {
                    if (p.id !== protocolId) return p;
                    return {
                        ...p,
                        methods: {
                            ...p.methods,
                            [methodName]: { ...p.methods[methodName as keyof typeof p.methods], ...updates }
                        }
                    };
                }),
                updatedAt: Date.now()
            };
        }));
    };

    const saveEdit = () => {
        if (!editingField || !selectedSuiteId) return;
        try {
            const parsed = JSON.parse(editValue);
            const field = editingField.field === 'payload' ? 'requestPayload' : 'responseSchema';
            updateProtocolMethod(editingField.protocolId, editingField.method, { [field]: parsed });
            setEditingField(null);
        } catch (e) {
            alert('Invalid JSON');
        }
    };

    // --- Test Execution ---

    const runSingleTest = async (protocol: ProtocolDefinition, methodName: 'SET' | 'GET'): Promise<{ status: 'PASS' | 'FAIL' | 'TIMEOUT'; duration: number; response?: any; error?: string }> => {
        const methodConfig = protocol.methods[methodName];
        if (!methodConfig || !targetDevice || !mqttConnected || !onMqttPublish || !session) {
            return { status: 'FAIL', duration: 0, error: '设备未连接或 MQTT 未就绪' };
        }

        const timestampMs = (Date.now() / 1000).toString();
        const messageId = md5(timestampMs).toLowerCase();
        const timestamp = Math.floor(Date.now() / 1000);
        const sign = md5(messageId + (session.key || '') + String(timestamp)).toLowerCase();
        const fromTopic = appid
            ? `/app/${session.uid}-${appid}/subscribe`
            : `/app/${session.uid}/subscribe`;

        const payload = {
            header: {
                messageId,
                namespace: protocol.namespace,
                method: methodName,
                payloadVersion: 1,
                from: fromTopic,
                timestamp,
                sign,
                triggerSrc: 'iot-audit',
                uuid: targetDevice.id
            },
            payload: methodConfig.requestPayload
        };

        const topic = `/appliance/${targetDevice.id}/subscribe`;
        const startTime = Date.now();

        addTestLog('TX', `${protocol.namespace} ${methodName}`);

        try {
            await onMqttPublish(topic, JSON.stringify(payload));

            const response = await new Promise<any>((resolve, reject) => {
                pendingNamespaceRef.current = protocol.namespace;
                pendingMethodRef.current = methodName;
                responseResolverRef.current = resolve;
                setTimeout(() => {
                    if (pendingNamespaceRef.current === protocol.namespace) {
                        pendingNamespaceRef.current = null;
                        pendingMethodRef.current = null;
                        responseResolverRef.current = null;
                        reject(new Error('TIMEOUT'));
                    }
                }, 8000);
            });

            const duration = Date.now() - startTime;
            const validate = ajv.current.compile(methodConfig.responseSchema);
            const valid = validate(response);

            return {
                status: valid ? 'PASS' : 'FAIL',
                duration,
                response,
                error: valid ? undefined : JSON.stringify(validate.errors, null, 2)
            };
        } catch (e: any) {
            return {
                status: e.message === 'TIMEOUT' ? 'TIMEOUT' : 'FAIL',
                duration: Date.now() - startTime,
                error: e.message
            };
        }
    };

    const runAllTests = async () => {
        if (!selectedSuite || !targetDevice || !mqttConnected) {
            alert('请选择测试库、目标设备并确保 MQTT 已连接');
            return;
        }

        setIsRunning(true);
        setTestLogs([]);

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

        for (const protocol of selectedSuite.protocols) {
            for (const methodName of REQUEST_METHODS) {
                const methodConfig = protocol.methods[methodName];
                if (!methodConfig?.enabled) continue;

                setRunningTest(`${protocol.id}:${methodName}`);
                run.summary.total++;

                const result = await runSingleTest(protocol, methodName);

                run.results.push({
                    protocolId: protocol.id,
                    namespace: protocol.namespace,
                    method: methodName,
                    ...result
                });

                if (result.status === 'PASS') run.summary.passed++;
                else if (result.status === 'FAIL') run.summary.failed++;
                else if (result.status === 'TIMEOUT') run.summary.timeout++;

                // 更新协议的 lastResult
                updateProtocolMethod(protocol.id, methodName, { lastResult: result });

                setCurrentRun({ ...run });
                await new Promise(r => setTimeout(r, 200));
            }
        }

        run.endTime = Date.now();
        run.status = run.summary.failed > 0 || run.summary.timeout > 0 ? 'FAILED' : 'COMPLETED';
        setCurrentRun(run);
        setTestHistory(prev => [...prev, run]);
        setRunningTest(null);
        setIsRunning(false);

        addTestLog('INFO', `测试完成: ${run.summary.passed}/${run.summary.total} 通过`);
    };

    // --- Report Export ---

    const exportReport = (format: 'json' | 'junit') => {
        if (!currentRun) return;

        let data: string;
        let filename: string;
        let mimeType: string;

        if (format === 'json') {
            data = JSON.stringify(currentRun, null, 2);
            filename = `test_report_${currentRun.id}.json`;
            mimeType = 'application/json';
        } else {
            data = generateJUnitXML(currentRun);
            filename = `test_report_${currentRun.id}.xml`;
            mimeType = 'application/xml';
        }

        const blob = new Blob([data], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    };

    const sendToJenkins = async () => {
        if (!currentRun || !jenkinsUrl.trim()) {
            alert('请输入 Jenkins Webhook URL');
            return;
        }

        try {
            const response = await fetch(jenkinsUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(currentRun)
            });

            if (response.ok) {
                alert('报告已成功发送到 Jenkins');
                setShowReportModal(false);
            } else {
                alert(`发送失败: ${response.status} ${response.statusText}`);
            }
        } catch (e: any) {
            alert(`发送失败: ${e.message}`);
        }
    };

    // --- Render ---

    return (
        <div className="h-full flex gap-4 p-4">
            {/* Left Panel - Suite Selection */}
            <div className="w-72 bg-slate-900/40 border border-slate-800 rounded-2xl flex flex-col overflow-hidden">
                <div className="p-3 border-b border-slate-800">
                    <h2 className="text-xs font-black text-white uppercase tracking-wider mb-3">Test Suites</h2>

                    {/* Target Device */}
                    <div className="mb-3">
                        <label className="text-[9px] font-bold text-slate-500 uppercase mb-1 block">Target Device</label>
                        <select
                            value={targetDeviceId}
                            onChange={e => setTargetDeviceId(e.target.value)}
                            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white outline-none"
                        >
                            {devices.map(d => (
                                <option key={d.id} value={d.id}>{d.name}</option>
                            ))}
                        </select>
                    </div>
                </div>

                {/* Suite List */}
                <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
                    {suites.map(suite => {
                        const isSelected = selectedSuiteId === suite.id;
                        const enabledCount = suite.protocols.reduce((acc, p) =>
                            acc + Object.values(p.methods).filter(m => m?.enabled).length, 0);

                        return (
                            <div
                                key={suite.id}
                                onClick={() => setSelectedSuiteId(suite.id)}
                                className={`p-3 rounded-xl cursor-pointer transition-all border group ${isSelected
                                    ? 'bg-indigo-500/10 border-indigo-500/50'
                                    : 'bg-slate-800/30 border-transparent hover:border-slate-700'
                                    }`}
                            >
                                <div className="flex justify-between items-start mb-1">
                                    <div className="flex items-center gap-2 flex-1 min-w-0">
                                        <Package size={14} className={isSelected ? 'text-indigo-400' : 'text-slate-500'} />
                                        {editingSuiteId === suite.id ? (
                                            <input
                                                type="text"
                                                value={editingSuiteName}
                                                onChange={e => setEditingSuiteName(e.target.value)}
                                                onBlur={() => updateSuiteName(suite.id, editingSuiteName)}
                                                onKeyDown={e => {
                                                    if (e.key === 'Enter') updateSuiteName(suite.id, editingSuiteName);
                                                    if (e.key === 'Escape') { setEditingSuiteId(null); setEditingSuiteName(''); }
                                                }}
                                                onClick={e => e.stopPropagation()}
                                                autoFocus
                                                className="flex-1 bg-slate-950 border border-indigo-500 rounded px-2 py-0.5 text-sm font-bold text-white outline-none"
                                            />
                                        ) : (
                                            <span
                                                className={`text-sm font-bold truncate ${isSelected ? 'text-indigo-300' : 'text-white'}`}
                                                onDoubleClick={(e) => {
                                                    e.stopPropagation();
                                                    setEditingSuiteId(suite.id);
                                                    setEditingSuiteName(suite.name);
                                                }}
                                            >
                                                {suite.name}
                                            </span>
                                        )}
                                    </div>
                                    <div className="hidden group-hover:flex gap-1">
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setEditingSuiteId(suite.id);
                                                setEditingSuiteName(suite.name);
                                            }}
                                            className="p-1 text-slate-500 hover:text-indigo-400"
                                            title="编辑名称"
                                        >
                                            <Edit3 size={12} />
                                        </button>
                                        <button onClick={(e) => { e.stopPropagation(); exportSuite(suite); }} className="p-1 text-slate-500 hover:text-white" title="导出">
                                            <Download size={12} />
                                        </button>
                                        <button onClick={(e) => { e.stopPropagation(); duplicateSuite(suite); }} className="p-1 text-slate-500 hover:text-white" title="复制">
                                            <Copy size={12} />
                                        </button>
                                        <button onClick={(e) => { e.stopPropagation(); deleteSuite(suite.id); }} className="p-1 text-slate-500 hover:text-red-400" title="删除">
                                            <Trash2 size={12} />
                                        </button>
                                    </div>
                                </div>
                                <div className="text-[10px] text-slate-500">
                                    {suite.protocols.length} 协议 · {enabledCount} 测试项
                                </div>
                            </div>
                        );
                    })}
                </div>

                {/* Actions */}
                <div className="p-2 border-t border-slate-800 flex gap-2">
                    <button
                        onClick={() => setIsAddingSuite(true)}
                        className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold flex items-center justify-center gap-1"
                    >
                        <Plus size={14} /> 新建
                    </button>
                    <label className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-xs font-bold flex items-center justify-center gap-1 cursor-pointer">
                        <Upload size={14} /> 导入
                        <input type="file" accept=".json" className="hidden" onChange={importSuite} />
                    </label>
                </div>
            </div>

            {/* Right Panel - Suite Details */}
            <div className="flex-1 flex flex-col min-h-0 gap-4">
                {selectedSuite ? (
                    <>
                        {/* Header */}
                        <div className="flex justify-between items-start shrink-0">
                            <div>
                                <h1 className="text-xl font-black text-white">{selectedSuite.name}</h1>
                                {selectedSuite.description && (
                                    <p className="text-sm text-slate-500 mt-1">{selectedSuite.description}</p>
                                )}
                            </div>
                            <div className="flex gap-2">
                                <button
                                    onClick={runAllTests}
                                    disabled={isRunning || !mqttConnected || selectedSuite.protocols.length === 0}
                                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold uppercase flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {isRunning ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />}
                                    {isRunning ? 'Running...' : 'Run All Tests'}
                                </button>
                                {currentRun && (
                                    <button
                                        onClick={() => setShowReportModal(true)}
                                        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold uppercase flex items-center gap-2"
                                    >
                                        <FileJson size={14} /> Export Report
                                    </button>
                                )}
                                <button
                                    onClick={() => setIsAddingProtocol(true)}
                                    className="p-2 bg-slate-700 hover:bg-slate-600 text-white rounded-xl"
                                >
                                    <Plus size={18} />
                                </button>
                            </div>
                        </div>

                        {/* Current Run Summary */}
                        {currentRun && (
                            <div className={`p-3 rounded-xl border flex items-center justify-between ${currentRun.status === 'COMPLETED' ? 'bg-emerald-500/10 border-emerald-500/30' :
                                currentRun.status === 'FAILED' ? 'bg-red-500/10 border-red-500/30' :
                                    'bg-blue-500/10 border-blue-500/30'
                                }`}>
                                <div className="flex items-center gap-4">
                                    {currentRun.status === 'COMPLETED' && <CheckCircle size={20} className="text-emerald-400" />}
                                    {currentRun.status === 'FAILED' && <XCircle size={20} className="text-red-400" />}
                                    {currentRun.status === 'RUNNING' && <RefreshCw size={20} className="text-blue-400 animate-spin" />}
                                    <div>
                                        <div className="text-sm font-bold text-white">
                                            {currentRun.status === 'RUNNING' ? 'Testing...' :
                                                currentRun.status === 'COMPLETED' ? 'All Tests Passed' : 'Some Tests Failed'}
                                        </div>
                                        <div className="text-xs text-slate-400">
                                            Device: {currentRun.deviceName}
                                        </div>
                                    </div>
                                </div>
                                <div className="flex items-center gap-4 text-sm">
                                    <span className="text-emerald-400 font-bold">{currentRun.summary.passed} Pass</span>
                                    <span className="text-red-400 font-bold">{currentRun.summary.failed} Fail</span>
                                    <span className="text-amber-400 font-bold">{currentRun.summary.timeout} Timeout</span>
                                </div>
                            </div>
                        )}

                        {/* Protocol List */}
                        <div className="flex-1 overflow-y-auto space-y-2 custom-scrollbar min-h-0">
                            {selectedSuite.protocols.length === 0 ? (
                                <div className="h-full flex flex-col items-center justify-center text-slate-600">
                                    <FolderOpen size={48} className="mb-4 opacity-30" />
                                    <p className="text-sm">此测试库暂无协议</p>
                                    <button
                                        onClick={() => setIsAddingProtocol(true)}
                                        className="mt-4 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold"
                                    >
                                        添加协议
                                    </button>
                                </div>
                            ) : (
                                selectedSuite.protocols.map(protocol => {
                                    const isExpanded = expandedProtocols.has(protocol.id);

                                    return (
                                        <div key={protocol.id} className="bg-slate-800/30 border border-slate-700/50 rounded-xl overflow-hidden">
                                            {/* Protocol Header */}
                                            <div
                                                className="flex items-center justify-between p-3 cursor-pointer hover:bg-slate-800/50"
                                                onClick={() => setExpandedProtocols(prev => {
                                                    const next = new Set(prev);
                                                    if (next.has(protocol.id)) next.delete(protocol.id);
                                                    else next.add(protocol.id);
                                                    return next;
                                                })}
                                            >
                                                <div className="flex items-center gap-3">
                                                    {isExpanded ? <ChevronDown size={16} className="text-slate-400" /> : <ChevronRight size={16} className="text-slate-400" />}
                                                    <div>
                                                        <div className="text-sm font-bold text-white">{protocol.name}</div>
                                                        <div className="text-xs text-slate-500 font-mono">{protocol.namespace}</div>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    {/* Method 标签 */}
                                                    {ALL_METHODS.map(methodName => {
                                                        const methodConfig = protocol.methods[methodName];
                                                        if (!methodConfig?.enabled) return null;

                                                        const methodColors: Record<MethodType, { bg: string, text: string }> = {
                                                            GET: { bg: 'bg-blue-500/20', text: 'text-blue-400' },
                                                            SET: { bg: 'bg-amber-500/20', text: 'text-amber-400' },
                                                            SYNC: { bg: 'bg-cyan-500/20', text: 'text-cyan-400' },
                                                            DELETE: { bg: 'bg-red-500/20', text: 'text-red-400' },
                                                            PUSH: { bg: 'bg-purple-500/20', text: 'text-purple-400' }
                                                        };

                                                        const isCurrentlyRunning = runningTest === `${protocol.id}:${methodName}`;
                                                        const lastResult = methodConfig.lastResult;

                                                        let statusStyle = `${methodColors[methodName].bg} ${methodColors[methodName].text}`;
                                                        if (lastResult?.status === 'PASS') statusStyle = 'bg-emerald-500/20 text-emerald-400';
                                                        else if (lastResult?.status === 'FAIL') statusStyle = 'bg-red-500/20 text-red-400';
                                                        else if (lastResult?.status === 'TIMEOUT') statusStyle = 'bg-amber-500/20 text-amber-400';

                                                        return (
                                                            <span
                                                                key={methodName}
                                                                className={`text-xs px-2 py-0.5 rounded font-bold flex items-center gap-1 ${statusStyle}`}
                                                            >
                                                                {methodName}
                                                                {isCurrentlyRunning && <RefreshCw size={10} className="animate-spin" />}
                                                            </span>
                                                        );
                                                    })}

                                                    {/* 编辑按钮 */}
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); startEditingProtocol(protocol); }}
                                                        className="p-1 text-slate-500 hover:text-indigo-400"
                                                        title="编辑协议"
                                                    >
                                                        <Edit3 size={14} />
                                                    </button>

                                                    {/* 删除按钮 */}
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); deleteProtocol(protocol.id); }}
                                                        className="p-1 text-slate-600 hover:text-red-400"
                                                        title="删除协议"
                                                    >
                                                        <Trash2 size={14} />
                                                    </button>
                                                </div>
                                            </div>

                                            {/* Protocol Details - 简化版 */}
                                            {isExpanded && (
                                                <div className="border-t border-slate-700/50 p-4">
                                                    <div className="grid grid-cols-2 gap-3">
                                                        {ALL_METHODS.map(methodName => {
                                                            const methodConfig = protocol.methods[methodName];
                                                            if (!methodConfig?.enabled) return null;

                                                            return (
                                                                <div key={methodName} className="bg-slate-900/50 rounded-lg p-3">
                                                                    <div className="flex items-center justify-between mb-2">
                                                                        <span className={`text-sm font-bold ${methodName === 'GET' ? 'text-blue-400' :
                                                                            methodName === 'SET' ? 'text-amber-400' :
                                                                                methodName === 'SYNC' ? 'text-cyan-400' :
                                                                                    methodName === 'DELETE' ? 'text-red-400' :
                                                                                        'text-purple-400'
                                                                            }`}>{methodName}</span>
                                                                        {methodConfig.lastResult && (
                                                                            <span className={`px-2 py-1 rounded text-xs ${methodConfig.lastResult.status === 'PASS' ? 'bg-emerald-500/20 text-emerald-400' :
                                                                                methodConfig.lastResult.status === 'FAIL' ? 'bg-red-500/20 text-red-400' :
                                                                                    'bg-amber-500/20 text-amber-400'
                                                                                }`}>
                                                                                {methodConfig.lastResult.status}
                                                                                {methodConfig.lastResult.duration && ` ${methodConfig.lastResult.duration}ms`}
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                    {methodName !== 'PUSH' && (
                                                                        <pre className="bg-slate-950/50 rounded p-2 text-xs font-mono text-slate-400 max-h-20 overflow-auto">
                                                                            {JSON.stringify(methodConfig.requestPayload, null, 2)}
                                                                        </pre>
                                                                    )}
                                                                    {methodName === 'PUSH' && (
                                                                        <span className="text-sm text-slate-500 italic">设备主动推送</span>
                                                                    )}
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })
                            )}
                        </div>

                        {/* Test Log */}
                        <div className="h-32 bg-slate-900/60 border border-slate-800 rounded-xl flex flex-col shrink-0">
                            <div className="px-3 py-2 border-b border-slate-800 flex justify-between items-center">
                                <span className="text-xs font-bold text-slate-500 uppercase">Test Log</span>
                                <button onClick={() => setTestLogs([])} className="text-xs text-slate-500 hover:text-red-400">Clear</button>
                            </div>
                            <div className="flex-1 overflow-y-auto p-2 font-mono text-xs space-y-0.5 custom-scrollbar">
                                {testLogs.length === 0 ? (
                                    <span className="text-slate-600">Run tests to see logs...</span>
                                ) : (
                                    testLogs.map((log, i) => (
                                        <div key={i} className={log.type === 'ERROR' ? 'text-red-400' : log.type === 'RX' ? 'text-emerald-400' : log.type === 'TX' ? 'text-blue-400' : 'text-slate-400'}>
                                            [{log.time}] {log.type} {log.message}
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-slate-600">
                        <ShieldCheck size={64} className="mb-4 opacity-20" />
                        <p className="text-lg font-bold">选择或创建一个测试库</p>
                        <p className="text-sm mt-2">测试库可以复用于同型号的任何设备</p>
                    </div>
                )}
            </div>

            {/* Add Suite Modal */}
            {isAddingSuite && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
                    <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-[450px]">
                        <h3 className="text-lg font-black text-white mb-4">新建测试库</h3>
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
                            <button onClick={() => setIsAddingSuite(false)} className="px-4 py-2 text-slate-400 hover:text-white">取消</button>
                            <button onClick={addNewSuite} className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-bold">创建</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Add Protocol Wizard Modal */}
            {isAddingProtocol && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
                    <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-[600px] max-h-[80vh] overflow-hidden flex flex-col">
                        {/* Header with Steps */}
                        <div className="flex items-center justify-between mb-6">
                            <h3 className="text-lg font-black text-white">{editingProtocolId ? '编辑协议' : '添加协议'}</h3>
                            <div className="flex items-center gap-2">
                                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${wizardStep >= 1 ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-slate-400'}`}>1</div>
                                <div className={`w-8 h-1 rounded ${wizardStep >= 2 ? 'bg-indigo-600' : 'bg-slate-700'}`} />
                                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${wizardStep >= 2 ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-slate-400'}`}>2</div>
                            </div>
                        </div>

                        <div className="flex-1 overflow-y-auto custom-scrollbar">
                            {/* Step 1: Basic Info & Method Selection */}
                            {wizardStep === 1 && (
                                <div className="space-y-4">
                                    <div>
                                        <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Namespace *</label>
                                        <input
                                            value={newProtocol.namespace}
                                            onChange={e => setNewProtocol(p => ({ ...p, namespace: e.target.value }))}
                                            placeholder="例如：Appliance.Control.ToggleX"
                                            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-4 py-3 text-sm text-white font-mono outline-none focus:border-indigo-500"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">显示名称</label>
                                        <input
                                            value={newProtocol.name}
                                            onChange={e => setNewProtocol(p => ({ ...p, name: e.target.value }))}
                                            placeholder="可选，默认使用 namespace 最后一段"
                                            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-4 py-3 text-sm text-white outline-none focus:border-indigo-500"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-xs font-bold text-slate-400 uppercase mb-2 block">选择支持的 Methods *</label>
                                        <div className="grid grid-cols-2 gap-2">
                                            {ALL_METHODS.map(method => {
                                                const methodColors: Record<MethodType, string> = {
                                                    GET: 'text-blue-400',
                                                    SET: 'text-amber-400',
                                                    SYNC: 'text-cyan-400',
                                                    DELETE: 'text-red-400',
                                                    PUSH: 'text-purple-400'
                                                };
                                                const methodDesc: Record<MethodType, string> = {
                                                    GET: '查询设备状态 → GETACK',
                                                    SET: '设置设备状态 → SETACK',
                                                    SYNC: '同步数据 → SYNCACK',
                                                    DELETE: '删除数据 → DELETEACK',
                                                    PUSH: '设备主动推送'
                                                };
                                                return (
                                                    <label
                                                        key={method}
                                                        className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${newProtocol.methods[method].enabled
                                                            ? 'bg-indigo-500/10 border-indigo-500/50'
                                                            : 'bg-slate-800/30 border-slate-700 hover:border-slate-600'
                                                            }`}
                                                    >
                                                        <input
                                                            type="checkbox"
                                                            checked={newProtocol.methods[method].enabled}
                                                            onChange={e => setNewProtocol(p => ({
                                                                ...p,
                                                                methods: {
                                                                    ...p.methods,
                                                                    [method]: { ...p.methods[method], enabled: e.target.checked }
                                                                }
                                                            }))}
                                                            className="w-4 h-4 rounded"
                                                        />
                                                        <div className="flex-1">
                                                            <div className={`text-sm font-bold ${methodColors[method]}`}>{method}</div>
                                                            <div className="text-[10px] text-slate-500">{methodDesc[method]}</div>
                                                        </div>
                                                    </label>
                                                );
                                            })}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Step 2: Configure Each Method */}
                            {wizardStep === 2 && (
                                <div className="space-y-4">
                                    {/* Method Tabs */}
                                    <div className="flex gap-2 border-b border-slate-700 pb-2">
                                        {getEnabledMethods().map((method, idx) => (
                                            <button
                                                key={method}
                                                onClick={() => setCurrentMethodIndex(idx)}
                                                className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${currentMethodIndex === idx
                                                    ? (method === 'GET' ? 'bg-blue-500 text-white' : method === 'SET' ? 'bg-amber-500 text-white' : 'bg-purple-500 text-white')
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

                                        return (
                                            <div className="space-y-4">
                                                {/* Edit Mode Toggle */}
                                                <div className="flex items-center gap-2">
                                                    <span className="text-xs text-slate-500">编辑模式:</span>
                                                    <button
                                                        onClick={() => setPayloadEditMode('json')}
                                                        className={`px-3 py-1 text-xs rounded-lg ${payloadEditMode === 'json' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'}`}
                                                    >
                                                        JSON
                                                    </button>
                                                    <button
                                                        onClick={() => setPayloadEditMode('keyvalue')}
                                                        className={`px-3 py-1 text-xs rounded-lg ${payloadEditMode === 'keyvalue' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'}`}
                                                    >
                                                        Key-Value
                                                    </button>
                                                </div>

                                                {/* Request Payload - 仅对非 PUSH 方法显示 */}
                                                {currentMethod !== 'PUSH' ? (
                                                    <div>
                                                        <div className="flex items-center justify-between mb-2">
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
                                                        {payloadEditMode === 'json' ? (
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
                                                                className="w-full h-32 bg-slate-950 border border-slate-700 rounded-lg px-4 py-3 text-sm text-emerald-400 font-mono outline-none focus:border-indigo-500 resize-none"
                                                            />
                                                        ) : (
                                                            <div className="bg-slate-950 border border-slate-700 rounded-lg p-3 space-y-2">
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
                                                <div>
                                                    <div className="flex items-center justify-between mb-2">
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
                                                        className="w-full h-32 bg-slate-950 border border-slate-700 rounded-lg px-4 py-3 text-sm text-blue-400 font-mono outline-none focus:border-indigo-500 resize-none"
                                                    />
                                                    <p className="text-[10px] text-slate-600 mt-1">
                                                        💡 提示：点击「从 JSON 示例生成」，粘贴协议文档中的响应 JSON 即可自动生成 Schema
                                                    </p>
                                                </div>
                                            </div>
                                        );
                                    })()}
                                </div>
                            )}
                        </div>

                        {/* Footer */}
                        <div className="flex justify-between gap-3 mt-6 pt-4 border-t border-slate-800">
                            <button onClick={resetProtocolWizard} className="px-4 py-2 text-slate-400 hover:text-white">
                                取消
                            </button>
                            <div className="flex gap-2">
                                {wizardStep > 1 && (
                                    <button
                                        onClick={() => setWizardStep(s => s - 1)}
                                        className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg font-bold"
                                    >
                                        上一步
                                    </button>
                                )}
                                {wizardStep === 1 ? (
                                    <button
                                        onClick={() => {
                                            if (!newProtocol.namespace.trim()) {
                                                alert('请输入 Namespace');
                                                return;
                                            }
                                            if (!getEnabledMethods().length) {
                                                alert('请至少选择一个 Method');
                                                return;
                                            }
                                            setWizardStep(2);
                                            setCurrentMethodIndex(0);
                                        }}
                                        className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-bold"
                                    >
                                        下一步
                                    </button>
                                ) : (
                                    <button
                                        onClick={addProtocolToSuite}
                                        className="px-6 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold"
                                    >
                                        {editingProtocolId ? '保存修改' : '完成添加'}
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Report Export Modal */}
            {showReportModal && currentRun && (
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
            )}

            {/* JSON Extract Modal (Payload / Schema) */}
            {showJsonToSchemaModal && (
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
                                            alert('请先选择一个 Method');
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
                                        alert('JSON 解析失败，请检查格式是否正确');
                                    }
                                }}
                                className={`px-6 py-2 ${jsonExtractMode === 'payload' ? 'bg-blue-600 hover:bg-blue-500' : 'bg-emerald-600 hover:bg-emerald-500'} text-white rounded-lg font-bold`}
                            >
                                {jsonExtractMode === 'payload' ? '提取 Payload' : '生成 Schema'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Required Fields Selection Modal */}
            {showRequiredFieldsModal && (
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
            )}
        </div>
    );
};
