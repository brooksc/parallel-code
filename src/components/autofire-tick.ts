import type { StagedNotification } from '../store/types';

const PROMPT_MARKER_SCAN_CHARS = 500;

export type AutoFireTickResult =
  | { outcome: 'too-soon' }
  | { outcome: 'paused' }
  | { outcome: 'no-prompt'; newMissCount: number }
  | { outcome: 'fire' };

/**
 * Pure decision function for a single autofire interval tick.
 * Returns what the tick should do without executing any side effects.
 * Exported for unit testing.
 */
export function processAutoFireTick(params: {
  staged: StagedNotification;
  now: number;
  controlledBy: 'coordinator' | 'human' | undefined;
  questionActive: boolean;
  tail: string;
  currentMissCount: number;
}): AutoFireTickResult {
  // Human has taken control — pause without counting misses so the counter
  // doesn't accumulate while the human is typing.
  if (params.controlledBy === 'human') {
    return { outcome: 'paused' };
  }

  // In coordinator-controlled mode there's no human to cancel, so skip the
  // delay entirely. In human mode the delay is irrelevant (already paused above).
  if (params.controlledBy !== 'coordinator' && params.staged.autoFireAt - params.now > 0) {
    return { outcome: 'too-soon' };
  }

  // A question/dialog is active — the ❯ visible in the TUI is a selection
  // cursor, not the agent prompt. Pause to avoid sending into the dialog.
  if (params.questionActive) {
    return { outcome: 'paused' };
  }

  // User has manually edited the prompt — suppress autofire indefinitely until
  // they press Enter themselves.
  if (params.staged.userEdited) {
    return { outcome: 'paused' };
  }

  const tailSnippet = params.tail.slice(-PROMPT_MARKER_SCAN_CHARS);
  const hasPrompt = /[❯›]/.test(tailSnippet);
  if (!hasPrompt) {
    return { outcome: 'no-prompt', newMissCount: params.currentMissCount + 1 };
  }

  return { outcome: 'fire' };
}
