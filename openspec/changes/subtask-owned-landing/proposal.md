# Sub-Task Owned Landing

## Why

Coordinator mode is limited less by task execution than by coordinator
attention. Around three concurrent sub-tasks, the coordinator stops being a
dispatcher and becomes a manual integrator: it has to inspect each completion,
decide whether verification was real, merge branches, close tasks, and
reconstruct queue state from interleaved messages.

Landing is the cost that grows worst as more sub-tasks complete. Each sibling
branch may have to reconcile with work that landed after it was spawned, and
the coordinator often has less implementation context than the sub-task that
made the change.

The goal is to let one coordinator manage a larger batch of routine sub-tasks,
including 10 or more at a time, without requiring one coordinator interaction
per task on the happy path.

## What Changes

Sub-tasks get one new sub-task-scoped MCP tool, `land_self`, for the happy path.
The tool asks the backend to land the calling sub-task into its coordinator
branch.

The ownership split is:

- sub-tasks own the landing decision.
- the backend owns the landing mechanics.

A sub-task knows why it made its change, which checks it ran, and whether it is
ready to land. The backend knows how to merge safely: it validates ownership,
merges in the coordinator worktree, serializes with the repository lock,
updates task state, and cleans up the worktree.

`land_self` is terminal from the sub-task agent's perspective. A successful
self-landed task does not call `signal_done` afterward. After the backend
merges and cleans up the child task, the child task closes; only failures or
escalations remain visible for coordinator or user action.

`signal_done` remains available for older sub-tasks and for manual-review flows
where the coordinator still wants to review and land a task itself.

Guarded automerge is the default for successful `land_self` calls. This is an
intentional product tradeoff: if every task still waits for pre-merge
coordinator review, the coordinator remains the bottleneck. Unsafe cases still
stop for coordinator or human input.

## Impact

- Affected capability: `subtask-owned-landing` (new capability spec).
- Extends existing capability: `coordinator-mcp-backend`.
- New sub-task MCP tool: `land_self`.
- New task states: landing escalated, landing failed, landed cleanup failed,
  and reviewed for legacy persisted/review-clearing compatibility.
- Existing `merge_task` remains available for coordinator-driven manual
  landings.
- Existing base-branch policy remains: sub-tasks should branch from the
  coordinator task's branch by default.

## Out Of Scope

- Launch babysitting, trust prompts, and delayed initial prompt delivery.
- Full rollback UI for landed tasks. The first pass preserves enough metadata
  for review and manual follow-up.
