# 协议测试执行计划 — 实施文档

> 创建日期：2026-02-25
> 版本：v1.0
> 状态：待实施

---

## 目录

1. [需求背景](#1-需求背景)
2. [现状分析](#2-现状分析)
3. [解决方案总览](#3-解决方案总览)
4. [数据模型设计](#4-数据模型设计)
5. [UI 设计详述](#5-ui-设计详述)
6. [执行引擎设计](#6-执行引擎设计)
7. [分阶段实施步骤](#7-分阶段实施步骤)
8. [文件改动清单](#8-文件改动清单)
9. [测试验证方案](#9-测试验证方案)

---

## 1. 需求背景

一个协议库包含几十个协议，不同协议支持不同的 method，测试过程各不相同。现有系统只能按固定顺序自动遍历执行，无法适配以下场景：

| 类型 | 场景举例 |
|------|---------|
| ① 需要手动输入字段值 | 通道值(channel)、开关值(onoff)、id值、升级信息、位置值等 |
| ② 需要手动触发设备动作 | 设备重上电、升级、解绑等 |
| ③ 需要前置执行协议 | 升级前需要先执行某个配置协议 |
| ④ 需要自定义 method 执行顺序 | 先SET→收到SETACK→等PUSH→再GET→收到GETACK→再DELETE→收到DELETEACK |

**目标**：整体仍然自动执行，只在需要手动参与时暂停等待，需要等待 PUSH 时增加延时，有顺序要求时可提前配置。

---

## 2. 现状分析

### 2.1 核心文件

| 文件 | 作用 |
|------|------|
| `components/ProtocolAudit.tsx` | 主组件，包含所有类型定义、UI渲染、测试执行逻辑（~5163行） |
| `components/ProtocolAuditEnhancements.tsx` | 增强功能（模板库、搜索筛选等） |
| `components/TestCaseEditor.tsx` | 测试用例编辑器 |
| `services/auditStorageService.ts` | 本地持久化存储服务 |
| `services/auditDatabaseService.ts` | 后端数据库同步服务 |
| `services/auditDatabaseConfig.ts` | 数据库连接配置 |

### 2.2 现有执行流程（`runAllTests` 行2729-3088）

```
runAllTests()
  │
  ├── 获取待执行协议列表（全选或勾选）
  ├── 审核门禁检查
  ├── 遍历 protocolsToRun:
  │     └── 遍历 REQUEST_METHODS = ['GET','SET','SYNC','DELETE'] （硬编码顺序）
  │           ├── 有 testCases → 逐个执行 testCase
  │           └── 无 testCases → 执行默认测试
  │                 ├── runSingleTest(protocol, methodName)
  │                 └── 如果是 SET 且 PUSH 启用 → waitForPush(protocol) （硬编码10s超时）
  │
  └── 汇总结果 → 保存历史 → 显示报告
```

### 2.3 现有问题

| 问题 | 代码位置 | 说明 |
|------|---------|------|
| method 顺序硬编码 | 行2819: `for (const methodName of REQUEST_METHODS)` | 固定为 GET→SET→SYNC→DELETE |
| PUSH 只在 SET 后触发 | 行2861/2984: `if (methodName === 'SET' && protocol.methods['PUSH']?.enabled)` | 无法独立等待 PUSH |
| PUSH 超时硬编码 | 行2602: `const timeoutMs = 10000` | 固定10秒 |
| 步骤间延时硬编码 | 行2950/3044: `setTimeout(r, 200)` | 固定200ms |
| 不支持手动操作暂停 | 无相关代码 | 无法暂停等待人工操作 |
| 不支持手动输入值 | 无相关代码 | 执行前必须提前配好所有 payload |
| 不支持前置协议 | 无相关代码 | 无法指定先执行其他协议 |

### 2.4 现有类型定义

```typescript
// 行22-28
interface MethodTest {
    enabled: boolean;
    payload: string;    // JSON string
    schema: string;     // JSON schema string
    testCases?: TestCase[];
    lastResult?: DetailedTestResult;
}

// 行30-43
interface ProtocolDefinition {
    id: string;
    namespace: string;
    name: string;
    description?: string;
    category?: string;
    docUrl?: string;
    methods: { [key in RequestMethod]?: MethodTest };
    reviewStatus?: 'UNVERIFIED' | 'VERIFIED';
    verificationMode?: 'direct' | 'manual';
    tags?: string[];
}

// 行97-101
interface TestExecutionConfig {
    timeout: number;
    retryCount: number;
    stopOnFail: boolean;
}

// 行58
type RequestMethod = 'GET' | 'SET' | 'PUSH' | 'SYNC' | 'DELETE';
```

### 2.5 现有 UI 结构（协议编辑面板）

```
头部栏: [← 返回] [协议名] [审核状态] [复制] [保存]      (行3610-3659)
  │
  ├── NAMESPACE 输入框                                    (行3667-3680)
  │
  ├── Method 选择行: [GET] [SET] [PUSH] [SYNC] [DELETE]  (行3682-3713)
  │
  └── Method 编辑区: 左右分栏                             (行3717-...)
        ├── 左侧: Request Payload 编辑器
        └── 右侧: Response Payload / Schema 编辑器
```

### 2.6 现有状态变量

```typescript
// 行1706 - 当前编辑面板的 Tab（但实际只用到 'edit'）
const [rightPanelTab, setRightPanelTab] = useState<'overview' | 'edit' | 'results' | 'review'>('overview');

// editingMethod 控制当前编辑哪个 method（用于下方编辑区切换）
// 在 startEditingProtocol 中通过 setEditingMethod 设置
```

---

## 3. 解决方案总览

### 3.1 核心思路

在每个 `ProtocolDefinition` 上新增可选的 `executionPlan` 字段。有执行计划的协议按自定义步骤序列执行，无配置的保持原有逻辑，**完全向下兼容**。

### 3.2 UI 入口位置

在 method 选择行（`[GET] [SET] [PUSH] [SYNC] [DELETE]`）的**右侧**新增 `[⚙️ 执行计划]` 按钮，与 method 按钮互斥切换。点击后**下方编辑区**从 Payload 编辑切换为执行计划配置界面。

```
[✓ GET] [✓ SET] [✓ PUSH] [ SYNC ] [✓ DELETE]     [⚙️ 执行计划]
                                                        ↑ 新增按钮
```

### 3.3 交互逻辑

| 操作 | 下方编辑区显示 |
|------|---------------|
| 点击任意 method 按钮 | 该 method 的 Request Payload + Response Schema 编辑器（现有逻辑） |
| 点击 `⚙️ 执行计划` 按钮 | 执行计划配置界面（新增） |

---

## 4. 数据模型设计

### 4.1 新增类型定义

以下类型定义将添加到 `ProtocolAudit.tsx` 的类型定义区域（约行22附近）：

```typescript
// ==================== 执行计划类型定义 ====================

/** 测试步骤类型 */
type StepType =
    | 'send_request'    // 发送请求并等待 ACK
    | 'wait_push'       // 等待设备主动 PUSH
    | 'delay'           // 固定延时等待
    | 'manual_action'   // 手动操作（暂停等待用户确认）
    | 'manual_input'    // 手动输入/修改 payload 字段值
    | 'prerequisite';   // 执行前置协议

/** 手动输入字段定义 */
interface ManualField {
    path: string;           // JSON 路径，如 "toggle.0.channel"
    label: string;          // 显示标签，如 "通道号"
    type: 'string' | 'number' | 'boolean';
    defaultValue?: any;     // 默认值
    hint?: string;          // 输入提示
}

/** 步骤配置（联合类型，根据 stepType 使用不同字段） */
interface StepConfig {
    // send_request 配置
    method?: RequestMethod;         // GET | SET | DELETE | SYNC
    payloadOverride?: string;       // 可选覆盖 payload（JSON string）
    validateSchema?: boolean;       // 是否校验响应 schema

    // wait_push 配置
    // timeout 用公共字段
    pushNamespace?: string;         // 可选：指定等待的 namespace（默认当前协议）

    // delay 配置
    duration?: number;              // 延时毫秒数

    // manual_action 配置
    instruction?: string;           // 操作指令文字
    confirmText?: string;           // 确认按钮文字（默认"已完成，继续"）
    timeoutWarning?: number;        // 超时提醒时间(ms)

    // manual_input 配置
    fields?: ManualField[];         // 需要手动输入的字段列表
    targetMethod?: RequestMethod;   // 修改后应用到哪个 method 的 payload

    // prerequisite 配置
    protocolId?: string;            // 前置协议 ID
    protocolNamespace?: string;     // 前置协议 namespace（显示用）
    prerequisiteMethod?: RequestMethod; // 执行哪个 method
    failAction?: 'stop' | 'continue';  // 前置失败时的行为
}

/** 单个测试步骤 */
interface TestStep {
    id: string;             // 步骤唯一 ID
    type: StepType;         // 步骤类型
    order: number;          // 执行顺序（从 0 开始）
    config: StepConfig;     // 步骤配置
    description?: string;   // 步骤描述/标题
    timeout?: number;       // 本步骤超时(ms)，默认使用全局超时
    continueOnFail?: boolean; // 失败后是否继续执行后续步骤
}

/** 测试执行计划 */
interface TestExecutionPlan {
    enabled: boolean;           // 是否启用自定义执行计划
    steps: TestStep[];          // 有序步骤列表
    description?: string;       // 计划整体描述
    totalTimeout?: number;      // 整体超时(ms)，0 表示不限制
}
```

### 4.2 扩展 ProtocolDefinition

```typescript
interface ProtocolDefinition {
    id: string;
    namespace: string;
    name: string;
    description?: string;
    category?: string;
    docUrl?: string;
    methods: { [key in RequestMethod]?: MethodTest };
    reviewStatus?: 'UNVERIFIED' | 'VERIFIED';
    verificationMode?: 'direct' | 'manual';
    tags?: string[];
    executionPlan?: TestExecutionPlan;   // ✅ 新增
}
```

### 4.3 扩展进度状态

```typescript
// 现有（行1583）:
const [testProgress, setTestProgress] = useState<{
    current: number;
    total: number;
    currentProtocol: string;
    startTime: number;
} | null>(null);

// 扩展为:
const [testProgress, setTestProgress] = useState<{
    current: number;           // 当前协议序号
    total: number;             // 总协议数
    currentProtocol: string;   // 当前协议名
    startTime: number;
    // ✅ 新增字段
    stepCurrent?: number;      // 当前步骤序号
    stepTotal?: number;        // 总步骤数
    stepDescription?: string;  // 当前步骤描述
    stepType?: StepType;       // 当前步骤类型
    countdown?: number;        // 倒计时秒数（用于 delay/wait_push）
    waitingForUser?: boolean;  // 是否等待用户操作
} | null>(null);
```

### 4.4 新增执行过程交互状态

```typescript
// 手动操作暂停弹窗
const [manualActionModal, setManualActionModal] = useState<{
    show: boolean;
    instruction: string;
    confirmText: string;
    protocolName: string;
    stepIndex: number;
    totalSteps: number;
    resolve?: () => void;       // Promise resolve，用户确认后调用
} | null>(null);

// 手动输入弹窗
const [manualInputModal, setManualInputModal] = useState<{
    show: boolean;
    fields: ManualField[];
    protocolName: string;
    targetMethod: RequestMethod;
    stepIndex: number;
    totalSteps: number;
    resolve?: (values: Record<string, any>) => void;  // 用户确认后调用，传入输入值
} | null>(null);
```

### 4.5 存储服务扩展

`auditStorageService.ts` 中的 `StoredProtocolDefinition` 需要同步新增 `executionPlan` 字段。由于 `executionPlan` 是可序列化对象，可以直接存储，不需要特殊转换。

---

## 5. UI 设计详述

### 5.1 "执行计划"按钮位置

**代码位置**：`ProtocolAudit.tsx` 行3682-3713（Method 选择行）

在 `{ALL_METHODS.map(method => { ... })}` 闭合后，追加执行计划按钮：

```
现有 method 按钮循环的 </div> 之后，追加：

{/* 分隔线 */}
<div className="h-6 w-px bg-slate-700 mx-1" />

{/* 执行计划按钮 */}
<button
    onClick={() => setEditingMethod('executionPlan' as any)}
    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold transition-all
        ${editingMethod === 'executionPlan'
            ? 'bg-indigo-500 text-white ring-2 ring-indigo-500 ring-offset-1 ring-offset-slate-950'
            : 'bg-slate-800/50 border border-slate-700 text-slate-400 hover:text-white hover:bg-slate-700'
        }`}
>
    <Settings size={14} />
    执行计划
    {newProtocol.executionPlan?.enabled && (
        <span className="w-2 h-2 rounded-full bg-emerald-400" />
    )}
</button>
```

### 5.2 editingMethod 状态扩展

将 `editingMethod` 的可选值扩展，或新建一个独立状态表示是否在编辑执行计划：

```typescript
// 方案A：复用 editingMethod（推荐，最小改动）
// editingMethod 值新增 'executionPlan'，在下方编辑区根据值判断渲染内容
// 注意：editingMethod 当前类型是 RequestMethod，需要扩展为联合类型

type EditingTarget = RequestMethod | 'executionPlan';
const [editingMethod, setEditingMethod] = useState<EditingTarget>('GET');
```

### 5.3 下方编辑区切换逻辑

**代码位置**：行3717 `{/* Method Editor Area */}` 处

```
原有逻辑:
  editingMethod 是 RequestMethod → 渲染 Payload 编辑区

新增逻辑:
  editingMethod === 'executionPlan' → 渲染 ExecutionPlanEditor 组件
  否则 → 保持原有 Payload 编辑区不变
```

```tsx
{/* Method Editor Area */}
<div className="flex-1 flex min-h-0 border-t border-slate-800">
    {editingMethod === 'executionPlan' ? (
        // ✅ 新增：执行计划编辑器
        <ExecutionPlanEditor
            plan={newProtocol.executionPlan}
            protocol={newProtocol}
            allProtocols={selectedSuite?.protocols || []}
            onChange={(plan) => setNewProtocol(p => ({ ...p, executionPlan: plan }))}
        />
    ) : (
        // 原有 Payload 编辑区（完全不改）
        <>
            {/* Left: Request Payload */}
            <div className="w-1/2 flex flex-col ...">
                ...
            </div>
            {/* Right: Response Payload */}
            <div className="w-1/2 flex flex-col ...">
                ...
            </div>
        </>
    )}
</div>
```

### 5.4 ExecutionPlanEditor 组件结构

新建文件 `components/ExecutionPlanEditor.tsx`，组件结构如下：

```
ExecutionPlanEditor
├── Props:
│     plan?: TestExecutionPlan
│     protocol: ProtocolDefinition
│     allProtocols: ProtocolDefinition[]  // 用于前置协议选择
│     onChange: (plan: TestExecutionPlan) => void
│
├── 头部区域:
│     执行模式切换: ○ 默认(自动)  ● 自定义流程
│
├── 步骤列表区域（当 enabled=true 时显示）:
│     可拖拽排序的步骤卡片列表
│     每个卡片包含：拖拽手柄、步骤序号、类型图标、配置表单、删除按钮
│
├── 添加步骤按钮:
│     点击后弹出步骤类型选择器
│
└── 快速模板区域:
      预设模板按钮，一键生成常见步骤组合
```

#### 5.4.1 快速模板列表

| 模板名称 | 生成的步骤 |
|---------|-----------|
| 仅 GET | `send_request(GET)` |
| SET → 验证 GET | `send_request(SET)` → `send_request(GET)` |
| SET → PUSH → GET | `send_request(SET)` → `wait_push` → `send_request(GET)` |
| SET → 手动操作 → GET | `send_request(SET)` → `manual_action` → `send_request(GET)` |
| 完整 CRUD | `send_request(SET)` → `wait_push` → `send_request(GET)` → `send_request(DELETE)` |
| 手动输入 → SET → PUSH → GET → DELETE | `manual_input` → `send_request(SET)` → `delay(3s)` → `wait_push` → `send_request(GET)` → `send_request(DELETE)` |

### 5.5 执行过程弹窗增强

#### 5.5.1 普通步骤进度弹窗（增强现有 testProgress 弹窗）

```
┌──────────────────────────────────────────────┐
│                                              │
│            ●●●●●○○○○○  45%                   │
│                                              │
│         正在执行测试...                       │
│   Appliance.Control.TimerX                   │
│                                              │
│   步骤 3/6: ⏳ 等待设备 PUSH...              │  ← 新增步骤信息
│   ┌──────────────────────┐                   │
│   │ ⏱ 倒计时: 7 秒       │                   │  ← 新增倒计时
│   └──────────────────────┘                   │
│                                              │
│   Total: 8   Current: 3                      │
│                                              │
│         [ 停止执行 ]                          │
│                                              │
└──────────────────────────────────────────────┘
```

#### 5.5.2 手动操作暂停弹窗

```
┌──────────────────────────────────────────────┐
│                                              │
│            ⚠️ 需要手动操作                    │
│                                              │
│   Appliance.Control.Upgrade                  │
│   步骤 2/5                                   │
│                                              │
│   ┌────────────────────────────────────┐     │
│   │  请将设备断电后重新上电，            │     │
│   │  等待设备重新连接后点击继续          │     │
│   └────────────────────────────────────┘     │
│                                              │
│   ⏱ 已等待: 12 秒                            │
│                                              │
│   [ 已完成，继续执行 ]    [ 跳过此步 ]        │
│                                              │
└──────────────────────────────────────────────┘
```

实现方式：`manual_action` 步骤通过 `new Promise` 暂停执行，将 `resolve` 函数存入 `manualActionModal` state，用户点击按钮调用 `resolve()`。

#### 5.5.3 手动输入弹窗

```
┌──────────────────────────────────────────────┐
│                                              │
│            ✏️ 请输入参数值                     │
│                                              │
│   Appliance.Control.TimerX SET               │
│   步骤 1/6                                   │
│                                              │
│   通道号 (channel):    [ 0        ]          │
│   开关值 (onoff):      [ 1        ]          │
│   定时时间 (duration):  [ 3600     ]          │
│                                              │
│   [ 确认并继续 ]         [ 使用默认值 ]       │
│                                              │
└──────────────────────────────────────────────┘
```

实现方式：同上，`manual_input` 步骤通过 Promise 暂停，用户填写表单后 `resolve(values)`，引擎拿到值后写入目标 method 的 payload 再继续。

---

## 6. 执行引擎设计

### 6.1 新增函数：`executeCustomPlan`

```typescript
/**
 * 按自定义执行计划逐步执行一个协议的测试
 * 在 runAllTests 内部调用，替代原有的 method 遍历逻辑
 */
const executeCustomPlan = async (
    protocol: ProtocolDefinition,
    plan: TestExecutionPlan,
    run: TestRun,
    batchResult: BatchTestResult
): Promise<void> => {
    const steps = [...plan.steps].sort((a, b) => a.order - b.order);

    for (let i = 0; i < steps.length; i++) {
        if (stopTestRef.current) break;

        const step = steps[i];

        // 更新进度
        setTestProgress(prev => prev ? {
            ...prev,
            stepCurrent: i + 1,
            stepTotal: steps.length,
            stepDescription: step.description || getStepDefaultDescription(step),
            stepType: step.type,
        } : null);

        switch (step.type) {
            case 'send_request':
                await executeSendRequestStep(protocol, step, run, batchResult);
                break;

            case 'wait_push':
                await executeWaitPushStep(protocol, step, run, batchResult);
                break;

            case 'delay':
                await executeDelayStep(step);
                break;

            case 'manual_action':
                await executeManualActionStep(protocol, step, i, steps.length);
                break;

            case 'manual_input':
                await executeManualInputStep(protocol, step, i, steps.length);
                break;

            case 'prerequisite':
                await executePrerequisiteStep(step, run, batchResult);
                break;
        }

        // 检查 stopOnFail
        // ...（根据步骤结果和 continueOnFail 判断）
    }
};
```

### 6.2 各步骤执行函数

#### `executeSendRequestStep`
- 复用现有 `runSingleTest(protocol, step.config.method)`
- 如果有 `payloadOverride`，临时覆盖 protocol 的 method payload
- 根据 `validateSchema` 决定是否校验
- 将结果记录到 run 和 batchResult

#### `executeWaitPushStep`
- 复用现有 `waitForPush(protocol)` 的核心逻辑
- 使用 `step.timeout || step.config.timeout || 10000` 作为超时
- 支持倒计时显示（通过 `setTestProgress` 更新 `countdown`）

#### `executeDelayStep`
- `await new Promise(r => setTimeout(r, step.config.duration))`
- 期间通过 `setInterval` 更新 `countdown` 实现倒计时显示

#### `executeManualActionStep`
- 弹出 `manualActionModal`
- `await new Promise(resolve => setManualActionModal({...step.config, resolve}))`
- 用户点击"已完成"按钮后 `resolve()` 继续

#### `executeManualInputStep`
- 弹出 `manualInputModal`
- `const values = await new Promise(resolve => setManualInputModal({...step.config, resolve}))`
- 用户填写字段后 `resolve(values)`
- 将 `values` 按 `field.path` 写入目标 method 的 payload JSON

#### `executePrerequisiteStep`
- 在当前 suite 中查找 `step.config.protocolId` 对应的协议
- 调用 `runSingleTest(prerequisiteProtocol, step.config.prerequisiteMethod)`
- 根据 `failAction` 决定前置失败时是终止还是继续

### 6.3 修改 `runAllTests` 分流逻辑

```typescript
// 行2817 outerLoop 处
outerLoop: for (const protocol of protocolsToRun) {
    if (stopTestRef.current) break;

    // ✅ 新增：判断是否有自定义执行计划
    if (protocol.executionPlan?.enabled && protocol.executionPlan.steps.length > 0) {
        // 使用自定义执行计划
        await executeCustomPlan(protocol, protocol.executionPlan, run, batchResult);
    } else {
        // 原有逻辑：遍历 REQUEST_METHODS
        for (const methodName of REQUEST_METHODS) {
            // ... 原有代码保持不变 ...
        }
    }
}
```

### 6.4 手动输入值写入 payload 的逻辑

```typescript
/**
 * 将手动输入的值按 JSON path 写入 payload
 * @param payload 原始 payload JSON string
 * @param field 字段定义（含 path）
 * @param value 用户输入的值
 * @returns 更新后的 payload JSON string
 */
function applyManualInputToPayload(payload: string, fields: ManualField[], values: Record<string, any>): string {
    const obj = JSON.parse(payload);
    for (const field of fields) {
        const parts = field.path.split('.');
        let current = obj;
        for (let i = 0; i < parts.length - 1; i++) {
            const key = parts[i];
            // 支持数组索引，如 "toggle.0.channel"
            if (/^\d+$/.test(key)) {
                current = current[parseInt(key)];
            } else {
                if (!current[key]) current[key] = {};
                current = current[key];
            }
        }
        const lastKey = parts[parts.length - 1];
        if (/^\d+$/.test(lastKey)) {
            current[parseInt(lastKey)] = values[field.path];
        } else {
            current[lastKey] = values[field.path];
        }
    }
    return JSON.stringify(obj);
}
```

---

## 7. 分阶段实施步骤

### 阶段一：数据模型 + 核心引擎（基础功能可用）

**目标**：数据结构就位，执行引擎能按自定义步骤运行

| 步骤 | 操作 | 文件 | 预估行数 |
|------|------|------|---------|
| 1.1 | 新增类型定义（StepType, TestStep, TestExecutionPlan 等） | `ProtocolAudit.tsx` 行22附近 | +60行 |
| 1.2 | 扩展 `ProtocolDefinition` 增加 `executionPlan` 字段 | `ProtocolAudit.tsx` 行42 | +1行 |
| 1.3 | 扩展 `testProgress` 状态类型 | `ProtocolAudit.tsx` 行1583 | 修改+5行 |
| 1.4 | 新增 `manualActionModal` 和 `manualInputModal` 状态 | `ProtocolAudit.tsx` 行1590附近 | +20行 |
| 1.5 | 实现 `executeCustomPlan` 及各步骤执行函数 | `ProtocolAudit.tsx` 行2720附近 | +250行 |
| 1.6 | 修改 `runAllTests` 增加分流判断 | `ProtocolAudit.tsx` 行2817 | 修改+10行 |
| 1.7 | 扩展 `StoredProtocolDefinition` 增加 `executionPlan` | `auditStorageService.ts` 行56 | +1行 |

### 阶段二：执行过程 UI（手动交互可用）

**目标**：执行时能显示步骤进度、倒计时，能弹出手动操作和手动输入弹窗

| 步骤 | 操作 | 文件 | 预估行数 |
|------|------|------|---------|
| 2.1 | 增强进度弹窗（步骤信息、倒计时） | `ProtocolAudit.tsx` 行4497-4525 | 修改+30行 |
| 2.2 | 实现手动操作暂停弹窗 | `ProtocolAudit.tsx` 行4525附近 | +50行 |
| 2.3 | 实现手动输入弹窗 | `ProtocolAudit.tsx` 行4525附近 | +80行 |

### 阶段三：执行计划编辑器 UI（用户可配置）

**目标**：用户能在协议编辑面板中配置自定义执行计划

| 步骤 | 操作 | 文件 | 预估行数 |
|------|------|------|---------|
| 3.1 | 新建 `ExecutionPlanEditor.tsx` 组件 | `components/ExecutionPlanEditor.tsx` | ~500行 |
| 3.2 | 在 method 行右侧增加执行计划按钮 | `ProtocolAudit.tsx` 行3713附近 | +20行 |
| 3.3 | 扩展 `editingMethod` 类型，增加 `'executionPlan'` | `ProtocolAudit.tsx` | 修改+5行 |
| 3.4 | 在编辑区增加条件渲染（执行计划 vs Payload） | `ProtocolAudit.tsx` 行3717 | 修改+10行 |
| 3.5 | 实现步骤类型选择器 | `ExecutionPlanEditor.tsx` 内 | 含在3.1中 |
| 3.6 | 实现各步骤类型的配置表单 | `ExecutionPlanEditor.tsx` 内 | 含在3.1中 |
| 3.7 | 实现拖拽排序 | `ExecutionPlanEditor.tsx` 内 | 含在3.1中 |
| 3.8 | 实现快速模板功能 | `ExecutionPlanEditor.tsx` 内 | 含在3.1中 |

### 阶段四：增强完善

| 步骤 | 操作 | 文件 |
|------|------|------|
| 4.1 | 协议列表中显示执行计划标识（小图标） | `ProtocolAudit.tsx` TestPlanPanel 内 |
| 4.2 | 执行日志增强（每步详细日志、耗时） | `ProtocolAudit.tsx` |
| 4.3 | 执行计划的导入导出 | `ExecutionPlanEditor.tsx` |
| 4.4 | 批量为协议套用模板 | `ExecutionPlanEditor.tsx` |

---

## 8. 文件改动清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `components/ProtocolAudit.tsx` | **修改** | 1) 新增类型定义 2) 扩展状态 3) 执行引擎 4) UI入口 5) 弹窗 |
| `components/ExecutionPlanEditor.tsx` | **新建** | 执行计划编辑器组件（步骤列表、配置表单、模板） |
| `services/auditStorageService.ts` | **修改** | StoredProtocolDefinition 增加 executionPlan 字段 |
| `services/auditDatabaseService.ts` | **无需修改** | executionPlan 随 protocol 整体序列化存储 |

---

## 9. 测试验证方案

### 9.1 向下兼容测试

- [ ] 没有配置执行计划的协议，执行行为与修改前完全一致
- [ ] 现有协议库导入/导出不受影响
- [ ] 现有测试历史记录正常显示

### 9.2 执行计划编辑器测试

- [ ] 切换"默认/自定义"模式正常
- [ ] 添加各类型步骤正常
- [ ] 拖拽排序正常
- [ ] 删除步骤正常
- [ ] 各步骤配置表单输入正常
- [ ] 快速模板一键生成正常
- [ ] 保存后执行计划持久化正常
- [ ] 切换到 method 编辑再切回来数据不丢失

### 9.3 执行引擎测试

| 场景 | 预期行为 |
|------|---------|
| 仅 GET 协议（无执行计划） | 走原有逻辑，发送 GET → 校验 GETACK |
| SET→PUSH→GET 执行计划 | 按步骤顺序执行，PUSH 步骤等待设备推送 |
| 带手动操作的执行计划 | 执行到手动步骤时弹窗暂停，确认后继续 |
| 带手动输入的执行计划 | 弹出输入表单，填写后值写入 payload，继续执行 |
| 带前置协议的执行计划 | 先执行前置协议，成功后继续本协议步骤 |
| 带延时的执行计划 | 延时期间显示倒计时，到时后继续 |
| 中途停止 | 点击"停止执行"按钮后立即停止 |
| 步骤失败 + continueOnFail=true | 记录失败，继续执行后续步骤 |
| 步骤失败 + continueOnFail=false | 记录失败，终止该协议后续步骤 |

### 9.4 典型场景端到端测试

**场景A：Appliance.Control.TimerX**
```
执行计划: manual_input(channel,onoff) → SET → delay(3s) → wait_push(15s) → GET → DELETE
预期：弹出输入框 → 填写后执行SET → 等待3秒 → 等待PUSH → 执行GET → 执行DELETE → 全部通过
```

**场景B：Appliance.Control.Upgrade**
```
执行计划: prerequisite(Config.Upgrade SET) → manual_action(设备重上电) → delay(30s) → GET
预期：先执行升级配置 → 弹出重上电提示 → 确认后等待30秒 → 执行GET验证 → 通过
```

---

## 附录：常见问题

### Q1: editingMethod 类型扩展会不会影响现有逻辑？
A: 需要注意所有使用 `editingMethod` 的地方。现有代码中 `editingMethod` 用于：
- 判断当前编辑哪个 method 的 payload（需排除 'executionPlan'）
- 在 method 按钮上判断高亮状态（'executionPlan' 时所有 method 按钮不高亮）

所以在渲染 Payload 编辑区的地方需要添加 `editingMethod !== 'executionPlan'` 的判断，或者在外层用条件渲染包裹。

### Q2: 执行计划存储会增加多少数据量？
A: 每个协议的执行计划通常包含 3-8 个步骤，每步骤约 200-500 字节 JSON。一个标准协议库（30个协议）约增加 30KB-120KB 存储。对 localStorage 和数据库均无影响。

### Q3: 如何处理执行计划中引用的前置协议被删除的情况？
A: 在 `executePrerequisiteStep` 中查找前置协议时，如果找不到，记录错误日志并根据 `failAction` 决定是跳过还是终止。
