import { describe, expect, it } from 'vitest';
import { processAutoFireTick } from './autofire-tick';
import type { StagedNotification } from '../store/types';

const staged: StagedNotification = {
  batchId: 'batch-1',
  notificationIds: ['n1'],
  text: 'hello coordinator',
  autoFireAt: 1_000,
  userEdited: false,
};

const pastNow = 2_000; // past autoFireAt=1000
const noPromptTail = 'agent is thinking...';
const promptTail = 'agent output ❯ ';

describe('processAutoFireTick — controlledBy: human', () => {
  it('returns paused without touching the miss counter when controlledBy is human', () => {
    const result = processAutoFireTick({
      staged,
      now: pastNow,
      controlledBy: 'human',
      tail: noPromptTail,
      currentMissCount: 0,
    });
    expect(result.outcome).toBe('paused');
    // 'paused' carries no newMissCount — the counter was not incremented
    expect('newMissCount' in result).toBe(false);
  });

  it('does not fire even when the prompt marker is visible and controlledBy is human', () => {
    const result = processAutoFireTick({
      staged,
      now: pastNow,
      controlledBy: 'human',
      tail: promptTail,
      currentMissCount: 0,
    });
    expect(result.outcome).toBe('paused');
  });
});

describe('processAutoFireTick — controlledBy reverts to coordinator', () => {
  it('increments the miss counter on the first coordinator tick when no prompt is visible', () => {
    const result = processAutoFireTick({
      staged,
      now: pastNow,
      controlledBy: 'coordinator',
      tail: noPromptTail,
      currentMissCount: 0,
    });
    expect(result.outcome).toBe('no-prompt');
    if (result.outcome !== 'no-prompt') throw new Error('unreachable');
    expect(result.newMissCount).toBe(1);
  });

  it('resumes miss counting from wherever the counter was (not from zero) when human releases control', () => {
    // Simulate: misses accumulated to 3, then human paused (counter stayed at 3),
    // then coordinator took back over — next tick should increment from 3.
    const result = processAutoFireTick({
      staged,
      now: pastNow,
      controlledBy: 'coordinator',
      tail: noPromptTail,
      currentMissCount: 3,
    });
    expect(result.outcome).toBe('no-prompt');
    if (result.outcome !== 'no-prompt') throw new Error('unreachable');
    expect(result.newMissCount).toBe(4);
  });

  it('fires when the prompt marker is visible after control returns to coordinator', () => {
    const result = processAutoFireTick({
      staged,
      now: pastNow,
      controlledBy: 'coordinator',
      tail: promptTail,
      currentMissCount: 2,
    });
    expect(result.outcome).toBe('fire');
  });

  it('also fires when controlledBy is undefined (unset coordinator task)', () => {
    const result = processAutoFireTick({
      staged,
      now: pastNow,
      controlledBy: undefined,
      tail: promptTail,
      currentMissCount: 0,
    });
    expect(result.outcome).toBe('fire');
  });
});
