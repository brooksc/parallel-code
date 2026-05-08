# Known TODOs

Items ordered from simplest to hardest. All items marked "Fixed" have been removed.

---

## Token file permissions — write MCP config files with mode 0o600

**Status:** Not implemented.

**Problem:** `electron/ipc/register.ts` lines ~1090, ~1096 and `electron/mcp/coordinator.ts` line ~400 write token-bearing JSON config files with the default umask (0644), making them world-readable on a shared machine.

**Fix:** Add `{ mode: 0o600 }` to every `fs.writeFile` / `writeFileSync` call that writes a file containing an MCP token:

- `register.ts` — the `.mcp.json` worktree file and the `parallel-code-mcp-*.json` tmp file
- `coordinator.ts` — the per-sub-task `parallel-code-subtask-<id>.json` tmp file

Reference: `electron/ipc/pty.ts:694` already does this correctly for a similar file.

---

## Minor coordinator bugs (batch these together)

**Status:** Not implemented. These are small, low-risk fixes that can be done in a single PR.

**1. `setTaskControl` — validate taskId exists**
`coordinator.ts` — `setTaskControl(taskId, who)` does not call `tasks.has(taskId)` before updating `controlMap`. An unknown taskId silently enters the map. Add a guard: if `!tasks.has(taskId)` throw or log a warning and return early.

**2. `coordinatorTaskId: 'api'` magic string**
`electron/remote/server.ts:247,289` uses the string literal `'api'` as a sentinel to mean "task was created via REST, not by a coordinator". Replace with `undefined` (or a named constant `REST_SENTINEL = 'api'`) and update the comparison at line 289 to `opts.coordinatorTaskId !== undefined` (or `!== REST_SENTINEL`). The current shape lets a real coordinator task accidentally adopt the sentinel value if its ID happened to be `'api'`.

**3. `get_task_diff` — report truncation**
The diff result type (`electron/mcp/types.ts:108-117`) has no field for truncation metadata. When the diff is truncated at 50 KB, the coordinator agent has no way to know the output is incomplete. Add a `truncated?: boolean` and `originalSizeBytes?: number` field to `ApiDiffResult` and populate them in the truncation path in `coordinator.ts` / `git.ts`.

**4. `gitIsolation` missing from `create_task` REST schema**
`electron/remote/server.ts` — the `POST /api/tasks` endpoint validates `name`, `prompt`, `projectId`, `skipPermissions`, `baseBranch` but does not accept `gitIsolation`. The PR description mentions this option. Add `gitIsolation` to the Zod schema (or equivalent validation) and wire it through to the task creation logic.

---

## Network binding — restrict coordinator REST endpoints to 127.0.0.1

**Status:** Not implemented.

**Problem:** `electron/remote/server.ts:644` binds to `0.0.0.0`, which was acceptable when the surface was read-mostly (mobile remote). With coordinator mode, the same token also gates `POST /api/tasks` (spawn worktree + process), `POST /api/tasks/:id/merge`, `DELETE /api/tasks/:id`, and `POST /api/tasks/:id/prompt` — highly destructive endpoints. Any host on the local network that can guess or sniff the token can spawn processes, merge branches, or delete tasks.

**Fix:** Bind to `127.0.0.1` by default in `server.ts`. Only widen to `0.0.0.0` when the user explicitly enables "Remote mobile access" in Settings. The `opts.host` plumbing already exists — just change the default. No capability-scoping of the token is needed if network binding is tight.

---

## Post-restart MCP path — `mcpConfigPath` not persisted

**Status:** Not implemented. This is a correctness bug — causes `fetch failed` on the first MCP tool call after restarting the app.

**Problem:** `mcpConfigPath` exists on the runtime `Task` type (`src/store/types.ts:89`) but is absent from `PersistedTask` (`src/store/types.ts:101-126`). After a restart, persisted coordinator tasks are rehydrated without `mcpConfigPath`, so `TaskAITerminal.tsx:223` omits `--mcp-config` entirely and the sub-agent's Claude Code instance starts with no MCP server configured. Additionally, `App.tsx` does not call `StartMCPServer` for persisted coordinator tasks on load, so the tmp config file is never rewritten with the new session's port/token.

**Fix:**

1. Add `mcpConfigPath?: string` to `PersistedTask` in `src/store/types.ts` and persist/rehydrate it in `src/store/persistence.ts` (`saveState`/`loadState`).
2. In `App.tsx` (or the store's load path), for each rehydrated task that has `isCoordinator === true` and a saved `mcpConfigPath`, call `IPC.StartMCPServer` to rewrite the tmp config with the current session's port and token. The existing `setMCPServerInfo()` in `coordinator.ts` handles the actual file rewrite — it just needs to be triggered on restart.
3. Verify with the test-plan step: "Kill and relaunch the app … MCP tools still work" — the first MCP call from a sub-agent should succeed, not `fetch failed`.

---

## `waitForIdle` — return reason so coordinator can branch on human takeover

**Status:** Not implemented.

**Problem:** `coordinator.ts:514-550` — `waitForIdle(taskId)` returns `Promise<void>`. When `controlMap.get(taskId) === 'human'` it resolves immediately (line ~495). The coordinator agent receives the same resolved promise whether the agent went idle naturally or the human paused it, so it cannot distinguish the two cases and likely loops or continues as if the agent finished.

**Fix:** Change the return type to `Promise<{ reason: 'idle' | 'human_control' | 'exited' }>` and resolve with the appropriate reason:

- `'idle'` — PTY output went quiet for the configured threshold
- `'human_control'` — `controlMap.get(taskId) === 'human'` at resolve time
- `'exited'` — the PTY process exited

Update all call sites in coordinator tools (e.g. `wait_for_signal_done`) to pass the reason back to the MCP tool response so the coordinator agent's LLM can read it and branch accordingly (e.g. wait for human to return control before continuing).

---

## CLAUDE.md mutation — replace with `.claude/settings.local.json` injection

**Status:** Not implemented.

**Problem:** `coordinator.ts` lines ~373-384 write a `<!-- parallel-code-subtask-start -->` block directly into the worktree's tracked `CLAUDE.md`. It is restored 3 seconds after first idle via `setTimeout` with `stdio: 'ignore'` (line ~322), so a restore failure is invisible. A skip-permissions sub-agent that runs `git add -A && git commit` early will commit the injected block into the repo. There is no visible error if restore fails.

**Fix options (in preference order):**

1. **`.claude/settings.local.json`** — write the preamble into `<worktreePath>/.claude/settings.local.json` under the `systemPrompt` key. This file is already gitignored. No restore needed. Append to existing content if the file already exists rather than overwriting.
2. **`--append-system-prompt`** — pass the preamble via the `--append-system-prompt` CLI flag if Claude Code supports it (verify with `claude --help`). This avoids touching the filesystem at all.

Either option eliminates the tracked-file mutation and the fragile restore-on-timeout pattern.

---

## Coordinator + Docker container support

**Status:** Not implemented. Docker mode and coordinator mode are mutually exclusive in the UI.

**Problem:** When a coordinator task runs in Docker, sub-agents created via `create_task` are spawned as native host processes (no Docker isolation). This defeats the security purpose of Docker mode.

**Considered approach — same container (`docker exec`):**

- Coordinator would need to run in "main" (direct git isolation, not a worktree) so its volume mount (`-v /repo:/repo`) covers the whole project root including all sub-task worktrees at `/repo/.worktrees/task/...`
- Sub-agents would be spawned via `docker exec parallel-code-<coordinatorAgentId> claude ...`
- Lightweight — no new container startup per sub-agent
- Requires: passing coordinator's Docker container name through coordinator; enforcing direct git isolation for coordinator mode

**Alternative — separate containers per sub-agent:**

- Each sub-agent gets its own `docker run` mounting its own worktree path
- Must also bind-mount the per-task MCP config file from `/tmp`
- More containers to manage but cleaner isolation and independent lifecycle
- Works regardless of coordinator git isolation mode

**Prerequisite decision:** Should coordinator mode force direct git isolation (running on main branch, no worktree)? This would simplify the same-container approach and is conceptually correct since coordinators shouldn't be committing code themselves.
