# Tasks - Sub-Task Owned Landing

- [x] Add `land_self` to the sub-task MCP tool list with required structured
      verification and optional summary input.
- [x] Update the MCP server sub-task tool guard so sub-task tokens may call
      `signal_done` and `land_self`, while other coordinator routes remain
      forbidden.
- [x] Add MCP client support for `land_self`, sending the task ID and per-task
      done token to the remote route.
- [x] Add a remote API route for self-landing that validates the matching
      sub-task done token, task ownership, live coordinator state, and request
      body.
- [x] Add backend task fields for landing state, verification state, landed
      metadata, escalation reason, landed order, and cleanup-failed state.
- [x] Persist and hydrate the new landing and verification fields.
- [x] Implement backend `land_self` handling using the existing coordinator
      merge path and repository lock.
- [x] Reject `land_self` when verification is missing, blocked, failed, or
      unknown.
- [x] Reject `land_self` for orphaned sub-tasks.
- [x] Reject `land_self` when the task branch/worktree no longer matches the
      registered task.
- [x] Validate the sub-task worktree is clean after backend-owned injected
      artifacts are stripped or ignored; reject dirty worktrees without
      auto-committing or discarding sub-task changes.
- [x] On successful self-landing, strip injected preamble/config artifacts,
      delete the per-task MCP config, remove the worktree/branch, record landed
      metadata, and close the completed child task.
- [x] Add explicit landing escalation events/state for verification rejection,
      dirty worktree, orphaned coordinator, invalid ownership, branch/worktree
      mismatch, merge conflict, and cleanup failure.
- [x] Represent cleanup failure as landed-cleanup-failed so a successful merge
      is not hidden by failed cleanup.
- [x] Add renderer display for verification status, landing escalated, landing
      failed, landed cleanup failed, and legacy landed pending-review states.
- [x] Prevent landed/reviewed child task terminals and prompt sends from
      writing to the removed backend agent after self-landing cleanup.
- [x] Add a user action to clear legacy landed pending-review state.
- [x] Update sub-task preamble text so new sub-tasks call `land_self` on the
      happy path and reserve `signal_done` for legacy/manual-review flows.
- [x] Keep coordinator preamble base-branch guidance: sub-tasks branch from the
      coordinator task's branch by default.
- [x] Reject coordinator-driven `merge_task` for still-running tasks that have
      not entered manual-review or landing-escalation state.
- [x] Add tests for sub-task tool exposure and forbidden cross-route access.
- [x] Add remote-route tests for matching/missing/wrong done tokens.
- [x] Add backend tests for clean self-landing, dirty worktree rejection,
      orphan rejection, branch/worktree mismatch, merge conflict escalation,
      cleanup failure state, and landed metadata persistence.
- [x] Add renderer/store tests for successful close, legacy landed
      pending-review clearing, verification display, and escalation states.
- [x] Run `openspec validate --all --strict`, `npm run compile`,
      `npm run typecheck`, `git diff --check`, and focused tests covering
      `electron/mcp/coordinator.test.ts`, `electron/mcp/mcp-tool-list.test.ts`,
      `electron/remote/coordinator-scoping.test.ts`, `src/store/persistence.test.ts`,
      and `src/store/tasks.test.ts`.
      Note: repo-wide OpenSpec strict validation is still blocked by pre-existing
      `custom-themes` issues; `subtask-owned-landing` validates on its own.
