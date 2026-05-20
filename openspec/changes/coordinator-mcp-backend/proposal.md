# Coordinator MCP Backend

## Why

Parallel Code today only supports running a single Claude task at a time in a
given project. Power users want to run a coordinator task that can spawn and
manage multiple sub-tasks in isolated worktrees, collect their results, and keep
those tasks recoverable across app restarts.

That requires a backend capability for coordinator-owned task creation,
task-scoped authorization, completion signaling, and cleanup that preserves
already-running child tasks when the coordinator exits.

## What changes

- Add a coordinator MCP backend for creating, listing, prompting, waiting on,
  reviewing, merging, and closing coordinator-owned sub-tasks.
- Scope remote API access by token class and owning coordinator so one
  coordinator cannot inspect or control another coordinator's children.
- Persist coordinator task metadata needed for restore, sidebar grouping,
  orphan handling, and cleanup.
- Preserve sub-task completion signaling and MCP configuration until each child
  is closed, even if its coordinator exits first.
- Keep manual remote access from invalidating remote server state already handed
  to live coordinator tasks.

## Impact

- New capability: `coordinator-mcp-backend`
- Extends existing capability: `remote-access`
