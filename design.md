# Coordinator Mode — Design Document

PR #100 · `feature/orchestrator-control-v2`

---

## 1. What is coordinator mode?

Coordinator mode lets a single "coordinator" Claude instance act as an
orchestrator: it receives a high-level task from the user, breaks it into
parallel sub-tasks, creates isolated git worktrees for each, monitors their
progress, reviews results, and merges the work — all without leaving the
Claude Code session.

From the user's perspective:

1. Open the New Task dialog, enable **Coordinator mode**, write a prompt.
2. Claude starts with a preamble that explains the MCP tools available to it.
3. Claude creates N sub-tasks via `create_task`; each gets its own branch,
   worktree, and agent.
4. The coordinator loops on `wait_for_signal_done` until every sub-task calls
   `signal_done`.
5. For each finished sub-task, the coordinator reads the diff, calls
   `review_and_merge_task`, and the work lands in the base branch.
6. The app notifies the user when the coordinator is idle for review.

---

## 2. Architecture overview

```
┌─────────────────────────────────────────────────────────┐
│  Electron renderer (SolidJS)                            │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │TaskPanel │  │PromptInput   │  │SubTaskStrip      │  │
│  │(control  │  │(autofire,    │  │(live sub-task     │  │
│  │ bar)     │  │ staged notif)│  │ status)           │  │
│  └────┬─────┘  └──────┬───────┘  └──────────────────┘  │
│       │  IPC           │ IPC                             │
└───────┼────────────────┼─────────────────────────────────┘
        │                │
┌───────┼────────────────┼─────────────────────────────────┐
│  Electron main process │                                 │
│  ┌─────────────────────▼──────────────────────────────┐  │
│  │  Coordinator class (electron/mcp/coordinator.ts)   │  │
│  │  - task lifecycle (create/kill/close)              │  │
│  │  - PTY output monitoring (idle detection)          │  │
│  │  - notification batching + staging                 │  │
│  │  - signal_done / wait_for_signal_done              │  │
│  └───────────────────┬────────────────────────────────┘  │
│                      │ HTTP (127.0.0.1:random)            │
└──────────────────────┼─────────────────────────────────── ┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│  MCP stdio server (electron/mcp/server.ts)              │
│  Spawned as a child process, speaks MCP over stdio      │
│  to coordinator Claude. Proxies tool calls via HTTP.    │
└─────────────────────────────────────────────────────────┘
         ▲  MCP over stdio
         │
┌────────┴────────────────────────────────────────────────┐
│  Coordinator Claude (claude --mcp-config ...)           │
│  Has access to 12 MCP tools                             │
└─────────────────────────────────────────────────────────┘
```

### Why a separate MCP stdio server?

Claude Code communicates with MCP servers over stdio. Electron's main process
can't act as a stdio server directly (it already owns stdin/stdout for its own
use). The solution: spawn a small Node.js script (`electron/mcp/server.ts`) as
a child process. It speaks MCP over its stdio, and forwards every tool call to
the main process via an HTTP API (`electron/remote/server.ts`). The HTTP
transport uses a randomly-assigned port on localhost with a shared secret token,
so no cross-machine access is possible.

### Why HTTP between the MCP server and the main process?

The `remote/server.ts` HTTP API already existed to support the Remote Access
feature (mobile/tablet pairing). Reusing it for the coordinator MCP bridge
avoided building a second IPC mechanism. The coordinator gets its own
HTTP endpoint scope using a `coordinatorTaskId` query parameter, keeping its
calls separate from the remote-access REST paths.

---

## 3. The Coordinator class

`electron/mcp/coordinator.ts` — the heart of the feature. A singleton created
at app startup when `coordinatorModeEnabled` is true.

### State it maintains

| Field                    | Purpose                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `tasks`                  | `Map<taskId, CoordinatedTask>` — all sub-tasks across all coordinators                             |
| `coordinators`           | `Map<coordinatorTaskId, CoordinatorState>` — registered coordinators and their notification queues |
| `tailBuffers`            | Last ~4 KB of PTY output per sub-task agent, used for idle detection                               |
| `idleResolvers`          | Pending `wait_for_idle` promises per task                                                          |
| `anySignalResolvers`     | Pending `wait_for_signal_done` promises per coordinator                                            |
| `controlMap`             | `Map<taskId, 'coordinator' \| 'human'>` — current control owner for each sub-task                  |
| `blockedByHumanControl`  | Sub-tasks where `send_prompt` was attempted while human had control                                |
| `activeSignalWaitCounts` | How many active `wait_for_signal_done` calls a coordinator has in flight                           |

### Task lifecycle

```
create_task → createTask()
  → createBackendTask() — creates git worktree + branch
  → spawnAgent()        — starts PTY with claude/codex/etc.
  → subscribeToAgent()  — listens to PTY output for idle detection
  → writes preamble file (AGENTS.md, GEMINI.md, or settings.local.json)
    depending on the agent type
  → task status: 'running'

PTY output → chunkContainsAgentPrompt()
  → if prompt detected AND task is 'running' AND not in a signal wait:
       → maybeQueueReviewNotification() after notificationDelayMs
  → if agent exits:
       → status: 'exited'
       → resolve any idleResolvers
       → maybeQueueReviewNotification()

signal_done → signalDone()
  → marks task.signalDoneAt
  → if a wait_for_signal_done resolver is queued:
       → suppress pending notification (prevents double-notify)
       → resolve the promise with { taskId, name, remaining }
       → finishSignalWait()
  → else: queue review notification via maybeQueueReviewNotification()

close_task → cleanupTask()
  → killAgent()
  → deleteTask() — removes worktree + branch
  → deletes preamble file it wrote
  → removes from this.tasks
```

### Idle detection

The coordinator needs to know when a sub-task's agent has finished its current
work and is back at the prompt. The mechanism:

1. `subscribeToAgent(agentId, cb)` — registers a callback that fires for every
   PTY output chunk.
2. Each chunk is appended to a rolling `tailBuffer` (capped at ~4 KB).
3. `chunkContainsAgentPrompt()` scans the tail for `❯` or `›` (Claude Code's
   prompt markers). The same logic used by `PromptInput`'s autofire.
4. When a prompt is detected and the task is `running`, the coordinator starts a
   `notificationDelayMs` timer (default 30 s). If the agent is still idle when
   the timer fires, a review notification is staged for the coordinator task.

This avoids polling: we react to PTY events instead of sampling at intervals.

### Per-agent preamble injection

Sub-tasks need to know about `signal_done`. Rather than hard-coding a Claude
assumption, the coordinator inspects the agent command:

| Agent command contains         | File written to worktree      |
| ------------------------------ | ----------------------------- |
| `codex` or `opencode`          | `AGENTS.md`                   |
| `gemini`                       | `GEMINI.md`                   |
| `copilot`                      | `.agent.md`                   |
| anything else (Claude default) | `.claude/settings.local.json` |

The file contains the sub-task instructions including a `signal_done`
reminder. Because the file lives in the worktree (not the project root),
`close_task` can safely delete it without affecting the main repo.

---

## 4. The MCP tool surface

Twelve tools exposed to the coordinator agent.

### Coordinator-side tools

| Tool                    | What it does                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------- |
| `create_task`           | Creates a git worktree, spawns an agent, delivers the prompt. Returns `{ taskId, name, branchName }`.                                   |
| `list_tasks`            | Returns all sub-tasks for this coordinator with name, status, branch.                                                                   |
| `get_task_status`       | Returns detailed status including git diff stats, agent state, signal_done flag.                                                        |
| `send_prompt`           | Writes text to a sub-task's PTY. Blocked if human has control of that task.                                                             |
| `wait_for_idle`         | Blocks until the sub-task agent returns to its prompt. Used before `send_prompt` follow-ups. Returns `{ reason: 'idle'                  | 'exited' | 'human_control' }`. |
| `get_task_diff`         | Returns `{ files, diff }` for review. Diff truncated at 50 KB with a notice.                                                            |
| `get_task_output`       | Returns recent PTY scrollback, ANSI-stripped.                                                                                           |
| `wait_for_signal_done`  | Blocks until ANY sub-task calls `signal_done`. Returns `{ taskId, name, remaining }` — `remaining` is the count of tasks still pending. |
| `review_and_merge_task` | Atomically: gets diff, merges branch into base, cleans up worktree. Returns both in one call.                                           |
| `merge_task`            | Merge without cleanup (lower-level; `review_and_merge_task` preferred).                                                                 |
| `close_task`            | Kill agent, delete worktree and branch.                                                                                                 |

### Sub-task-side tool

| Tool          | What it does                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `signal_done` | Sub-task calls this when its work is complete. Wakes the coordinator's `wait_for_signal_done`. |

### wait_for_signal_done design

This tool went through a significant redesign. The original design had a
`taskId` parameter — you waited for a specific task. The problem: the
coordinator had to guess which task would finish first, or wait for each
task sequentially, preventing true parallelism.

The redesigned version takes no `taskId` — it returns whichever sub-task
completes next. The `remaining` field tells the coordinator how many tasks
are still pending, enabling a clean loop:

```python
# Coordinator loop pattern
while remaining > 0:
    result = wait_for_signal_done()   # blocks until next completion
    taskId = result.taskId
    remaining = result.remaining
    diff = review_and_merge_task(taskId)  # MUST review before next wait
```

The `signalDoneConsumed` flag on `CoordinatedTask` prevents double-delivery:
once a resolver has been handed a task, subsequent `wait_for_signal_done`
calls skip it. `countRemaining()` counts tasks where `!signalDoneConsumed`
and not `(exited && !signalDoneAt)`.

---

## 5. Notification system

When a sub-task is done (either by `signal_done` or by going idle after
natural exit), the coordinator needs to be told. The problem: you can't just
inject arbitrary text into an active Claude Code session mid-thought.

### Staged notifications

The mechanism mirrors what happens when you stage text in the `PromptInput`:

1. `maybeQueueReviewNotification(task, state, exitCode, delayMs)` queues a
   `PendingNotification` for the coordinator.
2. After `notificationDelayMs` (default 30 s), if the task is still in
   review-worthy state, the pending notifications for that coordinator are
   batched into a single `StagedNotification`.
3. The `StagedNotification` is sent to the renderer via
   `MCP_CoordinatorNotificationStaged` IPC, which sets it on the coordinator
   task in the SolidJS store.
4. `PromptInput` displays a yellow "Staged for auto-send" chip and an amber
   textarea border.
5. After a countdown (default 30 s more), `PromptInput`'s autofire interval
   detects the coordinator's PTY is at the `❯` prompt and injects the staged
   text — as if the user had typed and submitted it.

### Why the delay?

The coordinator often finishes a sub-task while the coordinator Claude is
still busy with other tasks. Immediately injecting a prompt would interrupt
it. The two-stage delay (notification delay + autofire countdown) gives the
coordinator time to finish its current work before the next review prompt
lands.

### Orphaned notifications

If the coordinator task is closed while a sub-task's notification is pending,
the notification becomes "orphaned". The sub-task shows an amber **Review**
badge in the UI so the user can manually inspect it.

### Notification suppression during signal waits

When `wait_for_signal_done` resolves directly (a resolver was waiting),
`suppressPendingNotificationForTask()` is called **before** the resolver
fires. This ordering matters: `finishSignalWait()` runs after and might
call `stageBatch()` — if suppression happened after, the notification would
get re-staged.

---

## 6. Control handoff

### The problem

The coordinator auto-fires prompts into the coordinator task's PTY. But the
user also needs to be able to type into that same terminal — to correct the
coordinator, ask it to stop, or just observe without accidentally sending.

### Sub-task control (existing)

For sub-tasks created by the coordinator, a **"Coordinator driving" / "Take
Control"** bar appears at the top of the task panel. The coordinator can call
`send_prompt` to drive the sub-task; if the user clicks **Take Control**,
`setTaskControl(taskId, 'human')` is called and the backend's `controlMap`
marks that task as human-controlled. `send_prompt` calls block on human-
controlled tasks (added to `blockedByHumanControl`); when the user clicks
**Release Control**, blocked sends are retried and the coordinator is notified.

### Coordinator task control (new in this PR)

The same bar is now shown on the **coordinator task itself** (not just
sub-tasks). A coordinator task is created with `controlledBy: 'coordinator'`
in the SolidJS store. In this state:

- The `PromptInput` textarea is `disabled`.
- The autofire interval runs normally (can fire staged prompts).
- The bar reads **"Auto mode"** with a **"Take Control"** button.

When the user clicks **Take Control**:

- `setTaskControl(coordinatorTaskId, 'human')` sets `controlledBy: 'human'`
  in the store.
- The textarea becomes enabled.
- The autofire interval checks `controlledBy` each tick and skips firing
  while `'human'`.
- The bar turns yellow and reads **"You have control"** / **"Release Control"**.

When **Release Control** is clicked:

- `controlledBy` reverts to `'coordinator'`.
- The textarea is disabled again.
- The autofire interval resumes on the next tick.

**Why `setTaskControl` doesn't invoke the backend for coordinator tasks:**
The backend `Coordinator.setTaskControl()` only knows about sub-tasks (they're
in `this.tasks`). The coordinator task itself is in `this.coordinators`, not
`this.tasks`. Calling the IPC would produce a `console.warn('setTaskControl:
unknown taskId')`. The frontend skips the IPC call when
`task.coordinatorMode === true` — coordinator control state lives entirely in
the SolidJS store.

### Persistence of controlledBy

`controlledBy` is persisted in `state.json` via `PersistedTask`. On load, if
a coordinator task's `controlledBy` is missing (old state file), it defaults
to `'coordinator'`:

```typescript
controlledBy: pt.controlledBy ?? (pt.coordinatorMode ? 'coordinator' : undefined);
```

Without this, an app restart would leave the coordinator textarea enabled
indefinitely — the bug that prompted the persistence fix.

---

## 7. Autofire

`PromptInput` runs a `setInterval` that fires every second when a
`stagedNotification` is present on the task. Each tick:

1. **Human control check:** If `store.tasks[taskId]?.controlledBy === 'human'`,
   skip the tick entirely. Miss counter does not increment.
2. **Countdown:** Compare `autoFireAt` (epoch ms) to `Date.now()`.
   `autoFireCountdownText()` returns the display string:
   - `'Paused — release control to send'` when human has control
   - `'Auto-sending in Ns…'` during countdown
   - `'Sending when coordinator is ready…'` after countdown fires but prompt
     not yet found
3. **Prompt detection:** Scan the last 500 chars of PTY output for `❯`.
   If found: inject the staged text, clear the notification, reset.
4. **Miss escalation:** If the prompt isn't found 10 consecutive times after
   `autoFireAt`, the notification is escalated to an orphaned state — the
   coordinator Claude is probably mid-tool-call and the countdown fired at a
   bad moment. The user gets an amber badge instead of a silent hang.

### Staged notification visual treatment

When a `StagedNotification` is active and `!userEdited`:

- An absolute-positioned **"Staged for auto-send"** chip appears above the
  textarea.
- The textarea border turns amber.
- Top padding increases to 20 px so text doesn't overlap the chip.
- Placeholder changes to `'Auto mode — click "Take Control" to type'`.

If the user edits the staged text directly (types in the textarea), the
notification is marked `userEdited: true`. The chip hides, the amber border
drops, and the auto-fire is cancelled for that batch — the user's edit is
treated as a manual override.

---

## 8. Discoverability hint

First-time users need to know the "Take Control" button exists. A small tooltip
appears when the user clicks anywhere in the coordinator task panel while it's
in auto mode:

```
"Autofire is active — click Take Control to type freely."
```

- Shown at most 3 times (persisted in `coordinatorControlHintCount`).
- Auto-dismisses after 4 seconds.
- A **×** button dismisses immediately.
- **"Don't show again"** sets the count to 999 and saves.

The hint is triggered by the outer container's `onClick`, not by the textarea's
`onClick`, so it fires even though the textarea is disabled.

---

## 9. Settings

### Coordinator mode enable/disable

`coordinatorModeEnabled` is a persisted boolean (default `false`) in the app
store. The **Experimental** tab in Settings exposes a toggle. When disabled:

- The coordinator checkbox in New Task dialog is hidden.
- The `Coordinator` class is not instantiated.
- No MCP server is started.

### Notification delay

`coordinatorNotificationDelayMs` (default 30 000 ms) controls both the
initial wait before batching notifications and the autofire countdown.
Configurable in the Experimental settings tab.

---

## 10. Security

| Surface          | Mitigation                                                                          |
| ---------------- | ----------------------------------------------------------------------------------- |
| REST HTTP server | Bound to `127.0.0.1` only, never `0.0.0.0`                                          |
| Auth token       | Random UUID generated per session, passed as `Authorization: Bearer <token>` header |
| MCP config file  | Written with `mode: 0o600` (owner read-write only)                                  |
| MCP config path  | Written to `os.tmpdir()`, not the project directory                                 |
| Remote access    | Separate auth; coordinator endpoints require the same token                         |

---

## 11. Docker integration

When coordinator mode runs with Docker enabled, sub-agents are spawned via
`docker exec` into the coordinator's container rather than as local processes.
The coordinator's container name is derived from its agent ID:
`parallel-code-${agentId.slice(0, 12)}`.

`create_task` passes `dockerContainerName` to the sub-task spawn, which uses
`docker exec <container>` as the agent command prefix. This keeps sub-tasks
inside the same container filesystem as the coordinator, avoiding the
complexity of mounting worktrees into separate containers.

---

## 12. New Task Dialog changes

The coordinator checkbox was moved from **above** the checkboxes group to
**below** it (after Dangerously Skip Permissions and Docker). Reason: checking
"Dangerously skip permissions" previously caused the "Propagate
skip-permissions to sub-tasks" option to appear inside the coordinator
block, which sits above the skip-permissions checkbox — content appeared
above the element that triggered it, which is visually jarring.

The new order:

1. Agent selector
2. Git isolation
3. Base branch
4. Steps tracking / Dangerously skip all confirms / Docker mode
5. **Coordinator mode** (with warning + propagate-skip sub-options)

The "Propagate skip-permissions" label is also restructured: it's now nested
inside `<Show when={coordinatorMode()}>` so it only appears when coordinator
mode is enabled, rather than checking three separate conditions.

---

## 13. Test coverage

### Backend (well covered)

`electron/mcp/coordinator.test.ts` — 63 unit tests covering:

- Task create / idle / exited state transitions
- `wait_for_idle` resolve paths: idle, exited, human_control, timeout
- `signal_done` → `wait_for_signal_done` resolution
- `wait_for_signal_done` with multiple tasks, `remaining` count accuracy
- Notification batching, staging, suppression, and re-staging edge cases
- Stale resolver cleanup after coordinator deregistration
- `countRemaining` logic with consumed/unconsumed signals

`src/store/notifications.test.ts` — staged notification replacement and the
`userEdited` override path.

### Frontend (gaps)

The three frontend layers added in this PR have no tests yet:

- `src/store/tasks.ts` — `setTaskControl`, `MCP_TaskCreated` with `controlledBy`
- `src/store/persistence.ts` — `controlledBy` save/restore round-trip
- `src/components/PromptInput.tsx` — autofire skip when human has control
- `src/components/TerminalView.tsx` — `disableStdin` reactive effect

See `TODOS.md` items 12–16 for the specific test cases needed.
