# Change: New Task Defaults for Steps, Skip-Permissions, and Propagate

## Summary

Add three persistent app-level defaults that pre-fill checkboxes in the New
Task dialog, so users who habitually enable the same options do not have to
re-tick them on every task.

## Affected spec

`openspec/specs/steps-tracking/spec.md` — the `showSteps` field referenced in
the "opt-in per task with remembered default" scenarios is renamed to
`defaultStepsEnabled`. Behaviour is unchanged; only the storage key differs.
Existing `showSteps` values are migrated to `defaultStepsEnabled` on first
load.

## New behaviour

### `defaultStepsEnabled` (replaces `showSteps`)

- **WHEN** the user opens the new-task dialog
- **THEN** the "Steps tracking" checkbox is pre-checked iff `defaultStepsEnabled` is true
- **WHEN** the user toggles the Setting in Settings → General → New Task Defaults
- **THEN** `defaultStepsEnabled` is updated; task creation does not mutate this default

### `defaultSkipPermissions`

- **WHEN** the user opens the new-task dialog and the selected agent supports skip-permissions
- **THEN** the "Skip permissions" checkbox is pre-checked iff `defaultSkipPermissions` is true

### `defaultPropagateSkipPermissions`

- **WHEN** the user opens the new-task dialog with coordinator mode enabled and skip-permissions ticked
- **THEN** the "Propagate skip-permissions to sub-tasks" checkbox is pre-checked iff
  `defaultPropagateSkipPermissions` is true

## Settings surface

All three defaults are exposed in **Settings → General → New Task Defaults**
(adjacent to the Behavior section). The propagate row is only shown when
`coordinatorModeEnabled` is true.

## Migration

`loadState` maps `raw.showSteps === true` → `defaultStepsEnabled = true` so
existing users who had steps tracking enabled keep their preference.
`showSteps` is no longer written by `saveState`.
