# TODOs

## Project context (read before dispatching tasks)

**Stack:** SolidJS frontend (`src/`), Electron main process (`electron/`), Node-pty terminals, TypeScript strict throughout.
**Test command:** `npm test && npm run typecheck && npm run lint && npm run compile && npm run build:mcp`
**Key conventions:** No `any`, functional SolidJS components, IPC channels defined in `electron/ipc/channels.ts`, MCP tools in `electron/mcp/server.ts`, coordinator logic in `electron/mcp/coordinator.ts`.
**Do not** modify files outside the scope of the assigned task. Run the full test command and fix any failures before calling `signal_done`.

---

## Beta blockers — lifecycle/scoping issues

### 13. Coordinator cross-contamination — tasks not scoped to their coordinator

**Files:** `electron/mcp/server.ts:75-80` (`create_task`), `electron/remote/server.ts:300-325,420-450` (`list_tasks`, `send_prompt`, `merge_task`, `close_task`)
**What's wrong:** `create_task` sends no `projectId`. Tool handlers accept `taskId` without verifying the caller's `coordinatorId`. Multiple concurrent coordinators can see and control each other's sub-tasks.
**Done when:** Every MCP tool call that targets a specific task passes `coordinatorId`, and each handler rejects calls where `task.coordinatorTaskId !== coordinatorId`.

### 14. Coordinator MCP broken when remote access server was already running

**File:** `electron/ipc/register.ts` (`StartMCPServer`), `electron/remote/server.ts` (`startRemoteServer`)
**What's wrong:** `StartMCPServer` skips `startRemoteServer()` if already running. If remote access started first (without a coordinator), coordinator-specific API routes are never registered.
**Done when:** Either route handlers look up coordinator at request time via a mutable closure, or the server is torn down and recreated when a coordinator registers.

### 23. Collapsing coordinated children breaks backend agent identity

**Files:** `src/store/tasks.ts` (`collapseTask`, `uncollapseTask`), `electron/mcp/coordinator.ts`
**What's wrong:** `collapseTask` clears `agentIds`; `uncollapseTask` creates a new `agentId`. The backend coordinator registry still holds the old `agentId`, so `send_prompt` and idle detection target a dead PTY.
**Done when:** Either collapse is blocked for tasks with `coordinatedBy` set (simplest), or uncollapse emits an IPC event so the backend updates its agent reference.

---

## Known edge cases — no fix yet

### 7. Autofire expiry window — coordinator in long tool call during countdown

**What's wrong:** If the coordinator is mid-tool-call when autofire countdown fires, it finds no PTY prompt, misses 10 times, and escalates unnecessarily.
**No fix yet** — depends on timing; low frequency in practice.

### 8. Post-restart coordinator MCP config stale if coordinator process restarts

**What's wrong:** `mcpConfigPath` is persisted and rewritten on app restart, but if the coordinator Claude process itself restarts, the MCP token changes and running sub-tasks become unreachable.
**No fix yet** — edge case.

### ~~25. Remote server started without coordinator routes when remote access precedes coordinator~~ ✅ COMPLETE

Already resolved by TODO #14's lazy `getCoordinator()` pattern. All coordinator routes are registered at server startup and call `opts.getCoordinator()` at request time, returning 503 when null. Test coverage added in `electron/remote/coordinator-scoping.test.ts`.

### 30. MCP remote server bind address — WAITING FOR REPO OWNER INPUT — DO NOT FIX

> ⚠️ **DO NOT IMPLEMENT A SOLUTION HERE.** This item is parked pending a decision from the repo owner. Do not touch `electron/remote/server.ts` or `electron/ipc/register.ts` bind address logic.

**Background:** The coordinator MCP HTTP server (`StartMCPServer` path in `electron/ipc/register.ts`) was previously binding to `127.0.0.1`, which made it unreachable from Docker containers via `host.docker.internal`. A fix was applied to bind to `0.0.0.0` so Docker coordinator mode works.

**The concern (raised by repo owner):** Binding to `0.0.0.0` exposes mutating REST endpoints (`POST /api/tasks`, `POST /api/tasks/:id/merge`, `DELETE /api/tasks/:id`, `POST /api/tasks/:id/prompt`) to anyone on the LAN. The repo owner previously flagged this for the mobile-remote feature (where the surface was read-mostly) and suggested: _(a)_ bind to `127.0.0.1` by default and only widen when the user explicitly enables remote mobile, or _(b)_ scope the token so coordinator endpoints require an additional capability the mobile-remote token doesn't get.

**The conflict:** Option (a) breaks Docker coordinator — `host.docker.internal` from inside a Docker container resolves to the host's gateway IP (not loopback), so `127.0.0.1:7777` is unreachable. Docker coordinator requires either `0.0.0.0` or a separate server/transport (Unix socket, second port, etc.).

**Options on the table:**

1. Keep `0.0.0.0` for coordinator MCP (current state). Token protects it. Document the risk.
2. Split into two servers: a separate minimal `0.0.0.0` server for coordinator-only routes, mobile remote stays independent.
3. Unix socket bind-mounted into the container — eliminates TCP exposure entirely, larger change.

**Status:** Waiting for repo owner to weigh in on preferred approach before any work begins.
