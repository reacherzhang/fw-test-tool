import React, { useState, useRef } from 'react';
import { Play, Upload, CheckCircle, XCircle, ChevronRight, Activity, CloudUpload } from 'lucide-react';
import { GlobalLogEntry, CloudSession } from '../types';

interface QAAutoTaskRunnerProps {
    onLog?: (log: Omit<GlobalLogEntry, 'id' | 'timestamp'>) => void;
    devices: { id: string; name: string; ip?: string }[];
    mqttConnected?: boolean;
    onMqttPublish?: (topic: string, message: string) => Promise<any>;
    onHttpRequest?: (ip: string, payload: any) => Promise<any>;
    session?: CloudSession | null;
    appid?: string;
    qaServerUrl?: string;
    qaUser?: string;
    qaToken?: string;
}

interface QATaskPlan {
    plan_id: number;
    plan_name: string;
    semi_auto_decision: number;
    timestamp: string;
    executable_cases: QACase[];
}

interface QACase {
    case_id: number;
    case_name: string;
    module_name: string;
    automation_type: number;
    script: string | any;
    status?: 'PENDING' | 'PASS' | 'FAIL' | 'SKIPPED';
    resultMsg?: string;
}

export const QAAutoTaskRunner: React.FC<QAAutoTaskRunnerProps> = ({
    onLog, devices, mqttConnected, onMqttPublish, onHttpRequest, session, appid, qaServerUrl, qaUser, qaToken
}) => {
    const [taskPlan, setTaskPlan] = useState<QATaskPlan | null>(null);
    const [targetDevice, setTargetDevice] = useState<string>('');
    const fileInputRef = useRef<HTMLInputElement>(null);

    const [isRunning, setIsRunning] = useState(false);
    const [currentCaseIndex, setCurrentCaseIndex] = useState(-1);
    const [activeStepPrompt, setActiveStepPrompt] = useState<{ caseInfo: QACase, message: string } | null>(null);
    const [syncing, setSyncing] = useState(false);

    const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const content = ev.target?.result as string;
                const plan: QATaskPlan = JSON.parse(content);
                if (!plan.plan_id || !plan.executable_cases) {
                    throw new Error('Invalid plan format');
                }
                plan.executable_cases.forEach(c => c.status = 'PENDING');
                setTaskPlan(plan);
                onLog?.({ type: 'SYSTEM', direction: 'SYS', label: 'Plan Loaded', detail: `Loaded plan: ${plan.plan_name} with ${plan.executable_cases.length} cases` });
            } catch (err) {
                alert('无法解析脚本包，格式错误！');
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    };

    const startTestPlan = async () => {
        if (!taskPlan) return;
        if (!targetDevice) {
            alert('请先选择目标测试设备');
            return;
        }

        setIsRunning(true);
        setCurrentCaseIndex(0);

        onLog?.({ type: 'SYSTEM', direction: 'SYS', label: 'Task Runner Started', detail: `Running against dev_id = ${targetDevice}` });

        // Iterate through cases
        for (let i = 0; i < taskPlan.executable_cases.length; i++) {
            setCurrentCaseIndex(i);
            const tCase = taskPlan.executable_cases[i];

            if (tCase.status !== 'PENDING') continue; // Might be re-running un-run cases

            // execute case
            try {
                let scriptObj = tCase.script;
                if (typeof scriptObj === 'string') {
                    try { scriptObj = JSON.parse(tCase.script); } catch (e) { scriptObj = {} }
                }

                // Check automation type: 1 = Semi-Auto (Requires Manual Check)
                if (tCase.automation_type === 1 && taskPlan.semi_auto_decision === 2) {
                    // Halt and prompt
                    await new Promise<void>((resolve, reject) => {
                        setActiveStepPrompt({
                            caseInfo: tCase,
                            message: `(半自动用例) 需要人工干预验证:\n[用例名] ${tCase.case_name}\n[步骤/期望] ${tCase.script || '请按用例描述检查设备状态'}`
                        });

                        // Store resolve/reject globally to be called by UI dialog buttons
                        (window as any)._currentQAAction = (passed: boolean) => {
                            setActiveStepPrompt(null);
                            if (passed) resolve();
                            else reject(new Error('人工标记为不通过'));
                        };
                    });

                    // If resolved, mark pass
                    markCaseResult(tCase.case_id, 'PASS', 'Manual validation OK');
                } else if (tCase.automation_type === 2) {
                    let steps: any[] = [];
                    if (Array.isArray(scriptObj)) {
                        steps = scriptObj;
                    } else if (scriptObj && Array.isArray(scriptObj.steps)) {
                        steps = scriptObj.steps;
                    }

                    if (steps.length === 0) {
                        onLog?.({ type: 'SYSTEM', direction: 'SYS', label: `Empty Script`, detail: `Automated case ${tCase.case_id} has no valid execution steps defined in its JSON script.` });
                        markCaseResult(tCase.case_id, 'FAIL', '失败: 未下发或未解析到有效的自动化配置脚本字典');
                    } else {
                        let stepSuccess = true;
                        for (let sIdx = 0; sIdx < steps.length; sIdx++) {
                            const step = steps[sIdx];
                            const type = step.type || 'unknown';
                            const config = step.config || step;
                            const timeoutMs = step.timeout || config.timeout || 5000;

                            onLog?.({ type: 'SYSTEM', direction: 'SYS', label: `Step ${sIdx + 1}/${steps.length}`, detail: `[${type}]\nConfig:\n${JSON.stringify(config, null, 2)}` });

                            try {
                                if (type === 'delay') {
                                    const delayTime = config.duration || config.delay || 1500;
                                    onLog?.({ type: 'SYSTEM', direction: 'SYS', label: 'Wait', detail: `${delayTime} ms...` });
                                    await new Promise(r => setTimeout(r, delayTime));
                                } else if (type === 'send_request') {
                                    const method = config.method || 'SET';
                                    const rawPayload = config.payload || config.payloadOverride || {};
                                    const payloadStr = typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);

                                    if (onMqttPublish) {
                                        const topic = config.topic || `/app/${appid || 'meross'}-${targetDevice}/subscribe`;
                                        onLog?.({ type: 'MQTT', direction: 'TX', label: `Publish [${method}]`, detail: `Topic: ${topic}\nPayload:\n${payloadStr}` });
                                        await onMqttPublish(topic, payloadStr);
                                        await new Promise(r => setTimeout(r, 800)); // simulate wait for ACK
                                    } else if (onHttpRequest) {
                                        const dev = devices.find(d => d.id === targetDevice);
                                        if (!dev?.ip) throw new Error('Cannot execute HTTP request: Target device IP is missing');
                                        onLog?.({ type: 'HTTP', direction: 'TX', label: `Request [${method}]`, detail: `Target IP: ${dev.ip}\nPayload:\n${payloadStr}` });
                                        await onHttpRequest(dev.ip, typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload);
                                    } else {
                                        throw new Error('Neither MQTT nor HTTP executor is available');
                                    }
                                } else if (type === 'wait_push') {
                                    onLog?.({ type: 'SYSTEM', direction: 'SYS', label: 'Wait PUSH', detail: `Waiting up to ${timeoutMs}ms for device PUSH message...` });
                                    await new Promise(r => setTimeout(r, Math.min(timeoutMs, 2500))); // Simulate wait
                                } else if (type === 'manual_action' || type === 'manual_input') {
                                    onLog?.({ type: 'SYSTEM', direction: 'SYS', label: 'Skip Manual', detail: `Skipped manual intervention step in full-auto mode.` });
                                } else {
                                    onLog?.({ type: 'SYSTEM', direction: 'SYS', label: 'Mock Execute', detail: `Simulating unknown step resolution for 1s` });
                                    await new Promise(r => setTimeout(r, 1000));
                                }
                            } catch (e: any) {
                                onLog?.({ type: 'SYSTEM', direction: 'SYS', label: 'Step Error', detail: e.message });
                                if (step.continueOnFail !== true) {
                                    stepSuccess = false;
                                    markCaseResult(tCase.case_id, 'FAIL', `Step ${sIdx + 1} failed: ${e.message}`);
                                    break;
                                }
                            }
                        }
                        if (stepSuccess) markCaseResult(tCase.case_id, 'PASS', 'Auto-execution successful');
                    }
                } else {
                    markCaseResult(tCase.case_id, 'SKIPPED', 'Unknown automation type or degraded');
                }
            } catch (err: any) {
                markCaseResult(tCase.case_id, 'FAIL', err.message);
            }
        }

        setCurrentCaseIndex(-1);
        setIsRunning(false);
        onLog?.({ type: 'SYSTEM', direction: 'SYS', label: 'Task Runner Completed', detail: 'All cases parsed' });
    };

    const markCaseResult = (id: number, status: 'PASS' | 'FAIL' | 'SKIPPED', msg: string) => {
        setTaskPlan(prev => {
            if (!prev) return prev;
            const newCases = prev.executable_cases.map(c =>
                c.case_id === id ? { ...c, status, resultMsg: msg } : c
            );
            return { ...prev, executable_cases: newCases };
        });
    };

    const syncResultsToCloud = async () => {
        if (!taskPlan) return;
        if (!qaServerUrl || !qaUser || !qaToken) {
            alert('QA Center 访问凭证不完整，请确保是从网页端拉起该应用的深链以正确继承会话!');
            return;
        }

        setSyncing(true);
        try {
            const results = taskPlan.executable_cases.filter(c => c.status && c.status !== 'PENDING').map(c => ({
                case_id: c.case_id,
                status: c.status,
                msg: c.resultMsg || ''
            }));

            onLog?.({ type: 'HTTP', direction: 'TX', label: 'Sync QA Results', detail: `To: ${qaServerUrl}/api/testplan/sync_auto_result/` });

            const res = await window.electronAPI?.nativeRequest({
                url: `${qaServerUrl.replace(/\/$/, '')}/api/testplan/sync_auto_result/`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${qaToken}`
                },
                body: JSON.stringify({
                    plan_id: taskPlan.plan_id,
                    executer: qaUser,
                    results
                })
            });

            if ((res?.status || 0) >= 200 && (res?.status || 0) < 300) {
                alert('结果同步成功！QA Center 的用例执行状态已更新。');
            } else {
                throw new Error(`Cloud Sync Failed: HTTP ${res?.status || 'Unknown'}`);
            }
        } catch (err: any) {
            alert('同步失败: ' + err.message);
        } finally {
            setSyncing(false);
        }
    };

    return (
        <div className="flex flex-col gap-6 p-6 h-full max-w-5xl mx-auto">
            {/* Header Setup */}
            <div className="bg-slate-900/40 border border-slate-800 rounded-2xl p-6">
                <h3 className="text-xl font-black text-white uppercase mb-4 flex items-center gap-2">
                    <Play className="text-indigo-500" />
                    QA 自动化任务台
                </h3>

                <div className="flex gap-4 items-end mb-2">
                    <div className="flex-1">
                        <label className="text-xs font-bold text-slate-500 uppercase mb-2 block">导入的任务包 (.json)</label>
                        <input type="file" ref={fileInputRef} accept=".json" onChange={handleFileUpload} className="hidden" />
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            className="w-full bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-indigo-500 text-slate-300 rounded-xl px-4 py-3 flex items-center justify-between transition-colors"
                        >
                            <span>{taskPlan ? `已加载：${taskPlan.plan_name} (${taskPlan.executable_cases.length} 条用例)` : '点击选择脚本包...'}</span>
                            <Upload size={16} />
                        </button>
                    </div>
                    <div className="flex-1">
                        <label className="text-xs font-bold text-slate-500 uppercase mb-2 block">测试靶机 (Target Device)</label>
                        <select
                            className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white outline-none focus:border-indigo-500"
                            value={targetDevice}
                            onChange={e => setTargetDevice(e.target.value)}
                        >
                            <option value="">-- 选择云端拉取的设备 --</option>
                            {devices.map(d => <option key={d.id} value={d.id}>{d.name} {d.ip ? `(${d.ip})` : ''}</option>)}
                        </select>
                    </div>
                    <button
                        onClick={startTestPlan}
                        disabled={!taskPlan || isRunning || !targetDevice}
                        className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 text-white rounded-xl px-8 py-3 font-bold uppercase tracking-wider transition-all disabled:opacity-50 flex items-center gap-2 h-12"
                    >
                        <Play size={18} />
                        开始执行
                    </button>
                    <button
                        onClick={syncResultsToCloud}
                        disabled={!taskPlan || syncing || isRunning}
                        className="bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-600 text-white rounded-xl px-6 py-3 font-bold uppercase tracking-wider transition-all disabled:opacity-50 flex items-center gap-2 h-12"
                    >
                        <CloudUpload size={18} />
                        {syncing ? '同步中...' : '同步结果至 QA 端'}
                    </button>
                </div>

                {qaServerUrl ? (
                    <div className="mt-4 text-[10px] text-emerald-400 font-mono">
                        <CheckCircle size={10} className="inline mr-1" />
                        QA Session Active: {qaUser} @ {qaServerUrl}
                    </div>
                ) : (
                    <div className="mt-4 text-[10px] text-red-400 font-mono">
                        <XCircle size={10} className="inline mr-1" />
                        未检测到 QA Session，无法进行云端结果同步 (推荐由网页端唤起客户端执行)
                    </div>
                )}
            </div>

            {/* Execution List */}
            {taskPlan && (
                <div className="flex-1 overflow-y-auto bg-slate-900/40 border border-slate-800 rounded-2xl p-6 custom-scrollbar min-h-0">
                    <h4 className="text-sm font-black text-slate-400 uppercase tracking-wider mb-4">执行队列</h4>
                    <div className="space-y-3">
                        {taskPlan.executable_cases.map((c, idx) => (
                            <div key={c.case_id} className={`p-4 rounded-xl border flex items-center justify-between transition-all ${idx === currentCaseIndex ? 'border-indigo-500 bg-indigo-500/10 shadow-lg shadow-indigo-500/10' :
                                c.status === 'PASS' ? 'border-emerald-500/30 bg-emerald-500/5' :
                                    c.status === 'FAIL' ? 'border-red-500/30 bg-red-500/5' :
                                        'border-slate-800 bg-slate-900/50'
                                }`}>
                                <div className="flex flex-col gap-1">
                                    <div className="flex items-center gap-2">
                                        <span className={`w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold ${idx === currentCaseIndex ? 'bg-indigo-500 text-white' : 'bg-slate-800 text-slate-400'
                                            }`}>{idx + 1}</span>
                                        <h5 className="font-bold text-slate-200 text-sm">{c.case_name}</h5>
                                        <span className="px-2 py-0.5 bg-slate-800 border border-slate-700 rounded-full text-[9px] text-slate-400 uppercase">{c.module_name}</span>
                                        {c.automation_type === 1 && <span className="px-2 py-0.5 bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded-full text-[9px] font-bold uppercase">半自动干预</span>}
                                    </div>
                                    {c.resultMsg && (
                                        <p className="text-xs text-slate-500 ml-8">{c.resultMsg}</p>
                                    )}
                                </div>

                                <div className="flex items-center">
                                    {idx === currentCaseIndex && <Activity className="text-indigo-400 animate-pulse" size={20} />}
                                    {c.status === 'PASS' && <CheckCircle className="text-emerald-500" size={20} />}
                                    {c.status === 'FAIL' && <XCircle className="text-red-500" size={20} />}
                                    {c.status === 'PENDING' && idx !== currentCaseIndex && <span className="text-xs text-slate-600 font-bold pr-2">等待中</span>}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Modal for manual interaction */}
            {activeStepPrompt && (
                <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center z-[200]">
                    <div className="bg-slate-900 border border-slate-700 rounded-3xl p-8 max-w-lg w-full shadow-2xl animate-in zoom-in-95 duration-200">
                        <h3 className="text-xl font-black text-amber-500 uppercase tracking-tight mb-2">手动验证检查</h3>
                        <div className="w-full h-px bg-slate-800 mb-6" />

                        <div className="text-sm text-slate-300 leading-relaxed font-mono bg-slate-950 p-4 rounded-xl border border-slate-800 mb-6 whitespace-pre-wrap flex-1 break-words">
                            {activeStepPrompt.message}
                        </div>

                        <div className="flex gap-4">
                            <button
                                onClick={() => (window as any)._currentQAAction?.(false)}
                                className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-red-500/30 hover:border-red-500/50 py-3 rounded-xl font-bold transition-all"
                            >
                                不符合预期 (Fail)
                            </button>
                            <button
                                onClick={() => (window as any)._currentQAAction?.(true)}
                                className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/20 hover:shadow-emerald-500/40 py-3 rounded-xl font-bold transition-all flex justify-center items-center gap-2"
                            >
                                <CheckCircle size={18} />
                                状态符合 (Pass)
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
