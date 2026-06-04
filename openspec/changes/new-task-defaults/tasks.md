# Tasks — New Task Defaults

- [x] Add `defaultStepsEnabled`, `defaultSkipPermissions`, and
      `defaultPropagateSkipPermissions` to `AppStore` and `PersistedState` in
      `src/store/types.ts`; remove `showSteps` from `PersistedState`.
- [x] Add setters for all three fields in `src/store/ui.ts`.
- [x] Update `saveState` in `src/store/persistence.ts` to write the three new
      fields and stop writing `showSteps`.
- [x] Add migration in `loadState`: use `raw.defaultStepsEnabled` when it is a boolean; fall back to `raw.showSteps === true` only when the new field is absent (not present-but-invalid).
- [x] Add all three fields to `persistedSnapshot()` in `src/store/autosave.ts`
      and export the function for testing.
- [x] Fix New Task dialog open effect (`src/components/NewTaskDialog.tsx`) to
      initialize all three signals from the store rather than hardcoding `false`.
- [x] Add the three Settings rows in `src/components/SettingsDialog.tsx`
      (New Task Defaults section, placed after the Behavior group).
- [x] Add autosave regression tests (`src/store/autosave.test.ts`) using the
      real `persistedSnapshot()`.
- [x] Add migration tests to `src/store/persistence.test.ts`.
- [x] Update `openspec/specs/steps-tracking/spec.md` to rename `showSteps` →
      `defaultStepsEnabled` and document the two new fields.
- [x] Validate with `npm run typecheck`, `npm test`, and
      `openspec validate --all --strict`.
