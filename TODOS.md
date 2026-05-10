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

### ~~31. Docker sub-tasks: one container per sub-task instead of docker exec~~ ✅ COMPLETE

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

### ~~32. Preamble injection uses synchronous file I/O on the main thread~~ ✅ COMPLETE

**File:** `electron/mcp/coordinator.ts` (`createTask`, ~line 444–499)
**What's wrong:** `createTask` uses `readFileSync`/`writeFileSync` for preamble injection into the sub-task worktree. This blocks the Electron main thread on every sub-task creation. With multiple concurrent sub-tasks, it can also race — two `create_task` calls reading the same file before either writes.
**Done when:** Preamble injection uses `fs/promises` (`readFile`/`writeFile`) and either serializes writes per-path or is made safe for concurrent calls.

---

### ~~34. Preamble stripping can hide or silently delete legitimate task changes — P1~~ ✅ COMPLETE

**Files:** `electron/mcp/coordinator.ts` (`getTaskDiff` ~line 760/777; `mergeTask` cleanup ~line 972)
**What's wrong (two facets):**

1. `getTaskDiff` drops the _entire_ file section for any preamble-bearing file (`AGENTS.md`, `GEMINI.md`, `.agent.md`, `.claude/settings.local.json`). The coordinator review sees no changes to that file, so legitimate sub-agent edits are silently invisible at review time.
2. `mergeTask` cleanup strips from the first `<sub-task-mode>` marker to EOF. If a sub-agent legitimately edits that file _after_ the injected preamble block, those edits are permanently deleted on merge. This is a data-loss risk.

**Fix direction:** Treat the injected preamble as a bounded generated block, not as "everything from the first marker onward".

Implementation constraints:

- Add an explicit generated-block boundary that can be found unambiguously. Reuse `<sub-task-mode>` as the start marker only if there is a reliable end marker; otherwise add a wrapper comment around the generated block and migrate the injection/removal code together.
- Removal must delete only the generated block and its immediately adjacent separator blank lines. Content before and after the generated block must be preserved byte-for-byte except for the separator normalization required by the removal.
- `getTaskDiff()` must not drop the entire file. It should compute the diff after normalizing/removing the generated block from the worktree copy, then show any remaining user/sub-task edits.
- `mergeTask()` must run the same normalization before staging. Do not implement separate "diff cleanup" and "merge cleanup" algorithms that can drift.
- `.claude/settings.local.json` needs a JSON-specific path: remove only the injected content from `systemPrompt`; preserve other keys and any non-generated system prompt text.

**Tests to add** (in `electron/mcp/coordinator.test.ts`):

- `getTaskDiff()` on a worktree where `AGENTS.md` has an injected preamble _and_ a legitimate edit after it → diff includes the legitimate edit, excludes the injected block
- same as above with a legitimate edit before the injected preamble → edit is visible and preserved
- `mergeTask` with same scenario → committed result contains the legitimate edit, injected block removed
- Pure-preamble case (no other edits) → empty diff for that file, no content lost after merge
- `.claude/settings.local.json` with another key and pre-existing `systemPrompt` text → only generated preamble text removed

**Done when:** A sub-task that edits a preamble-bearing file outside the injected block has those edits visible in the diff review and preserved after merge.

---

### ~~33. No integration tests for post-restart coordinator flow~~ ✅ COMPLETE

**Files:** `electron/mcp/coordinator.ts` (`hydrateTask`), `src/App.tsx` (restart restore path)
**What's wrong:** `hydrateTask` restores output callbacks, `setMCPServerInfo` rewrites config files, and `StartMCPServer` is awaited before child hydration — but there are no tests exercising the full restart → re-subscribe → `wait_for_idle` / `wait_for_signal_done` round-trip. A regression in the restart path would be invisible.
**Tests to add** (in `electron/mcp/coordinator.test.ts`): simulate a full restart cycle — persist a coordinator + child task with an old config path and token, re-create the coordinator, call `setMCPServerInfo` with new tokens, call `hydrateTask` with the persisted child, assert the child's config file is rewritten with the new `subtaskToken` (not the old or coordinator token), and verify `wait_for_idle` resolves after the next agent output event.
**Done when:** At least one integration test simulates app restart (re-create coordinator, call `hydrateTask`, verify `wait_for_idle` resolves correctly after the next agent output) and the rewritten config uses the correct scoped token.

---

### ~~35. Missing tests for `StartMCPServer` IPC input validation~~ ✅ COMPLETE

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

### ~~36. Missing tests for hydrated `mcpConfigPath` directory scoping~~ ✅ COMPLETE

**File:** `electron/mcp/coordinator.test.ts` (hydrateTask describe block)
**What's wrong:** `hydrateTask` now validates `mcpConfigPath` against exact expected paths, but only the happy path is tested. Path-traversal and wrong-directory inputs could silently fall back to `undefined` and be mistaken for correct behavior.
**Tests to add:**

- `../../etc/passwd`-style path → `task.mcpConfigPath` is `undefined`, no write occurs
- `/tmp/evil/parallel-code-subtask-{id}.json` (right filename, wrong dir) → rejected
- `/tmp/parallel-code-subtask-{id}.json` with correct host tmpdir → accepted, write occurs
- Docker mode: `dirname(serverPath)/subtask-{id}.json` → accepted; any other dir → rejected

**Done when:** Every branch of the path-scoping logic has a test, including both accepted and rejected cases.

---

### ~~37. Missing tests for awaited coordinator cleanup ordering~~ ✅ COMPLETE

**File:** `src/store/tasks.test.ts`
**What's wrong:** `MCP_CoordinatorDeregistered` and `MCP_CoordinatedTaskClosed` are now awaited before UI state is removed, but there are no tests asserting the order or handling a rejection.
**Tests to add:**

- `MCP_CoordinatedTaskClosed` rejects → expected behavior is explicit and tested. If product behavior remains "remove from UI anyway", the test must assert that the warning is logged and the backend cleanup failure is not presented as a successful backend cleanup.
- `MCP_CoordinatedTaskClosed` resolves → backend state removal happens before `removeTaskFromStore`
- Coordinator close: `MCP_CoordinatorDeregistered` rejects → warning logged; task close still completes

**Done when:** Both the success-ordering guarantee and the rejection-warning behavior have test coverage.

---

### ~~38. MCP/REST `baseBranch` bypasses IPC branch-name guard~~ ✅ COMPLETE

**Files:** `electron/mcp/server.ts:69`, `electron/remote/server.ts:291`, `electron/ipc/git.ts:705`
**What's wrong:** Normal IPC validates `baseBranch` before it reaches git. The MCP tool handler and REST `POST /api/tasks` only check that `baseBranch` is a string, then pass it into coordinator task creation and eventually git. `execFile` avoids shell injection, but git can interpret option-looking refs strangely, and this creates an inconsistency between UI-created tasks and coordinator-created tasks.

Implementation constraints:

- Do not import `validateBranchName` from `electron/ipc/register.ts`; it is currently a local helper inside IPC registration code and is the wrong ownership boundary for MCP/REST validation.
- Extract a shared validator into a small non-IPC module, for example `electron/ipc/validation.ts` or `electron/git/validation.ts`, and use it from IPC, MCP, and REST paths.
- Keep the validator intentionally conservative and documented. At minimum reject non-string, empty, leading `-`, ASCII control characters, and whitespace-only values. Prefer aligning with `git check-ref-format --branch` semantics if implemented without adding process-spawn overhead to hot paths.
- Validate `baseBranch` at the boundary (`electron/mcp/server.ts` and `electron/remote/server.ts`) before calling `client.createTask()` / `orch.createTask()`. Also keep validation in lower-level coordinator creation as defense in depth.
- Preserve the current "undefined means default base branch" behavior. Empty string should be rejected at external boundaries, not silently treated as default.

**Tests to add** (unit, in `electron/mcp/coordinator.test.ts` or validator-specific test):

- `createTask` called with `baseBranch: '-main'` → throws
- `baseBranch: ''` → throws
- `baseBranch: '   '` → throws
- `baseBranch: 'main'` and `baseBranch: 'feature/ok'` → accepted

**Tests to add** (integration, via REST in `electron/remote/coordinator-scoping.test.ts`):

- `POST /api/tasks` with `baseBranch: '-bad'` → 400
- `POST /api/tasks` with `baseBranch: ''` → 400
- `POST /api/tasks` with `baseBranch: 'feature/ok'` → proceeds past validation

**Done when:** IPC, MCP, REST, and coordinator-internal task creation all enforce the same branch/ref validation, and tests cover rejected and accepted values through at least one public boundary.

---

### ~~39. No Docker coordinator child-close isolation test~~ ✅ COMPLETE

**File:** `electron/mcp/coordinator.test.ts`
**What's wrong:** When one of two running sub-tasks is closed, cleanup should target only that child's process/config. There is no test asserting that closing child A does not affect child B's config file or state.
**Tests to add:** Register a coordinator, create two sub-tasks (task-1, task-2), close task-1, assert: task-1's `mcpConfigPath` is deleted, task-2's config file is untouched, task-2 is still in `listTasks()`.
**Done when:** Multi-child close isolation has explicit test coverage.

---

### ~~40. No `.mcp.json` merge/cleanup test~~ ✅ COMPLETE

**File:** `electron/ipc/register-mcp.test.ts` (or `electron/mcp/coordinator.test.ts`)
**What's wrong:** The `.mcp.json` read-before-write logic merges only the `parallel-code` key and preserves other servers, but this is untested. A regression could silently destroy user-configured MCP servers on coordinator startup.
**Tests to add:**

- Start coordinator with a pre-existing `.mcp.json` that contains a `my-server` key → after `StartMCPServer`, file contains both `my-server` and `parallel-code`; `my-server` config is byte-for-byte unchanged
- Deregister coordinator → `parallel-code` key removed, `my-server` preserved, file still exists
- Start coordinator with no pre-existing `.mcp.json` → file created; deregister → file deleted entirely

**Tests to add (also):**

- Start coordinator with a `.mcp.json` that contains malformed JSON → `StartMCPServer` fails with a clear error and does not overwrite the file (P3 complement — see #42 fix direction)

**Done when:** All three cases (merge, cleanup-preserving, cleanup-delete) have test coverage, plus the malformed-JSON rejection case.

---

### ~~41. Coordinator cleanup reports success even when worktree/branch deletion fails~~ ✅ COMPLETE

**File:** `electron/mcp/coordinator.ts` (`cleanupTask` ~line 1030; Docker inner-process cleanup ~line 1074)
**What's wrong:** `cleanupTask` catches `deleteTask` failure, logs a warning, then removes backend state and emits `MCP_TaskClosed`. Docker inner-process cleanup is also fire-and-forget, so worktree deletion can race an agent process that is still alive. The UI and backend believe the task is cleanly closed while the worktree, branch, or Docker process may still exist.

Implementation constraints:

- Split cleanup into explicit phases: unsubscribe/kill PTY, stop Docker inner process if any, delete worktree/branch, then remove coordinator backend state.
- The Docker inner-process stop may remain best-effort, but it must be awaited with a bounded timeout before `deleteTask()` starts. Log its failure separately from worktree deletion failure.
- If `deleteTask()` fails, do not delete the task from `this.tasks`, do not remove control/blocked state, and do not emit `IPC.MCP_TaskClosed`. Keep enough state for retry.
- Add or reuse an IPC event that reports cleanup failure to the renderer. Do not overload `MCP_TaskClosed` for failure.
- In the renderer/store, represent this as a visible `closingStatus: 'error'` / `closingError` or equivalent state on the task. The user should be able to retry close/cleanup without restarting the app.
- For `mergeTask({ cleanup: true })`, treat cleanup failure as "merge may have succeeded, cleanup failed". Do not imply the merge itself was rolled back unless it actually was.

**Tests to add:**

- `electron/mcp/coordinator.test.ts`: mock `deleteTask` rejection; assert task remains in `listTasks()`, no `MCP_TaskClosed` notification is sent, and a failure notification/event is sent.
- `electron/mcp/coordinator.test.ts`: Docker task cleanup awaits the targeted inner-process kill attempt before calling `deleteTask`.
- `src/store/tasks.test.ts`: cleanup-failure event marks the visible task as recoverable error and does not remove it from the store.

**Done when:** If `deleteTask` (worktree/branch deletion) fails, the task is retained with a visible recoverable error, `MCP_TaskClosed` is not emitted, and retry can run using the retained backend state.

---

### ~~42. Malformed existing `.mcp.json` is silently overwritten~~ ✅ COMPLETE

**File:** `electron/ipc/register.ts` (~line 1406)
**What's wrong:** If `.mcp.json` exists but cannot be parsed (malformed JSON), the handler treats it as empty and writes a new file. This silently destroys a user's malformed-but-recoverable MCP config — other servers they have configured are gone.
**Fix direction:** Fail closed on parse failure. Do not overwrite or rewrite malformed user config.

Implementation constraints:

- If the selected `.mcp.json` exists and `JSON.parse` fails, throw a descriptive `StartMCPServer` error that includes the path and tells the user to fix or remove the file.
- Do not create `.mcp.json.bak` in the first implementation unless the repo owner explicitly asks for backup behavior; failing without writes is simpler and safer.
- Make sure the temp coordinator `--mcp-config` file is not left behind if `.mcp.json` merge fails after the temp file was written. Either reorder writes so `.mcp.json` parse/merge validation happens first, or clean up the temp file in the error path.
- Keep the existing preservation behavior for valid JSON with unrelated `mcpServers` entries.

**Tests to add:** See #40 for the malformed-JSON case. Also assert neither `writeFileSync(worktreeMcpPath, ...)` nor `chmodSync(worktreeMcpPath, ...)` is called after parse failure.

**Done when:** A malformed `.mcp.json` causes `StartMCPServer` to reject with a descriptive error, no user config file is overwritten, and no stale temp MCP config is left behind.

---

### ~~43. Restore failure leaves coordinator tasks permanently unspawned~~ ✅ COMPLETE

**Files:** `src/App.tsx` (~line 349), `src/components/TerminalView.tsx` (~line 637)
**What's wrong:** On app restore, coordinator and coordinated task PTYs are gated on `mcpReady`. If `StartMCPServer` or `MCP_HydrateCoordinatedTask` fails (bad persisted path, config write error, Docker path issue, transient startup failure), the error is only logged and `mcpReady` is never set to `true`. `TerminalView` then waits indefinitely — the agent process is never spawned and there is no user-visible error or retry path. The task appears stuck/dead.
**Fix direction:** Treat MCP restore as an explicit task lifecycle state, not just a boolean gate.

Implementation constraints:

- Add a persisted or runtime-only task field such as `mcpStartupStatus?: 'pending' | 'ready' | 'error'` plus `mcpStartupError?: string`, or extend the existing model in an equally explicit way. Avoid encoding three states in `mcpReady?: boolean`.
- On restore, set coordinator/coordinated tasks to `pending` before invoking `StartMCPServer` / `MCP_HydrateCoordinatedTask`.
- On success, mark `ready` and spawn as today.
- On failure, mark `error` with a sanitized message. `TerminalView` must stop waiting forever and render a visible failure/retry state instead of silently doing nothing.
- Add a retry action that reruns the same startup/hydration path for the affected task. For children, retry should require the parent coordinator to be registered first; if the parent is in error, surface that dependency clearly.
- Do not fall back to spawning a coordinated task without MCP unless a product decision explicitly accepts that degraded mode. Without MCP, `signal_done`, coordinator control, and task scoping are broken.

**Tests to add:**

- `src/store/persistence.test.ts` or `src/App`-level test if available: failed `StartMCPServer` marks coordinator task error instead of leaving it pending forever.
- child hydration failure marks only that child error and leaves other successfully hydrated children spawnable.
- retry success transitions `error -> pending -> ready` and allows `TerminalView` to spawn.

**Done when:** A `StartMCPServer` or hydration failure on restore surfaces a visible error on the affected task(s), does not leave `TerminalView` waiting forever, and provides a retry path that uses the same validated startup/hydration flow.

---

### ~~44. Staged coordinator prompt is not visible unless the user takes control~~ ✅ COMPLETE

**Files:** Coordinator notification UI (staged notification section, `src/components/`)
**What's wrong:** When the coordinator is driving, the staged-notification section collapses. If a prompt has been queued for autofire and the user wants to see it, they must click "Take Control" to expand the section — which is a heavyweight action taken only for visibility. The user shouldn't need to claim control just to read what's pending.
**Fix direction:** Show the staged notification (at minimum, the pending prompt text and countdown) in a read-only overlay or subtle indicator even while the coordinator is driving. The "Take Control" button can remain for actually interrupting, but visibility should not require it.
**Related:** The coordinator's autofire already writes to the PTY when the timer fires regardless of agent state — Claude's readline layer will buffer the prompt if the agent is mid-response, exactly as a human typing ahead would. No idle-gate change is needed; only the visibility is the issue.
**Done when:** A user can read the queued coordinator prompt and its countdown without taking control, and "Take Control" remains reserved for actually interrupting the coordinator.

---

### ~~45. `wait_for_signal_done` network retry must be replay-safe~~ ✅ COMPLETE

**Files:** `electron/mcp/client.ts` (`waitForSignalDone`), `electron/mcp/coordinator.ts` (`signalDone`, `waitForSignalDone`), `electron/remote/server.ts` (`/api/wait-signal`)
**What's wrong:** Retrying the MCP client call on a network `TypeError` is not enough by itself. If the first long-poll receives `signal_done`, the backend currently marks `task.signalDoneConsumed = true` before the HTTP response reaches the MCP process. If the connection drops after that consumption but before the client receives the body, the retry finds no unconsumed signal and can block until timeout. The signal was durable, but the delivery result was not replayable.

Implementation constraints:

- Make `wait_for_signal_done` consumption idempotent across transport failure. Either add a request/client id and replay the result for that id, or keep a short-lived last-delivered result per coordinator/task that a retry can return.
- Preserve existing semantics: HTTP 4xx/5xx application errors should not be retried as network failures.
- Keep retry bounded by the original `timeoutMs`; do not let backoff extend a caller's requested wait indefinitely.
- Do not restage duplicate UI notifications or decrement/alter `remaining` twice when a replay happens.
- Log enough context to distinguish "new signal consumed" from "previous signal replayed".

**Tests to add:**

- Active waiter receives `signal_done`, server resolves the waiter, client sees a simulated network `TypeError`, retry returns the same task result immediately.
- Replay does not double-count `remaining`.
- Replay does not re-stage or auto-fire duplicate coordinator notifications.
- HTTP 4xx/5xx failures are not retried.
- Repeated network `TypeError`s stop after the configured retry/timeout boundary.

**Done when:** A transient response-loss/network failure after backend signal consumption still returns the consumed signal to the coordinator exactly once, without human intervention or duplicate UI side effects.

---

### 46. Comprehensive coordinator regression test suite — P1/P2

**Goal:** Add tests around coordinator invariants so future changes cannot regress PR #100 behavior. Prefer real temporary git repos for diff/merge behavior and focused unit tests for pure validation/state-machine helpers. Do not rely only on mocked git output for preamble diff correctness.

**Priority 1 — prevent known P1 regressions:**

- `wait_for_signal_done` replay/idempotency: cover response loss after backend consumption, retry replay, no duplicate `remaining`, no duplicate notifications, HTTP errors not retried, and bounded network retry.
- Normalized preamble diff: use a real temp git repo and verify `baseBranch` undefined uses the same detected-main diff base as `getAllFileDiffs`, not `HEAD`.
- Preamble-bearing files: preamble-only changes are hidden; legitimate edits before the generated block are shown; legitimate edits after the generated block are shown; edits on both sides are shown.
- Preamble merge cleanup: merge strips only the generated block and preserves legitimate edits before/after it.
- `.claude/settings.local.json`: preserves unrelated keys, preserves pre-existing non-generated `systemPrompt`, removes only the generated block, deletes `systemPrompt` only when empty, and does not silently rewrite malformed JSON.

**Priority 2 — lifecycle and recovery coverage:**

- Restart/hydration: app restart rewrites child MCP config with fresh `subtaskToken`, never the stale or coordinator token.
- Restart/hydration: `hydrateTask` restores `wait_for_idle` and unconsumed `signal_done`.
- MCP startup failure: failed `StartMCPServer` / child hydration marks a visible error instead of leaving `TerminalView` waiting forever.
- MCP retry: retry transitions `error -> pending -> ready`; child retry requires parent coordinator readiness and surfaces that dependency when missing.
- Cleanup failure: `deleteTask` failure does not emit `MCP_TaskClosed`, retains backend state for retry, and marks the renderer task recoverable.
- Merge cleanup failure: represent "merge succeeded, cleanup failed" separately from merge failure.

**Priority 3 — boundary/security coverage:**

- MCP/REST/IP C validation parity: `baseBranch` rejects empty strings, whitespace-only values, leading `-`, and control characters through public boundaries; valid refs still work.
- Token/task scoping: coordinator token cannot access another coordinator's tasks; subtask token can only call `signal_done`; subtask token cannot use websocket.
- Remote/mobile scoping: missing `X-Coordinator-Id` behavior is explicitly tested only for routes that are intended to support unscoped remote/mobile access.
- Docker isolation: closing child A does not stop child B, delete child B's config, or remove child B from `listTasks()`.
- Docker reachability: Docker MCP URL remains reachable from containers, while non-Docker mode does not widen bind address unless the owner-approved design requires it.

**Recommended structure:**

- Pure helper tests for branch validation, preamble-block removal, network-error retry classification, and replay-cache behavior.
- Real temp git repo tests for `getTaskDiff()` and merge cleanup.
- Unit tests for coordinator state transitions and renderer store error states.
- One golden coordinator flow sequence test: `create_task -> wait_for_idle -> signal_done -> wait_for_signal_done -> get_task_diff -> review_and_merge -> cleanup`.
- One restart sequence test: `persist -> reload -> StartMCPServer -> hydrate children -> respawn -> signal_done`.
- Keep Docker runtime tests opt-in with `RUN_DOCKER_MCP_TEST=1`, but keep command-construction and state-isolation tests in the normal suite.

**Done when:** The suite fails for the known replay/idempotency and normalized-diff-base bugs, passes after those fixes, and covers the coordinator lifecycle from creation through restart, review/merge, and cleanup.
