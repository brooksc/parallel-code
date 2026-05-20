import { describe, expect, it } from 'vitest';
import { canRebindMcpRemoteServer, selectMcpJsonDir } from './register.js';

describe('selectMcpJsonDir', () => {
  it('returns worktreePath when defined', () => {
    expect(selectMcpJsonDir('/worktrees/my-task', '/project')).toBe('/worktrees/my-task');
  });

  it('returns projectRoot when worktreePath is undefined', () => {
    expect(selectMcpJsonDir(undefined, '/project')).toBe('/project');
  });

  it('returns empty string when worktreePath is empty string (nullish coalescing only catches null/undefined)', () => {
    expect(selectMcpJsonDir('', '/project')).toBe('');
  });
});

describe('canRebindMcpRemoteServer', () => {
  it('allows rebind only for MCP-started servers with no active coordinator or orphaned tasks', () => {
    expect(
      canRebindMcpRemoteServer(true, {
        hasActiveCoordinator: () => false,
        hasOrphanedTasks: () => false,
      }),
    ).toBe(true);
  });

  it('does not rebind while orphaned tasks still need the existing server', () => {
    expect(
      canRebindMcpRemoteServer(true, {
        hasActiveCoordinator: () => false,
        hasOrphanedTasks: () => true,
      }),
    ).toBe(false);
  });
});
