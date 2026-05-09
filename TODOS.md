# TODOs

Items ordered from simplest to hardest.

## Regressions (introduced by sub-agent session)

### R1. `MCP_TaskClosed` neighbor selection still broken

`s.taskOrder.indexOf(taskId)` is called at `tasks.ts:902` **after** `cleanupPanelEntries` has already removed `taskId` from `s.taskOrder` (line 897). It always returns `-1`, so `neighborIdx` is always `0` — the active task always jumps to the first task instead of the adjacent one.

Fix: capture idx before `cleanupPanelEntries`, use the return value, and index into `s.taskOrder` (already filtered) rather than re-filtering.

- File: `src/store/tasks.ts` `MCP_TaskClosed` handler (~line 895)

### R2. `signalDoneReceived` and `needsReview` not persisted

Both fields exist on `Task` in `types.ts` but are absent from `saveState()` and `loadState()` in `persistence.ts`, and from `autosave.ts`. They are lost on app restart — "needs review" badges and done signals disappear on reload.

Fix: add both fields to `PersistedTask` in `types.ts` and include them in the save/load blocks in `persistence.ts` (active and collapsed), plus the autosave snapshot.

- Files: `src/store/types.ts`, `src/store/persistence.ts`, `src/store/autosave.ts`

### R3. `createTask` failure cleanup incomplete — zombie tasks left in memory

On `createTask` failure, the `catch` block at `coordinator.ts:578` only restores the preamble file then re-throws. It does NOT call `this.tasks.delete(task.id)`, `this.tailBuffers.delete(agentId)`, `this.subscribers.delete(agentId)`, or `killAgent(agentId)`. If `spawnAgent` succeeded before the failure, a running PTY agent is leaked and the task remains in `this.tasks` indefinitely.

Fix: the catch block should remove all in-memory state and kill the agent if it was spawned (the full cleanup that was implemented earlier and reverted).

- File: `electron/mcp/coordinator.ts` `createTask()` catch block (~line 578)

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

### R4. `.claude/settings.local.json` preamble injection not stripped before merge

For Claude agents, the preamble is written into `.claude/settings.local.json` (`coordinator.ts:446`). This file is assumed to be gitignored, but if a project tracks it, `git add -A` in the auto-commit will stage the injected preamble content and it will land in the merge. `stripPreambleFromBranch` has no code path for this file.

Fix: either explicitly `git restore .claude/settings.local.json` before auto-commit, or track it the same way as AGENTS.md/GEMINI.md (store original content, strip before commit).

- File: `electron/mcp/coordinator.ts` `mergeTask()` / `stripPreambleFromBranch()`

### 12. `review_and_merge_task` merges before coordinator can review

`reviewAndMergeTask()` calls `getTaskDiff()` then immediately calls `mergeTask()` (`coordinator.ts:774-775`), returning the diff only after the merge is complete. The coordinator preamble instructs agents to "review the result and call `review_and_merge_task`" — but the diff arrives post-merge, so the "review" is cosmetic and cannot abort the merge.

Fix: either update the preamble to use `get_task_diff → merge_task → close_task` explicitly and deprecate `review_and_merge_task`, or split the tool into two calls with a genuine gate between them.

### 13. `gitIsolation` accepted by REST but silently ignored end-to-end

REST validates and forwards `gitIsolation` (`remote/server.ts:271`), but `MCPClient.createTask()` has no `gitIsolation` field, the MCP tool schema omits it, and `Coordinator.createTask()` always creates a worktree unconditionally. A caller that requests a different isolation mode gets a worktree with no error.

Fix: either remove `gitIsolation` from the REST path, or implement and forward only supported modes explicitly.

### 14. `SubTaskStrip` collapsed sub-task click selects without uncollapsing

The strip now includes collapsed sub-tasks, but the click handler only calls `setActiveTask(task.id)` (`SubTaskStrip.tsx:186`). Clicking a collapsed sub-task selects it without uncollapsing it, leaving it hidden.

Fix: if `task.collapsed`, call `uncollapseTask(task.id)` before `setActiveTask`.

- File: `src/components/SubTaskStrip.tsx`

### 15. Preamble stripping deletes intentionally empty tracked instruction files

`stripPreambleFromBranch()` deletes the preamble file when the content before the injected block is empty/whitespace (`coordinator.ts:800`). If a project had an intentionally empty tracked `AGENTS.md`, `GEMINI.md`, or `.agent.md`, the merge will stage its deletion.

Fix: store whether the file existed originally (not just its content) and always restore to original state — delete only if the file was newly created, restore the original bytes (even if empty) if it existed.

- File: `electron/mcp/coordinator.ts` `stripPreambleFromBranch()`

### 18. Sidebar drag indices wrong when coordinated children are hidden/nested

`taskIndexById` indexes raw `store.taskOrder` (`Sidebar.tsx:134`). Coordinated children are filtered out of the flat rendered list and nested under the coordinator (`sidebar-order.ts:54`). `computeDropIndex()` returns a rendered DOM index (`Sidebar.tsx:253`), then `reorderTask(from, to)` applies that index to raw `taskOrder` (`Sidebar.tsx:296`). If `taskOrder` contains hidden coordinated children, dragging top-level tasks can insert them between a coordinator and its child in raw order.

Fix: base dragging on task IDs / visible order, then translate to raw `taskOrder` preserving coordinator child blocks.

### 19. Collapsed coordinator children can recurse into odd UI states

`CollapsedTaskEntry` renders children for collapsed coordinators (`Sidebar.tsx:1071`). Clicking a collapsed child uncollapses it directly while its parent coordinator remains collapsed, creating a visible active child nested under a collapsed coordinator or moving it depending on derived order.

Fix: restoring a collapsed child should restore/activate the coordinator, or children should not be independently restorable while their coordinator is collapsed.
