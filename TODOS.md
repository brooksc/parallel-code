# TODOs

Items ordered from simplest to hardest.

## Medium (known edge cases — no fix yet)

### 7. Autofire expiry window — coordinator in long tool call during countdown

`bf07118` escalates to an orphaned notification after 10 prompt misses, but if
the coordinator is mid-tool-call when the autofire countdown fires (no PTY
prompt visible), the countdown fires, finds no prompt, misses 10 times, and
escalates unnecessarily. Whether this happens in practice depends on timing; no
fix yet.

### 8. Post-restart coordinator MCP config becomes stale if coordinator process restarts

`22effac` persists `mcpConfigPath` across app restarts and rewrites configs with
the new port/token. However, if the coordinator Claude process itself restarts
(not the Electron app), the MCP server URL and token change and any running
sub-tasks are unreachable. Edge case, but real.

## Hard

### 9. Backend coordinator task registry is not hydrated after app restart

On app restart, `App.tsx` restarts the MCP server for persisted coordinator
tasks, but the backend `Coordinator.tasks` map is empty — it's only populated
by live `createTask()` calls. Resumed coordinator sessions can have visible
child tasks in the UI while MCP tools (`list_tasks`, `send_prompt`,
`wait_for_signal_done`, `close_task`) operate on an empty registry and fail
silently.

Fix: add a backend hydration path. After `loadState()` and coordinator MCP
startup, replay each restored coordinated child into `Coordinator.tasks` —
including task id, agent id, branch, worktree, coordinator id, status, and
base branch. This is non-trivial because the backend task type differs from the
frontend `PersistedTask` shape.

### 10. Backend `controlMap` is not restored after app restart

The frontend persists and restores `controlledBy` correctly, but the backend
gate uses an in-memory `controlMap` in `coordinator.ts`. On restart, no path
replays `controlledBy === 'human'` sub-task state into `IPC.MCP_ControlChanged`.
The UI can show "You have control" while the backend still allows coordinator
`send_prompt` to go through.

Fix: after coordinator MCP startup completes, replay `MCP_ControlChanged` for
any restored coordinated children whose `controlledBy === 'human'`. Depends on
fix #9 above (backend must have the task registered before control state can be
set on it).

### 11. `MCP_CoordinatorOrphanedNotification` channel is overloaded with incompatible payloads

Main→renderer orphan notifications carry `{ subTaskId, notificationId, state, text }`
(`coordinator.ts:195`). Renderer→main uses the same channel name for
`{ coordinatorTaskId, batchId }` (`PromptInput.tsx`). Direction prevents
runtime collision today, but the overload is masking a real behavior gap:
the renderer-to-main path just `ackNotification()`s without surfacing any
review state on the affected sub-tasks — the notification is silently dropped.

Fix: split into two channels (`MCP_CoordinatorNotificationDropAck` for the
renderer-to-main ack path, keep `MCP_CoordinatorOrphanedNotification` for
main-to-renderer sub-task review surfacing). Separately, decide whether the
drop-ack path should mark affected sub-tasks `needsReview` before acking.

## UI / Behavior

### 18. Sidebar drag indices wrong when coordinated children are hidden/nested

`taskIndexById` indexes raw `store.taskOrder` (`Sidebar.tsx:134`). Coordinated children are filtered out of the flat rendered list and nested under the coordinator (`sidebar-order.ts:54`). `computeDropIndex()` returns a rendered DOM index (`Sidebar.tsx:253`), then `reorderTask(from, to)` applies that index to raw `taskOrder` (`Sidebar.tsx:296`). If `taskOrder` contains hidden coordinated children, dragging top-level tasks can insert them between a coordinator and its child in raw order.

Fix: base dragging on task IDs / visible order, then translate to raw `taskOrder` preserving coordinator child blocks.

### 19. Collapsed coordinator children can recurse into odd UI states

`CollapsedTaskEntry` renders children for collapsed coordinators (`Sidebar.tsx:1071`). Clicking a collapsed child uncollapses it directly while its parent coordinator remains collapsed, creating a visible active child nested under a collapsed coordinator or moving it depending on derived order.

Fix: restoring a collapsed child should restore/activate the coordinator, or children should not be independently restorable while their coordinator is collapsed.
