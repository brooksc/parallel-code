# MCP Coordinator/Sub-task Handoff

## Why

The MCP server exposes task orchestration tools to Claude Code agents. When a
coordinator agent creates sub-tasks, there was no reliable mechanism for a
sub-task to signal completion back to the coordinator, and no way for the
coordinator's `create_task` calls to be automatically tagged with the
coordinator's own task ID. Additionally, fully autonomous sub-tasks had no way
to opt out of permission prompts.

## What changes

### `signal_done` tool (sub-tasks)

- New MCP tool `signal_done` — callable only by sub-task agents (requires
  `--task-id` in the MCP server config).
- When called, sets `signalDoneAt` on the task and resolves any pending
  `wait_for_signal_done` calls on the coordinator side.
- Triggers an accelerated review notification (5 s delay vs. the 60 s default).
- Renderer receives a `MCP_TaskStateSync` push that sets `signalDoneReceived`
  on the matching task; the sub-task chip in `SubTaskStrip` turns green.

### `wait_for_signal_done` tool (coordinators)

- New MCP tool `wait_for_signal_done` — blocks until the target task calls
  `signal_done` or the timeout elapses.
- More reliable than `wait_for_idle` because it requires an intentional signal
  from the agent rather than PTY quiescence.

### `--coordinator-id` CLI arg

- Coordinator MCP server config now includes `--coordinator-id <taskId>`.
- The MCP server propagates this as `coordinatorTaskId` in every `create_task`
  HTTP call, so sub-tasks are automatically linked to their coordinator without
  the coordinator agent needing to pass it manually.

### `skipPermissions` in `create_task`

- New optional boolean field `skipPermissions` on `create_task`.
- When `true`, the spawned sub-task agent runs with
  `--dangerously-skip-permissions` (fully autonomous, no permission prompts).

### Sub-task preamble

- Every sub-task prompt is prefixed with a `[SUB-TASK MODE]` preamble that
  instructs the agent to call `signal_done` when done and not to ask
  clarifying questions.

### Per-task MCP config files

- Each sub-task gets its own MCP config written to `/tmp/` with `--task-id`
  baked in, so `signal_done` is scoped to that specific task.
- The config file is deleted when the task is closed/cleaned up.

## Impact

- Modifies: `electron/mcp/server.ts`, `electron/mcp/client.ts`,
  `electron/mcp/orchestrator.ts`, `electron/remote/server.ts`,
  `electron/ipc/register.ts`
- New file: `electron/mcp/sub-task-preamble.ts`
- Renderer: `src/store/tasks.ts`, `src/store/types.ts`,
  `src/components/SubTaskStrip.tsx`
- New IPC push channel: `MCP_TaskStateSync`
- New REST endpoints: `POST /api/tasks/:id/done`,
  `POST /api/tasks/:id/wait-signal`
