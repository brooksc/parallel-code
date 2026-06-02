import { describe, expect, it } from 'vitest';
import { isStartupBlockingAutoSend } from './prompt-autosend-readiness';

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

  it('blocks while Codex is booting multiple MCP servers (plural form)', () => {
    expect(isStartupBlockingAutoSend('Booting MCP servers: parallel-code\n›')).toBe(true);
  });

  it('blocks during mid-redraw: screen-clear issued but new frame not yet drawn', () => {
    // Codex emits \x1b[2J\x1b[H to start a new frame, but no content has arrived yet.
    // normalizeCurrentFrame returns '' in this window — treat as blocking so we
    // don't start stability checks against an empty snapshot.
    const tail = 'model: loading...\x1b[2J\x1b[H';
    expect(isStartupBlockingAutoSend(tail)).toBe(true);
  });

  it('blocks during cursor-home-only mid-redraw (no screen clear)', () => {
    const tail = 'Starting MCP servers (1/2)\x1b[H';
    expect(isStartupBlockingAutoSend(tail)).toBe(true);
  });

  it('does not block when the current frame has visible non-startup content', () => {
    // A screen clear followed by something unrelated to startup is ready.
    expect(isStartupBlockingAutoSend('\x1b[2J\x1b[H›')).toBe(false);
  });
});
