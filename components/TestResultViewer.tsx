/**
 * TestResultViewer - 测试结果查看器组件
 * 
 * 功能：
 * 1. 完整展示请求/响应数据（左右对比布局）
 * 2. 期望值与实际值的 Side-by-Side Diff 高亮
 * 3. Schema 验证错误详情
 * 4. 批量测试汇总面板
 */

import React, { useState, useMemo, useEffect } from 'react';
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
    deviceId?: string;
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



/**
 * Side-by-Side Diff 视图组件
 */


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

interface HighlightedJSONProps {
    data: any;
    errors?: any[];
    mode?: 'data' | 'schema'; // 'data' uses instancePath, 'schema' uses schemaPath
    highlightColor?: 'red' | 'amber' | 'blue';
    hideErrorText?: boolean;
}

const HighlightedJSON: React.FC<HighlightedJSONProps> = ({ data, errors, mode = 'data', highlightColor = 'red', hideErrorText = false }) => {
    const errorMap = useMemo(() => {
        const map = new Map<string, string>();
        if (!errors) return map;

        const hasPayload = data && typeof data === 'object' && 'payload' in data;

        errors.forEach(err => {
            let path = '';

            if (mode === 'schema') {
                // For schema, use schemaPath
                // schemaPath format: "#/properties/payload/properties/system/..."
                path = err.schemaPath || '';
                if (path.startsWith('#')) {
                    path = path.substring(1);
                }

                // If we are displaying a wrapped object (Response Structure) where schema is under /payload
                // We need to adjust the path if it doesn't already start with /payload
                if (hasPayload && !path.startsWith('/payload')) {
                    if (!path.startsWith('/') && path !== '') {
                        path = '/' + path;
                    }
                    path = '/payload' + path;
                }
            } else {
                // For data (request/response), use instancePath
                path = err.instancePath ?? err.dataPath ?? '';

                // Normalize path to JSON Pointer
                if (path.startsWith('.')) {
                    path = path.replace(/^\./, '/').replace(/\./g, '/');
                    path = path.replace(/\[['"]?([^'"\]]+)['"]?\]/g, '/$1');
                }

                if (hasPayload && !path.startsWith('/payload') && !path.startsWith('/header')) {
                    if (!path.startsWith('/') && path !== '') {
                        path = '/' + path;
                    }
                    path = '/payload' + path;
                }
            }

            map.set(path, err.message);
        });
        return map;
    }, [data, errors, mode]);

    const renderValue = (value: any, path: string, level: number, key?: string, isLast: boolean = true): React.ReactNode[] => {
        const indent = '  '.repeat(level);
        const elements: React.ReactNode[] = [];
        const error = errorMap.get(path);

        // Enhanced Highlight Style
        const isHighlighted = !!error;

        let bgClass = '';
        let borderClass = 'border-l-4 border-transparent';
        let badgeClass = '';

        if (isHighlighted) {
            if (highlightColor === 'red') {
                bgClass = 'bg-red-500/30';
                borderClass = 'border-l-4 border-red-500';
                badgeClass = 'text-red-300 bg-red-950/80 border-red-500/50';
            } else if (highlightColor === 'amber') {
                bgClass = 'bg-amber-500/30';
                borderClass = 'border-l-4 border-amber-500';
                badgeClass = 'text-amber-300 bg-amber-950/80 border-amber-500/50';
            } else {
                bgClass = 'bg-blue-500/30';
                borderClass = 'border-l-4 border-blue-500';
                badgeClass = 'text-blue-300 bg-blue-950/80 border-blue-500/50';
            }
        }

        const getLineClass = (highlight: boolean) => {
            if (!highlight) return `flex hover:bg-white/5 border-l-4 border-transparent transition-colors duration-150`;
            return `flex hover:bg-white/5 ${bgClass} ${borderClass} transition-colors duration-150`;
        };

        const errorBadge = (error && !hideErrorText) ? (
            <span className={`ml-4 font-bold italic flex items-center gap-1 text-xs px-2 py-0.5 rounded border ${badgeClass} select-text`}>
                <AlertTriangle size={12} /> {error}
            </span>
        ) : null;

        const renderLine = (content: React.ReactNode, keyPath: string, highlight: boolean = false, showBadge: boolean = false) => (
            <div key={keyPath} className={getLineClass(highlight)}>
                <div className="flex-1 whitespace-pre font-mono text-xs flex items-center px-2 py-[1px] select-text cursor-text">
                    <span>{content}</span>
                    {showBadge && errorBadge}
                </div>
            </div>
        );

        if (value === null) {
            elements.push(renderLine(<><span className="text-slate-500">{indent}</span>{key && <span className="text-blue-300">"{key}": </span>}<span className="text-slate-400">null</span>{isLast ? '' : ','}</>, path, isHighlighted, true));
        } else if (typeof value === 'object') {
            const isArray = Array.isArray(value);
            const isEmpty = Object.keys(value).length === 0;
            const openChar = isArray ? '[' : '{';
            const closeChar = isArray ? ']' : '}';

            if (isEmpty) {
                elements.push(renderLine(<><span className="text-slate-500">{indent}</span>{key && <span className="text-blue-300">"{key}": </span>}<span className="text-slate-300">{openChar}{closeChar}</span>{isLast ? '' : ','}</>, path, isHighlighted, true));
            } else {
                // Only highlight start line for objects/arrays
                elements.push(renderLine(<><span className="text-slate-500">{indent}</span>{key && <span className="text-blue-300">"{key}": </span>}<span className="text-slate-300">{openChar}</span></>, path, isHighlighted, true));
                const keys = Object.keys(value);
                keys.forEach((k, i) => {
                    const childPath = `${path}/${k}`;
                    const childValue = value[k];
                    const isLastChild = i === keys.length - 1;
                    elements.push(...renderValue(childValue, childPath, level + 1, isArray ? undefined : k, isLastChild));
                });
                // Do NOT highlight end line
                elements.push(renderLine(<><span className="text-slate-500">{indent}</span><span className="text-slate-300">{closeChar}</span>{isLast ? '' : ','}</>, path + '/_end', false, false));
            }
        } else {
            let valColor = 'text-emerald-300';
            if (typeof value === 'string') valColor = 'text-amber-300';
            if (typeof value === 'boolean') valColor = 'text-purple-300';
            if (typeof value === 'number') valColor = 'text-blue-300';
            const valDisplay = typeof value === 'string' ? `"${value}"` : String(value);
            elements.push(renderLine(
                <>
                    <span className="text-slate-500">{indent}</span>
                    {key && <span className="text-blue-300">"{key}": </span>}
                    <span className={valColor}>{valDisplay}</span>
                    {isLast ? '' : ','}
                </>,
                path,
                isHighlighted,
                true
            ));
        }
        return elements;
    };

    return (
        <div className="w-full select-text">
            {renderValue(data, '', 0)}
        </div>
    );
};

export const ThreeWayDiff: React.FC<ThreeWayDiffProps & { schemaErrors?: any[], requestMessage?: any }> = ({
    requestPayload, expectedSchema, actualResponse, schemaErrors, requestMessage
}) => {
    // 从 Schema 提取预期字段
    const requestData = requestMessage || requestPayload;

    /**
     * 根据 Schema 生成示例数据
     */
    const generateExampleFromSchema = (schema: any): any => {
        if (!schema) return {};

        // Handle string schema
        if (typeof schema === 'string') {
            try {
                schema = JSON.parse(schema);
            } catch (e) {
                return {};
            }
        }

        if (schema.const !== undefined) return schema.const;
        if (schema.examples && schema.examples.length > 0) return schema.examples[0];
        if (schema.default !== undefined) return schema.default;

        if (schema.type === 'object') {
            const obj: any = {};
            if (schema.properties) {
                Object.entries(schema.properties).forEach(([key, value]: [string, any]) => {
                    obj[key] = generateExampleFromSchema(value);
                });
            }
            return obj;
        }

        if (schema.type === 'array') {
            if (schema.items) {
                // Generate one item as example
                return [generateExampleFromSchema(schema.items)];
            }
            return [];
        }

        if (schema.type === 'string') {
            if (schema.enum && schema.enum.length > 0) return schema.enum[0];
            if (schema.format === 'date-time') return new Date().toISOString();
            return "String";
        }
        if (schema.type === 'number' || schema.type === 'integer') return 0;
        if (schema.type === 'boolean') return true;
        if (schema.type === 'null') return null;

        return {}; // Default or unknown types
    };

    // Construct Expected Response Data (Header + Payload Schema)
    const expectedResponseData = useMemo(() => {
        // Mock Header based on Request or Default
        const header = {
            messageId: requestMessage?.header?.messageId || "String",
            namespace: requestMessage?.header?.namespace || "String",
            method: requestMessage?.header?.method || "String",
            payloadVersion: 1,
            from: "String (Topic)",
            timestamp: "Number",
            sign: "String"
        };

        return {
            header,
            payload: generateExampleFromSchema(expectedSchema)
        };
    }, [expectedSchema, requestMessage]);

    // Transform errors for Expected Response to point to missing properties
    const expectedErrors = useMemo(() => {
        if (!schemaErrors) return [];
        return schemaErrors.map(err => {
            // Adjust schemaPath to match our display structure where schema is under 'payload'
            let path = err.schemaPath || '';
            if (path.startsWith('#')) {
                path = path.substring(1);
            }
            // If path is empty, it refers to root.
            // Our root schema is at /payload.
            const displayPath = '/payload' + path;

            return {
                ...err,
                schemaPath: displayPath
            };
        });
    }, [schemaErrors]);

    const requestRef = React.useRef<HTMLDivElement>(null);
    const expectedRef = React.useRef<HTMLDivElement>(null);
    const actualRef = React.useRef<HTMLDivElement>(null);
    const isScrolling = React.useRef(false);

    const handleScroll = (sourceRef: React.RefObject<HTMLDivElement | null>) => {
        if (isScrolling.current) return;
        isScrolling.current = true;

        const scrollTop = sourceRef.current?.scrollTop || 0;

        [requestRef, expectedRef, actualRef].forEach(ref => {
            if (ref.current && ref !== sourceRef) {
                ref.current.scrollTop = scrollTop;
            }
        });

        setTimeout(() => {
            isScrolling.current = false;
        }, 50);
    };

    return (
        <div className="flex flex-col h-full">
            {/* Three Column Grid */}
            <div className="flex-1 grid grid-cols-3 overflow-hidden bg-slate-950">
                {/* Column 1: Request */}
                <div className="border-r border-slate-800 flex flex-col overflow-hidden">
                    <div className="px-4 py-2 bg-blue-500/10 border-b border-slate-800 shrink-0 flex items-center justify-between">
                        <div className="font-bold text-blue-400 text-base">REQUEST</div>
                        <div className="text-sm text-slate-500">发送报文</div>
                    </div>
                    <div
                        ref={requestRef}
                        onScroll={() => handleScroll(requestRef)}
                        className="flex-1 overflow-auto custom-scrollbar p-3"
                    >
                        <HighlightedJSON data={requestData} mode="data" highlightColor="blue" />
                    </div>
                </div>

                {/* Column 2: Expected Response (Schema) */}
                <div className="border-r border-slate-800 flex flex-col overflow-hidden">
                    <div className="px-4 py-2 bg-amber-500/10 border-b border-slate-800 shrink-0 flex items-center justify-between">
                        <div className="font-bold text-amber-400 text-base">EXPECTED</div>
                        <div className="text-sm text-slate-500">期望结果</div>
                    </div>
                    <div
                        ref={expectedRef}
                        onScroll={() => handleScroll(expectedRef)}
                        className="flex-1 overflow-auto custom-scrollbar p-3"
                    >
                        <HighlightedJSON
                            data={expectedResponseData}
                            errors={schemaErrors}
                            mode="data"
                            highlightColor="amber"
                            hideErrorText={true}
                        />
                    </div>
                </div>

                {/* Column 3: Actual Response */}
                <div className="flex flex-col overflow-hidden">
                    <div className="px-4 py-2 bg-emerald-500/10 border-b border-slate-800 shrink-0 flex items-center justify-between">
                        <div className="font-bold text-emerald-400 text-base">ACTUAL</div>
                        <div className="text-sm text-slate-500">实际响应</div>
                    </div>
                    <div
                        ref={actualRef}
                        onScroll={() => handleScroll(actualRef)}
                        className="flex-1 overflow-auto custom-scrollbar p-3"
                    >
                        <HighlightedJSON
                            data={actualResponse}
                            errors={schemaErrors}
                            mode="data"
                            highlightColor="red"
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};

export const TestResultViewer: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    result?: DetailedTestResult | null;
    batchResult?: BatchTestResult | null;
    protocolNamespace?: string;
    protocolMethod?: string;
    onRetry?: () => void;
}> = ({ isOpen, onClose, result, batchResult, protocolNamespace, protocolMethod, onRetry }) => {
    if (!isOpen) return null;

    // Normalize input to a list of results
    const results = useMemo(() => {
        if (batchResult) return batchResult.results;
        if (result) return [result];
        return [];
    }, [batchResult, result]);

    const title = batchResult ? `批量测试结果: ${batchResult.suiteName}` : `${protocolNamespace} / ${protocolMethod}`;
    const summary = batchResult ? batchResult.summary : (result ? {
        total: 1,
        passed: result.status === 'PASS' ? 1 : 0,
        failed: result.status === 'FAIL' ? 1 : 0,
        timeout: result.status === 'TIMEOUT' ? 1 : 0
    } : { total: 0, passed: 0, failed: 0, timeout: 0 });

    // State for collapsible items
    const [expandedIndices, setExpandedIndices] = useState<Set<number>>(new Set());

    useEffect(() => {
        if (isOpen) {
            const newExpanded = new Set<number>();
            results.forEach((res, idx) => {
                const isFocused = result && (res === result || res.id === result.id);
                const isFailed = res.status === 'FAIL' || res.status === 'TIMEOUT';
                if (isFocused || isFailed) {
                    newExpanded.add(idx);
                }
            });
            if (newExpanded.size === 0 && results.length === 1) {
                newExpanded.add(0);
            }
            setExpandedIndices(newExpanded);
        }
    }, [isOpen, results, result]);

    const toggleExpand = (index: number) => {
        setExpandedIndices(prev => {
            const next = new Set(prev);
            if (next.has(index)) {
                next.delete(index);
            } else {
                next.add(index);
            }
            return next;
        });
    };

    const [filterStatus, setFilterStatus] = useState<'ALL' | 'PASS' | 'FAIL' | 'TIMEOUT'>('ALL');

    const filteredResults = useMemo(() => {
        if (filterStatus === 'ALL') return results;
        return results.filter(r => r.status === filterStatus);
    }, [results, filterStatus]);

    const expandAll = () => {
        // Only expand currently visible results
        const newExpanded = new Set(expandedIndices);
        filteredResults.forEach(r => {
            // Find original index
            const idx = results.indexOf(r);
            if (idx !== -1) newExpanded.add(idx);
        });
        setExpandedIndices(newExpanded);
    };

    const collapseAll = () => {
        setExpandedIndices(new Set());
    };

    return (
        <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-50 backdrop-blur-sm">
            <div className="bg-slate-900 w-[95vw] h-[95vh] rounded-xl border border-slate-700 flex flex-col shadow-2xl overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700 bg-slate-800/50 shrink-0">
                    <div className="flex items-center gap-6">
                        <h2 className="text-xl font-bold text-white flex items-center gap-2">
                            {title}
                        </h2>
                        <div className="flex items-center bg-slate-800 rounded-lg p-1 border border-slate-700">
                            <button
                                onClick={() => setFilterStatus('ALL')}
                                className={`px-3 py-1 text-xs font-bold rounded transition-colors flex items-center gap-2 ${filterStatus === 'ALL' ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                            >
                                <span>Total</span>
                                <span className="bg-slate-700 px-1.5 rounded text-slate-300">{summary.total}</span>
                            </button>
                            <div className="w-px h-4 bg-slate-700 mx-1"></div>
                            <button
                                onClick={() => setFilterStatus('PASS')}
                                className={`px-3 py-1 text-xs font-bold rounded transition-colors flex items-center gap-2 ${filterStatus === 'PASS' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'text-slate-400 hover:text-emerald-400'}`}
                            >
                                <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                                <span>Pass</span>
                                <span className={`px-1.5 rounded ${filterStatus === 'PASS' ? 'bg-emerald-500/20' : 'bg-slate-700 text-slate-300'}`}>{summary.passed}</span>
                            </button>
                            <button
                                onClick={() => setFilterStatus('FAIL')}
                                className={`px-3 py-1 text-xs font-bold rounded transition-colors flex items-center gap-2 ${filterStatus === 'FAIL' ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'text-slate-400 hover:text-red-400'}`}
                            >
                                <span className="w-2 h-2 rounded-full bg-red-500"></span>
                                <span>Fail</span>
                                <span className={`px-1.5 rounded ${filterStatus === 'FAIL' ? 'bg-red-500/20' : 'bg-slate-700 text-slate-300'}`}>{summary.failed}</span>
                            </button>
                            {summary.timeout > 0 && (
                                <button
                                    onClick={() => setFilterStatus('TIMEOUT')}
                                    className={`px-3 py-1 text-xs font-bold rounded transition-colors flex items-center gap-2 ${filterStatus === 'TIMEOUT' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'text-slate-400 hover:text-amber-400'}`}
                                >
                                    <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                                    <span>Timeout</span>
                                    <span className={`px-1.5 rounded ${filterStatus === 'TIMEOUT' ? 'bg-amber-500/20' : 'bg-slate-700 text-slate-300'}`}>{summary.timeout}</span>
                                </button>
                            )}
                        </div>
                        {summary.total > 0 && (
                            <div className="text-xs font-mono text-slate-500">
                                Success Rate: <span className={`${summary.passed === summary.total ? 'text-emerald-400' : 'text-slate-300'}`}>{Math.round((summary.passed / summary.total) * 100)}%</span>
                            </div>
                        )}
                    </div>
                    <div className="flex items-center gap-3">
                        <div className="flex bg-slate-800 rounded-lg p-1 mr-2">
                            <button onClick={expandAll} className="px-3 py-1 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors">Expand All</button>
                            <button onClick={collapseAll} className="px-3 py-1 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors">Collapse All</button>
                        </div>
                        {onRetry && !batchResult && (
                            <button onClick={onRetry} className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm flex items-center gap-2 transition-colors">
                                <RefreshCw size={16} /> 重试
                            </button>
                        )}
                        <button onClick={onClose} className="p-2 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-white transition-colors">
                            <X size={24} />
                        </button>
                    </div>
                </div>

                {/* Content List */}
                <div className="flex-1 overflow-y-auto custom-scrollbar bg-slate-950 p-6 space-y-4">
                    {filteredResults.map((res) => {
                        const index = results.indexOf(res); // Use original index for stable keys and state
                        const isExpanded = expandedIndices.has(index);
                        return (
                            <div key={index} className="border border-slate-800 rounded-xl overflow-hidden bg-slate-900 shadow-lg transition-all duration-300">
                                {/* Result Header (Clickable) */}
                                <div
                                    className={`px-4 py-3 bg-slate-800 border-b ${isExpanded ? 'border-slate-700' : 'border-transparent'} flex items-center justify-between cursor-pointer hover:bg-slate-750 transition-colors`}
                                    onClick={() => toggleExpand(index)}
                                >
                                    <div className="flex items-center gap-3">
                                        <div className={`transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}>
                                            <ChevronRight size={18} className="text-slate-500" />
                                        </div>
                                        <div className={`p-1.5 rounded-lg ${res.status === 'PASS' ? 'bg-emerald-500/20 text-emerald-400' : res.status === 'TIMEOUT' ? 'bg-amber-500/20 text-amber-400' : 'bg-red-500/20 text-red-400'}`}>
                                            {res.status === 'PASS' ? <CheckCircle size={18} /> : res.status === 'TIMEOUT' ? <Clock size={18} /> : <XCircle size={18} />}
                                        </div>
                                        <div>
                                            <div className="text-sm font-bold text-white font-mono flex items-center gap-2">
                                                {res.namespace || protocolNamespace} <span className="text-slate-500">/</span> {res.method || protocolMethod}
                                                {res.status !== 'PASS' && (
                                                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${res.status === 'TIMEOUT' ? 'bg-amber-500/10 text-amber-400' : 'bg-red-500/10 text-red-400'}`}>
                                                        {res.status}
                                                    </span>
                                                )}
                                            </div>
                                            {res.error && (
                                                <div className="text-xs text-red-400 mt-0.5">{res.error}</div>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-4 text-xs text-slate-400">
                                        <span className="flex items-center gap-1"><Clock size={12} /> {res.duration}ms</span>
                                        <span>{new Date(res.startTime || 0).toLocaleTimeString()}</span>
                                    </div>
                                </div>

                                {/* 3-Column Detail View (Collapsible) */}
                                {isExpanded && (
                                    <div className="h-[500px] border-b border-slate-800 last:border-0 animate-in fade-in slide-in-from-top-2 duration-200">
                                        <ThreeWayDiff
                                            requestPayload={res.request?.payload}
                                            requestMessage={res.request}
                                            expectedSchema={res.expectedSchema}
                                            actualResponse={res.response}
                                            schemaErrors={res.schemaErrors}
                                        />
                                    </div>
                                )}
                            </div>
                        );
                    })}

                    {filteredResults.length === 0 && (
                        <div className="text-center text-slate-500 py-20">
                            No results to display
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};


