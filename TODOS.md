# TODOs

Items ordered from simplest to hardest.

> **Testing note:** "Easy" items are single-file stubs used to exercise the
> coordinator end-to-end. Any files they create (`docs/`, `.editorconfig`,
> `CONTRIBUTING.md`, `CHANGELOG.md`, etc.) can be deleted after the test run —
> they exist only to give the coordinator real work to dispatch.

## Easy (coordinator test tasks)

### 1. Add a README file to the docs/ folder

Create `docs/coordinator-mode.md` with a one-paragraph description of
coordinator mode and how it works. No other files needed.

### 2. Add a `.editorconfig` file to the repo root

Create a standard `.editorconfig` at the root of the project with
`indent_style = space`, `indent_size = 2`, and `end_of_line = lf`.

### 3. Add a `CONTRIBUTING.md` stub to the repo root

Create `CONTRIBUTING.md` at the root with a single sentence:
"See the README for build instructions." No other content needed.

### 4. Add a `CHANGELOG.md` stub to the repo root

Create `CHANGELOG.md` at the root with a single line: `# Changelog` and one
bullet: `- Initial release`. No other content needed.

## Medium

### 5. `get_task_output` truncates at 20 000 chars with no indication

The MCP `get_task_output` tool silently truncates scrollback to 20 000
characters. If the output is truncated the coordinator gets no signal that it
saw only part of the output. Append a `\n[... output truncated at 20000 chars ...]`
sentinel when truncation occurs.

- File: `electron/mcp/coordinator.ts`, `getTaskOutput` method

### 6. `merge_task` worktree fix not validated in a live run

`dfaf91d` fixed `gitMergeTask` to operate in the coordinator's worktree instead
of doing `git checkout` in the main repo. The fix was committed but never
exercised — in the last test session the coordinator failed on an old binary and
then worked around the issue by not calling `merge_task`. Needs a clean
end-to-end run to confirm the fix works.

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

## Tests

The MCP backend (`electron/mcp/coordinator.test.ts`) is well covered. The
frontend integration added in this PR has no tests. Items below are the highest
value gaps — all are unit-testable with Vitest + jsdom without a running Electron
instance.

### 12. `setTaskControl` store function — unit test

`src/store/tasks.ts` `setTaskControl(taskId, who)`:

- Sets `controlledBy` in the store
- Does NOT invoke `MCP_ControlChanged` IPC when `task.coordinatorMode === true`
- DOES invoke `MCP_ControlChanged` IPC for coordinated sub-tasks
- Calls `saveState()` in both cases

### 13. `MCP_TaskCreated` handler — `controlledBy` initialisation

`src/store/tasks.ts` handler for `IPC.MCP_TaskCreated`:

- Newly created sub-task has `controlledBy: 'coordinator'` in the store
- `coordinatedBy` is set to the coordinator task ID
- (Regression guard for the bug where sub-tasks were created without `controlledBy`)

### 14. Persistence round-trip for `controlledBy`

`src/store/persistence.ts`:

- A coordinator task (`coordinatorMode: true`) with `controlledBy: 'coordinator'`
  survives a save/load round-trip with the value intact
- A coordinated sub-task with `controlledBy: 'human'` survives a round-trip
- An old state file with no `controlledBy` field on a coordinator task defaults
  to `'coordinator'` on load (not `undefined`)
- An old state file with no `controlledBy` on a coordinated sub-task defaults
  to `'coordinator'` on load

### 15. Autofire skips ticks when coordinator task has human control

`src/components/PromptInput.tsx` autofire interval:

- When `store.tasks[taskId].controlledBy === 'human'`, the interval callback
  returns early without incrementing the miss counter or attempting to fire
- When `controlledBy` reverts to `'coordinator'`, the next tick runs normally

### 16. `TerminalView` — `disableStdin` tracks `controlledBy`

`src/components/TerminalView.tsx` `createEffect` inside `onMount`:

- When task `controlledBy` is `'coordinator'`, `term.options.disableStdin` is `true`
- When task `controlledBy` is `'human'`, `term.options.disableStdin` is `false`
- When task has no `coordinatedBy` or `coordinatorMode` (`controlledBy` undefined),
  `disableStdin` is `false`

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
