# Protocol Audit Redesign - Technical Implementation Plan

## 1. Overview
This document outlines the technical plan to redesign the `ProtocolAudit` module into a project-centric, workflow-driven interface. The goal is to support "Post-Provisioning" testing with a mix of automated verification and interactive confirmation, powered by Confluence data.

## 2. Data Model Evolution

We will evolve the existing `ProtocolTestSuite` into a more robust `AuditProject` structure.

### 2.1. AuditProject (formerly ProtocolTestSuite)
```typescript
interface AuditProject {
    id: string;
    name: string;          // e.g., "Smart Speaker V1"
    deviceId?: string;     // Bound device ID
    targetDeviceName?: string;
    protocols: ProtocolDefinition[];
    createdAt: number;
    updatedAt: number;
    status: 'ACTIVE' | 'ARCHIVED';
}
```

### 2.2. ProtocolDefinition (Enhanced)
We will add fields to support the "Auto vs Interactive" classification.

```typescript
interface ProtocolDefinition {
    id: string;
    namespace: string;     // e.g., "Appliance.System.Info"
    category: string;      // e.g., "System", "Audio" (Derived from namespace)
    
    // Confluence Metadata
    docUrl?: string;
    description?: string;
    
    // Methods
    methods: {
        [key in RequestMethod]?: MethodTest;
    };
    
    // Status
    reviewStatus: 'UNVERIFIED' | 'VERIFIED';
}

interface MethodTest {
    enabled: boolean;
    type: 'AUTO' | 'INTERACTIVE'; // NEW: Determines where it shows in UI
    
    // Request Configuration
    payload: string;       // JSON Template from Confluence
    parameters?: ParameterConfig[]; // NEW: For parameterized GETs
    
    // Validation
    schema: string;        // Expected Response Schema
    
    // Execution State
    lastResult?: DetailedTestResult;
}
```

## 3. Component Architecture

The `ProtocolAudit.tsx` file will be refactored into a container that manages the high-level view state.

### 3.1. Main Container (`ProtocolAudit`)
*   **State**: `currentView` ('DASHBOARD' | 'WORKSPACE'), `activeProject`.
*   **Responsibility**: Routing between the Project List and the Active Project Workspace.

### 3.2. View 1: Project Dashboard (`ProjectDashboard`)
*   **UI**: Grid of cards.
*   **Actions**: Create New Project, Select Project, Delete Project.

### 3.3. View 2: Audit Workspace (`AuditWorkspace`)
The core 3-column layout.

*   **Left: Test Plan (`TestPlanPanel`)**
    *   Tree view of `activeProject.protocols`.
    *   Grouped by Namespace segments (e.g., `Appliance` -> `System`).
    *   Visual indicators for Pass/Fail/Pending.
    
*   **Center: Protocol Workbench (`WorkbenchPanel`)**
    *   **Zone A: Auto-Verification**: Filters `methods` where `type === 'AUTO'`. Renders a compact list + "Run All" button.
    *   **Zone B: Interactive Task**: Renders the *Active Protocol*.
        *   Uses a new `TreePropertyEditor` component (evolution of `FieldTreeItem`) to edit Payload/Parameters.
        *   "Execute" button triggers MQTT request.

*   **Right: Live Inspection (`InspectionPanel`)**
    *   **Top**: `ResponseViewer` (JSON with Schema Validation highlights).
    *   **Bottom**: `TrafficLog` (Filtered MQTT stream).

## 4. Implementation Steps

### Phase 1: Foundation & Dashboard
1.  Refactor `ProtocolAudit` state to support multiple "Projects" (Suites).
2.  Implement `ProjectDashboard` component.
3.  Implement navigation logic (Dashboard <-> Workspace).

### Phase 2: Workspace Layout & Navigation
1.  Scaffold the 3-column `AuditWorkspace`.
2.  Implement `TestPlanPanel` (Left) using the existing recursive tree logic but styled for navigation.
3.  Implement `InspectionPanel` (Right) by moving existing Log/Result logic.

### Phase 3: The Workbench (Core)
1.  Implement **Auto-Classification Logic**:
    *   IF method is GET AND payload is empty -> `AUTO`.
    *   ELSE -> `INTERACTIVE`.
2.  Build `AutoVerificationZone`: Batch runner for AUTO items.
3.  Build `TreePropertyEditor`: The "Screenshot-style" editor.
    *   Columns: Key, Type, Value (Editable), Description.
    *   Populate `Value` from Confluence defaults.

### Phase 4: Integration
1.  Connect `ProtocolGenerator` (Confluence Service) to populate the new data structure.
2.  Ensure MQTT loop works with the new UI.

## 5. User Confirmation
Please review this plan. If approved, I will begin with **Phase 1**.
