# TODOs

## Missing unit tests (test plan gaps)

Three test-plan behaviors have no unit test coverage and are likely to regress
silently. Tests should be written from the spec, not the implementation.

### 9. Edit suppression — auto-fire must not fire when user edits staged text (Test plan §6)

When a staged notification appears in the coordinator PromptInput and the user
types anything, auto-fire must be suppressed indefinitely (until manual Enter).
No test currently verifies that `userEdited: true` on the staged notification
prevents the autofire tick from firing. Add to `PromptInput.test.ts` or
`autofire-tick.ts`.

### 10. /tmp config cleanup — sub-task MCP config file deleted on close (Test plan §11)

`createTask` in `coordinator.ts` writes a per-task config to `/tmp/parallel-code-subtask-<id>.json`.
`cleanupTask` should delete it. No test verifies that the file is removed when
`close_task` is called or the task is closed. Add to `coordinator.test.ts`
using a temp-file spy or `fs.existsSync` assertion.

### 11. Coordinator checkbox re-enables after coordinator task closes (Test plan §12)

`hasActiveCoordinator()` in `NewTaskDialog.tsx` derives from `store.tasks`. No
test verifies that closing (removing) a coordinator task causes the signal to
return false, re-enabling the checkbox. Add a store-level test to
`src/store/tasks.test.ts`.

---

## Known edge cases — no fix yet

### 7. Autofire expiry window — coordinator in long tool call during countdown

`bf07118` escalates to an orphaned notification after 10 prompt misses, but if
the coordinator is mid-tool-call when the autofire countdown fires (no PTY
prompt visible), the countdown fires, finds no prompt, misses 10 times, and
escalates unnecessarily. Whether this happens in practice depends on timing; no
fix yet.

### 8. Post-restart coordinator MCP config becomes stale if coordinator process restarts

`22effac` persists `mcpConfigPath` across app restarts and rewrites configs with
the new port/token. However, if the coordinator Claude process itself restarts
(not the Electron app), the MCP server URL and token change and any running
sub-tasks are unreachable. Edge case, but real.
