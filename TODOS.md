# TODOs

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
