# Design - Sub-Task Owned Landing

## Ownership Model

Self-landing splits ownership between the sub-task and the backend:

- The sub-task decides that its work is ready to land. It owns committing its
  changes, reporting verification, and asking for help when it cannot safely
  land.
- The backend performs all landing mechanics. It validates task ownership,
  checks task state, merges in the coordinator worktree, updates task state,
  and cleans up successful tasks.

The sub-task never runs raw `git merge` against the coordinator branch. The
coordinator branch may already be checked out in another worktree, and the
backend already has a merge path that handles that case under the repository
lock.

## Happy Path

1. The coordinator creates a sub-task with a specific assignment.
2. The sub-task implements the requested change.
3. The sub-task runs required verification checks.
4. The sub-task commits its work locally.
5. The sub-task calls `land_self` with verification and an optional summary.
6. The backend validates the caller, task ownership, live coordinator, branch,
   and worktree state.
7. The backend verifies that the task worktree is clean after excluding
   backend-owned injected artifacts.
8. The backend merges the task branch into the coordinator branch in the
   coordinator worktree under the existing repository lock.
9. The backend records landed metadata, strips injected preamble/config
   artifacts, removes the sub-task worktree and branch, deletes MCP config, and
   closes the child task.
10. The child task disappears from the active task list. Cleanup failures
    remain visible because they still require attention.

`land_self` is terminal from the sub-task agent's perspective. The agent does
not call `signal_done` after a successful `land_self`, because cleanup may have
closed the task before another tool call can run.

## Authentication And Ownership

`land_self` should use the same per-task ownership proof as `signal_done`.
The sub-task MCP server already has:

- its task ID from `--task-id`.
- the per-task done token from `PARALLEL_CODE_MCP_DONE_TOKEN`.

The MCP client should send the done token to the remote route, and the remote
route should validate that it matches the target task before allowing the task
to land itself. Coordinator tokens can continue to use coordinator-scoped routes
for manual landing, but a sub-task token should only be able to self-land its
own task.

## Orphan Handling

Orphaned sub-tasks cannot self-land. If the coordinator has been deregistered,
there is no live owner to receive landed state, review follow-up fallout, or
coordinate later reversions. `land_self` should reject orphaned tasks and
surface an escalation state for the user.

Existing orphan behavior for `signal_done` remains unchanged for older
sub-tasks and manual-review flows.

## Verification

`land_self` requires structured verification:

```ts
type SubtaskVerification = {
  checks: Array<{
    name: string;
    command: string;
    result: 'passed' | 'blocked' | 'failed';
    reason?: string;
  }>;
};
```

The backend rejects `land_self` when verification is missing, blocked, or
failed. "Unknown" verification exists only for legacy `signal_done`
completions; it is never sufficient for `land_self`.

Verification state should be persisted and shown in the renderer so the
coordinator can distinguish passed, blocked, failed, and unknown completions.

## Clean Worktree Validation

The sub-task owns the decision to commit or discard its own changes. Before
landing, the backend should verify that the sub-task worktree is clean after
backend-owned injected artifacts are stripped or ignored.

If the worktree is dirty, `land_self` is rejected and the task enters an
escalated state. The backend should not auto-commit or discard arbitrary
sub-task changes as part of `land_self`.

## Merge And Cleanup

The backend should reuse the existing merge path that merges in the coordinator
worktree and serializes with the repository lock. No explicit
`acquire_land_lock` or `release_land_lock` tools are added.

On a successful merge, cleanup is backend-owned:

- strip injected sub-task preamble/config artifacts.
- remove the sub-task worktree and branch.
- delete the per-task MCP config.
- persist landed metadata.
- emit renderer state.

If the merge succeeds but cleanup fails, the task should enter a distinct
landed-cleanup-failed state so the coordinator/user can repair cleanup without
losing the fact that the branch already landed.

## Escalation

There is no separate `escalate_land` tool in the first pass.

If the sub-task knows it cannot land safely, it does not call `land_self`. It
asks its question in the terminal and waits under the existing
human/coordinator control flow.

If the backend discovers a problem during `land_self`, the failed response and
renderer event carry the escalation reason. Escalation cases include:

- failed, blocked, missing, or unknown verification.
- dirty sub-task worktree.
- invalid ownership or token.
- orphaned coordinator.
- branch/worktree mismatch.
- merge conflict.
- cleanup failure.

## Completion State

Successful self-landings are terminal and close the child task. After the
backend merges the branch and cleans up the child agent, worktree, branch, and
MCP config, it removes the child task from the active task list and tells the
renderer to close the child pane. The absence of the child task is the
completion signal; the user should not need to clear a successful task by hand.

Cleanup failures remain visible because they require attention. The first pass
does not need automatic rollback UI, but successful landing should record
enough metadata before closure for logs, responses, and future audit trails:

- sub-task ID and name.
- coordinator ID.
- target branch.
- landed commit.
- verification record.
- landing summary.
- landed order within the coordinator run.

When reverting or fixing a landed task, later landed tasks in the same
coordinator run should be re-reviewed for dependency on the reverted change.

## Active Task Ownership

The coordinator should not become the implementer for a sub-task that is still
running. Completion notifications and terminal text are hints, not ownership
transfers. `get_task_status` is authoritative: if it reports the task is still
running, the coordinator should treat the task as active. Before manual review
or merge work, the coordinator should verify the task state with
`get_task_status`.

If a task is still running and can receive prompts, the coordinator should send
specific findings back with `send_prompt` and let the assigned sub-task fix,
test, commit, and call `land_self` or return for manual review.
The backend also rejects `merge_task` for a still-running task unless that task
has already entered a manual-review or landing-escalation path, so the prompt
rule is enforced at the tool boundary.

Manual coordinator edits are reserved for genuinely terminal/manual-review/
blocked tasks, or for an explicit takeover. When taking over, the coordinator
should state the reason and evidence, such as an exited agent, a blocked agent,
a manual-review task state, a backend merge failure that needs conflict
resolution, or an explicit user request to take over.

Coordinator-side normalization is narrower than takeover. It is acceptable only
after `merge_task` fails, only to resolve mechanical conflicts caused by
already-landed shared fixes, and only when it makes no behavioral changes. The
coordinator should state that reason before editing.

## Base-Branch Policy

Self-landing does not relax the existing base-branch policy. Sub-tasks should
still branch from the coordinator task's branch by default.

Backend-mediated landing reduces coordinator merge work, but it does not make
stale spawn-time context safe. A sub-task that starts from `main` may miss the
coordinator's in-progress APIs, produce noisy diffs, or implement against
outdated assumptions.
