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

**Status:** Waiting for repo owner to weigh in on preferred approach before any work begins.

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
