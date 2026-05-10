# TODOs

## Project context (read before dispatching tasks)

**Stack:** SolidJS frontend (`src/`), Electron main process (`electron/`), Node-pty terminals, TypeScript strict throughout.
**Test command:** `npm test && npm run typecheck && npm run lint && npm run compile && npm run build:mcp`
**Key conventions:** No `any`, functional SolidJS components, IPC channels defined in `electron/ipc/channels.ts`, MCP tools in `electron/mcp/server.ts`, coordinator logic in `electron/mcp/coordinator.ts`.
**Do not** modify files outside the scope of the assigned task. Run the full test command and fix any failures before calling `signal_done`.

---

## Known edge cases — no fix yet

### ~~7. Autofire expiry window — coordinator in long tool call during countdown~~ ✅ COMPLETE

Fixed: the interval now tracks the last-seen tail. If new output arrives since the previous tick the agent is actively working, so the miss counter resets to zero. Escalation only triggers when the tail has been completely static for 10+ consecutive seconds with no prompt visible.

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

**Status:** Waiting for repo owner to weigh in on preferred approach before any work begins. (Independently re-confirmed as a concern in a subsequent review — same recommendation: loopback by default, wider binding only when Docker requires it.)

---

### 31. Docker sub-tasks: one container per sub-task instead of docker exec

**Current approach:** The coordinator spawns one `docker run` container and all sub-tasks run inside it via `docker exec`. This causes two known problems: HOME collision (#19, partially mitigated) and shaky process cleanup (#18, partially mitigated).

**Proposed change:** Spawn each sub-task as its own `docker run` container (same image, same volume mounts). Sub-tasks get isolated filesystems, so HOME collision is eliminated by design. Process cleanup becomes `docker stop <container>` — clean and reliable.

**Key files:** `electron/mcp/coordinator.ts` (sub-task spawn logic, ~line 526), `electron/ipc/pty.ts` (`spawnAgent` docker exec path)

**What changes:**

- In `coordinator.ts` `createTask`: instead of `docker exec -it -w <worktree> <coordinator-container> claude ...`, build a `docker run --rm -it -w <worktree> -v ... <image> claude ...` command with the same volume mounts the coordinator container uses (worktree parent + `.git` dir).
- The coordinator container name is no longer needed as a spawn target for sub-tasks — only needed for the coordinator itself.
- `electron/ipc/pty.ts` already handles `docker run` spawning; sub-tasks would use the same path as the coordinator (not the `docker exec` branch).

**Note:** The bind address question (#30) is unchanged — sub-task containers still need to reach `host.docker.internal:7777` for `signal_done`. Resolve #30 first or in parallel.

**Done when:** Sub-tasks spawned in Docker coordinator mode each run in their own container, HOME collisions are gone, and `close_task` cleanly stops the container.

---

### 32. Preamble injection uses synchronous file I/O on the main thread

**File:** `electron/mcp/coordinator.ts` (`createTask`, ~line 444–499)
**What's wrong:** `createTask` uses `readFileSync`/`writeFileSync` for preamble injection into the sub-task worktree. This blocks the Electron main thread on every sub-task creation. With multiple concurrent sub-tasks, it can also race — two `create_task` calls reading the same file before either writes.
**Done when:** Preamble injection uses `fs/promises` (`readFile`/`writeFile`) and either serializes writes per-path or is made safe for concurrent calls.

---

### 34. Preamble stripping can hide or silently delete legitimate task changes — P1

**Files:** `electron/mcp/coordinator.ts` (`getTaskDiff` ~line 760/777; `mergeTask` cleanup ~line 972)
**What's wrong (two facets):**

1. `getTaskDiff` drops the _entire_ file section for any preamble-bearing file (`AGENTS.md`, `GEMINI.md`, `.agent.md`, `.claude/settings.local.json`). The coordinator review sees no changes to that file, so legitimate sub-agent edits are silently invisible at review time.
2. `mergeTask` cleanup strips from the first `<sub-task-mode>` marker to EOF. If a sub-agent legitimately edits that file _after_ the injected preamble block, those edits are permanently deleted on merge. This is a data-loss risk.
   **Fix direction:** Use explicit start/end markers and remove only the injected block from both `getTaskDiff` and `mergeTask` cleanup. Strip only the `<sub-task-mode>…</sub-task-mode>` block (and surrounding blank lines) rather than the whole file section or everything after the first marker. If the remaining content is non-empty, include it in the diff / preserve it after merge.
   **Tests to add** (in `electron/mcp/coordinator.test.ts`):

- `getTaskDiff()` on a worktree where `AGENTS.md` has an injected preamble _and_ a legitimate edit after it → diff includes the legitimate edit, excludes the injected block
- `mergeTask` with same scenario → committed result contains the legitimate edit, injected block removed
- Pure-preamble case (no other edits) → empty diff for that file, no content lost after merge
  **Done when:** A sub-task that edits a preamble-bearing file outside the injected block has those edits visible in the diff review and preserved after merge.

---

### 33. No integration tests for post-restart coordinator flow

**Files:** `electron/mcp/coordinator.ts` (`hydrateTask`), `src/App.tsx` (restart restore path)
**What's wrong:** `hydrateTask` restores output callbacks, `setMCPServerInfo` rewrites config files, and `StartMCPServer` is awaited before child hydration — but there are no tests exercising the full restart → re-subscribe → `wait_for_idle` / `wait_for_signal_done` round-trip. A regression in the restart path would be invisible.
**Tests to add** (in `electron/mcp/coordinator.test.ts`): simulate a full restart cycle — persist a coordinator + child task with an old config path and token, re-create the coordinator, call `setMCPServerInfo` with new tokens, call `hydrateTask` with the persisted child, assert the child's config file is rewritten with the new `subtaskToken` (not the old or coordinator token), and verify `wait_for_idle` resolves after the next agent output event.
**Done when:** At least one integration test simulates app restart (re-create coordinator, call `hydrateTask`, verify `wait_for_idle` resolves correctly after the next agent output) and the rewritten config uses the correct scoped token.

---

### 35. Missing tests for `StartMCPServer` IPC input validation

**File:** `electron/ipc/register-mcp.test.ts` (or new `electron/ipc/register.test.ts`)
**What's wrong:** The `StartMCPServer` handler now validates renderer-supplied paths and IDs, but there are no tests exercising the rejection paths. A future refactor could accidentally remove or weaken the guards invisibly.
**Tests to add:**

- Non-absolute `projectRoot` → handler throws before any file I/O
- `projectRoot` containing `..` → rejected
- Non-absolute `worktreePath` → rejected
- `agentArgs` containing a non-string element → rejected
- `dockerContainerName` containing shell-special characters (e.g. `; rm -rf`) → rejected
- Assert `writeFileSync`/`copyFileSync` are not called when validation fails
  **Done when:** All validation paths have at least one negative test and one positive test confirming valid input is accepted.

---

### 36. Missing tests for hydrated `mcpConfigPath` directory scoping

**File:** `electron/mcp/coordinator.test.ts` (hydrateTask describe block)
**What's wrong:** `hydrateTask` now validates `mcpConfigPath` against exact expected paths, but only the happy path is tested. Path-traversal and wrong-directory inputs could silently fall back to `undefined` and be mistaken for correct behavior.
**Tests to add:**

- `../../etc/passwd`-style path → `task.mcpConfigPath` is `undefined`, no write occurs
- `/tmp/evil/parallel-code-subtask-{id}.json` (right filename, wrong dir) → rejected
- `/tmp/parallel-code-subtask-{id}.json` with correct host tmpdir → accepted, write occurs
- Docker mode: `dirname(serverPath)/subtask-{id}.json` → accepted; any other dir → rejected
  **Done when:** Every branch of the path-scoping logic has a test, including both accepted and rejected cases.

---

### 37. Missing tests for awaited coordinator cleanup ordering

**File:** `src/store/tasks.test.ts`
**What's wrong:** `MCP_CoordinatorDeregistered` and `MCP_CoordinatedTaskClosed` are now awaited before UI state is removed, but there are no tests asserting the order or handling a rejection.
**Tests to add:**

- `MCP_CoordinatedTaskClosed` rejects → task is not removed from the store silently as "fully cleaned up"; warning is logged
- `MCP_CoordinatedTaskClosed` resolves → backend state removal happens before `removeTaskFromStore`
- Coordinator close: `MCP_CoordinatorDeregistered` rejects → warning logged; task close still completes
  **Done when:** Both the success-ordering guarantee and the rejection-warning behavior have test coverage.

---

### 38. MCP/REST `baseBranch` bypasses IPC branch-name guard — P2

**Files:** `electron/mcp/server.ts:69`, `electron/remote/server.ts:291`, `electron/ipc/git.ts:705`
**What's wrong:** Normal IPC validates `baseBranch` with `validateBranchName` (rejects leading `-`, shell-special chars, etc). The MCP tool handler and REST `POST /api/tasks` only check that `baseBranch` is a string, then pass it directly into `createTask`. `execFile` avoids shell injection, but git can interpret option-looking refs strangely, and this creates an inconsistency between UI task creation and coordinator-created tasks.
**Fix direction:** Call the same `validateBranchName` (from `electron/ipc/git.ts`) on the MCP and REST paths before invoking `createTask`. This also upgrades the validation that was added to `coordinator.createTask()` (which currently only checks non-empty and no leading `-`) to use the shared validator.
**Tests to add** (unit, in coordinator.test.ts): `createTask` called with `baseBranch: '-main'` → throws; `baseBranch: ''` → throws; `baseBranch: 'main'` → accepted.
**Tests to add** (integration, via REST in coordinator-scoping.test.ts): `POST /api/tasks` with `baseBranch: '-bad'` → 400; with `baseBranch: 'feature/ok'` → proceeds past validation.
**Done when:** Leading-dash, empty-string, and valid inputs are all covered by tests; MCP and REST paths use the same validator as IPC.

---

### 39. No Docker coordinator child-close isolation test

**File:** `electron/mcp/coordinator.test.ts`
**What's wrong:** When one of two running sub-tasks is closed, cleanup should target only that child's process/config. There is no test asserting that closing child A does not affect child B's config file or state.
**Tests to add:** Register a coordinator, create two sub-tasks (task-1, task-2), close task-1, assert: task-1's `mcpConfigPath` is deleted, task-2's config file is untouched, task-2 is still in `listTasks()`.
**Done when:** Multi-child close isolation has explicit test coverage.

---

### 40. No `.mcp.json` merge/cleanup test

**File:** `electron/ipc/register-mcp.test.ts` (or `electron/mcp/coordinator.test.ts`)
**What's wrong:** The `.mcp.json` read-before-write logic merges only the `parallel-code` key and preserves other servers, but this is untested. A regression could silently destroy user-configured MCP servers on coordinator startup.
**Tests to add:**

- Start coordinator with a pre-existing `.mcp.json` that contains a `my-server` key → after `StartMCPServer`, file contains both `my-server` and `parallel-code`; `my-server` config is byte-for-byte unchanged
- Deregister coordinator → `parallel-code` key removed, `my-server` preserved, file still exists
- Start coordinator with no pre-existing `.mcp.json` → file created; deregister → file deleted entirely
  **Tests to add (also):**
- Start coordinator with a `.mcp.json` that contains malformed JSON → `StartMCPServer` fails with a clear error and does not overwrite the file (P3 complement — see #41 fix direction)
  **Done when:** All three cases (merge, cleanup-preserving, cleanup-delete) have test coverage, plus the malformed-JSON rejection case.

---

### 41. Coordinator cleanup reports success even when worktree/branch deletion fails — P2

**File:** `electron/mcp/coordinator.ts` (`cleanupTask` ~line 1030; Docker inner-process cleanup ~line 1074)
**What's wrong:** `cleanupTask` catches `deleteTask` failure, logs a warning, then removes backend state and emits `MCP_TaskClosed`. Docker inner-process cleanup is also fire-and-forget, so worktree deletion can race an agent process that is still alive. The UI and backend believe the task is cleanly closed while the worktree, branch, or Docker process may still exist.
**Fix direction:** Await Docker inner-process cleanup (best-effort with timeout) before attempting worktree/branch deletion. Represent delete failure as a partial-cleanup error state on the task rather than emitting `MCP_TaskClosed` as if fully clean. Surface the error to the user so they can retry or manually clean up.
**Done when:** If `deleteTask` (worktree/branch deletion) fails, the task is marked as partially-closed with an error, `MCP_TaskClosed` is not emitted, and the user has a visible recovery path (e.g., retry button or error message).

---

### 42. Malformed existing `.mcp.json` is silently overwritten — P3

**File:** `electron/ipc/register.ts` (~line 1406)
**What's wrong:** If `.mcp.json` exists but cannot be parsed (malformed JSON), the handler treats it as empty and writes a new file. This silently destroys a user's malformed-but-recoverable MCP config — other servers they have configured are gone.
**Fix direction:** On JSON parse failure, either (a) fail `StartMCPServer` with a clear error message ("`.mcp.json` is malformed — please fix or remove it") so the user can recover their config, or (b) copy the original file to `.mcp.json.bak` before overwriting. Option (a) is safer; option (b) is friendlier but adds complexity.
**Done when:** A malformed `.mcp.json` causes `StartMCPServer` to reject with a descriptive error rather than silently overwriting the file.

---

### 43. Restore failure leaves coordinator tasks permanently unspawned — P2/P3

**Files:** `src/App.tsx` (~line 349), `src/components/TerminalView.tsx` (~line 637)
**What's wrong:** On app restore, coordinator and coordinated task PTYs are gated on `mcpReady`. If `StartMCPServer` or `MCP_HydrateCoordinatedTask` fails (bad persisted path, config write error, Docker path issue, transient startup failure), the error is only logged and `mcpReady` is never set to `true`. `TerminalView` then waits indefinitely — the agent process is never spawned and there is no user-visible error or retry path. The task appears stuck/dead.
**Fix direction:** On failure, set an `mcpError` state on the task (visible in the UI) and either (a) allow the user to retry startup, or (b) fall back to spawning without MCP when that is safe. At minimum, clear the `mcpReady` gate and show a recoverable error rather than silently blocking forever.
**Done when:** A `StartMCPServer` or hydration failure on restore surfaces a visible error on the affected task(s) and provides a path to retry or recover, rather than leaving the task silently unspawnable.
