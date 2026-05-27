import { describe, expect, it } from 'vitest';
import {
  isStartupBlockingAutoSend,
  shouldAbortInitialPromptAfterTimeout,
} from './prompt-autosend-readiness';
import { normalizeCurrentFrame } from '../store/taskStatus';

describe('isStartupBlockingAutoSend', () => {
  it('blocks while Codex is still loading the model', () => {
    expect(isStartupBlockingAutoSend('model: loading   /model to change\n›')).toBe(true);
  });

  it('blocks while Codex is starting MCP servers', () => {
    expect(
      isStartupBlockingAutoSend(
        'Starting MCP servers (0/2): codex_apps, parallel-code\n› Explain this codebase',
      ),
    ).toBe(true);
  });

  it('blocks while Codex is booting a single MCP server', () => {
    expect(isStartupBlockingAutoSend('Booting MCP server: parallel-code\n›')).toBe(true);
  });

  it('ignores stale startup text before the latest screen clear', () => {
    const tail = 'Starting MCP servers (0/2): parallel-code\x1b[2J\x1b[H›';
    expect(isStartupBlockingAutoSend(tail)).toBe(false);
  });
});

describe('normalizeCurrentFrame (used to gate initial-prompt delivery)', () => {
  it('returns falsy while no renderer tail has been observed', () => {
    expect(normalizeCurrentFrame('')).toBeFalsy();
  });

  it('returns falsy for control-only renderer output', () => {
    expect(normalizeCurrentFrame('\x1b[?2004h\x1b[?1004h')).toBeFalsy();
  });

  it('returns truthy once any renderer tail has been observed', () => {
    expect(normalizeCurrentFrame('› Explain this codebase')).toBeTruthy();
  });
});

describe('shouldAbortInitialPromptAfterTimeout', () => {
  it('does not abort before the readiness timeout', () => {
    expect(
      shouldAbortInitialPromptAfterTimeout({
        elapsedMs: 44_999,
        maxWaitMs: 45_000,
        coordinatedBy: undefined,
        tail: '› Explain this codebase',
      }),
    ).toBe(false);
  });

  it('keeps coordinated sub-task initial assignments alive after the readiness timeout', () => {
    expect(
      shouldAbortInitialPromptAfterTimeout({
        elapsedMs: 45_001,
        maxWaitMs: 45_000,
        coordinatedBy: 'coordinator-1',
        tail: '› Explain this codebase',
      }),
    ).toBe(false);
  });

  it('keeps prompt delivery alive after timeout when no renderer tail has been observed', () => {
    expect(
      shouldAbortInitialPromptAfterTimeout({
        elapsedMs: 45_001,
        maxWaitMs: 45_000,
        coordinatedBy: undefined,
        tail: '',
      }),
    ).toBe(false);
  });

  it('aborts non-coordinated initial prompts after timeout once output is visible', () => {
    expect(
      shouldAbortInitialPromptAfterTimeout({
        elapsedMs: 45_001,
        maxWaitMs: 45_000,
        coordinatedBy: undefined,
        tail: '› Explain this codebase',
      }),
    ).toBe(true);
  });
});
