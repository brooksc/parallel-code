# New Task Defaults for Steps, Skip-Permissions, and Propagate

## Why

Users who habitually enable the same options (steps tracking, skip-permissions,
propagate to sub-tasks) must re-tick them on every new task. There is no way to
set an app-level default so the dialog opens pre-checked.

## What changes

- Three new boolean settings in **Settings → General → New Task Defaults**:
  - **Steps tracking** — pre-tick "Steps tracking" in the New Task dialog
  - **Skip permissions** — pre-tick "Skip permissions" (only honoured when the
    selected agent supports it)
  - **Propagate skip-permissions to sub-tasks** — pre-tick propagate (shown
    only when `coordinatorModeEnabled` is true)
- All three values are persisted and included in the autosave snapshot.
- The `showSteps` key is renamed to `defaultStepsEnabled`; existing users'
  preferences are migrated transparently on first load.

## Impact

- Modifies `openspec/specs/steps-tracking/spec.md`: renames `showSteps` →
  `defaultStepsEnabled` and documents the two new fields.
- Store: adds `defaultSkipPermissions`, `defaultPropagateSkipPermissions`;
  renames `showSteps` → `defaultStepsEnabled` in `AppStore`, `PersistedState`,
  `saveState`, and `persistedSnapshot`.
- New Task dialog: open effect initializes all three signals from store instead
  of hardcoding `false`.
- No new IPC channels.
