# Unsaved Changes & Navigation Workflow

## Overview
This document outlines the implementation of the "Unsaved Changes" warning system and the enhanced navigation workflow in the Protocol Audit component.

## Features

### 1. Clickable Protocol Library Name
- **Location**: Top Header.
- **Behavior**: Clicking the protocol library name (e.g., "Active Project Name") now navigates the user back to the Test Result List (Suite Overview).
- **Implementation**:
  - Replaced `<span>` with `<button>`.
  - Uses `safeNavigate` to ensure unsaved changes are checked before navigation.

### 2. Unsaved Changes Warning
- **Trigger**: Attempting to navigate away from a protocol editing session when there are unsaved changes.
- **Detection**: Compares `newProtocol` (current state) with `originalProtocol` (state at start of edit or last save).
- **UI**: A non-blocking modal dialog.
- **Options**:
  - **Cancel**: Stay on the current page.
  - **Discard & Leave**: Discard changes and proceed with navigation.

### 3. Safe Navigation Wrapper (`safeNavigate`)
- A utility function that wraps any navigation action.
- **Logic**:
  - Checks `hasUnsavedChanges()`.
  - If true: Shows modal, stores the intended navigation action in `pendingNavigation`.
  - If false: Executes the navigation action immediately.
- **Covered Actions**:
  - **Header**: Dashboard, Protocol Library Name, Run Tests, Add Protocol.
  - **Sidebar**: Select Protocol, Select Suite, Add Suite, Auto Generate, Statistics Report, Quick Run.
  - **Right Panel**: Back Button (Return to List).

### 4. Dirty State Management
- **Start Editing**: `originalProtocol` is set to a deep copy of the protocol.
- **Save/Create**: `originalProtocol` is updated to match the saved state, resetting the dirty flag.

## Code Changes
- Modified `ProtocolAudit.tsx`:
  - Added `originalProtocol`, `showUnsavedChangesModal`, `pendingNavigation` states.
  - Implemented `hasUnsavedChanges` and `safeNavigate`.
  - Updated `addProtocolToSuite` to sync `originalProtocol`.
  - Updated `TestPlanPanel`'s `onSelectProtocol` to use `safeNavigate`.
  - Added Modal JSX.
  - Fixed `StatusIcon` type error.

## Usage
- **Developers**: When adding new navigation actions that leave the protocol editor, always wrap the state update with `safeNavigate(() => { ... })`.
