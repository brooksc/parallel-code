import { describe, expect, it } from 'vitest';
import { getMcpConfigArgs, getSkipPermissionsArgs } from './agents.js';

describe('getMcpConfigArgs', () => {
  it('returns flag + path for claude', () => {
    expect(getMcpConfigArgs('claude', '/tmp/config.json')).toEqual([
      '--mcp-config',
      '/tmp/config.json',
    ]);
  });

  it('returns flag + path for codex', () => {
    expect(getMcpConfigArgs('codex', '/tmp/config.json')).toEqual(['--config', '/tmp/config.json']);
  });

  it('returns empty for gemini', () => {
    expect(getMcpConfigArgs('gemini', '/tmp/config.json')).toEqual([]);
  });

  it('returns empty for opencode', () => {
    expect(getMcpConfigArgs('opencode', '/tmp/config.json')).toEqual([]);
  });

  it('returns empty for copilot', () => {
    expect(getMcpConfigArgs('copilot', '/tmp/config.json')).toEqual([]);
  });

  it('handles path-qualified claude command', () => {
    expect(getMcpConfigArgs('/usr/local/bin/claude', '/tmp/config.json')).toEqual([
      '--mcp-config',
      '/tmp/config.json',
    ]);
  });

  it('handles unknown agent', () => {
    expect(getMcpConfigArgs('unknown-agent', '/tmp/config.json')).toEqual([]);
  });
});

describe('getSkipPermissionsArgs', () => {
  it('returns a copy of default skip-permission args', () => {
    const first = getSkipPermissionsArgs('claude');
    first.push('--mutated');

    expect(getSkipPermissionsArgs('claude')).toEqual(['--dangerously-skip-permissions']);
  });
});
