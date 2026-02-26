import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    ShieldCheck, Play, Plus, Trash2, ChevronRight, ChevronDown, ChevronLeft,
    CheckCircle, XCircle, AlertTriangle, Edit3, FolderOpen,
    RefreshCw, Copy, Zap, ArrowRight, Download, Upload, FileJson,
    Package, Clock, History, Send, Check, X, Wand2, BarChart3, FileText, MoreVertical, Settings, Search, Pause, Square, Minimize2, Maximize2,
    CheckCircle2, HelpCircle, AlertCircle, Circle, Info, Activity, ArrowDownCircle, Save, Bell, AlignLeft, ArrowUp, ArrowDown, ListOrdered, GripVertical
} from 'lucide-react';
import Ajv from 'ajv';
import { CloudSession, Device } from '../types';
import { md5 } from './AuthScreen';
import { ProtocolGenerator } from './ProtocolGenerator';
import { TestResultViewer, DetailedTestResult, TestRequest, TestResponse, SchemaValidationError, BatchTestResult } from './TestResultViewer';
import { TestStatisticsDashboard, TestRunHistory } from './TestStatisticsDashboard';
import { TestCaseEditor, TestCase } from './TestCaseEditor';
import { ExecutionPlanEditor, ManualInputDialog, TestExecutionPlan, TestStep, StepType, StepConfig, ManualField } from './ExecutionPlanEditor';
import * as AuditStorage from '../services/auditStorageService';
import * as AuditDB from '../services/auditDatabaseService';
import { databaseConfig } from '../services/auditDatabaseConfig';

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
    category?: string; // New: Derived from namespace
    docUrl?: string;   // New: Link to Confluence
    methods: {
        [key in RequestMethod]?: MethodTest;
    };
    reviewStatus?: 'UNVERIFIED' | 'VERIFIED';
    verificationMode?: 'direct' | 'manual';
    tags?: string[]; // New: Tags for categorization
    executionPlan?: TestExecutionPlan; // 自定义测试执行计划
}

interface AuditProject {
    id: string;
    name: string;
    description?: string;
    deviceId?: string;
    targetDeviceName?: string;
    protocols: ProtocolDefinition[];
    createdAt: number;
    updatedAt: number;
    status: 'ACTIVE' | 'ARCHIVED';
    progress: number;
}

type RequestMethod = 'GET' | 'SET' | 'PUSH' | 'SYNC' | 'DELETE';
type AckMethod = 'GETACK' | 'SETACK' | 'PUSHACK' | 'SYNCACK' | 'DELETEACK';
type EditingTarget = RequestMethod | 'executionPlan'; // 扩展编辑目标类型
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

// Helper to infer schema from JSON data
const inferSchemaFromData = (data: any): any => {
    if (data === null) return { type: 'null' };

    const type = typeof data;
    if (type === 'number' || type === 'string' || type === 'boolean') {
        return { type };
    }

    if (Array.isArray(data)) {
        return {
            type: 'array',
            items: data.length > 0 ? inferSchemaFromData(data[0]) : {}
        };
    }

    if (type === 'object') {
        const properties: Record<string, any> = {};
        const required: string[] = [];

        Object.entries(data).forEach(([key, value]) => {
            properties[key] = inferSchemaFromData(value);
            required.push(key);
        });

        return {
            type: 'object',
            properties,
            required: required.length > 0 ? required : undefined
        };
    }

    return {};
};

// Helper to check if an object looks like a JSON Schema
const isLikelySchema = (obj: any): boolean => {
    if (!obj || typeof obj !== 'object') return false;
    // Check for explicit schema keywords. 
    // Note: We do NOT treat empty objects as schemas anymore, treating them as empty payloads instead.
    const schemaKeywords = ['$schema', 'type', 'properties', 'items', 'required', 'allOf', 'anyOf', 'oneOf', 'not', 'enum', 'const'];
    return schemaKeywords.some(k => k in obj);
};

interface ProtocolTestSuite {
    id: string;
    name: string;
    description?: string;
    protocols: ProtocolDefinition[];
    createdAt: number;
    updatedAt: number;
    executionConfig?: TestExecutionConfig;
    testRuns?: BatchTestResult[];
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
        request?: any;
        expectedSchema?: any;
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



// --- New Components for Redesign ---

const ProjectDashboard: React.FC<{
    projects: AuditProject[];
    onSelect: (project: AuditProject) => void;
    onCreate: () => void;
    onDelete: (id: string) => void;
    onRename: (id: string, newName: string) => void;
    onDuplicate: (sourceProject: AuditProject, newName: string, newDescription: string) => void;
}> = ({ projects, onSelect, onCreate, onDelete, onRename, onDuplicate }) => {
    const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editName, setEditName] = useState('');
    const [searchTerm, setSearchTerm] = useState('');

    // Duplicate Modal State
    const [duplicateSource, setDuplicateSource] = useState<AuditProject | null>(null);
    const [duplicateData, setDuplicateData] = useState({ name: '', description: '' });

    const startEditing = (project: AuditProject, e: React.MouseEvent) => {
        e.stopPropagation();
        setEditingId(project.id);
        setEditName(project.name);
    };

    const saveEditing = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (editingId && editName.trim()) {
            onRename(editingId, editName.trim());
            setEditingId(null);
        }
    };

    const cancelEditing = (e: React.MouseEvent) => {
        e.stopPropagation();
        setEditingId(null);
    };

    const handleDuplicateClick = (project: AuditProject, e: React.MouseEvent) => {
        e.stopPropagation();
        setDuplicateSource(project);
        setDuplicateData({ name: `${project.name} (Copy)`, description: project.description || '' });
    };

    const confirmDuplicate = () => {
        if (duplicateSource && duplicateData.name.trim()) {
            onDuplicate(duplicateSource, duplicateData.name, duplicateData.description);
            setDuplicateSource(null);
        }
    };

    const filteredProjects = projects
        .filter(p => p.name.toLowerCase().includes(searchTerm.toLowerCase()))
        .sort((a, b) => b.updatedAt - a.updatedAt);

    return (
        <div className="p-6 space-y-6 h-full flex flex-col">
            <div className="flex justify-between items-center shrink-0">
                <div>
                    <h2 className="text-2xl font-bold text-white">Project Dashboard</h2>
                    <p className="text-slate-400">Manage your protocol audit projects</p>
                </div>
                <div className="flex items-center gap-4">
                    <div className="relative">
                        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                        <input
                            type="text"
                            placeholder="Search projects..."
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                            className="bg-slate-900 border border-slate-700 rounded-lg pl-9 pr-4 py-2 text-sm text-white outline-none focus:border-blue-500 w-64 transition-colors"
                        />
                    </div>
                    <button
                        onClick={onCreate}
                        className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg flex items-center gap-2 transition-colors shadow-lg shadow-blue-900/20"
                    >
                        <Plus size={18} /> New Project
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar bg-slate-900 rounded-xl border border-slate-800">
                {/* Header Row - Adjusted widths */}
                <div className="flex items-center px-6 py-4 border-b border-slate-800 text-xs font-bold text-slate-500 uppercase bg-slate-900/50 sticky top-0 z-10 backdrop-blur-sm">
                    <div className="w-[5%] min-w-[50px] text-center">ID</div>
                    <div className="w-[20%] min-w-[180px]">Project Name</div>
                    <div className="w-[25%] min-w-[200px] px-4">Description</div>
                    <div className="w-[10%] text-center">Protocols</div>
                    <div className="w-[20%] px-4">Verification</div>
                    <div className="w-[10%] text-right">Last Updated</div>
                    <div className="w-[10%] min-w-[120px] text-right"></div>
                </div>

                {/* List Items */}
                <div className="divide-y divide-slate-800/50">
                    {filteredProjects.map((project, index) => {
                        const verifiedCount = project.protocols.filter(p => p.reviewStatus === 'VERIFIED').length;
                        const totalCount = project.protocols.length;
                        const progress = totalCount > 0 ? Math.round((verifiedCount / totalCount) * 100) : 0;

                        return (
                            <div
                                key={project.id}
                                onClick={() => onSelect(project)}
                                className="group flex items-center px-6 py-5 hover:bg-slate-800/50 transition-colors cursor-pointer"
                            >
                                {/* ID Column - Simple Number */}
                                <div className="w-[5%] min-w-[50px] text-center text-sm text-slate-500 font-mono">
                                    {index + 1}
                                </div>

                                {/* Name Column */}
                                <div className="w-[20%] min-w-[180px] flex items-center gap-4 pr-4">
                                    <div className="p-2.5 bg-blue-500/10 rounded-lg text-blue-400 group-hover:bg-blue-500 group-hover:text-white transition-colors shrink-0">
                                        <Package size={20} />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        {editingId === project.id ? (
                                            <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                                                <input
                                                    value={editName}
                                                    onChange={e => setEditName(e.target.value)}
                                                    className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-white text-sm outline-none focus:border-blue-500 w-full"
                                                    autoFocus
                                                    onKeyDown={e => {
                                                        if (e.key === 'Enter') saveEditing(e as any);
                                                        if (e.key === 'Escape') cancelEditing(e as any);
                                                    }}
                                                />
                                                <button onClick={saveEditing} className="p-1 text-emerald-400 hover:bg-emerald-500/20 rounded"><Check size={14} /></button>
                                                <button onClick={cancelEditing} className="p-1 text-red-400 hover:bg-red-500/20 rounded"><X size={14} /></button>
                                            </div>
                                        ) : (
                                            <div>
                                                <h3 className="text-sm font-bold text-white truncate">{project.name}</h3>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Description Column */}
                                <div className="w-[25%] min-w-[200px] px-4 text-sm text-slate-400 truncate">
                                    {project.description || '-'}
                                </div>

                                {/* Protocols Count */}
                                <div className="w-[10%] text-center text-sm text-slate-400">
                                    <span className="font-mono text-white font-medium">{totalCount}</span> Protocols
                                </div>

                                {/* Verification Progress - Shorter Bar */}
                                <div className="w-[20%] px-4">
                                    <div className="flex justify-between text-xs font-medium text-slate-400 mb-1.5 max-w-[150px]">
                                        <span>Verified</span>
                                        <span className={progress === 100 ? 'text-emerald-400' : 'text-blue-400'}>{progress}%</span>
                                    </div>
                                    <div className="h-2 bg-slate-800 rounded-full overflow-hidden max-w-[150px]">
                                        <div
                                            className={`h-full transition-all duration-500 ${progress === 100 ? 'bg-emerald-500' : 'bg-blue-500'}`}
                                            style={{ width: `${progress}%` }}
                                        />
                                    </div>
                                </div>

                                {/* Last Updated */}
                                <div className="w-[10%] text-right text-sm text-slate-400 font-mono">
                                    {new Date(project.updatedAt).toLocaleDateString()}
                                </div>

                                {/* Actions */}
                                <div className="w-[10%] min-w-[120px] flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity pl-4">
                                    <button
                                        onClick={(e) => startEditing(project, e)}
                                        className="p-2 text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition-colors"
                                        title="Rename"
                                    >
                                        <Edit3 size={16} />
                                    </button>
                                    <button
                                        onClick={(e) => handleDuplicateClick(project, e)}
                                        className="p-2 text-slate-400 hover:text-blue-400 hover:bg-blue-500/10 rounded-lg transition-colors"
                                        title="Duplicate"
                                    >
                                        <Copy size={16} />
                                    </button>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(project.id); }}
                                        className="p-2 text-slate-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                                        title="Delete"
                                    >
                                        <Trash2 size={16} />
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                    {projects.length === 0 && (
                        <div className="p-12 text-center text-slate-500">
                            <div className="inline-block p-4 bg-slate-800/50 rounded-full mb-4">
                                <Package size={32} className="opacity-50" />
                            </div>
                            <p>No projects found. Create one to get started.</p>
                        </div>
                    )}
                </div>
            </div>

            {/* Duplicate Modal */}
            {duplicateSource && (
                <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setDuplicateSource(null)}>
                    <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-[450px] shadow-2xl" onClick={e => e.stopPropagation()}>
                        <h3 className="text-lg font-bold text-white mb-4">Duplicate Project</h3>
                        <div className="space-y-4">
                            <div>
                                <label className="text-sm text-slate-400 block mb-2">New Project Name *</label>
                                <input
                                    type="text"
                                    value={duplicateData.name}
                                    onChange={(e) => setDuplicateData(prev => ({ ...prev, name: e.target.value }))}
                                    className="w-full bg-slate-800 text-white px-4 py-2 rounded-lg border border-slate-700 focus:border-blue-500 outline-none"
                                    autoFocus
                                />
                            </div>
                            <div>
                                <label className="text-sm text-slate-400 block mb-2">Description</label>
                                <textarea
                                    value={duplicateData.description}
                                    onChange={(e) => setDuplicateData(prev => ({ ...prev, description: e.target.value }))}
                                    className="w-full bg-slate-800 text-white px-4 py-2 rounded-lg border border-slate-700 focus:border-blue-500 outline-none h-24 resize-none"
                                />
                            </div>
                            <p className="text-xs text-slate-500 italic">
                                * All {duplicateSource.protocols.length} protocols will be copied to the new project.
                            </p>
                        </div>
                        <div className="flex justify-end gap-3 mt-6">
                            <button
                                onClick={() => setDuplicateSource(null)}
                                className="px-4 py-2 text-slate-400 hover:text-white font-bold transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={confirmDuplicate}
                                className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-bold transition-colors"
                            >
                                Duplicate
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Delete Confirmation Modal */}
            {deleteConfirmId && (
                <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setDeleteConfirmId(null)}>
                    <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-[400px] shadow-2xl" onClick={e => e.stopPropagation()}>
                        <h3 className="text-lg font-bold text-white mb-2">Delete Project?</h3>
                        <p className="text-slate-400 text-sm mb-6">
                            Are you sure you want to delete <span className="text-white font-bold">{projects.find(p => p.id === deleteConfirmId)?.name}</span>? This action cannot be undone.
                        </p>
                        <div className="flex justify-end gap-3">
                            <button
                                onClick={() => setDeleteConfirmId(null)}
                                className="px-4 py-2 text-slate-400 hover:text-white font-bold transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={() => {
                                    if (deleteConfirmId) {
                                        onDelete(deleteConfirmId);
                                        setDeleteConfirmId(null);
                                    }
                                }}
                                className="px-6 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg font-bold transition-colors"
                            >
                                Delete
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

const SortProtocolsModal: React.FC<{
    protocols: ProtocolDefinition[];
    onClose: () => void;
    onSave: (newOrderIds: string[]) => void;
}> = ({ protocols, onClose, onSave }) => {
    const [order, setOrder] = useState<ProtocolDefinition[]>(protocols);
    const [draggedIdx, setDraggedIdx] = useState<number | null>(null);

    const handleDragStart = (e: React.DragEvent, idx: number) => {
        setDraggedIdx(idx);
        e.dataTransfer.effectAllowed = 'move';
        // Need to set data to make drag work in some browsers
        e.dataTransfer.setData('text/html', e.currentTarget.parentNode as unknown as string);
    };

    const handleDragOver = (e: React.DragEvent, idx: number) => {
        e.preventDefault();
        if (draggedIdx === null || draggedIdx === idx) return;

        const newOrder = [...order];
        const draggedItem = newOrder[draggedIdx];
        newOrder.splice(draggedIdx, 1);
        newOrder.splice(idx, 0, draggedItem);

        setDraggedIdx(idx);
        setOrder(newOrder);
    };

    return (
        <div className="fixed inset-0 bg-black/60 z-[150] flex items-center justify-center p-4 backdrop-blur-sm">
            <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-[400px] flex flex-col max-h-[80vh]">
                <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-800/50 rounded-t-xl">
                    <h3 className="text-sm font-bold text-white flex items-center gap-2">
                        <ListOrdered size={16} className="text-indigo-400" />
                        拖拽调整执行顺序
                    </h3>
                    <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
                        <X size={18} />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar">
                    {order.map((p, idx) => (
                        <div
                            key={p.id}
                            draggable
                            onDragStart={(e) => handleDragStart(e, idx)}
                            onDragOver={(e) => handleDragOver(e, idx)}
                            onDragEnd={() => setDraggedIdx(null)}
                            className={`flex items-center gap-3 p-3 rounded-lg border ${draggedIdx === idx ? 'bg-indigo-900 border-indigo-500 opacity-50' : 'bg-slate-800 border-slate-700'} hover:border-slate-500 cursor-grab active:cursor-grabbing transition-colors`}
                        >
                            <GripVertical size={16} className="text-slate-500 shrink-0" />
                            <span className="text-sm text-slate-300 font-mono truncate">{p.namespace}</span>
                        </div>
                    ))}
                </div>

                <div className="p-4 border-t border-slate-800 flex justify-end gap-3 bg-slate-900 rounded-b-xl">
                    <button onClick={onClose} className="px-4 py-2 hover:bg-slate-800 text-slate-300 rounded-lg text-sm font-medium transition-colors">
                        取消
                    </button>
                    <button onClick={() => onSave(order.map(o => o.id))} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors shadow-lg shadow-indigo-900/20">
                        确定并应用
                    </button>
                </div>
            </div>
        </div>
    );
};

const TestPlanPanel: React.FC<{
    suites: ProtocolTestSuite[];
    selectedSuiteId: string | null;
    selectedProtocolId: string | null;
    onSelectSuite: (id: string) => void;
    onSelectProtocol: (protocol: ProtocolDefinition) => void;
    searchTerm: string;
    onSearchChange: (term: string) => void;
    expandedSuites: Set<string>;
    toggleSuiteExpand: (id: string) => void;
    selectedProtocols: Set<string>;
    onToggleProtocolSelection: (id: string, selected: boolean) => void;
    onToggleSuiteSelection: (suite: ProtocolTestSuite, selected: boolean) => void;
    onToggleFilteredProtocols: (ids: string[], selected: boolean) => void;
    verificationErrorSuiteId: string | null;
    getProtocolStatus: (p: ProtocolDefinition) => any;
    STATUS_CONFIG: any;
    onQuickRun: (p: ProtocolDefinition) => void;
    runningTest: string | null;
    onAddSuite: () => void;
    onImportSuite: (e: any) => void;
    onAutoGen: () => void;
    mqttConnected: boolean;
    targetDevice: any;
    devices: any[];
    targetDeviceId: string;
    setTargetDeviceId: (id: string) => void;
    onShowStats: () => void;
    onEditSuite: (s: ProtocolTestSuite) => void;
    onExportSuite: (s: ProtocolTestSuite) => void;
    onDeleteSuite: (id: string) => void;
    onDeleteProtocol: (id: string) => void;
    onMoveProtocol: (id: string, direction: 'up' | 'down') => void;
    onReorderProtocols: (newOrderIds: string[]) => void;
}> = ({
    suites, selectedSuiteId, selectedProtocolId, onSelectSuite, onSelectProtocol,
    searchTerm, onSearchChange, expandedSuites, toggleSuiteExpand,
    selectedProtocols, onToggleProtocolSelection, onToggleSuiteSelection,
    onToggleFilteredProtocols, verificationErrorSuiteId, getProtocolStatus, STATUS_CONFIG, onQuickRun, runningTest,
    onAddSuite, onImportSuite, onAutoGen, mqttConnected, targetDevice, devices, targetDeviceId, setTargetDeviceId,
    onShowStats, onEditSuite, onExportSuite, onDeleteSuite, onDeleteProtocol, onMoveProtocol, onReorderProtocols
}) => {
        const [showSortModal, setShowSortModal] = useState(false);

        return (
            <div className="w-80 bg-slate-900 border-r border-slate-800 flex flex-col shrink-0 overflow-hidden h-full">
                {/* Toolbar */}
                <div className="p-3 border-b border-slate-800 flex gap-2">
                    <div className="flex-1 relative">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                        <input value={searchTerm} onChange={e => onSearchChange(e.target.value)} placeholder="搜索协议..." className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-9 pr-3 py-2 text-xs text-slate-300 outline-none focus:border-indigo-500 transition-colors" />
                        {searchTerm && <button onClick={() => onSearchChange('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"><XCircle size={12} /></button>}
                    </div>
                    <button onClick={onAutoGen} disabled={!mqttConnected || !targetDevice} className="px-3 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed transition-all" title="从设备自动生成协议">
                        <Wand2 size={14} /> 自动生成
                    </button>
                </div>

                {/* Device Selector - 移到更合理的位置 */}
                <div className="px-3 py-2 border-b border-slate-800">
                    <label className="text-[10px] font-bold text-slate-500 uppercase mb-1 block">目标设备</label>
                    <select value={targetDeviceId} onChange={(e) => setTargetDeviceId(e.target.value)} className="w-full bg-slate-800 text-white text-sm rounded-lg px-3 py-2 outline-none border border-slate-700 focus:border-indigo-500">
                        <option value="">选择设备...</option>
                        {devices.map(d => <option key={d.id} value={d.id}>{d.name} ({d.ip})</option>)}
                    </select>
                </div>

                {/* Flat Protocol List */}
                <div className="flex-1 flex flex-col min-h-0">
                    {(() => {
                        // Flatten protocols from the selected suite (or first suite)
                        const activeSuite = suites.find(s => s.id === selectedSuiteId) || suites[0];
                        if (!activeSuite) return <div className="text-center text-slate-500 py-8 text-xs">No protocols found</div>;

                        const displayProtocols = activeSuite.protocols.filter(p => !searchTerm || p.namespace.toLowerCase().includes(searchTerm.toLowerCase()) || p.name.toLowerCase().includes(searchTerm.toLowerCase()));

                        const allSelected = displayProtocols.length > 0 && displayProtocols.every(p => selectedProtocols.has(p.id));
                        const someSelected = displayProtocols.some(p => selectedProtocols.has(p.id));

                        return (
                            <>
                                {/* 批量操作区 */}
                                <div className="px-5 py-2 flex items-center justify-between bg-slate-800/50 border-y border-slate-800 shrink-0">
                                    <label className="flex items-center gap-2 cursor-pointer group w-full">
                                        <input
                                            type="checkbox"
                                            checked={allSelected}
                                            ref={input => { if (input) input.indeterminate = someSelected && !allSelected; }}
                                            onChange={(e) => onToggleFilteredProtocols(displayProtocols.map(p => p.id), e.target.checked)}
                                            className="w-4 h-4 rounded border-slate-600 bg-slate-800 accent-emerald-500 cursor-pointer"
                                        />
                                        <span className="text-[11px] font-bold text-slate-400 group-hover:text-slate-300">
                                            全选 / 取消全选 <span className="text-slate-500 font-normal">({displayProtocols.length})</span>
                                        </span>
                                    </label>
                                    <button onClick={() => setShowSortModal(true)} className="p-1 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors" title="列表顺序调整">
                                        <ListOrdered size={14} />
                                    </button>
                                </div>

                                <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
                                    {displayProtocols.map((protocol, idx) => {
                                        const isProtoSelected = selectedProtocolId === protocol.id;

                                        // 基于 reviewStatus 直接决定图标和颜色
                                        const isVerified = protocol.reviewStatus === 'VERIFIED';
                                        const StatusIcon = isVerified ? CheckCircle2 : AlertTriangle;
                                        const statusColor = isVerified ? 'text-emerald-500' : 'text-amber-500';
                                        const statusTitle = isVerified ? '已审核' : '未审核';

                                        return (
                                            <div key={protocol.id} className={`group/proto flex items-center gap-2 pl-2 pr-1 py-2.5 rounded-lg cursor-pointer transition-all ${isProtoSelected ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-900/20' : `text-slate-400 hover:bg-slate-800 hover:text-slate-200`}`}
                                                onClick={(e) => { e.stopPropagation(); onSelectProtocol(protocol); }}>

                                                <div onClick={e => e.stopPropagation()} className="flex items-center shrink-0">
                                                    <input type="checkbox" checked={selectedProtocols.has(protocol.id)} onChange={(e) => onToggleProtocolSelection(protocol.id, e.target.checked)}
                                                        className={`w-4 h-4 rounded border-slate-600 bg-slate-800 accent-emerald-500 cursor-pointer ${isProtoSelected ? 'border-white/50' : ''}`} />
                                                </div>

                                                <span className="flex-1 text-sm font-medium truncate font-mono min-w-0" title={protocol.namespace}>{protocol.namespace}</span>

                                                {/* Delete Button - Visible on Hover */}
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        onDeleteProtocol(protocol.id);
                                                    }}
                                                    className={`p-1 rounded-md opacity-0 group-hover/proto:opacity-100 transition-opacity shrink-0 ${isProtoSelected ? 'hover:bg-indigo-500 text-indigo-200 hover:text-white' : 'hover:bg-slate-700 text-slate-500 hover:text-red-400'}`}
                                                    title="删除协议"
                                                >
                                                    <Trash2 size={14} />
                                                </button>

                                                {/* Status Icon (Right aligned) - 基于审核状态 */}
                                                <div title={statusTitle} className="shrink-0">
                                                    <StatusIcon size={16} className={`${isProtoSelected ? 'text-white/80' : statusColor}`} />
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>

                                {/* 排列弹窗 */}
                                {showSortModal && (
                                    <SortProtocolsModal
                                        protocols={displayProtocols}
                                        onClose={() => setShowSortModal(false)}
                                        onSave={(newOrder) => {
                                            onReorderProtocols(newOrder);
                                            setShowSortModal(false);
                                        }}
                                    />
                                )}
                            </>
                        );
                    })()}
                </div>
                <div className="p-2 border-t border-slate-800">
                    <button onClick={onShowStats} className="w-full py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg text-xs font-bold flex items-center justify-center gap-2 transition-colors">
                        <BarChart3 size={14} /> Statistics Report
                    </button>
                </div>
            </div>
        );
    };

const InspectionPanel: React.FC<{
    logs: DetailedTestLog[];
    onClearLogs: () => void;
    autoScroll: boolean;
    setAutoScroll: (enabled: boolean) => void;
    logFilter: 'all' | 'TX' | 'RX' | 'ERROR' | 'INFO';

    setLogFilter: (filter: any) => void;
    headerActions?: React.ReactNode;
}> = ({ logs, onClearLogs, autoScroll, setAutoScroll, logFilter, setLogFilter, headerActions }) => {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [selectedLogId, setSelectedLogId] = useState<string | null>(null);

    // Auto-scroll and Auto-select latest log
    useEffect(() => {
        if (autoScroll && logs.length > 0) {
            if (scrollRef.current) {
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            }
            // Auto-select the latest log to keep the JSON viewer alive
            setSelectedLogId(logs[logs.length - 1].id);
        }
    }, [logs, autoScroll]);

    const filteredLogs = logs.filter(l => logFilter === 'all' || l.type === logFilter);
    const selectedLog = logs.find(l => l.id === selectedLogId) || (logs.length > 0 ? logs[logs.length - 1] : null);

    return (
        <div className="w-96 bg-slate-900 border-l border-slate-800 flex flex-col shrink-0 h-full">
            {/* Top Pane: JSON Inspector */}
            <div className="h-1/2 flex flex-col border-b border-slate-800 bg-slate-950">
                <div className="p-2 border-b border-slate-800 flex justify-between items-center bg-slate-900 h-10">
                    <div className="font-bold text-slate-300 flex items-center gap-2 text-sm"><FileJson size={16} /> JSON Inspector</div>
                    <div className="flex items-center gap-2">
                        {headerActions}
                        {selectedLog && (
                            <span className="text-xs font-mono text-slate-500 border-l border-slate-700 pl-2 ml-2">{selectedLog.timeStr}</span>
                        )}
                    </div>
                </div>
                <div className="flex-1 overflow-hidden relative">
                    {selectedLog ? (
                        <div className="absolute inset-0 overflow-auto custom-scrollbar p-3">
                            {selectedLog.details?.responsePayload ? (
                                <div>
                                    <div className="text-xs font-bold text-emerald-400 mb-2">Response Payload</div>
                                    <pre className="font-mono text-xs text-emerald-300 whitespace-pre-wrap break-all">
                                        {JSON.stringify(selectedLog.details.responsePayload, null, 2)}
                                    </pre>
                                </div>
                            ) : selectedLog.details?.requestPayload ? (
                                <div>
                                    <div className="text-xs font-bold text-blue-400 mb-2">Request Payload</div>
                                    <pre className="font-mono text-xs text-blue-300 whitespace-pre-wrap break-all">
                                        {JSON.stringify(selectedLog.details.requestPayload, null, 2)}
                                    </pre>
                                </div>
                            ) : (
                                <div className="text-slate-500 text-xs font-mono whitespace-pre-wrap">{selectedLog.message}</div>
                            )}
                        </div>
                    ) : (
                        <div className="flex items-center justify-center h-full text-slate-600 text-xs">
                            Select a log entry to view details
                        </div>
                    )}
                </div>
            </div>

            {/* Bottom Pane: Traffic Log */}
            <div className="h-1/2 flex flex-col bg-slate-900">
                <div className="p-2 border-b border-slate-800 flex justify-between items-center bg-slate-900">
                    <div className="font-bold text-slate-300 flex items-center gap-2 text-sm"><Activity size={14} /> Traffic Log</div>
                    <div className="flex gap-2">
                        <button onClick={() => setAutoScroll(!autoScroll)} className={`p-1 rounded ${autoScroll ? 'bg-indigo-500/20 text-indigo-400' : 'text-slate-500 hover:text-slate-300'}`} title="Auto Scroll"><ArrowDownCircle size={14} /></button>
                        <button onClick={onClearLogs} className="p-1 text-slate-500 hover:text-red-400 rounded" title="Clear Logs"><Trash2 size={14} /></button>
                    </div>
                </div>
                {/* Filter Bar */}
                <div className="px-2 py-1 border-b border-slate-800 flex gap-1 bg-slate-900 overflow-x-auto">
                    {(['all', 'TX', 'RX', 'ERROR'] as const).map(f => (
                        <button key={f} onClick={() => setLogFilter(f)} className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${logFilter === f ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-500 hover:bg-slate-700'}`}>{f}</button>
                    ))}
                </div>
                {/* Log List */}
                <div ref={scrollRef} className="flex-1 overflow-y-auto custom-scrollbar bg-slate-950">
                    {filteredLogs.map(log => (
                        <LogItem
                            key={log.id}
                            log={log}
                            selected={selectedLogId === log.id}
                            onSelect={() => {
                                setSelectedLogId(log.id);
                                setAutoScroll(false);
                            }}
                        />
                    ))}
                    {filteredLogs.length === 0 && <div className="text-center text-slate-600 py-8 text-xs">No logs captured</div>}
                </div>
            </div>
        </div>
    );
};

const WorkbenchPanel: React.FC<{
    children: React.ReactNode;
}> = ({ children }) => {
    return (
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-slate-950 relative">
            {children}
        </div>
    );
};


// --- Enhanced Tree Components ---

interface SchemaNode {
    id: string;
    key: string;
    type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null' | 'any' | 'int';
    value: any;
    required?: boolean;
    children?: SchemaNode[];
    parentType?: 'object' | 'array';
}

const getTypeColor = (type: string) => {
    switch (type) {
        case 'string': return 'text-emerald-400';
        case 'number': return 'text-blue-400';
        case 'boolean': return 'text-purple-400';
        case 'object': return 'text-amber-400';
        case 'array': return 'text-orange-400';
        case 'int': return 'text-blue-400';
        default: return 'text-slate-400';
    }
};

const SchemaTreeItem: React.FC<{
    node: SchemaNode;
    level: number;
    isLast: boolean;
    mode: 'payload' | 'schema';
    onUpdate: (id: string, updates: Partial<SchemaNode>) => void;
    onDelete: (id: string) => void;
    onAddChild: (id: string, type: SchemaNode['type']) => void;
}> = ({ node, level, isLast, mode, onUpdate, onDelete, onAddChild }) => {
    const [expanded, setExpanded] = useState(true);
    const [isHovered, setIsHovered] = useState(false);

    const handleValueChange = (val: string) => {
        let newValue: any = val;
        if (node.type === 'number') newValue = Number(val);
        if (node.type === 'int') newValue = parseInt(val, 10);
        if (node.type === 'boolean') newValue = val === 'true';
        onUpdate(node.id, { value: newValue });
    };

    return (
        <div className="font-mono text-sm select-none">
            <div
                className={`flex items-center gap-2 py-1 px-2 hover:bg-slate-800/50 rounded group relative ${isHovered ? 'bg-slate-800/50' : ''}`}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
                style={{ paddingLeft: `${level * 16 + 8}px` }}
            >
                {/* Indent Guides */}
                {level > 0 && <div className="absolute left-0 top-0 bottom-0 border-l border-slate-800" style={{ left: `${level * 16}px` }} />}

                {/* Expand/Collapse */}
                {(node.type === 'object' || node.type === 'array') ? (
                    <button onClick={() => setExpanded(!expanded)} className="p-0.5 hover:text-white text-slate-500 transition-colors">
                        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                ) : <div className="w-3.5" />}

                {/* Key (Editable if parent is object) */}
                {node.parentType !== 'array' ? (
                    <div className="flex items-center gap-1">
                        <input
                            value={node.key}
                            onChange={e => onUpdate(node.id, { key: e.target.value })}
                            className="bg-transparent text-indigo-300 outline-none w-auto min-w-[20px] max-w-[120px] border-b border-transparent focus:border-indigo-500 hover:border-slate-700 transition-colors"
                            placeholder="key"
                        />
                        <span className="text-slate-500">:</span>
                    </div>
                ) : (
                    <span className="text-slate-500 mr-1">-</span>
                )}

                {/* Value / Type Editor */}
                <div className="flex items-center gap-2 flex-1">
                    {/* Required Checkbox (Schema Mode) - Always Visible */}
                    {mode === 'schema' && node.parentType !== 'array' && (
                        <div className="flex items-center" title="Mark as Required">
                            <input
                                type="checkbox"
                                checked={node.required}
                                onChange={e => onUpdate(node.id, { required: e.target.checked })}
                                className="w-4 h-4 rounded border-slate-600 bg-slate-800 accent-red-500 cursor-pointer"
                            />
                        </div>
                    )}


                    <div className="relative group/type">
                        <select
                            value={node.type}
                            onChange={e => {
                                const newType = e.target.value as any;
                                let newValue = node.value;
                                if (newType === 'object') newValue = {};
                                if (newType === 'array') newValue = [];
                                if (newType === 'boolean') newValue = false;
                                if (newType === 'number' || newType === 'int') newValue = 0;
                                if (newType === 'string') newValue = '';
                                onUpdate(node.id, { type: newType, value: newValue });
                            }}
                            className={`bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-sm focus:outline-none focus:border-indigo-500 cursor-pointer appearance-none ${getTypeColor(node.type)}`}
                            style={{ paddingRight: '1.5em' }} // Space for arrow if needed, or just keep it simple
                        >
                            <option value="string" className="text-emerald-400 bg-slate-900">string</option>

                            <option value="boolean" className="text-amber-400 bg-slate-900">boolean</option>
                            <option value="object" className="text-purple-400 bg-slate-900">object</option>
                            <option value="array" className="text-cyan-400 bg-slate-900">array</option>
                            <option value="int" className="text-blue-400 bg-slate-900">int</option>
                        </select>
                    </div>

                    {/* Value Input (for primitives) */}
                    {node.type !== 'object' && node.type !== 'array' && node.type !== 'null' && (
                        <div className="flex-1 min-w-[100px]">
                            {node.type === 'boolean' ? (
                                <select
                                    value={String(node.value)}
                                    onChange={e => handleValueChange(e.target.value)}
                                    className="bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-emerald-400 outline-none"
                                >
                                    <option value="true">true</option>
                                    <option value="false">false</option>
                                </select>
                            ) : (
                                <input
                                    value={String(node.value)}
                                    onChange={e => handleValueChange(e.target.value)}
                                    className="w-full bg-transparent text-emerald-400 outline-none border-b border-transparent focus:border-emerald-500 hover:border-slate-700 transition-colors"
                                    placeholder="value"
                                />
                            )}
                        </div>
                    )}



                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity ml-2">
                    {(node.type === 'object' || node.type === 'array') && (
                        <button onClick={() => onAddChild(node.id, 'string')} className="p-1 text-slate-500 hover:text-emerald-400 rounded hover:bg-slate-700" title="Add Child">
                            <Plus size={12} />
                        </button>
                    )}
                    <button onClick={() => onDelete(node.id)} className="p-1 text-slate-500 hover:text-red-400 rounded hover:bg-slate-700" title="Delete">
                        <Trash2 size={12} />
                    </button>
                </div>
            </div>

            {/* Children */}
            {expanded && node.children && (
                <div>
                    {node.children.map((child, idx) => (
                        <SchemaTreeItem
                            key={child.id}
                            node={child}
                            level={level + 1}
                            isLast={idx === node.children!.length - 1}
                            mode={mode}
                            onUpdate={onUpdate}
                            onDelete={onDelete}
                            onAddChild={onAddChild}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};

const PayloadEditor: React.FC<{
    value: string;
    onChange: (val: string) => void;
    mode: 'payload' | 'schema';
    protocol?: ProtocolDefinition;
    method?: string;
    session?: CloudSession;
}> = ({ value, onChange, mode, protocol, method, session }) => {
    const [view, setView] = useState<'tree' | 'json'>('tree');
    const [nodes, setNodes] = useState<SchemaNode[]>([]);
    const [parseError, setParseError] = useState<string | null>(null);
    const [jsonContent, setJsonContent] = useState('');
    const isInternalChange = useRef(false);

    // --- JSON <-> Nodes Converters (Payload Mode) ---

    const jsonToNodes = (data: any, parentType: 'object' | 'array' = 'object'): SchemaNode[] => {
        if (typeof data !== 'object' || data === null) return [];
        return Object.entries(data).map(([key, val]) => {
            const id = Math.random().toString(36).substr(2, 9);
            const type = Array.isArray(val) ? 'array' : val === null ? 'null' : typeof val;
            return {
                id,
                key,
                type: type as any,
                value: (type === 'object' || type === 'array') ? null : val,
                required: true,
                parentType,
                children: (type === 'object' || type === 'array') ? jsonToNodes(val, type as any) : undefined
            };
        });
    };

    const nodesToJson = (nodes: SchemaNode[], parentType: 'object' | 'array'): any => {
        if (parentType === 'array') {
            return nodes.map(node => {
                if (node.type === 'object' || node.type === 'array') {
                    return nodesToJson(node.children || [], node.type);
                }
                return node.value;
            });
        } else {
            const obj: any = {};
            nodes.forEach(node => {
                if (node.type === 'object' || node.type === 'array') {
                    obj[node.key] = nodesToJson(node.children || [], node.type);
                } else {
                    obj[node.key] = node.value;
                }
            });
            return obj;
        }
    };

    // --- Schema <-> Nodes Converters (Schema Mode) ---

    const schemaToNodes = (schema: any): SchemaNode[] => {
        if (!schema || typeof schema !== 'object') return [];
        // Handle Object Schema
        if (schema.properties) {
            return Object.entries(schema.properties).map(([key, propSchema]: [string, any]) => {
                const id = Math.random().toString(36).substr(2, 9);
                const node: SchemaNode = {
                    id,
                    key,
                    type: (propSchema.type === 'integer' || propSchema.type === 'number') ? 'int' : (propSchema.type || 'string'),
                    value: propSchema.default ?? (propSchema.examples?.[0] ?? null),
                    required: schema.required?.includes(key) ?? false,
                    parentType: 'object',
                    children: []
                };

                if (propSchema.type === 'object') {
                    node.children = schemaToNodes(propSchema);
                } else if (propSchema.type === 'array' && propSchema.items) {
                    node.children = [singleSchemaToNode(propSchema.items, 'items', 'array')];
                }
                return node;
            });
        }
        return [];
    };

    const singleSchemaToNode = (schema: any, key: string, parentType: 'object' | 'array'): SchemaNode => {
        const id = Math.random().toString(36).substr(2, 9);
        const node: SchemaNode = {
            id,
            key,
            type: (schema.type === 'integer' || schema.type === 'number') ? 'int' : (schema.type || 'string'),
            value: schema.default ?? null,
            required: true,
            parentType,
            children: []
        };

        if (schema.type === 'object') {
            node.children = schemaToNodes(schema);
        } else if (schema.type === 'array' && schema.items) {
            node.children = [singleSchemaToNode(schema.items, 'items', 'array')];
        }
        return node;
    };

    const nodesToSchema = (nodes: SchemaNode[]): any => {
        const properties: any = {};
        const required: string[] = [];

        nodes.forEach(node => {
            let schema: any = { type: node.type === 'int' ? 'integer' : node.type };

            if (node.type === 'object') {
                Object.assign(schema, nodesToSchema(node.children || []));
            } else if (node.type === 'array') {
                if (node.children && node.children.length > 0) {
                    schema.items = singleNodeToSchema(node.children[0]);
                } else {
                    schema.items = { type: 'string' };
                }
            }

            properties[node.key] = schema;
            if (node.required) required.push(node.key);
        });

        const result: any = { type: 'object', properties };
        if (required.length > 0) result.required = required;
        return result;
    };

    const singleNodeToSchema = (node: SchemaNode): any => {
        let schema: any = { type: node.type === 'int' ? 'integer' : node.type };
        if (node.type === 'object') {
            Object.assign(schema, nodesToSchema(node.children || []));
        } else if (node.type === 'array') {
            if (node.children && node.children.length > 0) {
                schema.items = singleNodeToSchema(node.children[0]);
            } else {
                schema.items = { type: 'string' };
            }
        }
        return schema;
    };


    // Helper: Construct Full Message
    const getWrappedMessage = (payloadVal: any) => {
        if (mode === 'schema') return payloadVal; // Schema mode shows raw schema
        const header = {
            messageId: 'preview-uuid-1234',
            namespace: protocol?.namespace || 'Appliance.System.All',
            method: method || 'GET',
            payloadVersion: 1,
            from: `/app/${session?.uid || '0'}-preview/subscribe`,
            timestamp: Math.floor(Date.now() / 1000),
            sign: 'preview-signature-md5'
        };
        return { header, payload: payloadVal };
    };

    // Helper: Extract Payload from Full Message
    const extractPayload = (fullMsg: any) => {
        if (mode === 'schema') return fullMsg;
        return fullMsg.payload !== undefined ? fullMsg.payload : fullMsg;
    };

    // Initialize Nodes from Value & Sync JSON Content
    useEffect(() => {
        if (isInternalChange.current) {
            isInternalChange.current = false;
            return;
        }
        try {
            const parsed = JSON.parse(value || '{}');

            if (mode === 'schema') {
                setNodes(schemaToNodes(parsed));
            } else {
                setNodes(jsonToNodes(parsed));
            }

            setParseError(null);

            // Sync JSON content for JSON view
            const wrapped = getWrappedMessage(parsed);
            setJsonContent(JSON.stringify(wrapped, null, 2));
        } catch (e) {
            setParseError('Invalid JSON');
            setJsonContent(value); // Fallback
        }
    }, [value, mode, protocol, method, session]);

    const handleJsonChange = (newJson: string) => {
        setJsonContent(newJson);
        try {
            const parsed = JSON.parse(newJson);
            const payload = extractPayload(parsed);
            isInternalChange.current = true;
            onChange(JSON.stringify(payload, null, 2));
            setParseError(null);
        } catch {
            setParseError('Invalid JSON');
        }
    };

    const handleViewSwitch = (newView: 'tree' | 'json') => {
        if (newView === 'json') {
            try {
                const parsed = JSON.parse(value || '{}');
                const wrapped = getWrappedMessage(parsed);
                setJsonContent(JSON.stringify(wrapped, null, 2));
            } catch {
                setJsonContent(value);
            }
        }
        setView(newView);
    };

    const handleTreeUpdate = (newNodes: SchemaNode[]) => {
        isInternalChange.current = true;
        setNodes(newNodes);

        let json;
        if (mode === 'schema') {
            json = nodesToSchema(newNodes);
        } else {
            json = nodesToJson(newNodes, 'object');
        }
        onChange(JSON.stringify(json, null, 2));
    };

    // Node Operations
    const updateNode = (id: string, updates: Partial<SchemaNode>) => {
        const updateRecursive = (currentNodes: SchemaNode[]): SchemaNode[] => {
            return currentNodes.map(node => {
                if (node.id === id) {
                    const updatedNode = { ...node, ...updates };
                    if (updates.required !== undefined && updatedNode.children) {
                        const setChildrenRequired = (children: SchemaNode[], isRequired: boolean): SchemaNode[] => {
                            return children.map(child => ({
                                ...child,
                                required: isRequired,
                                children: child.children ? setChildrenRequired(child.children, isRequired) : undefined
                            }));
                        };
                        updatedNode.children = setChildrenRequired(updatedNode.children, updates.required);
                    }
                    return updatedNode;
                }
                if (node.children) {
                    return { ...node, children: updateRecursive(node.children) };
                }
                return node;
            });
        };
        handleTreeUpdate(updateRecursive(nodes));
    };

    const deleteNode = (id: string) => {
        const deleteRecursive = (currentNodes: SchemaNode[]): SchemaNode[] => {
            return currentNodes.filter(node => node.id !== id).map(node => {
                if (node.children) {
                    return { ...node, children: deleteRecursive(node.children) };
                }
                return node;
            });
        };
        handleTreeUpdate(deleteRecursive(nodes));
    };

    const addChild = (parentId: string, type: SchemaNode['type']) => {
        const addRecursive = (currentNodes: SchemaNode[]): SchemaNode[] => {
            return currentNodes.map(node => {
                if (node.id === parentId) {
                    const newChild: SchemaNode = {
                        id: Math.random().toString(36).substr(2, 9),
                        key: node.type === 'array' ? '' : 'newField',
                        type: 'string',
                        value: '',
                        parentType: node.type as any,
                        required: false
                    };
                    return { ...node, children: [...(node.children || []), newChild] };
                }
                if (node.children) {
                    return { ...node, children: addRecursive(node.children) };
                }
                return node;
            });
        };
        handleTreeUpdate(addRecursive(nodes));
    };

    const addRootItem = () => {
        const newNode: SchemaNode = {
            id: Math.random().toString(36).substr(2, 9),
            key: 'newField',
            type: 'string',
            value: '',
            parentType: 'object',
            required: false
        };
        handleTreeUpdate([...nodes, newNode]);
    };

    return (
        <div className="flex flex-col h-full bg-slate-950">
            {/* Toolbar */}
            <div className="flex items-center justify-between px-2 py-1 bg-slate-900 border-b border-slate-800 shrink-0">
                <div className="flex bg-slate-800 rounded p-0.5">
                    <button
                        onClick={() => handleViewSwitch('tree')}
                        className={`px-3 py-1 text-xs font-bold rounded flex items-center gap-1 ${view === 'tree' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
                    >
                        <FolderOpen size={12} /> Tree
                    </button>
                    <button
                        onClick={() => handleViewSwitch('json')}
                        className={`px-3 py-1 text-xs font-bold rounded flex items-center gap-1 ${view === 'json' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
                    >
                        <FileJson size={12} /> JSON
                    </button>
                </div>
                {mode === 'payload' && view === 'json' && (
                    <span className="text-[10px] text-slate-500 font-mono flex items-center gap-1">
                        <Edit3 size={10} /> Full Message Mode
                    </span>
                )}
            </div>

            {/* Editor Area */}
            <div className="flex-1 overflow-hidden relative">
                {view === 'tree' ? (
                    <div className="absolute inset-0 overflow-auto custom-scrollbar p-2 space-y-1">
                        {nodes.length === 0 && (
                            <div className="text-center py-8 text-slate-600 text-xs">
                                Empty {mode}. <button onClick={addRootItem} className="text-indigo-400 hover:underline">Add Field</button>
                            </div>
                        )}
                        {nodes.map((node, idx) => (
                            <SchemaTreeItem
                                key={node.id}
                                node={node}
                                level={0}
                                isLast={idx === nodes.length - 1}
                                mode={mode}
                                onUpdate={updateNode}
                                onDelete={deleteNode}
                                onAddChild={addChild}
                            />
                        ))}
                        {nodes.length > 0 && (
                            <button onClick={addRootItem} className="mt-2 ml-2 text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1 opacity-50 hover:opacity-100 transition-opacity">
                                <Plus size={12} /> Add Field
                            </button>
                        )}
                    </div>
                ) : (
                    <textarea
                        value={jsonContent}
                        onChange={e => handleJsonChange(e.target.value)}
                        className="w-full h-full bg-slate-950 text-emerald-400 font-mono text-sm p-3 outline-none resize-none"
                        spellCheck={false}
                    />
                )}
            </div>
        </div>
    );
};

// Log Item Component (Compact Row)
const LogItem: React.FC<{ log: DetailedTestLog; selected: boolean; onSelect: () => void }> = ({ log, selected, onSelect }) => {
    return (
        <div
            className={`flex items-center gap-2 p-2 font-mono text-xs cursor-pointer border-b border-slate-800 last:border-0 transition-colors ${selected ? 'bg-indigo-900/30 border-indigo-500/30' : 'hover:bg-slate-800/50'}`}
            onClick={onSelect}
        >
            <div className="text-slate-500 shrink-0 select-none w-16 truncate">{log.timeStr.split(' ')[1] || log.timeStr}</div>
            <div className={`font-bold shrink-0 w-10 ${log.type === 'TX' ? 'text-blue-400' : log.type === 'RX' ? 'text-emerald-400' : log.type === 'ERROR' ? 'text-red-400' : 'text-slate-400'}`}>
                {log.type}
            </div>
            <div className="flex-1 truncate text-slate-300">
                {log.message}
            </div>
            {log.details?.status && (
                <div className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold ${log.details.status === 'PASS' ? 'bg-emerald-500/20 text-emerald-400' : log.details.status === 'FAIL' ? 'bg-red-500/20 text-red-400' : 'bg-amber-500/20 text-amber-400'}`}>
                    {log.details.status}
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
    const [viewMode, setViewMode] = useState<'DASHBOARD' | 'WORKSPACE'>('DASHBOARD');
    const [projects, setProjects] = useState<AuditProject[]>([]);
    const [activeProject, setActiveProject] = useState<AuditProject | null>(null);

    // Legacy state mapping (to be refactored)
    const [selectedProtocolId, setSelectedProtocolId] = useState<string | null>(null);
    const [isAddingSuite, setIsAddingSuite] = useState(false); // Reused for "Adding Project" modal
    const [editingSuiteId, setEditingSuiteId] = useState<string | null>(null);



    const [showNewProjectModal, setShowNewProjectModal] = useState(false);
    const [newProjectData, setNewProjectData] = useState({ name: '', description: '' });
    const [confirmDialog, setConfirmDialog] = useState<{ show: boolean; title: string; message: string; onConfirm: () => void }>({ show: false, title: '', message: '', onConfirm: () => { } });

    const handleCreateProject = () => {
        setNewProjectData({ name: '', description: '' });
        setShowNewProjectModal(true);
    };

    const confirmCreateProject = () => {
        if (!newProjectData.name.trim()) {
            showToast('warning', 'Project name is required');
            return;
        }

        const newProject: AuditProject = {
            id: `proj_${Date.now()}`,
            name: newProjectData.name,
            description: newProjectData.description,
            protocols: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            status: 'ACTIVE',
            progress: 0
        };
        setProjects([...projects, newProject]);

        // Explicitly save to DB immediately
        AuditDB.saveProjectToDB(newProject).then(success => {
            if (success) console.log('[ProtocolAudit] New project saved to DB:', newProject.id);
            else console.error('[ProtocolAudit] Failed to save new project to DB');
        });

        setShowNewProjectModal(false);
        showToast('success', 'Project created successfully');
    };

    const handleDeleteProject = (id: string) => {
        setProjects(prevProjects => prevProjects.filter(p => p.id !== id));
        // 同时清理该项目的测试历史
        setTestHistory(prev => prev.filter(h => h.suiteId !== id));

        // Explicitly delete from DB
        AuditDB.deleteProjectFromDB(id).then(success => {
            if (success) console.log('[ProtocolAudit] Project deleted from DB:', id);
            else console.error('[ProtocolAudit] Failed to delete project from DB');
        });

        if (activeProject?.id === id) {
            setActiveProject(null);
            setViewMode('DASHBOARD');
        }
    };

    const handleDeleteTestRun = (testRun: TestRun) => {
        setConfirmDialog({
            show: true,
            title: 'Confirm Delete',
            message: `Are you sure you want to delete test run from ${new Date(testRun.startTime).toLocaleString()}?`,
            onConfirm: () => {
                // Update local state
                setTestHistory(prev => prev.filter(h => h.id !== testRun.id));

                // Delete from DB
                AuditDB.deleteTestRunFromDB(testRun.id).then(success => {
                    if (success) showToast('success', 'Test run deleted');
                    else showToast('error', 'Failed to delete test run from database');
                });

                setConfirmDialog({ show: false, title: '', message: '', onConfirm: () => { } });
            }
        });
    };

    const handleSelectProject = (project: AuditProject) => {
        setActiveProject(project);
        setViewMode('WORKSPACE');
    };

    const handleRenameProject = (id: string, newName: string) => {
        setProjects(prev => prev.map(p => p.id === id ? { ...p, name: newName, updatedAt: Date.now() } : p));
        if (activeProject?.id === id) {
            setActiveProject(prev => prev ? { ...prev, name: newName, updatedAt: Date.now() } : null);
        }
    };

    const handleDuplicateProject = (sourceProject: AuditProject, newName: string, newDescription: string) => {
        const newProject: AuditProject = {
            ...sourceProject,
            id: `proj_${Date.now()}`,
            name: newName,
            description: newDescription,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            // Reset protocols status if needed, or keep as is. Here we keep them but maybe reset verification?
            // Let's keep them as is for a true duplicate, or reset to UNVERIFIED if desired.
            // User requirement: "default copy all protocols".
            protocols: sourceProject.protocols.map(p => ({
                ...p,
                id: Math.random().toString(36).substr(2, 9), // New IDs for protocols
                reviewStatus: 'UNVERIFIED' as const, // Reset status for safety
                lastRun: undefined
            }))
        };
        setProjects(prev => [...prev, newProject]);
        showToast('success', 'Project duplicated successfully');
    };

    const [suites, setSuites] = useState<ProtocolTestSuite[]>([DEFAULT_SUITE]);
    const [selectedSuiteId, setSelectedSuiteId] = useState<string | null>(DEFAULT_SUITE.id);
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
    const [viewingResult, setViewingResult] = useState<{ result?: DetailedTestResult, batchResult?: BatchTestResult, namespace?: string, method?: string, protocolId?: string } | null>(null);
    const [viewingFromBatch, setViewingFromBatch] = useState(false);

    const [batchTestResult, setBatchTestResult] = useState<BatchTestResult | null>(null);
    const [testHistory, setTestHistory] = useState<TestRun[]>([]);
    const [showStatsDashboard, setShowStatsDashboard] = useState(false);
    const [showProtocolGenerator, setShowProtocolGenerator] = useState(false);
    const [runningTest, setRunningTest] = useState<string | null>(null); // protocolId:method
    const [verificationErrorSuiteId, setVerificationErrorSuiteId] = useState<string | null>(null);
    const [unverifiedProtocolsModal, setUnverifiedProtocolsModal] = useState<{ show: boolean; protocols: ProtocolDefinition[] }>({ show: false, protocols: [] });
    const [confirmationModal, setConfirmationModal] = useState<{
        show: boolean;
        title: string;
        message: string;
        onConfirm: () => void;
    }>({ show: false, title: '', message: '', onConfirm: () => { } });

    // Toast message system (replaces alert)
    const [toastMessage, setToastMessage] = useState<{ show: boolean; type: 'error' | 'success' | 'warning' | 'info'; message: string }>({ show: false, type: 'info', message: '' });
    const showToast = useCallback((type: 'error' | 'success' | 'warning' | 'info', message: string) => {
        setToastMessage({ show: true, type, message });
        setTimeout(() => setToastMessage(prev => ({ ...prev, show: false })), 4000);
    }, []);

    // P1 Optimization: Test Progress Tracking
    const [testProgressMinimized, setTestProgressMinimized] = useState(false);
    const [testProgress, setTestProgress] = useState<{
        current: number; total: number; currentProtocol: string; startTime: number;
        stepCurrent?: number; stepTotal?: number; stepDescription?: string;
        stepType?: StepType; countdown?: number; waitingForUser?: boolean;
    } | null>(null);

    // 执行计划：手动操作暂停弹窗
    const [manualActionModal, setManualActionModal] = useState<{
        show: boolean;
        instruction: string;
        confirmText: string;
        protocolName: string;
        stepIndex: number;
        totalSteps: number;
        resolve?: () => void;
    } | null>(null);

    // 执行计划：手动输入弹窗
    const [manualInputModal, setManualInputModal] = useState<{
        show: boolean;
        fields: ManualField[];
        protocolName: string;
        targetMethod: string;
        stepIndex: number;
        totalSteps: number;
        resolve?: (values: Record<string, any>) => void;
    } | null>(null);

    // Audit Confirmation State
    const [auditConfirmation, setAuditConfirmation] = useState<{
        show: boolean;
        protocol: ProtocolDefinition | null;
        method: RequestMethod | null;
    }>({ show: false, protocol: null, method: null });

    // Verification Modal
    const [verificationModal, setVerificationModal] = useState<{
        show: boolean;
        protocol: ProtocolDefinition | null;
        mode: 'direct' | 'manual';
    }>({ show: false, protocol: null, mode: 'manual' });

    // Stop test control
    const stopTestRef = useRef(false);
    const isPausedRef = useRef(false);
    const [isPaused, setIsPaused] = useState(false);

    const checkPause = async () => {
        while (isPausedRef.current && !stopTestRef.current) {
            await new Promise(r => setTimeout(r, 500));
        }
    };

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
    const [jsonExtractMode, setJsonExtractMode] = useState<'payload' | 'schema' | 'schema_payload'>('payload');

    // Required Fields Selection
    const [showRequiredFieldsModal, setShowRequiredFieldsModal] = useState(false);
    const [generatedSchema, setGeneratedSchema] = useState<any>(null);
    const [selectedRequiredFields, setSelectedRequiredFields] = useState<Set<string>>(new Set());
    const [showSchemaPreview, setShowSchemaPreview] = useState(false);

    // Search
    const [searchTerm, setSearchTerm] = useState('');

    // Sync activeProject to legacy suites state for Phase 1 compatibility
    // Sync activeProject to suites (Initial load & External updates)
    useEffect(() => {
        if (activeProject) {
            setSuites(prev => {
                const existing = prev.find(s => s.id === activeProject.id);
                // If suite exists and protocols match, don't update (avoids loop)
                if (existing && JSON.stringify(existing.protocols) === JSON.stringify(activeProject.protocols)) {
                    return prev;
                }

                // If suite exists but protocols differ (external update), update it
                if (existing) {
                    return prev.map(s => s.id === activeProject.id ? {
                        ...s,
                        name: activeProject.name,
                        protocols: activeProject.protocols,
                        updatedAt: activeProject.updatedAt
                    } : s);
                }

                // New project loaded
                const legacySuite: ProtocolTestSuite = {
                    id: activeProject.id,
                    name: activeProject.name,
                    description: '',
                    protocols: activeProject.protocols,
                    createdAt: activeProject.createdAt,
                    updatedAt: activeProject.updatedAt,
                    executionConfig: DEFAULT_EXECUTION_CONFIG
                };
                return [legacySuite];
            });

            // Only set selected suite if it's a new project switch
            setSelectedSuiteId(prev => prev === activeProject.id ? prev : activeProject.id);
        }
    }, [activeProject]);

    // Phase P0 Bugfix: Clear selected protocols when switching suites
    useEffect(() => {
        setSelectedProtocols(new Set());
    }, [selectedSuiteId]);

    // Sync suites changes back to activeProject and projects (Auto-save)
    useEffect(() => {
        if (!activeProject || suites.length === 0) return;
        const currentSuite = suites.find(s => s.id === activeProject.id);
        if (!currentSuite) return;

        // Check if protocols changed compared to activeProject
        if (JSON.stringify(currentSuite.protocols) !== JSON.stringify(activeProject.protocols)) {
            console.log('[ProtocolAudit] Syncing suite changes to project DB...');
            const updatedProject = {
                ...activeProject,
                protocols: currentSuite.protocols,
                updatedAt: Date.now()
            };

            // Update projects (triggers DB save via its own useEffect)
            setProjects(prev => prev.map(p => p.id === updatedProject.id ? updatedProject : p));

            // Update activeProject (to keep sync, will trigger above useEffect but it will exit early)
            setActiveProject(updatedProject);
        }
    }, [suites]);


    // Phase 1 Optimization: Template Category Filter - REMOVED
    // const [templateCategory, setTemplateCategory] = useState<'all' | 'control' | 'system' | 'config' | 'ota' | 'sensor'>('all');

    // Import Protocol Modal
    const [showImportProtocolModal, setShowImportProtocolModal] = useState(false);
    const [importSourceSuiteId, setImportSourceSuiteId] = useState<string>('');
    const [importSelectedTags, setImportSelectedTags] = useState<Set<string>>(new Set());
    const [importSelectedProtocols, setImportSelectedProtocols] = useState<Set<string>>(new Set());

    // Phase 1 Optimization: Log Panel
    const [logPanelExpanded, setLogPanelExpanded] = useState(true);
    const [logFilter, setLogFilter] = useState<'all' | 'TX' | 'RX' | 'ERROR' | 'INFO'>('all');
    const logContainerRef = useRef<HTMLDivElement>(null);

    // Phase 2 Optimization: Auto Scroll & Tabs
    const [autoScroll, setAutoScroll] = useState(true);
    const [rightPanelTab, setRightPanelTab] = useState<'overview' | 'edit' | 'results' | 'review'>('overview');
    const [viewingRunId, setViewingRunId] = useState<string | null>(null);
    const [editingMethod, setEditingMethod] = useState<EditingTarget>('GET');

    // Copy Protocol
    const [showCopyProtocolModal, setShowCopyProtocolModal] = useState(false);
    const [copyTargetSuiteId, setCopyTargetSuiteId] = useState<string>('');

    // Unsaved Changes Detection
    const [originalProtocol, setOriginalProtocol] = useState<ProtocolDefinition | null>(null);
    const [showUnsavedChangesModal, setShowUnsavedChangesModal] = useState(false);
    const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null);

    // --- Effects for Data Loading & Saving ---

    // Load initial projects from storage (Local + DB)
    useEffect(() => {
        const init = async () => {
            // Check DB Connection first
            const dbStatus = await AuditDB.checkDatabaseConnection();
            if (!dbStatus.connected && dbStatus.enabled) {
                const errMsg = `Database Connection Failed: ${dbStatus.error || 'Unknown error'}`;
                console.error('[ProtocolAudit]', errMsg);
                showToast('error', errMsg);
            } else if (dbStatus.connected) {
                console.log('[ProtocolAudit] Database connected successfully');
            }

            // 执行旧数据迁移
            AuditStorage.migrateOldStorage();

            // 加载存储的项目 (Sync with DB)
            const savedProjects = await AuditDB.syncLoadProjects();
            if (savedProjects.length > 0) {
                setProjects(savedProjects);

                // 恢复上次活动的项目
                const activeId = AuditStorage.loadActiveProjectId();
                if (activeId) {
                    const activeProj = savedProjects.find(p => p.id === activeId);
                    if (activeProj) {
                        setActiveProject(activeProj);
                        setViewMode('WORKSPACE');
                    }
                }
            }

            // 加载测试历史
            const savedHistory = await AuditDB.syncLoadTestHistory();
            if (savedHistory.length > 0) {
                console.log('[ProtocolAudit] Loaded test history:', savedHistory.length);
                setTestHistory(savedHistory as TestRun[]);
            } else {
                console.log('[ProtocolAudit] No test history found in DB');
            }
        };
        init();

        // 加载目标设备ID
        const savedDeviceId = AuditStorage.loadTargetDeviceId();
        if (savedDeviceId) {
            setTargetDeviceId(savedDeviceId);
        }
    }, []);

    // Save projects whenever they change
    useEffect(() => {
        if (projects.length > 0) {
            AuditDB.syncSaveProjects(projects);
        }
    }, [projects]);

    // Save test history whenever it changes
    useEffect(() => {
        if (testHistory.length > 0) {
            AuditDB.syncSaveTestHistory(testHistory);
        }
    }, [testHistory]);

    // Check if protocol has unsaved changes
    // Check if protocol has unsaved changes
    const hasUnsavedChanges = useCallback(() => {
        if (!originalProtocol || !newProtocol.id) return false;

        // Create shallow copies to avoid mutating state during comparison
        // We want to ignore changes to 'reviewStatus' and 'verificationMode' 
        // as these are often updated independently of the protocol configuration (and auto-saved)
        const original = { ...originalProtocol };
        const current = { ...newProtocol };

        delete original.reviewStatus;
        delete current.reviewStatus;
        delete original.verificationMode;
        delete current.verificationMode;

        return JSON.stringify(original) !== JSON.stringify(current);
    }, [originalProtocol, newProtocol]);

    // Safe navigation with unsaved changes check
    const safeNavigate = useCallback((action: () => void) => {
        if (hasUnsavedChanges()) {
            setPendingNavigation(() => action);
            setShowUnsavedChangesModal(true);
        } else {
            action();
        }
    }, [hasUnsavedChanges]);

    const handleCopyProtocol = () => {
        if (!selectedSuiteId || !newProtocol || !copyTargetSuiteId) return;

        setSuites(prev => prev.map(s => {
            if (s.id === copyTargetSuiteId) {
                const copiedProtocol = {
                    ...newProtocol,
                    id: Math.random().toString(36).substr(2, 9),
                    namespace: `${newProtocol.namespace}_copy`,
                    name: `${newProtocol.name}_copy`,
                    reviewStatus: 'UNVERIFIED' as const,
                    lastRun: undefined
                };
                return {
                    ...s,
                    protocols: [...s.protocols, copiedProtocol],
                    updatedAt: Date.now()
                };
            }
            return s;
        }));

        // showToast('Protocol copied successfully', 'success');
        setShowCopyProtocolModal(false);
        setCopyTargetSuiteId('');
    };

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

    // ==================== Persistence: Save on Change ====================

    // Save projects when they change (local + remote sync)
    useEffect(() => {
        if (projects.length > 0) {
            // 保存到本地缓存
            AuditStorage.saveProjects(projects);

            // 异步同步到后端数据库（如果已启用）
            if (databaseConfig.enabled) {
                AuditDB.saveAllProjectsToDB(projects).catch(err => {
                    console.warn('[Audit] Database sync failed:', err);
                });
            }
        }
    }, [projects]);

    // Save active project ID when it changes
    useEffect(() => {
        AuditStorage.saveActiveProjectId(activeProject?.id || null);
    }, [activeProject]);

    // Save test history when it changes (local + remote sync)
    useEffect(() => {
        if (testHistory.length > 0) {
            // 保存到本地缓存
            AuditStorage.saveTestHistory(testHistory);

            // 异步同步最新一条到后端数据库（如果已启用）
            if (databaseConfig.enabled && testHistory[0]) {
                AuditDB.saveTestRunToDB(testHistory[0]).catch(err => {
                    console.warn('[Audit] Database sync failed:', err);
                });
            }
        }
    }, [testHistory]);

    // Phase P0 Bugfix: Auto-fetch Appliance.System.All for uninitialized devices upon entering suite
    useEffect(() => {
        if (!activeProject || !targetDevice || !mqttConnected) return;

        // If device IP is uninitialized ('0.0.0.0'), actively request its info to update it
        if (targetDevice.ip === '0.0.0.0') {
            const requestId = md5(Math.random().toString(36)).toLowerCase();
            const replyTopic = `/app/${session?.uid}-${appid}/subscribe`;
            const ts = Math.floor(Date.now() / 1000);
            const sign = md5(requestId + session?.key + String(ts)).toLowerCase();

            const message = {
                header: {
                    messageId: requestId,
                    namespace: 'Appliance.System.All',
                    method: 'GET',
                    payloadVersion: 1,
                    from: replyTopic,
                    timestamp: ts,
                    timestampMs: Date.now(),
                    sign: sign
                },
                payload: {}
            };

            const topic = `/appliance/${targetDevice.id}/subscribe`;
            onMqttPublish?.(topic, JSON.stringify(message));
            onMqttSubscribe?.(replyTopic);
            console.log(`[ProtocolAudit] Auto-probing uninitialized device ${targetDevice.name} (IP: 0.0.0.0)`);
        }
    }, [activeProject, targetDevice, mqttConnected, session, appid]);

    // Save target device ID when it changes
    useEffect(() => {
        if (targetDeviceId) {
            AuditStorage.saveTargetDeviceId(targetDeviceId);
        }
    }, [targetDeviceId]);

    // Sync suites to projects for persistence (keep legacy compatibility)
    useEffect(() => {
        if (activeProject && suites.length > 0) {
            const currentSuite = suites.find(s => s.id === activeProject.id);
            if (currentSuite && currentSuite.protocols !== activeProject.protocols) {
                // Update the active project with the latest protocols
                const updatedProject = {
                    ...activeProject,
                    protocols: currentSuite.protocols,
                    updatedAt: Date.now()
                };
                setActiveProject(updatedProject);
                setProjects(prev => prev.map(p => p.id === updatedProject.id ? updatedProject : p));
            }
        }
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
            executionConfig: DEFAULT_EXECUTION_CONFIG,
            testRuns: []
        };
        setSuites(prev => [...prev, suite]);
        setNewSuite({ name: '', description: '' });
        setIsAddingSuite(false);
        setSelectedSuiteId(suite.id);
    };

    const resetProtocolWizard = () => {
        setNewProtocol({
            id: '',
            namespace: '',
            name: '',
            methods: ALL_METHODS.reduce((acc, m) => ({ ...acc, [m]: { enabled: false, payload: '{}', schema: '{}' } }), {} as any)
        });
        setWizardStep(1);
        setCurrentMethodIndex(0);
        setRightPanelTab('overview');
    };

    const deleteSuite = (id: string) => {
        setConfirmationModal({
            show: true,
            title: '删除测试库',
            message: '确定要删除这个测试库吗？此操作不可恢复。',
            onConfirm: () => {
                setSuites(prev => prev.filter(s => s.id !== id));
                if (selectedSuiteId === id) setSelectedSuiteId(null);
                setConfirmationModal({ show: false, title: '', message: '', onConfirm: () => { } });
            }
        });
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

        // Determine if Update or Create
        const existingProtocol = selectedSuite?.protocols.find(p => p.id === newProtocol.id);
        const isUpdate = !!existingProtocol && newProtocol.id !== '';

        // Generate a truly unique ID for new protocols
        const protocolId = isUpdate ? newProtocol.id : `proto_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        setSuites(prevSuites => prevSuites.map(s => {
            if (s.id !== selectedSuiteId) return s;

            if (isUpdate) {
                const exists = s.protocols.find(p => p.id === newProtocol.id);
                if (exists) {
                    // Check if meaningful changes occurred to reset verification status
                    const { reviewStatus: r1, ...p1 } = exists;
                    const { reviewStatus: r2, ...p2 } = newProtocol;
                    const hasChanges = JSON.stringify(p1) !== JSON.stringify(p2);

                    const updatedProtocol = {
                        ...newProtocol,
                        reviewStatus: hasChanges ? 'UNVERIFIED' : newProtocol.reviewStatus,
                        tags: newProtocol.tags || [] // Ensure tags are preserved
                    };

                    return {
                        ...s,
                        protocols: s.protocols.map(p => p.id === newProtocol.id ? updatedProtocol : p)
                    };
                }
                return s;
            } else {
                // Ensure we're adding a new protocol with a unique ID
                return {
                    ...s,
                    protocols: [...s.protocols, { ...newProtocol, id: protocolId, reviewStatus: 'UNVERIFIED', tags: newProtocol.tags || [] }]
                };
            }
        }));

        if (isUpdate) {
            showToast('success', '协议已保存');
            // Update original protocol to reset dirty state
            // The logic above calculates hasChanges. Let's simplify: after save, current newProtocol IS the original
            setOriginalProtocol(JSON.parse(JSON.stringify(newProtocol)));
        } else {
            showToast('success', '协议已创建');
            setSelectedProtocolId(protocolId);
            setRightPanelTab('edit');
            const created = { ...newProtocol, id: protocolId, reviewStatus: 'UNVERIFIED' as const, tags: newProtocol.tags || [] };
            setNewProtocol(created);
            setOriginalProtocol(JSON.parse(JSON.stringify(created)));
        }
    };

    const startEditingProtocol = (protocol: ProtocolDefinition) => {
        const protocolCopy = JSON.parse(JSON.stringify(protocol)); // Deep copy
        setNewProtocol(protocolCopy);
        setOriginalProtocol(protocolCopy); // 保存原始状态用于脏数据检测
        setSelectedProtocolId(protocol.id);
        setRightPanelTab('edit');

        // Auto-select first enabled method
        const firstEnabledMethod = ALL_METHODS.find(m => protocol.methods[m]?.enabled);
        if (firstEnabledMethod) {
            setEditingMethod(firstEnabledMethod);
        } else {
            setEditingMethod('GET');
        }
    };

    const deleteProtocol = (protocolId: string) => {
        if (!selectedSuiteId) return;
        setConfirmationModal({
            show: true,
            title: '删除协议',
            message: '确定要删除这个协议吗？',
            onConfirm: () => {
                setSuites(prev => prev.map(s => {
                    if (s.id !== selectedSuiteId) return s;
                    return { ...s, protocols: s.protocols.filter(p => p.id !== protocolId) };
                }));
                if (selectedProtocolId === protocolId) {
                    setSelectedProtocolId(null);
                    setRightPanelTab('overview');
                }
                setConfirmationModal({ show: false, title: '', message: '', onConfirm: () => { } });
            }
        });
    };

    const updateProtocolMethod = (protocolId: string, method: RequestMethod, updates: Partial<MethodTest>, preserveReviewStatus: boolean = false) => {
        if (!selectedSuiteId) return;
        setSuites(suites.map(s => {
            if (s.id !== selectedSuiteId) return s;
            return {
                ...s,
                protocols: s.protocols.map(p => {
                    if (p.id !== protocolId) return p;
                    return {
                        ...p,
                        // 只有当 preserveReviewStatus 为 false 时才重置审核状态
                        ...(preserveReviewStatus ? {} : { reviewStatus: 'UNVERIFIED' as const }),
                        methods: {
                            ...p.methods,
                            [method]: { ...p.methods[method], ...updates }
                        }
                    };
                })
            };
        }));
    };

    const moveProtocol = (protocolId: string, direction: 'up' | 'down') => {
        if (!selectedSuiteId) return;
        setSuites(prev => prev.map(s => {
            if (s.id !== selectedSuiteId) return s;
            const index = s.protocols.findIndex(p => p.id === protocolId);
            if (index === -1) return s;
            if (direction === 'up' && index === 0) return s;
            if (direction === 'down' && index === s.protocols.length - 1) return s;

            const newProtocols = [...s.protocols];
            const swapIndex = direction === 'up' ? index - 1 : index + 1;
            [newProtocols[index], newProtocols[swapIndex]] = [newProtocols[swapIndex], newProtocols[index]];

            return { ...s, protocols: newProtocols, updatedAt: Date.now() };
        }));
    };

    const getEnabledMethods = () => {
        if (!newProtocol) return [];
        return (Object.keys(newProtocol.methods) as RequestMethod[]).filter(m => newProtocol.methods[m]?.enabled);
    };

    // Protocol Generator Handler
    const handleGeneratedProtocols = (protocols: ProtocolDefinition[]) => {
        if (selectedSuiteId) {
            setSuites(prev => prev.map(s => {
                if (s.id === selectedSuiteId) {
                    // Merge logic: Update existing by ID, append new
                    const newProtocolsMap = new Map(protocols.map(p => [p.id, p]));
                    const updatedProtocols = s.protocols.map(p => {
                        if (newProtocolsMap.has(p.id)) {
                            const newP = newProtocolsMap.get(p.id)!;
                            newProtocolsMap.delete(p.id);
                            return newP;
                        }
                        return p;
                    });

                    return {
                        ...s,
                        protocols: [...updatedProtocols, ...Array.from(newProtocolsMap.values())],
                        updatedAt: Date.now()
                    };
                }
                return s;
            }));
            addTestLog('INFO', `Added ${protocols.length} generated protocols to current suite`);
            showToast('success', `已添加 ${protocols.length} 个协议到当前测试库`);
        } else {
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

            const newProject: AuditProject = {
                id: newSuiteId,
                name: newSuite.name,
                protocols: protocols,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                status: 'ACTIVE',
                progress: 0
            };

            setProjects(prev => [...prev, newProject]);
            setActiveProject(newProject);

            addTestLog('INFO', `Generated new project with ${protocols.length} protocols`);
            showToast('success', `已创建新测试库并添加 ${protocols.length} 个协议`);
        }
        setShowProtocolGenerator(false);
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
            const sign = md5(messageId + session.key + String(timestamp)).toLowerCase();

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
    const initiateProtocolTest = (protocol: ProtocolDefinition, method: RequestMethod) => {
        setAuditConfirmation({ show: true, protocol, method });
    };

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

        // Check if payload is a full message (has header and payload)
        let actualPayload = payload;
        if (payload && typeof payload === 'object' && payload.header && payload.payload) {
            actualPayload = payload.payload;
        }

        // Prepare Request
        const requestId = md5(Math.random().toString(36)).toLowerCase();
        const topic = `/appliance/${targetDevice.id}/subscribe`;
        const replyTopic = `/app/${session.uid}-${appid}/subscribe`;
        const ts = Math.floor(Date.now() / 1000);
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
            payload: actualPayload
        };

        addTestLog('TX', `Sending ${methodName} to ${protocol.namespace}`, {
            protocol: protocol.namespace,
            method: methodName,
            requestPayload: finalPayload
        });

        onMqttSubscribe(replyTopic);

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
                const startMessage = lastMessageRef.current;
                onMqttPublish(topic, JSON.stringify(finalPayload));

                // Wait for response
                const response = await new Promise<any>((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs);
                    const interval = setInterval(() => {
                        const current = lastMessageRef.current;
                        if (current && current !== startMessage) {
                            try {
                                const json = JSON.parse(current.message);
                                if ((json.header && json.header.messageId === requestId) ||
                                    (current.topic === replyTopic && json.header && json.header.namespace === protocol.namespace)) {
                                    clearInterval(interval);
                                    clearTimeout(timer);
                                    resolve(json);
                                }
                            } catch (e) { }
                        }
                    }, 100);
                });

                const duration = Date.now() - startTime;

                // Validate Response
                let schemaErrors: any[] = [];
                let status: 'PASS' | 'FAIL' = 'PASS';
                let errorMsg = undefined;

                if (methodConfig.schema) {
                    try {
                        const schemaObj = JSON.parse(methodConfig.schema);
                        let activeSchema = schemaObj;
                        let validate;

                        if (!isLikelySchema(schemaObj)) {
                            activeSchema = inferSchemaFromData(schemaObj);
                            validate = new Ajv({ allErrors: true }).compile(activeSchema);
                        } else {
                            try {
                                validate = new Ajv({ allErrors: true }).compile(schemaObj);
                            } catch (e) {
                                activeSchema = inferSchemaFromData(schemaObj);
                                validate = new Ajv({ allErrors: true }).compile(activeSchema);
                            }
                        }

                        let targetData = response;
                        const isFullSchema = activeSchema.properties && ('header' in activeSchema.properties || 'payload' in activeSchema.properties);
                        if (!isFullSchema && response && typeof response === 'object' && 'payload' in response) {
                            targetData = response.payload;
                        }

                        if (!validate(targetData)) {
                            status = 'FAIL';
                            schemaErrors = validate.errors || [];
                            errorMsg = 'Schema validation failed';
                        }
                    } catch (e: any) {
                        status = 'FAIL';
                        errorMsg = `Invalid schema: ${e.message}`;
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
                    },
                    expectedSchema: methodConfig.schema ? JSON.parse(methodConfig.schema) : undefined,
                    namespace: protocol.namespace,
                    method: methodName,
                    protocolId: protocol.id
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
                const duration = Date.now() - startTime;
                const isTimeout = e.message === 'TIMEOUT';

                if (!lastResult) {
                    lastResult = {
                        status: isTimeout ? 'TIMEOUT' : 'FAIL',
                        duration,
                        error: e.message,
                        namespace: protocol.namespace,
                        method: methodName,
                        protocolId: protocol.id,
                        request: {
                            method: methodName,
                            topic,
                            payload: finalPayload,
                            timestamp: startTime
                        },
                        expectedSchema: methodConfig.schema ? JSON.parse(methodConfig.schema) : undefined
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
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }
                break;
            }
        }

        return lastResult || {
            status: 'FAIL',
            duration: 0,
            error: 'Unknown error',
            namespace: protocol.namespace,
            method: methodName,
            protocolId: protocol.id
        };
    };


    const waitForPush = async (protocol: ProtocolDefinition): Promise<DetailedTestResult> => {
        const methodName = 'PUSH';
        const methodConfig = protocol.methods['PUSH'];
        if (!methodConfig) return { status: 'FAIL', duration: 0, error: 'No PUSH config' };

        const startTime = Date.now();
        const timeoutMs = 10000; // Wait 10s for PUSH

        // Initial result container
        let result: DetailedTestResult = {
            status: 'FAIL',
            duration: 0,
            namespace: protocol.namespace,
            method: 'PUSH',
            protocolId: protocol.id,
            expectedSchema: methodConfig.schema ? JSON.parse(methodConfig.schema) : undefined
        };

        try {
            addTestLog('INFO', `Waiting for PUSH from ${protocol.namespace}...`);

            // Capture current last message to identify new ones
            const startMessage = lastMessageRef.current;

            const response = await new Promise<any>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('TIMEOUT_PUSH')), timeoutMs);
                const checkInterval = setInterval(() => {
                    const current = lastMessageRef.current;
                    if (current && current !== startMessage) {
                        try {
                            // Support both raw string message and pre-parsed object
                            let json: any;
                            if ((current as any).header && (current as any).payload) {
                                json = current;
                            } else {
                                json = JSON.parse(current.message);
                            }

                            // Check for PUSH method (case insensitive) and namespace
                            const method = json.header?.method?.toUpperCase();
                            if ((method === 'PUSH' || method === 'REPORT') &&
                                json.header.namespace === protocol.namespace) {
                                clearInterval(checkInterval);
                                clearTimeout(timer);
                                resolve(json);
                            }
                        } catch (e) { }
                    }
                }, 100);
            });

            const duration = Date.now() - startTime;

            // Validate Schema
            let schemaErrors: any[] = [];
            let status: 'PASS' | 'FAIL' = 'PASS';
            let errorMsg = undefined;

            if (methodConfig.schema) {
                try {
                    const schemaObj = JSON.parse(methodConfig.schema);
                    const validate = new Ajv({ allErrors: true }).compile(schemaObj);

                    // Validate payload or root object
                    let targetData = response;
                    // Usually we validate payload for convenience unless schema defines header
                    if (response && typeof response === 'object' && 'payload' in response && !schemaObj.properties?.header) {
                        targetData = response.payload;
                    }

                    if (!validate(targetData)) {
                        status = 'FAIL';
                        schemaErrors = validate.errors || [];
                        errorMsg = 'Schema validation failed';
                    }
                } catch (e: any) {
                    status = 'FAIL';
                    errorMsg = `Invalid schema: ${e.message}`;
                }
            }

            result = {
                ...result,
                status,
                duration,
                response,
                error: errorMsg,
                schemaErrors,
                request: undefined // PUSH has no request from our side
            };

            addTestLog(status === 'PASS' ? 'RX' : 'ERROR', status === 'PASS' ? `Received PUSH for ${protocol.namespace}` : `PUSH Validation failed`, {
                protocol: protocol.namespace,
                method: 'PUSH',
                status,
                duration,
                responsePayload: response,
                error: errorMsg,
                schemaErrors: schemaErrors.length > 0 ? analyzeSchemaErrors(schemaErrors, response) : undefined
            });

            return result;

        } catch (e: any) {
            const duration = Date.now() - startTime;
            const isTimeout = e.message === 'TIMEOUT_PUSH';

            result = {
                ...result,
                status: isTimeout ? 'TIMEOUT' : 'FAIL',
                duration,
                error: isTimeout ? 'Wait for PUSH timeout' : e.message
            };

            addTestLog('ERROR', `PUSH Wait Failed: ${e.message}`, {
                protocol: protocol.namespace,
                method: 'PUSH',
                status: result.status,
                duration,
                error: e.message
            });

            return result;
        }
    };

    // ==================== 自定义执行计划引擎 ====================

    /** 将手动输入的值按 JSON path 写入 payload */
    const applyManualInputToPayload = (payload: string, fields: ManualField[], values: Record<string, any>): string => {
        try {
            const obj = JSON.parse(payload);
            for (const field of fields) {
                const parts = field.path.split('.');
                let current = obj;
                for (let i = 0; i < parts.length - 1; i++) {
                    const key = parts[i];
                    if (/^\d+$/.test(key)) {
                        current = current[parseInt(key)];
                    } else {
                        if (!current[key]) current[key] = {};
                        current = current[key];
                    }
                }
                const lastKey = parts[parts.length - 1];
                let val = values[field.path];
                // 类型转换
                if (field.type === 'number') val = Number(val);
                if (field.type === 'boolean') val = val === 'true' || val === true;
                if (/^\d+$/.test(lastKey)) {
                    current[parseInt(lastKey)] = val;
                } else {
                    current[lastKey] = val;
                }
            }
            return JSON.stringify(obj);
        } catch (e) {
            console.error('[ExecutionPlan] Failed to apply manual input:', e);
            return payload;
        }
    };

    /** 获取步骤默认描述 */
    const getStepDefaultDescription = (step: TestStep): string => {
        switch (step.type) {
            case 'send_request': return `发送 ${step.config.method || 'GET'} 请求`;
            case 'wait_push': return '等待设备 PUSH';
            case 'delay': return `延时 ${((step.config.duration || 3000) / 1000).toFixed(1)} 秒`;
            case 'manual_action': return step.config.instruction || '等待手动操作';
            case 'manual_input': return `输入 ${(step.config.fields || []).length} 个参数`;
            case 'prerequisite': return `前置: ${step.config.protocolNamespace || ''}`;
            default: return '';
        }
    };

    /** 按自定义执行计划逐步执行一个协议的测试 */
    const executeCustomPlan = async (
        protocol: ProtocolDefinition,
        plan: TestExecutionPlan,
        run: any, // TestRun
        batchResult: BatchTestResult,
        currentTestIndexRef: { value: number },
        totalTests: number
    ): Promise<void> => {
        const steps = [...plan.steps].sort((a, b) => a.order - b.order);
        // 临时 payload 覆盖存储（手动输入后修改的 payload）
        const payloadOverrides: Record<string, string> = {};

        addTestLog('INFO', `[执行计划] 开始执行 ${protocol.namespace}，共 ${steps.length} 个步骤`);

        for (let i = 0; i < steps.length; i++) {
            await checkPause();
            if (stopTestRef.current) break;

            const step = steps[i];
            const stepDesc = step.description || getStepDefaultDescription(step);

            // 更新进度
            setTestProgress(prev => prev ? {
                ...prev,
                current: currentTestIndexRef.value,
                currentProtocol: protocol.namespace,
                stepCurrent: i + 1,
                stepTotal: steps.length,
                stepDescription: stepDesc,
                stepType: step.type,
                countdown: undefined,
                waitingForUser: false,
            } : null);

            addTestLog('INFO', `[步骤 ${i + 1}/${steps.length}] ${stepDesc}`);

            try {
                switch (step.type) {
                    case 'send_request': {
                        const method = step.config.method as RequestMethod || 'GET';
                        setRunningTest(`${protocol.id}:${method}`);
                        currentTestIndexRef.value++;
                        setTestProgress(prev => prev ? { ...prev, current: currentTestIndexRef.value } : null);

                        // 如果有手动输入覆盖的 payload，临时替换
                        const originalPayload = protocol.methods[method]?.payload;
                        if (payloadOverrides[method] && protocol.methods[method]) {
                            (protocol.methods[method] as any).payload = payloadOverrides[method];
                        }

                        const result = await runSingleTest(protocol, method, false);

                        // 恢复原始 payload
                        if (originalPayload !== undefined && protocol.methods[method]) {
                            (protocol.methods[method] as any).payload = originalPayload;
                        }

                        // 记录结果
                        run.results.push({
                            protocolId: protocol.id,
                            namespace: protocol.namespace,
                            method,
                            status: result.status,
                            duration: result.duration,
                            response: result.response,
                            error: result.error,
                            request: result.request,
                            expectedSchema: result.expectedSchema,
                            schemaErrors: result.schemaErrors,
                        });
                        batchResult.results.push(result);

                        run.summary.total++;
                        batchResult.summary.total++;
                        if (result.status === 'PASS') { run.summary.passed++; batchResult.summary.passed++; }
                        else if (result.status === 'TIMEOUT') { run.summary.timeout++; batchResult.summary.timeout++; }
                        else { run.summary.failed++; batchResult.summary.failed++; }

                        // 失败时检查是否终止
                        if (result.status !== 'PASS' && !step.continueOnFail) {
                            addTestLog('ERROR', `[步骤 ${i + 1}] ${method} 失败，终止后续步骤`);
                            return;
                        }
                        break;
                    }

                    case 'wait_push': {
                        const pushTimeout = step.timeout || 15000;
                        setRunningTest(`${protocol.id}:PUSH`);

                        // 倒计时显示
                        const countdownInterval = setInterval(() => {
                            setTestProgress(prev => {
                                if (!prev) return null;
                                const elapsed = Date.now() - (prev.startTime || Date.now());
                                const remaining = Math.max(0, Math.ceil((pushTimeout - (elapsed % pushTimeout)) / 1000));
                                return { ...prev, countdown: remaining };
                            });
                        }, 500);

                        try {
                            const result = await waitForPush(protocol);
                            clearInterval(countdownInterval);

                            run.results.push({
                                protocolId: protocol.id,
                                namespace: protocol.namespace,
                                method: 'PUSH',
                                status: result.status,
                                duration: result.duration,
                                response: result.response,
                                error: result.error,
                                request: result.request,
                                expectedSchema: result.expectedSchema,
                                schemaErrors: result.schemaErrors,
                            });
                            batchResult.results.push(result);

                            run.summary.total++;
                            batchResult.summary.total++;
                            if (result.status === 'PASS') { run.summary.passed++; batchResult.summary.passed++; }
                            else if (result.status === 'TIMEOUT') { run.summary.timeout++; batchResult.summary.timeout++; }
                            else { run.summary.failed++; batchResult.summary.failed++; }

                            if (result.status !== 'PASS' && !step.continueOnFail) {
                                addTestLog('ERROR', `[步骤 ${i + 1}] PUSH 等待失败，终止后续步骤`);
                                return;
                            }
                        } catch (e) {
                            clearInterval(countdownInterval);
                            if (!step.continueOnFail) return;
                        }
                        break;
                    }

                    case 'delay': {
                        const duration = step.config.duration || 3000;
                        const startTime = Date.now();

                        await new Promise<void>((resolve) => {
                            const interval = setInterval(() => {
                                const elapsed = Date.now() - startTime;
                                const remaining = Math.max(0, Math.ceil((duration - elapsed) / 1000));
                                setTestProgress(prev => prev ? { ...prev, countdown: remaining, stepDescription: `延时等待 ${remaining} 秒...` } : null);

                                if (elapsed >= duration || stopTestRef.current) {
                                    clearInterval(interval);
                                    resolve();
                                }
                            }, 200);
                        });
                        break;
                    }

                    case 'manual_action': {
                        setTestProgress(prev => prev ? { ...prev, waitingForUser: true, stepDescription: step.config.instruction || '等待手动操作' } : null);

                        await new Promise<void>((resolve) => {
                            setManualActionModal({
                                show: true,
                                instruction: step.config.instruction || '请执行手动操作',
                                confirmText: step.config.confirmText || '已完成，继续',
                                protocolName: protocol.namespace,
                                stepIndex: i + 1,
                                totalSteps: steps.length,
                                resolve,
                            });
                        });

                        setManualActionModal(null);
                        addTestLog('INFO', `[步骤 ${i + 1}] 手动操作已确认`);
                        break;
                    }

                    case 'manual_input': {
                        const fields = step.config.fields || [];
                        if (fields.length === 0) break;

                        setTestProgress(prev => prev ? { ...prev, waitingForUser: true, stepDescription: `输入 ${fields.length} 个参数` } : null);

                        const values = await new Promise<Record<string, any>>((resolve) => {
                            setManualInputModal({
                                show: true,
                                fields,
                                protocolName: protocol.namespace,
                                targetMethod: step.config.targetMethod || 'SET',
                                stepIndex: i + 1,
                                totalSteps: steps.length,
                                resolve,
                            });
                        });

                        setManualInputModal(null);

                        // 将输入值写入目标 method 的 payload
                        const targetMethod = (step.config.targetMethod || 'SET') as RequestMethod;
                        const currentPayload = protocol.methods[targetMethod]?.payload || '{}';
                        payloadOverrides[targetMethod] = applyManualInputToPayload(currentPayload, fields, values);
                        addTestLog('INFO', `[步骤 ${i + 1}] 参数已输入，应用到 ${targetMethod} payload`);
                        break;
                    }

                    case 'prerequisite': {
                        const prereqId = step.config.protocolId;
                        const prereqMethod = (step.config.prerequisiteMethod || 'GET') as RequestMethod;

                        // 在当前 suite 中查找前置协议
                        const allProtocols = suites.flatMap(s => s.protocols);
                        const prereqProtocol = allProtocols.find(p => p.id === prereqId);

                        if (!prereqProtocol) {
                            addTestLog('ERROR', `[步骤 ${i + 1}] 前置协议未找到: ${step.config.protocolNamespace || prereqId}`);
                            if (step.config.failAction !== 'continue') return;
                            break;
                        }

                        addTestLog('INFO', `[步骤 ${i + 1}] 执行前置协议: ${prereqProtocol.namespace} ${prereqMethod}`);
                        setRunningTest(`${prereqProtocol.id}:${prereqMethod}`);

                        const result = await runSingleTest(prereqProtocol, prereqMethod, false);

                        if (result.status !== 'PASS') {
                            addTestLog('ERROR', `[步骤 ${i + 1}] 前置协议执行失败: ${result.error || result.status}`);
                            if (step.config.failAction !== 'continue') return;
                        } else {
                            addTestLog('INFO', `[步骤 ${i + 1}] 前置协议执行成功`);
                        }
                        break;
                    }

                    case 'wait_serial': {
                        const targetNs = step.config.serialNamespace || protocol.namespace;
                        const timeoutMs = step.timeout || 30000;
                        const matchRegexStr = step.config.serialMatchRegex;
                        setTestProgress(prev => prev ? { ...prev, waitingForUser: false, stepDescription: `串口监控 ${targetNs}`, countdown: Math.ceil(timeoutMs / 1000) } : null);

                        addTestLog('INFO', `[步骤 ${i + 1}] 开始监控串口 (目标: ${targetNs}, 超时: ${Math.ceil(timeoutMs / 1000)}s)`);

                        // 倒计时 timer
                        const progressInterval = setInterval(() => {
                            setTestProgress(prev => {
                                if (!prev || prev.countdown === undefined || prev.countdown <= 0) return prev;
                                return { ...prev, countdown: prev.countdown - 1 };
                            });
                        }, 1000);

                        try {
                            const result = await new Promise<boolean>((resolve) => {
                                let regex: RegExp | null = null;
                                if (matchRegexStr) {
                                    try {
                                        regex = new RegExp(matchRegexStr);
                                    } catch (e) {
                                        addTestLog('ERROR', `[步骤 ${i + 1}] 串口正则语法错误: ${matchRegexStr}`);
                                    }
                                }

                                const timer = setTimeout(() => {
                                    cleanup();
                                    resolve(false); // timeout
                                }, timeoutMs);

                                const checkStop = setInterval(() => {
                                    if (stopTestRef.current) {
                                        cleanup();
                                        resolve(false);
                                    }
                                }, 500);

                                let unsubscribe: (() => void) | null = null;

                                const cleanup = () => {
                                    clearTimeout(timer);
                                    clearInterval(checkStop);
                                    if (unsubscribe) unsubscribe();
                                };

                                const handleSerialData = (event: any, data: { line: string, timestamp: number, type?: string }) => {
                                    if (!data || !data.line) return;
                                    const line = data.line;

                                    // 检查是否包含 namespace
                                    if (line.includes(targetNs)) {
                                        // 检查正则
                                        if (regex && !regex.test(line)) {
                                            return;
                                        }
                                        cleanup();
                                        addTestLog('RX', `[串口] 命中目标: ${line.substring(0, 80)}${line.length > 80 ? '...' : ''}`);
                                        resolve(true);
                                    }
                                };

                                // 注册监听器 (使用 generic electron ipcRenderer)
                                if ((window as any).electron?.ipcRenderer?.on) {
                                    unsubscribe = (window as any).electron.ipcRenderer.on('serial:data', handleSerialData);
                                } else {
                                    addTestLog('ERROR', `[步骤 ${i + 1}] 无法监听串口，环境不支持或未运行客户端`);
                                    cleanup();
                                    resolve(false);
                                }
                            });

                            clearInterval(progressInterval);

                            if (result) {
                                addTestLog('INFO', `[步骤 ${i + 1}] 串口监控成功匹配`);
                            } else if (stopTestRef.current) {
                                addTestLog('INFO', `[步骤 ${i + 1}] 串口监控被终止`);
                                return;
                            } else {
                                addTestLog('ERROR', `[步骤 ${i + 1}] 串口监控超时未匹配到目标`);
                                if (!step.continueOnFail) return;
                            }
                        } catch (err: any) {
                            clearInterval(progressInterval);
                            addTestLog('ERROR', `[步骤 ${i + 1}] 串口监控异常: ${err.message}`);
                            if (!step.continueOnFail) return;
                        }

                        break;
                    }
                }

                // 步骤间短暂延时
                if (i < steps.length - 1 && !stopTestRef.current) {
                    await new Promise(r => setTimeout(r, 200));
                }
            } catch (err: any) {
                addTestLog('ERROR', `[步骤 ${i + 1}] 执行异常: ${err.message || err}`);
                if (!step.continueOnFail) return;
            }
        }

        addTestLog('INFO', `[执行计划] ${protocol.namespace} 执行完毕`);
    };

    const stopTests = () => {
        stopTestRef.current = true;
        isPausedRef.current = false;
        setIsPaused(false);
        setIsRunning(false);
        setRunningTest(null);
        showToast('info', '测试已被用户终止');
    };

    const togglePauseTest = () => {
        isPausedRef.current = !isPausedRef.current;
        setIsPaused(isPausedRef.current);
        if (isPausedRef.current) {
            showToast('info', '测试暂停中');
        } else {
            showToast('info', '测试恢复执行');
        }
    };

    const runAllTests = async (protocolsOverride?: any) => {
        if (!selectedSuite || !targetDevice || !mqttConnected) {
            showToast('warning', '请选择测试库、目标设备并确保 MQTT 已连接');
            return;
        }

        stopTestRef.current = false;

        // Determine protocols to run
        let protocolsToRun: ProtocolDefinition[] = [];
        if (Array.isArray(protocolsOverride)) {
            protocolsToRun = protocolsOverride;
        } else {
            protocolsToRun = selectedProtocols.size > 0
                ? selectedSuite.protocols.filter(p => selectedProtocols.has(p.id))
                : selectedSuite.protocols;
        }

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
            deviceId: targetDevice.id,
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
            // 自定义执行计划：按 send_request + wait_push 步骤数计算
            if (p.executionPlan?.enabled && p.executionPlan.steps.length > 0) {
                totalTests += p.executionPlan.steps.filter(s => s.type === 'send_request' || s.type === 'wait_push').length || 1;
            } else {
                for (const m of REQUEST_METHODS) {
                    const mc = p.methods[m];
                    if (!mc?.enabled) continue;
                    const cases = mc.testCases || [];
                    totalTests += cases.length > 0 ? cases.length : 1;
                }
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

            // 每开始一个新的协议前，固定等待3秒缓冲时间，确保设备TCP并发能力
            setRunningTest(`${protocol.id}:wait`);
            for (let i = 3; i > 0; i--) {
                setTestProgress(prev => prev ? {
                    ...prev,
                    currentProtocol: `准备阶段: ${protocol.namespace}`,
                    stepCurrent: 1,
                    stepTotal: 1,
                    stepDescription: `为防止设备处理阻塞，进行物理缓冲等待`,
                    countdown: i
                } : null);
                await new Promise(resolve => setTimeout(resolve, 1000));
                await checkPause();
                if (stopTestRef.current) break outerLoop;
            }
            setTestProgress(prev => prev ? {
                ...prev,
                countdown: undefined,
                stepDescription: undefined,
                stepCurrent: undefined,
                stepTotal: undefined
            } : null);

            // ===== 自定义执行计划分流 =====
            if (protocol.executionPlan?.enabled && protocol.executionPlan.steps.length > 0) {
                const currentTestIndexRef = { value: currentTestIndex };
                await executeCustomPlan(protocol, protocol.executionPlan, run, batchResult, currentTestIndexRef, totalTests);
                currentTestIndex = currentTestIndexRef.value;
                setCurrentRun({ ...run });
                setBatchTestResult({ ...batchResult });
                continue; // 跳过下面的默认逻辑
            }

            // ===== 默认逻辑（无自定义计划）=====
            for (const methodName of REQUEST_METHODS) {
                if (stopTestRef.current) break;
                const methodConfig = protocol.methods[methodName];
                if (!methodConfig?.enabled) continue;

                const testCases = methodConfig.testCases || [];

                if (testCases.length > 0) {
                    // Run Test Cases
                    for (const testCase of testCases) {
                        await checkPause();
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
                            testCaseName: testCase.name,
                            request: result.request,
                            expectedSchema: result.expectedSchema,
                            schemaErrors: result.schemaErrors
                        });

                        // result 本身就是 DetailedTestResult，直接 push
                        batchResult.results.push(result);

                        if (result.status === 'PASS') {
                            run.summary.passed++;
                            batchResult.summary.passed++;

                            // [OPTIMIZATION] If SET passed, verify PUSH
                            if (methodName === 'SET' && protocol.methods['PUSH']?.enabled) {
                                addTestLog('INFO', `SET passed, waiting for PUSH verification...`);

                                // Visual feedback
                                setRunningTest(`${protocol.id}:PUSH`);
                                setTestProgress(prev => prev ? { ...prev, currentProtocol: `${protocol.namespace} PUSH (Wait)` } : null);

                                const pushResult = await waitForPush(protocol);

                                run.summary.total++;
                                batchResult.summary.total++;
                                // Add PUSH result
                                run.results.push({
                                    protocolId: protocol.id,
                                    namespace: protocol.namespace,
                                    method: 'PUSH',
                                    status: pushResult.status,
                                    duration: pushResult.duration,
                                    response: pushResult.response,
                                    error: pushResult.error,
                                    testCaseId: testCase.id, // Associate with test case
                                    testCaseName: `PUSH Verification (after ${testCase.name})`,
                                    request: pushResult.request,
                                    expectedSchema: pushResult.expectedSchema,
                                    schemaErrors: pushResult.schemaErrors
                                });
                                batchResult.results.push(pushResult);

                                if (pushResult.status === 'PASS') {
                                    run.summary.passed++;
                                    batchResult.summary.passed++;
                                } else if (pushResult.status === 'TIMEOUT') {
                                    run.summary.timeout++;
                                    batchResult.summary.timeout++;
                                } else {
                                    run.summary.failed++;
                                    batchResult.summary.failed++;
                                }

                                // We don't necessarily update protocol-level lastResult for test cases, 
                                // as it might overwrite others. But strictly speaking PUSH is protocol level.
                                updateProtocolMethod(protocol.id, 'PUSH', { lastResult: pushResult }, true);
                            }
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
                        error: result.error,
                        request: result.request,
                        expectedSchema: result.expectedSchema,
                        schemaErrors: result.schemaErrors
                    });

                    // result 本身就是 DetailedTestResult，直接 push
                    batchResult.results.push(result);

                    if (result.status === 'PASS') {
                        run.summary.passed++;
                        batchResult.summary.passed++;

                        // [OPTIMIZATION] If SET passed, verify PUSH
                        if (methodName === 'SET' && protocol.methods['PUSH']?.enabled) {
                            addTestLog('INFO', `SET passed, waiting for PUSH verification...`);

                            // Visual feedback
                            setRunningTest(`${protocol.id}:PUSH`);
                            setTestProgress(prev => prev ? { ...prev, currentProtocol: `${protocol.namespace} PUSH (Wait)` } : null);

                            const pushResult = await waitForPush(protocol);

                            run.summary.total++;
                            batchResult.summary.total++;
                            // Add PUSH result
                            run.results.push({
                                protocolId: protocol.id,
                                namespace: protocol.namespace,
                                method: 'PUSH',
                                status: pushResult.status,
                                duration: pushResult.duration,
                                response: pushResult.response,
                                response: pushResult.response,
                                error: pushResult.error,
                                request: pushResult.request,
                                expectedSchema: pushResult.expectedSchema,
                                schemaErrors: pushResult.schemaErrors
                            });
                            batchResult.results.push(pushResult);

                            if (pushResult.status === 'PASS') {
                                run.summary.passed++;
                                batchResult.summary.passed++;
                            } else if (pushResult.status === 'TIMEOUT') {
                                run.summary.timeout++;
                                batchResult.summary.timeout++;
                            } else {
                                run.summary.failed++;
                                batchResult.summary.failed++;
                            }

                            updateProtocolMethod(protocol.id, 'PUSH', { lastResult: pushResult }, true);
                        }

                    } else if (result.status === 'FAIL') {
                        run.summary.failed++;
                        batchResult.summary.failed++;
                    } else if (result.status === 'TIMEOUT') {
                        run.summary.timeout++;
                        batchResult.summary.timeout++;
                    }

                    updateProtocolMethod(protocol.id, methodName, { lastResult: result }, true);

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

        // Save to Suite History
        setSuites(prev => prev.map(s => {
            if (s.id === selectedSuite.id) {
                return {
                    ...s,
                    testRuns: [batchResult, ...(s.testRuns || [])]
                };
            }
            return s;
        }));

        // 添加到测试历史（用于持久化存储）
        setTestHistory(prev => {
            const newHistory = [run, ...prev].slice(0, 100);
            // Explicitly trigger DB save
            AuditDB.syncSaveTestHistory(newHistory).then(() => {
                console.log('[ProtocolAudit] Test history synced to DB');
            });
            return newHistory;
        });

        setRunningTest(null);
        setIsRunning(false);
        setTestProgress(null); // 清除进度追踪

        addTestLog('INFO', `测试完成: ${run.summary.passed}/${run.summary.total} 通过`);

        // Show summary panel
        setViewingResult({ batchResult: batchResult });
        setShowResultViewer(true);
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

    if (viewMode === 'DASHBOARD') {
        return (
            <>
                <ProjectDashboard
                    projects={projects}
                    onSelect={handleSelectProject}
                    onCreate={handleCreateProject}
                    onDelete={handleDeleteProject}
                    onRename={handleRenameProject}
                    onDuplicate={handleDuplicateProject}
                />
                {/* New Project Modal */}
                {showNewProjectModal && (
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[200]" onClick={() => setShowNewProjectModal(false)}>
                        <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-[450px] shadow-2xl" onClick={e => e.stopPropagation()}>
                            <h3 className="text-lg font-bold text-white mb-4">Create New Project</h3>
                            <div className="space-y-4">
                                <div>
                                    <label className="text-sm text-slate-400 block mb-2">Project Name *</label>
                                    <input
                                        type="text"
                                        value={newProjectData.name}
                                        onChange={(e) => setNewProjectData(prev => ({ ...prev, name: e.target.value }))}
                                        className="w-full bg-slate-800 text-white px-4 py-2 rounded-lg border border-slate-700 focus:border-blue-500 outline-none"
                                        placeholder="e.g. Smart Home V2"
                                        autoFocus
                                    />
                                </div>
                                <div>
                                    <label className="text-sm text-slate-400 block mb-2">Description</label>
                                    <textarea
                                        value={newProjectData.description}
                                        onChange={(e) => setNewProjectData(prev => ({ ...prev, description: e.target.value }))}
                                        className="w-full bg-slate-800 text-white px-4 py-2 rounded-lg border border-slate-700 focus:border-blue-500 outline-none h-24 resize-none"
                                        placeholder="Optional project description..."
                                    />
                                </div>
                            </div>
                            <div className="flex justify-end gap-3 mt-6">
                                <button
                                    onClick={() => setShowNewProjectModal(false)}
                                    className="px-4 py-2 text-slate-400 hover:text-white font-bold transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={confirmCreateProject}
                                    className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-bold transition-colors"
                                >
                                    Create Project
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </>
        );
    }

    return (
        <div className="flex h-full flex-col bg-slate-950">
            {/* Workspace Header */}
            <div className="h-12 border-b border-slate-800 flex items-center px-4 justify-between bg-slate-900 shrink-0">
                <div className="flex items-center gap-3">
                    <button
                        onClick={() => safeNavigate(() => setViewMode('DASHBOARD'))}
                        className="text-slate-400 hover:text-white flex items-center gap-1 text-sm"
                    >
                        <ChevronLeft size={16} /> Dashboard
                    </button>
                    <div className="h-4 w-px bg-slate-700"></div>
                    {/* 协议库名称 - 可点击跳转到测试结果列表 */}
                    <button
                        onClick={() => safeNavigate(() => setSelectedProtocolId(null))}
                        className="font-bold text-white hover:text-indigo-400 transition-colors cursor-pointer"
                        title="点击返回测试结果列表"
                    >
                        {activeProject?.name}
                    </button>
                </div>

                {/* Header Actions */}
                <div className="flex items-center gap-2">
                    {/* Run/Stop - 始终显示，不受 selectedProtocolId 限制 */}
                    {isRunning ? (
                        <button onClick={stopTests} className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg shadow-lg shadow-red-900/20 transition-all font-bold flex items-center gap-2" title="停止测试">
                            <XCircle size={16} /> 停止
                        </button>
                    ) : (
                        <button
                            onClick={() => safeNavigate(() => runAllTests())}
                            disabled={!mqttConnected || !selectedSuite || selectedSuite.protocols.length === 0 || selectedProtocols.size === 0}
                            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-emerald-900/20 transition-all font-bold flex items-center gap-2"
                            title={selectedProtocols.size > 0 ? `运行 ${selectedProtocols.size} 个选中的协议` : '请先选择要运行的协议'}
                        >
                            <Play size={16} fill="currentColor" />
                            <span>运行 {selectedProtocols.size > 0 ? `(${selectedProtocols.size})` : ''}</span>
                        </button>
                    )}
                    {/* Import Protocol */}
                    <button onClick={() => safeNavigate(() => {
                        setImportSourceSuiteId('');
                        setImportSelectedTags(new Set());
                        setImportSelectedProtocols(new Set());
                        setShowImportProtocolModal(true);
                    })} className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium rounded-lg shadow-lg shadow-slate-900/20 transition-all border border-slate-700 flex items-center gap-2" title="导入协议">
                        <Download size={16} />
                        导入协议
                    </button>
                    {/* Add Protocol */}
                    <button onClick={() => safeNavigate(() => {
                        resetProtocolWizard();
                        setIsAddingProtocol(true);
                    })} className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg shadow-lg shadow-indigo-900/20 transition-all flex items-center gap-2" title="新增单条协议">
                        <Plus size={16} />
                        新增协议
                    </button>
                </div>
            </div>

            <div className="flex flex-col flex-1 overflow-hidden relative">
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
                <div className="flex-1 flex min-h-0 overflow-hidden">
                    <TestPlanPanel
                        suites={suites}
                        selectedSuiteId={selectedSuiteId}
                        selectedProtocolId={selectedProtocolId}
                        onSelectSuite={(id) => {
                            safeNavigate(() => {
                                setSelectedSuiteId(id);
                                setSelectedProtocolId(null);
                                setRightPanelTab('overview');
                            });
                        }}
                        onSelectProtocol={(p) => {
                            safeNavigate(() => {
                                setSelectedSuiteId(suites.find(s => s.protocols.some(proto => proto.id === p.id))?.id || null);
                                startEditingProtocol(p);
                            });
                        }}
                        searchTerm={searchTerm}
                        onSearchChange={setSearchTerm}
                        expandedSuites={expandedSuites}
                        toggleSuiteExpand={(id) => setExpandedSuites(prev => {
                            const next = new Set(prev);
                            if (next.has(id)) next.delete(id); else next.add(id);
                            return next;
                        })}
                        selectedProtocols={selectedProtocols}
                        onToggleProtocolSelection={(id, selected) => {
                            const newSelected = new Set(selectedProtocols);
                            if (selected) newSelected.add(id); else newSelected.delete(id);
                            setSelectedProtocols(newSelected);
                        }}
                        onToggleSuiteSelection={(suite, selected) => {
                            const newSelected = new Set(selectedProtocols);
                            if (selected) suite.protocols.forEach(p => newSelected.add(p.id));
                            else suite.protocols.forEach(p => newSelected.delete(p.id));
                            setSelectedProtocols(newSelected);
                        }}
                        onToggleFilteredProtocols={(ids, selected) => {
                            const newSelected = new Set(selectedProtocols);
                            ids.forEach(id => {
                                if (selected) newSelected.add(id);
                                else newSelected.delete(id);
                            });
                            setSelectedProtocols(newSelected);
                        }}
                        verificationErrorSuiteId={verificationErrorSuiteId}
                        getProtocolStatus={getProtocolStatus}
                        STATUS_CONFIG={STATUS_CONFIG}
                        onQuickRun={(p) => safeNavigate(() => runAllTests([p]))}
                        runningTest={runningTest}
                        onAddSuite={() => safeNavigate(() => setIsAddingSuite(true))}
                        onImportSuite={importSuite}
                        onAutoGen={() => safeNavigate(() => setShowProtocolGenerator(true))}
                        mqttConnected={mqttConnected}
                        targetDevice={targetDevice}
                        devices={devices}
                        targetDeviceId={targetDeviceId}
                        setTargetDeviceId={setTargetDeviceId}
                        onShowStats={() => safeNavigate(() => setShowStatsDashboard(true))}
                        onEditSuite={startEditingSuite}
                        onExportSuite={exportSuite}
                        onDeleteSuite={deleteSuite}
                        onDeleteProtocol={deleteProtocol}
                        onMoveProtocol={moveProtocol}
                        onReorderProtocols={(newOrderIds) => {
                            if (!selectedSuiteId) return;
                            setSuites(prev => prev.map(s => {
                                if (s.id !== selectedSuiteId) return s;
                                const originalMapped = new Map(s.protocols.map(p => [p.id, p]));
                                const newProtocols = newOrderIds.map(id => originalMapped.get(id)).filter(Boolean) as ProtocolDefinition[];
                                return { ...s, protocols: newProtocols, updatedAt: Date.now() };
                            }));
                        }}
                    />

                    <WorkbenchPanel>
                        <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-slate-900 border-x border-slate-800">
                            {/* Top Section: Editor/Results */}
                            <div className="flex-1 overflow-hidden flex flex-col">
                                {selectedSuite ? (
                                    <>
                                        {/* Header */}


                                        {/* Test History Table - Always show when no protocol is selected */}
                                        {!selectedProtocolId && (
                                            <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-4">
                                                {/* Current Run Summary */}
                                                {/* Test History Table */}
                                                <div className="flex-1 overflow-auto custom-scrollbar">
                                                    <table className="w-full text-left border-collapse">
                                                        <thead className="bg-slate-950 sticky top-0 z-10">
                                                            <tr>
                                                                <th className="p-4 text-sm font-bold text-slate-300 uppercase border-b border-slate-800">ID</th>
                                                                <th className="p-4 text-sm font-bold text-slate-300 uppercase border-b border-slate-800">协议库名称</th>
                                                                <th className="p-4 text-sm font-bold text-slate-300 uppercase border-b border-slate-800">设备标识 (UUID)</th>
                                                                <th className="p-4 text-sm font-bold text-slate-300 uppercase border-b border-slate-800">执行状态</th>
                                                                <th className="p-4 text-sm font-bold text-slate-300 uppercase border-b border-slate-800">测试内容</th>
                                                                <th className="p-4 text-sm font-bold text-slate-300 uppercase border-b border-slate-800">创建时间</th>
                                                                <th className="p-4 text-sm font-bold text-slate-300 uppercase border-b border-slate-800 text-right">操作</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody className="divide-y divide-slate-800">
                                                            {testHistory.filter(h => h.suiteId === selectedSuite.id || (h as any).projectId === selectedSuite.id).length === 0 ? (
                                                                <tr>
                                                                    <td colSpan={7} className="p-8 text-center text-slate-500 text-sm">
                                                                        暂无测试记录
                                                                    </td>
                                                                </tr>
                                                            ) : (
                                                                testHistory.filter(h => h.suiteId === selectedSuite.id || (h as any).projectId === selectedSuite.id).map((run, index) => (
                                                                    <tr key={run.id} className="hover:bg-slate-800/30 transition-colors select-text group">
                                                                        <td className="p-4 text-sm text-slate-400">{index + 1}</td>
                                                                        <td className="p-4 text-sm font-medium text-white">{run.suiteName}</td>
                                                                        <td className="p-4 text-sm text-slate-400">{run.deviceId}</td>
                                                                        <td className="p-4">
                                                                            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold ${run.status === 'COMPLETED'
                                                                                ? run.summary.failed === 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
                                                                                : 'bg-blue-500/10 text-blue-400'
                                                                                }`}>
                                                                                {run.status === 'COMPLETED'
                                                                                    ? run.summary.failed === 0 ? '成功' : '失败'
                                                                                    : run.status}
                                                                            </span>
                                                                        </td>
                                                                        <td className="p-4 text-sm text-slate-400">
                                                                            {run.results.length === 1 && run.results[0]
                                                                                ? <span className="text-slate-300" title={`${run.results[0].namespace || '?'} ${run.results[0].method || ''}`}>
                                                                                    {run.results[0].namespace ? run.results[0].namespace.split('.').pop() : 'Unknown'} {run.results[0].method}
                                                                                </span>
                                                                                : <span>{run.results.length} 个用例</span>
                                                                            }
                                                                        </td>
                                                                        <td className="p-4 text-sm text-slate-400">
                                                                            {new Date(run.startTime).toLocaleString()}
                                                                        </td>
                                                                        <td className="p-4 text-right">
                                                                            <div className="flex items-center justify-end gap-2">
                                                                                <button
                                                                                    onClick={() => {
                                                                                        setViewingResult({ batchResult: run });
                                                                                        setShowResultViewer(true);
                                                                                    }}
                                                                                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded transition-colors"
                                                                                >
                                                                                    详情
                                                                                </button>
                                                                                <button
                                                                                    onClick={() => {
                                                                                        const data = JSON.stringify(run, null, 2);
                                                                                        const blob = new Blob([data], { type: 'application/json' });
                                                                                        const url = URL.createObjectURL(blob);
                                                                                        const a = document.createElement('a');
                                                                                        a.href = url;
                                                                                        a.download = `test_run_${run.id}.json`;
                                                                                        a.click();
                                                                                        URL.revokeObjectURL(url);
                                                                                    }}
                                                                                    className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold rounded transition-colors"
                                                                                >
                                                                                    导出
                                                                                </button>
                                                                                <button
                                                                                    onClick={() => handleDeleteTestRun(run)}
                                                                                    className="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs font-bold rounded transition-colors"
                                                                                >
                                                                                    删除
                                                                                </button>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                ))
                                                            )}
                                                        </tbody>
                                                    </table>
                                                </div>

                                                {/* Suite Overview Cards */}


                                                {/* Method Distribution */}


                                                {/* Empty State */}

                                            </div>
                                        )}



                                        {/* Protocol Edit/Review Panel - Only show when a protocol is selected */}
                                        {selectedProtocolId && (
                                            <div className="flex-1 overflow-hidden flex flex-col bg-slate-900/50 rounded-xl m-2 mt-1 border border-slate-800 relative">
                                                {/* Consolidated Header & Tabs */}
                                                <div className="flex items-center justify-between px-4 border-b border-slate-800 shrink-0 h-14 bg-slate-900">
                                                    {/* Left: Back Button, Protocol Name & Status Badge */}
                                                    <div className="flex items-center gap-4">
                                                        {/* 返回测试列表按钮 */}
                                                        <button
                                                            onClick={() => safeNavigate(() => setSelectedProtocolId(null))}
                                                            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
                                                            title="返回测试列表"
                                                        >
                                                            <ChevronLeft size={18} />
                                                        </button>

                                                        <div className="text-lg font-bold text-white font-mono tracking-tight">
                                                            {newProtocol.namespace || 'New Protocol'}
                                                        </div>

                                                        {/* Status Badge - Clickable for Verification */}
                                                        <button
                                                            onClick={() => setVerificationModal({ show: true, protocol: newProtocol, mode: newProtocol.verificationMode || 'manual' })}
                                                            className={`px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider flex items-center gap-1.5 transition-all hover:scale-105 active:scale-95 ${newProtocol.reviewStatus === 'VERIFIED'
                                                                ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-900/20'
                                                                : 'bg-amber-500 text-white shadow-lg shadow-amber-900/20'
                                                                }`}
                                                        >
                                                            {newProtocol.reviewStatus === 'VERIFIED' ? (
                                                                <><CheckCircle2 size={12} strokeWidth={3} /> 已审核</>
                                                            ) : (
                                                                <><AlertTriangle size={12} strokeWidth={3} /> 未审核</>
                                                            )}
                                                        </button>
                                                    </div>



                                                    {/* Protocol Actions (Moved from below) */}
                                                    <div className="flex items-center gap-2 ml-2 pl-2 border-l border-slate-700">
                                                        <button
                                                            onClick={() => setShowCopyProtocolModal(true)}
                                                            className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg border border-slate-700 flex items-center gap-2 text-xs font-bold transition-colors"
                                                            title="Copy Protocol"
                                                        >
                                                            <Copy size={14} /> 复制
                                                        </button>

                                                        <button onClick={addProtocolToSuite}
                                                            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold uppercase shadow-lg shadow-emerald-900/20 transition-all hover:scale-105 active:scale-95 flex items-center gap-1.5">
                                                            <Save size={14} /> {newProtocol.id ? '保存' : '创建'}
                                                        </button>
                                                    </div>
                                                </div>

                                                {/* Edit Content - Compact Split-Pane Layout */}
                                                {(rightPanelTab === 'edit') && (
                                                    <div className="flex-1 flex flex-col h-full overflow-hidden bg-slate-950">
                                                        {/* Header: Namespace & Methods */}
                                                        <div className="px-3 py-2 border-b border-slate-800 space-y-2 shrink-0 bg-slate-900/50">
                                                            {/* Namespace Row */}
                                                            <div className="relative">
                                                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-bold text-slate-500 tracking-wider pointer-events-none">NAMESPACE</span>
                                                                <input
                                                                    value={newProtocol.namespace}
                                                                    onChange={e => setNewProtocol(p => ({ ...p, namespace: e.target.value, name: e.target.value }))}
                                                                    className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-32 pr-10 py-2 text-sm font-mono text-white outline-none focus:border-indigo-500 transition-colors"
                                                                    placeholder="Appliance.Module.Function"
                                                                />
                                                                {!/^[A-Z][a-zA-Z0-9]*(\.[A-Z][a-zA-Z0-9]*)+$/.test(newProtocol.namespace) && newProtocol.namespace && (
                                                                    <div className="absolute right-3 top-1/2 -translate-y-1/2 text-amber-500" title="格式建议: Appliance.Module.Function">
                                                                        <AlertTriangle size={14} />
                                                                    </div>
                                                                )}
                                                            </div>

                                                            {/* Methods Row */}
                                                            <div className="flex items-center flex-wrap gap-2 w-full">
                                                                {ALL_METHODS.map(method => {
                                                                    const isEnabled = newProtocol.methods[method]?.enabled || false;
                                                                    const isEditing = editingMethod === method;
                                                                    const colors = METHOD_COLORS[method];
                                                                    return (
                                                                        <div key={method}
                                                                            className={`flex items-center rounded-md border overflow-hidden transition-all select-none ${isEnabled ? `${colors.bgLight} border-${colors.text.split('-')[1]}-500/40` : 'bg-slate-800/50 border-slate-700'
                                                                                } ${isEditing ? 'ring-2 ring-indigo-500 ring-offset-1 ring-offset-slate-950' : ''}`}>
                                                                            {/* Checkbox area - only toggle enabled */}
                                                                            <div className="px-2 py-1.5 border-r border-inherit hover:bg-black/20 transition-colors flex items-center justify-center cursor-pointer"
                                                                                onClick={() => {
                                                                                    setNewProtocol(p => ({
                                                                                        ...p,
                                                                                        methods: { ...p.methods, [method]: { ...(p.methods[method] || { payload: '{}', schema: '{}' }), enabled: !isEnabled } }
                                                                                    }));
                                                                                }}>
                                                                                <div className={`w-4 h-4 rounded border flex items-center justify-center ${isEnabled ? `${colors.bg} border-transparent text-white` : 'border-slate-500'}`}>
                                                                                    {isEnabled && <Check size={8} strokeWidth={4} />}
                                                                                </div>
                                                                            </div>
                                                                            {/* Method name area - switch to edit this method */}
                                                                            <div className="px-2.5 py-1.5 flex flex-col cursor-pointer hover:bg-white/5 transition-colors"
                                                                                onClick={() => setEditingMethod(method)}>
                                                                                <span className={`text-xs font-bold ${isEnabled ? colors.text : 'text-slate-500'}`}>{method}</span>
                                                                                <span className="text-[10px] text-slate-500 font-mono">{METHOD_TO_ACK[method]}</span>
                                                                            </div>
                                                                        </div>
                                                                    );
                                                                })}

                                                                {/* 执行计划入口按钮 */}
                                                                <div className="flex items-center gap-2 ml-auto">
                                                                    <div className="h-6 w-px bg-slate-700 mx-1" />
                                                                    <button
                                                                        onClick={() => setEditingMethod('executionPlan')}
                                                                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold transition-all
                                                                            ${editingMethod === 'executionPlan'
                                                                                ? 'bg-indigo-500 text-white ring-2 ring-indigo-500 ring-offset-1 ring-offset-slate-950'
                                                                                : 'bg-slate-800/50 border border-slate-700 text-slate-400 hover:text-white hover:bg-slate-700'
                                                                            }`}
                                                                    >
                                                                        <Settings size={14} />
                                                                        执行计划
                                                                        {newProtocol.executionPlan?.enabled && (
                                                                            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                                                                        )}
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        </div>

                                                        {/* Method Editor Area / Execution Plan Editor */}
                                                        {editingMethod === 'executionPlan' ? (
                                                            /* 执行计划编辑器 */
                                                            <div className="flex-1 flex min-h-0 border-t border-slate-800">
                                                                <ExecutionPlanEditor
                                                                    plan={newProtocol.executionPlan}
                                                                    protocol={newProtocol}
                                                                    allProtocols={selectedSuite?.protocols || []}
                                                                    onChange={(plan) => setNewProtocol(p => ({ ...p, executionPlan: plan }))}
                                                                />
                                                            </div>
                                                        ) : (
                                                            /* 原有 Method 编辑区 */
                                                            <div className="flex-1 flex min-h-0 border-t border-slate-800">
                                                                {/* Left: Request Payload */}
                                                                <div className="w-1/2 flex flex-col border-r border-slate-800 bg-slate-950">
                                                                    <div className="px-3 py-2 border-b border-slate-800 flex justify-between items-center bg-slate-900/30">
                                                                        <div className="flex items-center gap-2">
                                                                            <span className={`w-2.5 h-2.5 rounded-full ${METHOD_COLORS[editingMethod]?.bg || 'bg-slate-500'}`} />
                                                                            <span className="text-xs font-bold text-slate-300 uppercase">Request Payload</span>
                                                                            <span className="text-xs text-slate-500 font-normal ml-2">(发送给设备的数据)</span>
                                                                        </div>
                                                                        <div className="flex items-center gap-2">
                                                                            <button onClick={() => {
                                                                                setJsonExampleInput('');
                                                                                setJsonExtractMode('payload');
                                                                                setShowJsonToSchemaModal(true);
                                                                            }} className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 transition-colors">
                                                                                <Copy size={12} /> 从示例提取
                                                                            </button>
                                                                            <button onClick={() => {
                                                                                const currentPayload = newProtocol.methods[editingMethod]?.payload || '{}';
                                                                                try {
                                                                                    const formatted = JSON.stringify(JSON.parse(currentPayload), null, 2);
                                                                                    setNewProtocol(p => ({
                                                                                        ...p,
                                                                                        methods: { ...p.methods, [editingMethod]: { ...p.methods[editingMethod], payload: formatted } }
                                                                                    }));
                                                                                    showToast('success', '格式化成功');
                                                                                } catch (e) {
                                                                                    showToast('error', 'JSON 格式错误，无法格式化');
                                                                                }
                                                                            }} className="text-xs text-slate-400 hover:text-white flex items-center gap-1 transition-colors">
                                                                                <AlignLeft size={12} /> 格式化
                                                                            </button>
                                                                        </div>
                                                                    </div>
                                                                    <div className="flex-1 overflow-hidden relative group/editor">
                                                                        {newProtocol.methods[editingMethod]?.enabled ? (
                                                                            editingMethod === 'PUSH' ? (
                                                                                <div className="flex flex-col items-center justify-center h-full text-slate-500 p-6 text-center">
                                                                                    <Bell size={32} className="mb-3 opacity-50" />
                                                                                    <p className="text-xs font-bold mb-1">PUSH 方法</p>
                                                                                    <p className="text-[10px] max-w-[180px] text-slate-600">设备主动推送消息，无需配置请求载荷</p>
                                                                                </div>
                                                                            ) : (
                                                                                <div className="absolute inset-0 overflow-hidden">
                                                                                    <PayloadEditor
                                                                                        value={newProtocol.methods[editingMethod]?.payload || '{}'}
                                                                                        onChange={(v) => setNewProtocol(p => ({
                                                                                            ...p,
                                                                                            methods: { ...p.methods, [editingMethod]: { ...p.methods[editingMethod], payload: v } }
                                                                                        }))}
                                                                                        mode="payload"
                                                                                        protocol={newProtocol}
                                                                                        method={editingMethod}
                                                                                        session={session}
                                                                                    />
                                                                                    {/* JSON Error Indicator */}
                                                                                    {(() => {
                                                                                        try {
                                                                                            JSON.parse(newProtocol.methods[editingMethod]?.payload || '{}');
                                                                                            return null;
                                                                                        } catch (e) {
                                                                                            return (
                                                                                                <div className="absolute bottom-4 right-4 px-3 py-1.5 bg-red-500/10 border border-red-500/50 rounded text-red-400 text-xs font-mono flex items-center gap-2 backdrop-blur-sm shadow-lg">
                                                                                                    <AlertTriangle size={12} /> JSON 格式错误
                                                                                                </div>
                                                                                            );
                                                                                        }
                                                                                    })()}
                                                                                </div>
                                                                            )
                                                                        ) : (
                                                                            <div className="flex flex-col items-center justify-center h-full text-slate-600">
                                                                                <p className="text-sm">方法未启用</p>
                                                                                <button onClick={() => {
                                                                                    setNewProtocol(p => ({
                                                                                        ...p,
                                                                                        methods: { ...p.methods, [editingMethod]: { ...(p.methods[editingMethod] || { payload: '{}', schema: '{}' }), enabled: true } }
                                                                                    }));
                                                                                }} className="mt-2 text-indigo-400 hover:text-indigo-300 text-xs underline">
                                                                                    启用 {editingMethod}
                                                                                </button>
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                </div>

                                                                {/* Right: Response Schema */}
                                                                <div className="w-1/2 flex flex-col bg-slate-950">
                                                                    <div className="px-3 py-2 border-b border-slate-800 flex justify-between items-center bg-slate-900/30">
                                                                        <div className="flex items-center gap-2">
                                                                            <span className={`w-2.5 h-2.5 rounded-full ${METHOD_COLORS[editingMethod]?.bg || 'bg-slate-500'}`} />
                                                                            <span className="text-xs font-bold text-slate-300 uppercase">Response Payload</span>
                                                                            <span className="text-xs text-slate-500 font-normal ml-2">(用于验证设备响应)</span>
                                                                        </div>
                                                                        <div className="flex items-center gap-2">
                                                                            <button onClick={() => {
                                                                                setJsonExampleInput('');
                                                                                setJsonExtractMode('schema_payload');
                                                                                setShowJsonToSchemaModal(true);
                                                                            }} className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 transition-colors">
                                                                                <Copy size={12} /> 从示例提取 Payload
                                                                            </button>
                                                                            <button onClick={() => {
                                                                                setShowSchemaPreview(true);
                                                                            }} className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors">
                                                                                <FileJson size={12} /> 查看 Schema
                                                                            </button>
                                                                        </div>
                                                                    </div>
                                                                    <div className="flex-1 overflow-hidden relative">
                                                                        {newProtocol.methods[editingMethod]?.enabled ? (
                                                                            <div className="absolute inset-0 overflow-hidden">
                                                                                <PayloadEditor
                                                                                    value={newProtocol.methods[editingMethod]?.schema || '{}'}
                                                                                    onChange={(v) => setNewProtocol(p => ({
                                                                                        ...p,
                                                                                        methods: { ...p.methods, [editingMethod]: { ...p.methods[editingMethod], schema: v } }
                                                                                    }))}
                                                                                    mode={(() => {
                                                                                        try {
                                                                                            const obj = JSON.parse(newProtocol.methods[editingMethod]?.schema || '{}');
                                                                                            return isLikelySchema(obj) ? 'schema' : 'payload';
                                                                                        } catch {
                                                                                            return 'payload';
                                                                                        }
                                                                                    })()}
                                                                                    protocol={newProtocol}
                                                                                    method={editingMethod}
                                                                                    session={session}
                                                                                />
                                                                                {/* JSON Error Indicator */}
                                                                                {(() => {
                                                                                    try {
                                                                                        JSON.parse(newProtocol.methods[editingMethod]?.schema || '{}');
                                                                                        return null;
                                                                                    } catch (e) {
                                                                                        return (
                                                                                            <div className="absolute bottom-4 right-4 px-3 py-1.5 bg-red-500/10 border border-red-500/50 rounded text-red-400 text-xs font-mono flex items-center gap-2 backdrop-blur-sm shadow-lg">
                                                                                                <AlertTriangle size={12} /> JSON 格式错误
                                                                                            </div>
                                                                                        );
                                                                                    }
                                                                                })()}
                                                                            </div>
                                                                        ) : (
                                                                            <div className="flex items-center justify-center h-full text-slate-600 text-sm">
                                                                                方法未启用
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
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
                                )}
                            </div>

                        </div>
                    </WorkbenchPanel>

                    <InspectionPanel
                        logs={testLogs}
                        onClearLogs={() => setTestLogs([])}
                        autoScroll={autoScroll}
                        setAutoScroll={setAutoScroll}
                        logFilter={logFilter}
                        setLogFilter={setLogFilter}
                        headerActions={null}
                    />


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
                    {
                        unverifiedProtocolsModal.show && (
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
                        )
                    }
                    {/* Import Protocol Modal */}
                    {
                        showImportProtocolModal && (
                            <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[100]" onClick={() => setShowImportProtocolModal(false)}>
                                <div className="bg-slate-900 border border-slate-700 rounded-2xl w-[900px] max-h-[85vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
                                    <div className="flex items-center justify-between p-6 border-b border-slate-800">
                                        <h3 className="text-xl font-black text-white flex items-center gap-2">
                                            <Download size={24} className="text-indigo-400" />
                                            导入协议
                                        </h3>
                                        <button onClick={() => setShowImportProtocolModal(false)} className="text-slate-400 hover:text-white">
                                            <X size={24} />
                                        </button>
                                    </div>

                                    <div className="flex-1 overflow-hidden flex">
                                        {/* Left Sidebar: Filters */}
                                        <div className="w-64 bg-slate-950 border-r border-slate-800 p-4 flex flex-col gap-6">
                                            {/* Source Project Filter */}
                                            <div>
                                                <label className="text-xs font-bold text-slate-500 uppercase mb-2 block">来源项目</label>
                                                <select
                                                    value={importSourceSuiteId}
                                                    onChange={e => {
                                                        setImportSourceSuiteId(e.target.value);
                                                        setImportSelectedTags(new Set());
                                                        setImportSelectedProtocols(new Set());
                                                    }}
                                                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-indigo-500"
                                                >
                                                    <option value="">选择项目...</option>
                                                    {projects.filter(p => p.id !== activeProject?.id).map(p => (
                                                        <option key={p.id} value={p.id}>{p.name}</option>
                                                    ))}
                                                </select>
                                            </div>
                                        </div>

                                        {/* Right: Protocol List */}
                                        <div className="flex-1 flex flex-col bg-slate-900">
                                            {(() => {
                                                const sourceProject = projects.find(p => p.id === importSourceSuiteId);
                                                const sourceProtocols = sourceProject ? sourceProject.protocols : [];

                                                return (
                                                    <>
                                                        <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                                                            {sourceProtocols.length === 0 ? (
                                                                <div className="text-center text-slate-500 mt-10">
                                                                    {importSourceSuiteId ? '该项目没有可用的协议' : '请先选择一个来源项目'}
                                                                </div>
                                                            ) : (
                                                                <div className="space-y-2">
                                                                    {sourceProtocols.map(p => (
                                                                        <div key={p.id}
                                                                            className={`p-3 rounded-lg border cursor-pointer flex items-center justify-between transition-colors ${importSelectedProtocols.has(p.id) ? 'bg-indigo-900/20 border-indigo-500/50' : 'bg-slate-800/50 border-slate-700 hover:border-slate-600'}`}
                                                                            onClick={() => {
                                                                                const newSet = new Set(importSelectedProtocols);
                                                                                if (newSet.has(p.id)) newSet.delete(p.id);
                                                                                else newSet.add(p.id);
                                                                                setImportSelectedProtocols(newSet);
                                                                            }}
                                                                        >
                                                                            <div>
                                                                                <div className="font-bold text-white text-sm font-mono">{p.namespace}</div>
                                                                                <div className="text-xs text-slate-500 mt-1 flex gap-2">
                                                                                    {Object.keys(p.methods).filter(m => p.methods[m as RequestMethod]?.enabled).map(m => (
                                                                                        <span key={m} className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${getMethodColorClasses(m)}`}>
                                                                                            {m}
                                                                                        </span>
                                                                                    ))}
                                                                                </div>
                                                                            </div>
                                                                            {importSelectedProtocols.has(p.id) && <CheckCircle2 size={18} className="text-indigo-400" />}
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            )}
                                                        </div>

                                                        <div className="p-4 border-t border-slate-800 flex justify-end gap-3 bg-slate-950">
                                                            <button onClick={() => setShowImportProtocolModal(false)} className="px-4 py-2 text-slate-400 hover:text-white text-sm font-bold">取消</button>
                                                            <button
                                                                onClick={() => {
                                                                    const sourceProject = projects.find(p => p.id === importSourceSuiteId);
                                                                    const sourceProtocols = sourceProject ? sourceProject.protocols : [];
                                                                    const protocolsToImport = sourceProtocols.filter(p => importSelectedProtocols.has(p.id));

                                                                    if (protocolsToImport.length === 0) return;

                                                                    setSuites(prev => prev.map(s => {
                                                                        if (s.id === selectedSuiteId) {
                                                                            const newProtocols = protocolsToImport.map(p => ({
                                                                                ...p,
                                                                                id: Math.random().toString(36).substr(2, 9),
                                                                                reviewStatus: 'UNVERIFIED' as const,
                                                                                lastRun: undefined
                                                                            }));
                                                                            return {
                                                                                ...s,
                                                                                protocols: [...s.protocols, ...newProtocols],
                                                                                updatedAt: Date.now()
                                                                            };
                                                                        }
                                                                        return s;
                                                                    }));

                                                                    showToast('success', `成功导入 ${protocolsToImport.length} 个协议`);
                                                                    setShowImportProtocolModal(false);
                                                                    setImportSelectedProtocols(new Set());
                                                                    setImportSelectedTags(new Set());
                                                                }}
                                                                disabled={importSelectedProtocols.size === 0}
                                                                className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-bold disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                                                            >
                                                                导入选中协议 ({importSelectedProtocols.size})
                                                            </button>
                                                        </div>
                                                    </>
                                                );
                                            })()}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )
                    }

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
                                                    } else if (jsonExtractMode === 'schema_payload') {
                                                        // Response: 仅提取 payload 作为 schema 模板
                                                        const payloadData = parsed.payload !== undefined ? parsed.payload : parsed;
                                                        const payloadStr = JSON.stringify(payloadData, null, 2);

                                                        setNewProtocol(p => ({
                                                            ...p,
                                                            methods: {
                                                                ...p.methods,
                                                                [currentMethod]: {
                                                                    ...p.methods[currentMethod],
                                                                    schema: payloadStr
                                                                }
                                                            }
                                                        }));
                                                        setShowJsonToSchemaModal(false);
                                                        showToast('success', 'Payload 已提取到 Schema 编辑器');
                                                    } else {
                                                        // 生成 Schema - 第一步：解析并准备必填字段选择
                                                        const schema = generateSchemaFromJson(parsed, false); // 先不生成 required
                                                        setGeneratedSchema(JSON.stringify(schema, null, 2));

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
                                    <h3 className="text-lg font-black text-white mb-4">编辑 Schema</h3>
                                    <p className="text-sm text-slate-400 mb-4">
                                        您可以编辑 Schema 结构，并勾选 <span className="text-red-400 font-bold">Required</span> 复选框来标记必填字段。
                                    </p>

                                    <div className="flex-1 overflow-hidden border border-slate-700 rounded-lg bg-slate-950 relative">
                                        <PayloadEditor
                                            value={typeof generatedSchema === 'string' ? generatedSchema : JSON.stringify(generatedSchema, null, 2)}
                                            onChange={(v) => setGeneratedSchema(v)}
                                            mode="schema"
                                            protocol={newProtocol}
                                            method={getEnabledMethods()[currentMethodIndex]}
                                            session={session}
                                        />
                                    </div>

                                    <div className="flex justify-end gap-3 mt-6">
                                        <button
                                            onClick={() => setShowRequiredFieldsModal(false)}
                                            className="px-4 py-2 text-slate-400 hover:text-white"
                                        >
                                            取消
                                        </button>
                                        <button
                                            onClick={() => {
                                                const methods = getEnabledMethods();
                                                const currentMethod = methods[currentMethodIndex];

                                                if (currentMethod) {
                                                    setNewProtocol(p => ({
                                                        ...p,
                                                        methods: {
                                                            ...p.methods,
                                                            [currentMethod]: {
                                                                ...p.methods[currentMethod],
                                                                schema: typeof generatedSchema === 'string' ? generatedSchema : JSON.stringify(generatedSchema, null, 2)
                                                            }
                                                        }
                                                    }));
                                                }

                                                setShowRequiredFieldsModal(false);
                                            }}
                                            className="px-6 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold"
                                        >
                                            应用 Schema
                                        </button>
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
                        existingProtocols={suites.find(s => s.id === selectedSuiteId)?.protocols || []}
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
                        batchResult={viewingResult?.batchResult || null}
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

                    {/* Test Progress Floating Panel */}
                    {testProgress && (
                        <div className={`fixed z-[200] transition-all duration-300 ease-in-out ${testProgressMinimized ? 'bottom-6 right-6 w-72' : 'bottom-6 right-6 w-[400px] shadow-2xl'} bg-slate-900 border border-slate-700 rounded-xl flex flex-col overflow-hidden`}>
                            {/* Header / Drag Handle area (non-draggable for now, just header) */}
                            <div className="bg-slate-800/80 px-4 py-3 flex items-center justify-between border-b border-slate-700">
                                <div className="flex items-center gap-2">
                                    {isPaused ? <Activity size={16} className="text-amber-500" /> : <Activity size={16} className="text-indigo-400 animate-pulse" />}
                                    <h3 className="text-sm font-bold text-white">
                                        {isPaused ? '测试已暂停' : testProgress.waitingForUser ? '等待操作...' : '正在执行测试...'}
                                    </h3>
                                </div>
                                <div className="flex items-center gap-1 text-slate-400">
                                    <button onClick={() => setTestProgressMinimized(!testProgressMinimized)} className="p-1 hover:text-white hover:bg-slate-700 rounded transition-colors" title={testProgressMinimized ? '展开' : '最小化'}>
                                        {testProgressMinimized ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
                                    </button>
                                </div>
                            </div>

                            {/* Content */}
                            {!testProgressMinimized && (
                                <div className="p-5 flex flex-col">
                                    {/* Primary Progress Info */}
                                    <div className="flex items-center gap-4 mb-4">
                                        <div className="relative w-12 h-12 shrink-0">
                                            <svg className="w-full h-full transform -rotate-90">
                                                <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="4" fill="none" className="text-slate-800" />
                                                <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="4" fill="none" className={`${isPaused ? 'text-amber-500' : 'text-indigo-500'} transition-all duration-300 ease-out`}
                                                    strokeDasharray={125.6}
                                                    strokeDashoffset={125.6 - (125.6 * testProgress.current) / testProgress.total}
                                                />
                                            </svg>
                                            <div className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-white">
                                                {Math.round((testProgress.current / testProgress.total) * 100)}%
                                            </div>
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-xs font-mono text-slate-500 mb-1">
                                                ({testProgress.current} / {testProgress.total})
                                            </div>
                                            <p className="text-sm text-slate-200 font-medium truncate" title={testProgress.currentProtocol}>
                                                {testProgress.currentProtocol || '准备中...'}
                                            </p>
                                        </div>
                                    </div>

                                    {/* Step Progress Info */}
                                    {testProgress.stepCurrent && testProgress.stepTotal && (
                                        <div className="bg-slate-800/50 rounded-lg p-3 mb-4 border border-slate-700/50">
                                            <div className="flex justify-between items-center mb-1.5">
                                                <span className="text-[11px] font-bold text-indigo-400">Step {testProgress.stepCurrent}/{testProgress.stepTotal}</span>
                                                {testProgress.countdown !== undefined && (
                                                    <span className="text-[11px] font-mono text-amber-400 font-bold bg-amber-500/10 px-1.5 py-0.5 rounded">{testProgress.countdown}s 剩余</span>
                                                )}
                                            </div>
                                            <p className="text-xs text-slate-400 truncate mb-2" title={testProgress.stepDescription}>
                                                {testProgress.stepDescription}
                                            </p>
                                            <div className="w-full bg-slate-800 rounded-full h-1">
                                                <div className={`h-1 rounded-full transition-all duration-300 ${isPaused ? 'bg-amber-500' : 'bg-indigo-500'}`}
                                                    style={{ width: `${(testProgress.stepCurrent / testProgress.stepTotal) * 100}%` }}
                                                />
                                            </div>
                                        </div>
                                    )}

                                    {/* Controls */}
                                    <div className="flex items-center gap-2 mt-2 pt-4 border-t border-slate-800">
                                        <button
                                            onClick={togglePauseTest}
                                            className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-bold transition-all ${isPaused ? 'bg-indigo-600 hover:bg-indigo-500 text-white' : 'bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white'}`}
                                        >
                                            {isPaused ? <Play size={14} fill="currentColor" /> : <Pause size={14} fill="currentColor" />}
                                            {isPaused ? '继续执行' : '暂停'}
                                        </button>
                                        <button
                                            onClick={stopTests}
                                            className="px-4 py-2 hover:bg-red-900/40 text-red-500 hover:text-red-400 bg-red-950/20 border border-red-900/30 hover:border-red-500/50 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5"
                                        >
                                            <Square size={12} fill="currentColor" /> 终止
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* Minimized Progress Bar (bottom edge) */}
                            {testProgressMinimized && (
                                <div className="h-1 w-full bg-slate-800 relative">
                                    <div className={`absolute left-0 top-0 h-full ${isPaused ? 'bg-amber-500' : 'bg-indigo-500'} transition-all duration-300`}
                                        style={{ width: `${(testProgress.current / testProgress.total) * 100}%` }}
                                    />
                                    {isPaused && <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full h-full animate-pulse bg-white/20" />}
                                </div>
                            )}
                        </div>
                    )}

                    {/* 手动操作确认弹窗 */}
                    {manualActionModal?.show && (
                        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[250]">
                            <div className="bg-slate-900 border border-amber-500/30 rounded-2xl p-8 w-[440px] flex flex-col items-center shadow-2xl">
                                <div className="w-14 h-14 rounded-full bg-amber-500/10 border-2 border-amber-500/30 flex items-center justify-center mb-4">
                                    <AlertTriangle size={28} className="text-amber-400" />
                                </div>
                                <h3 className="text-lg font-bold text-white mb-1">需要手动操作</h3>
                                <p className="text-xs text-slate-500 mb-4">
                                    {manualActionModal.protocolName} · 步骤 {manualActionModal.stepIndex}/{manualActionModal.totalSteps}
                                </p>
                                <div className="w-full bg-slate-800/50 rounded-lg p-4 mb-6 border border-slate-700">
                                    <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">
                                        {manualActionModal.instruction}
                                    </p>
                                </div>
                                <button
                                    onClick={() => manualActionModal.resolve?.()}
                                    className="px-8 py-2.5 bg-amber-500 hover:bg-amber-400 text-black font-bold rounded-lg text-sm transition-colors"
                                >
                                    {manualActionModal.confirmText}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* 手动输入弹窗 */}
                    {manualInputModal?.show && (
                        <ManualInputDialog
                            fields={manualInputModal.fields}
                            protocolName={manualInputModal.protocolName}
                            targetMethod={manualInputModal.targetMethod}
                            stepIndex={manualInputModal.stepIndex}
                            totalSteps={manualInputModal.totalSteps}
                            onConfirm={(values: Record<string, any>) => manualInputModal.resolve?.(values)}
                        />
                    )}

                    {/* Audit Confirmation Modal */}
                    {auditConfirmation.show && auditConfirmation.protocol && auditConfirmation.method && (
                        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[150]" onClick={() => setAuditConfirmation({ show: false, protocol: null, method: null })}>
                            <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-[600px] max-h-[90vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
                                <h3 className="text-lg font-black text-white mb-4 flex items-center gap-2">
                                    <Activity size={20} className="text-indigo-400" />
                                    Run Protocol Test
                                </h3>

                                <div className="mb-6">
                                    <div className="text-sm text-slate-400 mb-2">Protocol: <span className="text-white font-bold">{auditConfirmation.protocol.namespace}</span></div>
                                    <div className="text-sm text-slate-400">Method: <span className={`font-bold ${METHOD_COLORS[auditConfirmation.method as RequestMethod]?.text || 'text-slate-400'}`}>{auditConfirmation.method}</span></div>
                                </div>

                                {/* Test Method Selection */}
                                <div className="space-y-4 mb-6">
                                    <div className="text-xs font-bold text-slate-500 uppercase">Verification Mode</div>
                                    <div className="grid grid-cols-2 gap-4">
                                        <button
                                            className="p-4 rounded-xl border border-slate-700 bg-slate-800/50 hover:bg-slate-800 text-left transition-all group focus:ring-2 ring-indigo-500"
                                        >
                                            <div className="font-bold text-white mb-1 group-hover:text-emerald-400">Direct Fetch / Wait</div>
                                            <div className="text-xs text-slate-500">Use default payload or wait for device push. Suitable for GET/monitoring.</div>
                                        </button>
                                        <button
                                            className="p-4 rounded-xl border border-slate-700 bg-slate-800/50 hover:bg-slate-800 text-left transition-all group focus:ring-2 ring-indigo-500"
                                        >
                                            <div className="font-bold text-white mb-1 group-hover:text-amber-400">Manual Modification</div>
                                            <div className="text-xs text-slate-500">Manually modify the payload before sending. Required for strict audit.</div>
                                        </button>
                                    </div>
                                </div>

                                {/* Payload Editor */}
                                <div className="flex-1 min-h-[200px] border border-slate-700 rounded-lg overflow-hidden bg-slate-950 flex flex-col mb-6">
                                    <div className="px-3 py-2 border-b border-slate-800 bg-slate-900/50 text-xs font-bold text-slate-400">
                                        Request Payload
                                    </div>
                                    <div className="flex-1 relative">
                                        <PayloadEditor
                                            value={auditConfirmation.protocol.methods[auditConfirmation.method]?.payload || '{}'}
                                            onChange={(v) => {
                                                if (auditConfirmation.protocol && auditConfirmation.method) {
                                                    const p = auditConfirmation.protocol;
                                                    const m = auditConfirmation.method;
                                                    setNewProtocol(prev => ({
                                                        ...prev,
                                                        methods: {
                                                            ...prev.methods,
                                                            [m]: { ...prev.methods[m], payload: v }
                                                        }
                                                    }));
                                                }
                                            }}
                                            mode="payload"
                                            protocol={auditConfirmation.protocol}
                                            method={auditConfirmation.method}
                                            session={session}
                                        />
                                    </div>
                                </div>

                                <div className="flex justify-end gap-3">
                                    <button
                                        onClick={() => setAuditConfirmation({ show: false, protocol: null, method: null })}
                                        className="px-4 py-2 text-slate-400 hover:text-white"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={async () => {
                                            const { protocol, method } = auditConfirmation;
                                            if (!protocol || !method) return;
                                            setAuditConfirmation({ show: false, protocol: null, method: null });
                                            setRunningTest(`${protocol.id}:${method}`);
                                            await runSingleTest(protocol, method);
                                            setRunningTest(null);
                                        }}
                                        className="px-6 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold shadow-lg shadow-emerald-900/20"
                                    >
                                        Confirm & Run
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}



                    {/* Add Protocol Modal */}
                    {
                        isAddingProtocol && (
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
                                            <textarea
                                                value={newProtocol.description || ''}
                                                onChange={(e) => setNewProtocol(prev => ({ ...prev, description: e.target.value }))}
                                                className="w-full bg-slate-800 text-white px-4 py-2 rounded-lg border border-slate-700 focus:border-indigo-500 outline-none h-24 resize-none"
                                                placeholder="Optional description"
                                            />
                                        </div>
                                        <div>
                                            <label className="text-sm text-slate-400 block mb-2">Tags (comma separated)</label>
                                            <input
                                                type="text"
                                                value={newProtocol.tags?.join(', ') || ''}
                                                onChange={(e) => {
                                                    const tags = e.target.value.split(',').map(t => t.trim()).filter(t => t);
                                                    setNewProtocol(prev => ({ ...prev, tags }));
                                                }}
                                                className="w-full bg-slate-800 text-white px-4 py-2 rounded-lg border border-slate-700 focus:border-indigo-500 outline-none"
                                                placeholder="e.g. control, system, v1"
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
                                                // So we need to ensure methods are initialized if empty.

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
                        )
                    }

                    {/* JSON Input Modal (For Schema/Payload Generation) */}
                    {showJsonToSchemaModal && (
                        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 backdrop-blur-sm" onClick={() => setShowJsonToSchemaModal(false)}>
                            <div className="bg-[#0f172a] rounded-xl p-0 max-w-2xl w-full mx-4 border border-slate-800 shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
                                <div className="p-6 pb-4">
                                    <h3 className="text-lg font-bold text-white mb-2">
                                        {jsonExtractMode === 'schema' ? '从 JSON 示例生成 Schema' : '从 JSON 示例提取 Payload'}
                                    </h3>
                                    <p className="text-sm text-slate-400">
                                        {jsonExtractMode === 'schema'
                                            ? '粘贴完整的响应 JSON，自动生成用于验证的 Schema 结构。'
                                            : '粘贴完整的协议消息 JSON，自动提取其中的 payload 部分。'}
                                    </p>
                                </div>
                                <div className="px-6 py-2">
                                    <div className="bg-slate-950 rounded-lg border border-slate-800 p-4">
                                        <div className="text-xs text-slate-500 mb-2 font-mono">粘贴完整 JSON 示例:</div>
                                        <textarea
                                            value={jsonExampleInput}
                                            onChange={(e) => setJsonExampleInput(e.target.value)}
                                            className="w-full h-64 bg-transparent text-emerald-400 font-mono text-sm outline-none resize-none placeholder-slate-700 custom-scrollbar"
                                            placeholder={jsonExtractMode === 'schema'
                                                ? `{\n  "header": { "code": 0, ... },\n  "payload": { "status": "ok" }\n}`
                                                : `{\n  "header": { "method": "SET", ... },\n  "payload": { "switch": { "on": 1 } }\n}`}
                                        />
                                    </div>
                                </div>
                                <div className="p-6 pt-4 flex justify-end gap-3">
                                    <button
                                        onClick={() => setShowJsonToSchemaModal(false)}
                                        className="px-4 py-2 text-slate-400 hover:text-white text-sm transition-colors"
                                    >
                                        取消
                                    </button>
                                    <button
                                        onClick={() => {
                                            try {
                                                const json = JSON.parse(jsonExampleInput);
                                                if (jsonExtractMode === 'payload') {
                                                    // Extract payload if it exists, otherwise use full json
                                                    const payloadData = json.payload !== undefined ? json.payload : json;

                                                    setNewProtocol(p => ({
                                                        ...p,
                                                        methods: {
                                                            ...p.methods,
                                                            [editingMethod]: {
                                                                ...p.methods[editingMethod],
                                                                payload: JSON.stringify(payloadData, null, 2)
                                                            }
                                                        }
                                                    }));
                                                    setShowJsonToSchemaModal(false);
                                                    showToast('success', 'Payload 已提取并更新');
                                                } else {
                                                    // Schema Generation Logic
                                                    // Simple schema generator
                                                    const generateSimpleSchema = (val: any): any => {
                                                        if (val === null) return { type: 'null' };
                                                        if (Array.isArray(val)) {
                                                            return {
                                                                type: 'array',
                                                                items: val.length > 0 ? generateSimpleSchema(val[0]) : {}
                                                            };
                                                        }
                                                        if (typeof val === 'object') {
                                                            const props: any = {};
                                                            Object.keys(val).forEach(k => props[k] = generateSimpleSchema(val[k]));
                                                            return { type: 'object', properties: props };
                                                        }
                                                        return { type: typeof val };
                                                    };

                                                    const schema = generateSimpleSchema(json);
                                                    setGeneratedSchema(JSON.stringify(schema, null, 2));
                                                    setShowJsonToSchemaModal(false);
                                                    setShowRequiredFieldsModal(true);
                                                }
                                            } catch (e) {
                                                showToast('error', '无效的 JSON 格式');
                                            }
                                        }}
                                        className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-bold shadow-lg shadow-blue-900/20 transition-all"
                                    >
                                        {jsonExtractMode === 'schema' ? '生成 Schema' : '提取 Payload'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Schema Preview Modal */}
                    {showSchemaPreview && (
                        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 backdrop-blur-sm" onClick={() => setShowSchemaPreview(false)}>
                            <div className="bg-[#0f172a] rounded-xl p-0 max-w-3xl w-full mx-4 border border-slate-800 shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
                                <div className="p-6 pb-4 border-b border-slate-800">
                                    <h3 className="text-lg font-bold text-white mb-2">
                                        Schema 预览
                                    </h3>
                                    <p className="text-sm text-slate-400">
                                        这是当前配置生成的最终 JSON Schema，将用于验证设备响应。
                                    </p>
                                </div>
                                <div className="p-0">
                                    <div className="bg-slate-950 p-4 max-h-[60vh] overflow-auto custom-scrollbar">
                                        <pre className="text-xs font-mono text-emerald-400 whitespace-pre-wrap break-all">
                                            {(() => {
                                                try {
                                                    const schemaContent = newProtocol.methods[editingMethod]?.schema;
                                                    const parsed = typeof schemaContent === 'string' ? JSON.parse(schemaContent) : schemaContent;
                                                    // 尝试判断是否已经是 Schema 格式 (包含 type 或 properties)
                                                    if (parsed.type || parsed.properties) {
                                                        return JSON.stringify(parsed, null, 2);
                                                    }
                                                    // 否则视为 Payload 模板，生成 Schema
                                                    const generated = generateSchemaFromJson(parsed, true); // 默认全必填? 或者根据编辑器状态?
                                                    // 由于编辑器状态(required)未持久化到 schema 字符串，这里只能生成基础 Schema
                                                    // 如果需要精确控制，需要解决 required 持久化问题
                                                    return JSON.stringify(generated, null, 2);
                                                } catch (e) {
                                                    return newProtocol.methods[editingMethod]?.schema || '{}';
                                                }
                                            })()}
                                        </pre>
                                    </div>
                                </div>
                                <div className="p-6 pt-4 flex justify-end gap-3 border-t border-slate-800">
                                    <button
                                        onClick={() => {
                                            const content = (() => {
                                                try {
                                                    const schemaContent = newProtocol.methods[editingMethod]?.schema;
                                                    const parsed = typeof schemaContent === 'string' ? JSON.parse(schemaContent) : schemaContent;
                                                    if (parsed.type || parsed.properties) {
                                                        return JSON.stringify(parsed, null, 2);
                                                    }
                                                    const generated = generateSchemaFromJson(parsed, true);
                                                    return JSON.stringify(generated, null, 2);
                                                } catch (e) {
                                                    return newProtocol.methods[editingMethod]?.schema || '{}';
                                                }
                                            })();
                                            navigator.clipboard.writeText(content);
                                            showToast('success', 'Schema 已复制到剪贴板');
                                        }}
                                        className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-bold transition-colors flex items-center gap-2"
                                    >
                                        <Copy size={14} /> 复制
                                    </button>
                                    <button
                                        onClick={() => setShowSchemaPreview(false)}
                                        className="px-6 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm font-bold transition-colors"
                                    >
                                        关闭
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                    {/* Copy Protocol Modal */}
                    {showCopyProtocolModal && (
                        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
                            <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-[450px]">
                                <h3 className="text-lg font-black text-white mb-4">复制协议</h3>
                                <div className="space-y-4">
                                    <div>
                                        <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">目标测试库</label>
                                        <select
                                            value={copyTargetSuiteId}
                                            onChange={e => setCopyTargetSuiteId(e.target.value)}
                                            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-4 py-3 text-sm text-white outline-none focus:border-indigo-500"
                                        >
                                            <option value="">选择测试库...</option>
                                            {suites.map(s => (
                                                <option key={s.id} value={s.id}>{s.name}</option>
                                            ))}
                                        </select>
                                    </div>
                                    <div className="p-4 bg-slate-800/50 rounded-lg border border-slate-700/50">
                                        <div className="text-xs text-slate-400 mb-1">将复制以下协议:</div>
                                        <div className="font-mono text-sm text-white font-bold">{newProtocol.namespace}</div>
                                        <div className="text-xs text-slate-500 mt-1">新协议将自动命名为 "{newProtocol.name}_copy" 并重置为未验证状态。</div>
                                    </div>
                                </div>
                                <div className="mt-6 flex justify-end gap-3">
                                    <button
                                        onClick={() => setShowCopyProtocolModal(false)}
                                        className="px-4 py-2 text-slate-400 hover:text-white font-bold transition-colors"
                                    >
                                        取消
                                    </button>
                                    <button
                                        onClick={() => {
                                            handleCopyProtocol();
                                            setShowCopyProtocolModal(false);
                                        }}
                                        disabled={!copyTargetSuiteId}
                                        className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-bold transition-colors"
                                    >
                                        确认复制
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

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
                            setConfirmationModal({
                                show: true,
                                title: '清除历史记录',
                                message: '确定要清除所有测试历史记录吗？',
                                onConfirm: () => {
                                    setTestHistory([]);
                                    setConfirmationModal({ show: false, title: '', message: '', onConfirm: () => { } });
                                }
                            });
                        }}
                    />

                    {/* Confirmation Modal */}
                    {confirmationModal.show && (
                        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[200]" onClick={() => setConfirmationModal({ ...confirmationModal, show: false })}>
                            <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-[400px] shadow-2xl" onClick={e => e.stopPropagation()}>
                                <h3 className="text-lg font-bold text-white mb-2">{confirmationModal.title}</h3>
                                <p className="text-slate-400 text-sm mb-6">{confirmationModal.message}</p>
                                <div className="flex justify-end gap-3">
                                    <button
                                        onClick={() => setConfirmationModal({ ...confirmationModal, show: false })}
                                        className="px-4 py-2 text-slate-400 hover:text-white font-bold transition-colors"
                                    >
                                        取消
                                    </button>
                                    <button
                                        onClick={confirmationModal.onConfirm}
                                        className="px-6 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg font-bold transition-colors"
                                    >
                                        确认
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                    {/* Verification Configuration Modal - 验证配置模态框 */}
                    {verificationModal.show && verificationModal.protocol && (
                        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[150]" onClick={() => setVerificationModal({ ...verificationModal, show: false })}>
                            <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-[500px] shadow-2xl" onClick={e => e.stopPropagation()}>
                                <h3 className="text-lg font-black text-white mb-4 flex items-center gap-2">
                                    <ShieldCheck size={20} className="text-emerald-400" />
                                    协议审核
                                </h3>

                                <p className="text-sm text-slate-400 mb-6">
                                    确认 <span className="text-white font-bold">{verificationModal.protocol.namespace}</span> 协议的配置已正确无误？
                                </p>

                                {/* 协议当前状态预览 */}
                                <div className="bg-slate-800/50 rounded-xl p-4 mb-6 border border-slate-700">
                                    <div className="text-xs font-bold text-slate-400 uppercase mb-2">当前协议信息</div>
                                    <div className="grid grid-cols-2 gap-3 text-sm">
                                        <div>
                                            <span className="text-slate-500">命名空间：</span>
                                            <span className="text-white font-mono">{verificationModal.protocol.namespace}</span>
                                        </div>
                                        <div>
                                            <span className="text-slate-500">已启用方法：</span>
                                            <span className="text-white">
                                                {ALL_METHODS.filter(m => verificationModal.protocol?.methods[m]?.enabled).join(', ') || '无'}
                                            </span>
                                        </div>
                                    </div>
                                </div>

                                <div className="flex justify-between gap-3 pt-4 border-t border-slate-800">
                                    {/* 左侧：跳转编辑 */}
                                    <button
                                        onClick={() => {
                                            setVerificationModal({ ...verificationModal, show: false });
                                            setRightPanelTab('edit');
                                        }}
                                        className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg font-bold transition-colors flex items-center gap-2"
                                    >
                                        <Edit3 size={14} /> 返回编辑
                                    </button>

                                    {/* 右侧：确认操作 */}
                                    <div className="flex gap-3">
                                        <button
                                            onClick={() => setVerificationModal({ ...verificationModal, show: false })}
                                            className="px-4 py-2 text-slate-400 hover:text-white font-bold transition-colors"
                                        >
                                            取消
                                        </button>
                                        <button
                                            onClick={() => {
                                                if (verificationModal.protocol) {
                                                    const updatedProtocol = {
                                                        ...verificationModal.protocol,
                                                        reviewStatus: 'VERIFIED' as const,
                                                        verificationMode: 'direct' as const
                                                    };
                                                    setNewProtocol(updatedProtocol);

                                                    // Update in suite
                                                    if (selectedSuiteId) {
                                                        setSuites(prev => prev.map(s => {
                                                            if (s.id !== selectedSuiteId) return s;
                                                            return {
                                                                ...s,
                                                                protocols: s.protocols.map(p =>
                                                                    p.id === updatedProtocol.id ? updatedProtocol : p
                                                                ),
                                                                updatedAt: Date.now()
                                                            };
                                                        }));
                                                    }

                                                    setVerificationModal({ ...verificationModal, show: false });
                                                    showToast('success', '协议已标记为已审核');
                                                }
                                            }}
                                            className="px-6 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold shadow-lg shadow-emerald-900/20 transition-all flex items-center gap-2"
                                        >
                                            <CheckCircle2 size={16} /> 确认审核
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Unsaved Changes Modal */}
                    {showUnsavedChangesModal && (
                        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[200]" onClick={() => setShowUnsavedChangesModal(false)}>
                            <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-[400px] shadow-2xl" onClick={e => e.stopPropagation()}>
                                <h3 className="text-lg font-black text-white mb-4 flex items-center gap-2">
                                    <AlertTriangle size={20} className="text-amber-500" />
                                    未保存的更改
                                </h3>
                                <p className="text-slate-400 mb-6 text-sm">
                                    当前协议有未保存的更改。继续操作可能会导致更改丢失或被忽略。是否继续？
                                </p>
                                <div className="flex justify-end gap-3">
                                    <button
                                        onClick={() => setShowUnsavedChangesModal(false)}
                                        className="px-4 py-2 text-slate-400 hover:text-white font-bold transition-colors"
                                    >
                                        取消
                                    </button>
                                    <button
                                        onClick={() => {
                                            setShowUnsavedChangesModal(false);
                                            if (pendingNavigation) {
                                                pendingNavigation();
                                                setPendingNavigation(null);
                                            }
                                        }}
                                        className="px-6 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg font-bold shadow-lg shadow-red-900/20 transition-all"
                                    >
                                        忽略更改并继续
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                    {/* New Project Modal */}
                    {showNewProjectModal && (
                        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[200]" onClick={() => setShowNewProjectModal(false)}>
                            <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-[450px] shadow-2xl" onClick={e => e.stopPropagation()}>
                                <h3 className="text-lg font-bold text-white mb-4">Create New Project</h3>
                                <div className="space-y-4">
                                    <div>
                                        <label className="text-sm text-slate-400 block mb-2">Project Name *</label>
                                        <input
                                            type="text"
                                            value={newProjectData.name}
                                            onChange={(e) => setNewProjectData(prev => ({ ...prev, name: e.target.value }))}
                                            className="w-full bg-slate-800 text-white px-4 py-2 rounded-lg border border-slate-700 focus:border-blue-500 outline-none"
                                            placeholder="e.g. Smart Home V2"
                                            autoFocus
                                        />
                                    </div>
                                    <div>
                                        <label className="text-sm text-slate-400 block mb-2">Description</label>
                                        <textarea
                                            value={newProjectData.description}
                                            onChange={(e) => setNewProjectData(prev => ({ ...prev, description: e.target.value }))}
                                            className="w-full bg-slate-800 text-white px-4 py-2 rounded-lg border border-slate-700 focus:border-blue-500 outline-none h-24 resize-none"
                                            placeholder="Optional project description..."
                                        />
                                    </div>
                                </div>
                                <div className="flex justify-end gap-3 mt-6">
                                    <button
                                        onClick={() => setShowNewProjectModal(false)}
                                        className="px-4 py-2 text-slate-400 hover:text-white font-bold transition-colors"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={confirmCreateProject}
                                        className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-bold transition-colors"
                                    >
                                        Create Project
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                    {/* Generic Confirmation Modal */}
                    {confirmDialog.show && (
                        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[200] backdrop-blur-sm" onClick={() => setConfirmDialog(prev => ({ ...prev, show: false }))}>
                            <div className="bg-slate-900 rounded-2xl p-6 max-w-sm w-full mx-4 border border-slate-700 shadow-2xl" onClick={e => e.stopPropagation()}>
                                <h3 className="text-lg font-bold text-white mb-2">{confirmDialog.title}</h3>
                                <p className="text-sm text-slate-400 mb-6">{confirmDialog.message}</p>
                                <div className="flex justify-end gap-3">
                                    <button
                                        onClick={() => setConfirmDialog(prev => ({ ...prev, show: false }))}
                                        className="px-4 py-2 text-slate-400 hover:text-white text-sm"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={confirmDialog.onConfirm}
                                        className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-bold shadow-lg shadow-red-900/20"
                                    >
                                        Confirm
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div >
        </div >
    );
};
