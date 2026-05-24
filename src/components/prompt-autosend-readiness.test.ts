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
});
