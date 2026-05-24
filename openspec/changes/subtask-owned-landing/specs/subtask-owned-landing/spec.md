# Sub-Task Owned Landing Specification

## ADDED Requirements

### Requirement: Sub-tasks can request backend-mediated self-landing

The app SHALL expose a sub-task-scoped self-landing capability that lets a
coordinated child task ask the backend to land its own branch into the owning
coordinator branch.

#### Scenario: Sub-task self-lands successfully

- **GIVEN** a coordinated child task with a live owning coordinator
- **AND** the child task has committed work and passed verification
- **WHEN** the child task requests self-landing
- **THEN** the backend merges the child branch into the coordinator branch
- **AND** the child task is recorded as landed
- **AND** the coordinator does not need to send a merge or close command for
  that child

#### Scenario: Coordinator manual merge remains available

- **GIVEN** a coordinator wants to land a child task manually
- **WHEN** the coordinator uses the existing coordinator merge flow
- **THEN** the app still supports that manual landing path

### Requirement: Self-landing is authorized by the owning sub-task

The app SHALL allow self-landing only when the caller proves ownership of the
target sub-task and SHALL reject attempts to land another task.

#### Scenario: Matching sub-task token self-lands

- **GIVEN** a coordinated child task has a per-task done token
- **WHEN** the child task requests self-landing with its matching token
- **THEN** the backend accepts the caller as the owner of that child task

#### Scenario: Missing or wrong sub-task token is rejected

- **GIVEN** a coordinated child task has a per-task done token
- **WHEN** a self-landing request omits the token or presents another task's
  token
- **THEN** the backend rejects the request
- **AND** no merge or cleanup is performed

#### Scenario: Orphaned child cannot self-land

- **GIVEN** a coordinated child task whose owning coordinator has deregistered
- **WHEN** the child task requests self-landing
- **THEN** the backend rejects the request
- **AND** the child task is surfaced for coordinator or user attention

### Requirement: Self-landing requires passed verification

The app SHALL require structured verification with passed checks before
self-landing and SHALL reject missing, blocked, failed, or unknown verification.

#### Scenario: Passed verification allows landing

- **GIVEN** a coordinated child task reports structured verification
- **AND** every verification check is passed
- **WHEN** the child task requests self-landing
- **THEN** verification does not block the landing request

#### Scenario: Missing verification is rejected

- **GIVEN** a coordinated child task has no structured verification record
- **WHEN** the child task requests self-landing
- **THEN** the backend rejects the request
- **AND** the task is surfaced for coordinator or user attention

#### Scenario: Blocked or failed verification is rejected

- **GIVEN** a coordinated child task reports at least one blocked or failed
  verification check
- **WHEN** the child task requests self-landing
- **THEN** the backend rejects the request
- **AND** the task is surfaced for coordinator or user attention

#### Scenario: Legacy done signal has unknown verification

- **GIVEN** an older coordinated child task signals completion without
  structured verification
- **WHEN** the renderer shows that completion
- **THEN** the verification state is shown as unknown
- **AND** unknown verification does not satisfy self-landing verification

### Requirement: Self-landing requires a clean registered task worktree

The app SHALL reject self-landing when the target child task worktree is dirty
after backend-owned injected artifacts are handled, or when the worktree no
longer matches the registered task branch.

#### Scenario: Dirty worktree is rejected

- **GIVEN** a coordinated child task has uncommitted user-authored changes
- **WHEN** the child task requests self-landing
- **THEN** the backend rejects the request
- **AND** it does not auto-commit or discard those changes

#### Scenario: Registered branch no longer matches the worktree

- **GIVEN** a coordinated child task's worktree is no longer on the registered
  task branch
- **WHEN** the child task requests self-landing
- **THEN** the backend rejects the request
- **AND** no merge or cleanup is performed

### Requirement: Backend owns merge serialization and cleanup

The app SHALL perform self-landing merges in the coordinator branch worktree
under backend serialization, and SHALL clean up successfully landed child tasks.

#### Scenario: Backend lands and cleans up child task

- **GIVEN** a child task is eligible for self-landing
- **WHEN** the backend completes the self-landing merge
- **THEN** the backend removes the child worktree and branch
- **AND** removes the child task's MCP config
- **AND** strips injected sub-task preamble artifacts when present
- **AND** records landed metadata for review

#### Scenario: Merge conflict escalates without landing

- **GIVEN** a child task is eligible for self-landing
- **AND** merging the child branch into the coordinator branch conflicts
- **WHEN** the backend attempts self-landing
- **THEN** the backend aborts the merge
- **AND** records an escalated landing state
- **AND** no cleanup removes the child worktree

#### Scenario: Cleanup fails after successful merge

- **GIVEN** the backend successfully merges a child task
- **AND** cleanup of the child task fails
- **WHEN** the renderer displays the child task state
- **THEN** the task is shown as landed with cleanup failed
- **AND** the landed merge is not hidden or treated as unlanded

### Requirement: Successful self-landings close completed child tasks

The app SHALL remove successfully self-landed child tasks from the active task
list after the backend has merged the branch and cleaned up the child task
agent, worktree, branch, and MCP config.

#### Scenario: Successful landing closes the child task

- **WHEN** a child task self-lands successfully
- **THEN** the backend records landed metadata before cleanup
- **AND** the child task is removed from the backend task list
- **AND** the renderer removes the child task pane from the UI
- **AND** the renderer no longer sends prompt, terminal input, or terminal
  resize commands to the removed child task agent

#### Scenario: Cleanup failure remains visible

- **GIVEN** a child task branch was merged by self-landing
- **WHEN** cleanup of the child task fails
- **THEN** the child task remains visible with landed cleanup-failed state
- **AND** the task requires user or coordinator attention

### Requirement: Coordinator instructions preserve active sub-task ownership

The app SHALL instruct coordinators to treat `get_task_status` status `running`
as authoritative and to send follow-up prompts to running sub-tasks instead of
manually editing, verifying, merging, or closing those sub-tasks.
The app SHALL reject coordinator-driven `merge_task` calls for still-running
sub-tasks that have not entered manual-review or landing-escalation state.

#### Scenario: Running child receives follow-up

- **GIVEN** a child task appears complete from terminal output or notification
- **AND** `get_task_status` reports the child task is still running
- **WHEN** the coordinator finds an issue in that child task's work
- **THEN** the coordinator instructions tell it to use `send_prompt` with
  specific findings
- **AND** the instructions tell it not to manually edit, verify, merge, or close
  the running child task

#### Scenario: Backend rejects active merge

- **GIVEN** a child task is still running
- **AND** the child task has not called `signal_done`
- **AND** the child task is not in a landing escalation state
- **WHEN** the coordinator calls `merge_task` for that child task
- **THEN** the backend rejects the merge request
- **AND** the child branch is not merged or cleaned up

#### Scenario: Manual takeover requires explicit reason and evidence

- **GIVEN** a child task needs coordinator-owned manual intervention
- **WHEN** the coordinator takes over implementation, normalization, merge, or
  cleanup work
- **THEN** the coordinator instructions require stating the takeover reason and
  evidence

#### Scenario: Coordinator-side normalization is limited

- **GIVEN** `merge_task` fails for a child task
- **AND** the conflict is mechanical fallout from an already-landed shared fix
- **WHEN** the coordinator performs normalization to unblock the backend merge
- **THEN** the coordinator instructions limit the edit to non-behavioral
  normalization
- **AND** the instructions require stating the reason before editing

### Requirement: Sub-tasks keep using the coordinator branch as default base

The app SHALL continue guiding coordinators to create sub-tasks from the
coordinator task's branch by default.

#### Scenario: Coordinator instructions describe default base branch

- **WHEN** a coordinator task receives its coordination instructions
- **THEN** those instructions tell the coordinator to use its own branch as the
  default base branch for sub-tasks
