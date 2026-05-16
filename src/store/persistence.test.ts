import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDef } from '../ipc/types';
import type { PersistedTask } from './types';

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: mockInvoke,
}));

import { loadState, resolveIncomingPanelUserSize } from './persistence';
import { setStore, store } from './core';

function agentDef(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    args: [],
    resume_args: ['resume', '--last'],
    skip_permissions_args: [],
    description: 'Codex',
    ...overrides,
  };
}

function persistedTask(def: AgentDef): PersistedTask {
  return {
    id: 'task-1',
    name: 'Task',
    projectId: 'project-1',
    branchName: 'task/task-1',
    worktreePath: '/repo/.worktrees/task-1',
    notes: '',
    lastPrompt: '',
    shellCount: 0,
    agentDef: def,
    gitIsolation: 'worktree',
  };
}

async function loadPersistedAgent(def: AgentDef): Promise<AgentDef> {
  mockInvoke.mockResolvedValueOnce(
    JSON.stringify({
      projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'hsl(0, 70%, 75%)' }],
      lastProjectId: 'project-1',
      lastAgentId: null,
      taskOrder: ['task-1'],
      collapsedTaskOrder: [],
      tasks: {
        'task-1': persistedTask(def),
      },
      activeTaskId: 'task-1',
      sidebarVisible: true,
    }),
  );

  await loadState();

  const agentId = store.tasks['task-1']?.agentIds[0];
  expect(agentId).toBeTruthy();
  return store.agents[agentId as string].def;
}

beforeEach(() => {
  vi.clearAllMocks();
  setStore('projects', []);
  setStore('lastProjectId', null);
  setStore('lastAgentId', null);
  setStore('taskOrder', []);
  setStore('collapsedTaskOrder', []);
  setStore('tasks', {});
  setStore('agents', {});
  setStore('activeTaskId', null);
  setStore('activeAgentId', null);
  setStore('availableAgents', []);
  setStore('customAgents', []);
});

describe('resolveIncomingPanelUserSize', () => {
  it('prefers panelUserSize when both new and legacy are present', () => {
    const result = resolveIncomingPanelUserSize({ 'tiling:a': 200 }, { 'tiling:a': 999 }, true);
    expect(result).toEqual({ 'tiling:a': 200 });
  });

  it('falls back to legacy panelSizes when new field is missing', () => {
    const result = resolveIncomingPanelUserSize(undefined, { 'sidebar:width': 280 }, true);
    expect(result).toEqual({ 'sidebar:width': 280 });
  });

  it('returns empty when neither source is a string->number record', () => {
    expect(resolveIncomingPanelUserSize(null, null, true)).toEqual({});
    expect(resolveIncomingPanelUserSize('nope', 42, true)).toEqual({});
    expect(resolveIncomingPanelUserSize({ x: 'string' }, null, true)).toEqual({});
  });

  it('wipes task:* entries on first v2 migration but keeps tiling:/sidebar: pins', () => {
    const result = resolveIncomingPanelUserSize(
      {
        'task:abc:ai-terminal': 400,
        'task:abc:shell-section': 300,
        'tiling:uuid-1': 520,
        'sidebar:width': 240,
      },
      undefined,
      undefined,
    );
    expect(result).toEqual({
      'tiling:uuid-1': 520,
      'sidebar:width': 240,
    });
  });

  it('passes task:* entries through once the v2 flag is set', () => {
    const result = resolveIncomingPanelUserSize(
      { 'task:abc:prompt': 120, 'tiling:x': 500 },
      undefined,
      true,
    );
    expect(result).toEqual({ 'task:abc:prompt': 120, 'tiling:x': 500 });
  });

  it('migrates legacy panelSizes values too (drops task:* unless flag is set)', () => {
    const result = resolveIncomingPanelUserSize(
      undefined,
      { 'task:xyz:ai-terminal': 300, 'tiling:p': 480 },
      undefined,
    );
    expect(result).toEqual({ 'tiling:p': 480 });
  });

  it('rejects records containing non-finite numbers (NaN / Infinity)', () => {
    const result = resolveIncomingPanelUserSize(
      { 'tiling:a': Number.NaN, 'tiling:b': 200 },
      undefined,
      true,
    );
    expect(result).toEqual({});
  });

  it('rejects records containing negative or absurdly large values', () => {
    expect(resolveIncomingPanelUserSize({ 'tiling:a': -5 }, undefined, true)).toEqual({});
    expect(resolveIncomingPanelUserSize({ 'tiling:a': 1_000_000 }, undefined, true)).toEqual({});
  });

  it('keeps reasonable pixel values through the validator', () => {
    const result = resolveIncomingPanelUserSize(
      { 'tiling:a': 0, 'sidebar:width': 240, 'tiling:b': 15_000 },
      undefined,
      true,
    );
    expect(result).toEqual({
      'tiling:a': 0,
      'sidebar:width': 240,
      'tiling:b': 15_000,
    });
  });
});

describe('loadState agent definition migrations', () => {
  it('restores multiple persisted agents for one task', async () => {
    const codex = agentDef({ id: 'codex', name: 'Codex CLI' });
    const claude = agentDef({
      id: 'claude',
      name: 'Claude Code',
      command: 'claude',
      description: 'Claude',
    });

    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'hsl(0, 70%, 75%)' }],
        lastProjectId: 'project-1',
        lastAgentId: null,
        taskOrder: ['task-1'],
        collapsedTaskOrder: [],
        tasks: {
          'task-1': {
            ...persistedTask(codex),
            agentDefs: [codex, claude],
            agentIds: ['persisted-agent-1', 'persisted-agent-2'],
          },
        },
        activeTaskId: 'task-1',
        sidebarVisible: true,
      }),
    );

    await loadState();

    const agentIds = store.tasks['task-1']?.agentIds ?? [];
    expect(agentIds).toEqual(['persisted-agent-1', 'persisted-agent-2']);
    expect(agentIds.map((id) => store.agents[id].def.id)).toEqual(['codex', 'claude']);
    expect(store.agents[agentIds[0]].spawnDelayMs).toBeUndefined();
    expect(store.agents[agentIds[1]].spawnDelayMs).toBeGreaterThan(0);
    expect(store.agents[agentIds[0]].attachExisting).toBe(true);
    expect(store.agents[agentIds[1]].attachExisting).toBe(true);
  });

  it('restores prompted agent ids only when they still belong to active task agents', async () => {
    const codex = agentDef({ id: 'codex', name: 'Codex CLI' });
    const claude = agentDef({
      id: 'claude',
      name: 'Claude Code',
      command: 'claude',
      description: 'Claude',
    });

    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'hsl(0, 70%, 75%)' }],
        lastProjectId: 'project-1',
        lastAgentId: null,
        taskOrder: ['task-1'],
        collapsedTaskOrder: [],
        tasks: {
          'task-1': {
            ...persistedTask(codex),
            agentDefs: [codex, claude],
            agentIds: ['persisted-agent-1', 'persisted-agent-2'],
            promptedAgentIds: ['persisted-agent-2', 'missing-agent'],
          },
        },
        activeTaskId: 'task-1',
        sidebarVisible: true,
      }),
    );

    await loadState();

    expect(store.tasks['task-1']?.promptedAgentIds).toEqual(['persisted-agent-2']);
  });

  it('restores the selected agent for active multi-agent tasks', async () => {
    const codex = agentDef({ id: 'codex', name: 'Codex CLI' });
    const claude = agentDef({
      id: 'claude',
      name: 'Claude Code',
      command: 'claude',
      description: 'Claude',
    });

    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'hsl(0, 70%, 75%)' }],
        lastProjectId: 'project-1',
        lastAgentId: null,
        taskOrder: ['task-1'],
        collapsedTaskOrder: [],
        tasks: {
          'task-1': {
            ...persistedTask(codex),
            agentDefs: [codex, claude],
            agentIds: ['persisted-agent-1', 'persisted-agent-2'],
            selectedAgentId: 'persisted-agent-2',
          },
        },
        activeTaskId: 'task-1',
        sidebarVisible: true,
      }),
    );

    await loadState();

    expect(store.tasks['task-1']?.selectedAgentId).toBe('persisted-agent-2');
    expect(store.activeAgentId).toBe('persisted-agent-2');
  });

  it('restores pending initial prompts until they are sent', async () => {
    const codex = agentDef({ id: 'codex', name: 'Codex CLI' });

    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'hsl(0, 70%, 75%)' }],
        lastProjectId: 'project-1',
        lastAgentId: null,
        taskOrder: ['task-1'],
        collapsedTaskOrder: [],
        tasks: {
          'task-1': {
            ...persistedTask(codex),
            agentIds: ['persisted-agent-1'],
            initialPrompt: 'queued prompt',
            savedInitialPrompt: 'clean queued prompt',
          },
        },
        activeTaskId: 'task-1',
        sidebarVisible: true,
      }),
    );

    await loadState();

    expect(store.tasks['task-1']?.initialPrompt).toBe('queued prompt');
    expect(store.tasks['task-1']?.savedInitialPrompt).toBe('clean queued prompt');
  });

  it('keeps prompted agent indexes for collapsed task restore', async () => {
    const codex = agentDef({ id: 'codex', name: 'Codex CLI' });

    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'hsl(0, 70%, 75%)' }],
        lastProjectId: 'project-1',
        lastAgentId: null,
        taskOrder: [],
        collapsedTaskOrder: ['task-1'],
        tasks: {
          'task-1': {
            ...persistedTask(codex),
            collapsed: true,
            agentDefs: [codex],
            promptedAgentIds: ['stale-agent-id'],
            savedSelectedAgentIndex: 0,
            savedPromptedAgentIndexes: [0, -1, 101],
          },
        },
        activeTaskId: null,
        sidebarVisible: true,
      }),
    );

    await loadState();

    expect(store.tasks['task-1']?.agentIds).toEqual([]);
    expect(store.tasks['task-1']?.promptedAgentIds).toBeUndefined();
    expect(store.tasks['task-1']?.savedSelectedAgentIndex).toBe(0);
    expect(store.tasks['task-1']?.savedPromptedAgentIndexes).toEqual([0]);
  });

  it('migrates persisted Codex --full-auto skip-permissions args', async () => {
    const restored = await loadPersistedAgent(
      agentDef({
        skip_permissions_args: ['--full-auto', '--stale-extra'],
      }),
    );

    expect(restored.skip_permissions_args).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
  });

  it('leaves non-Codex --full-auto skip-permissions args unchanged', async () => {
    const restored = await loadPersistedAgent(
      agentDef({
        id: 'custom-agent',
        name: 'Custom Agent',
        command: 'custom',
        skip_permissions_args: ['--full-auto'],
      }),
    );

    expect(restored.skip_permissions_args).toEqual(['--full-auto']);
  });

  it('leaves current Codex skip-permissions args unchanged', async () => {
    const restored = await loadPersistedAgent(
      agentDef({
        skip_permissions_args: ['--dangerously-bypass-approvals-and-sandbox'],
      }),
    );

    expect(restored.skip_permissions_args).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
  });
});

// Minimal valid payload — no theme fields — used as a base for theme migration tests.
function basePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    projects: [{ id: 'p1', name: 'Repo', path: '/repo', color: 'hsl(0, 70%, 75%)' }],
    lastProjectId: 'p1',
    lastAgentId: null,
    taskOrder: [],
    collapsedTaskOrder: [],
    tasks: {},
    activeTaskId: null,
    sidebarVisible: true,
    ...overrides,
  });
}

describe('loadState theme persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setStore('projects', []);
    setStore('taskOrder', []);
    setStore('collapsedTaskOrder', []);
    setStore('tasks', {});
    setStore('agents', {});
    setStore('activeTaskId', null);
    setStore('activeAgentId', null);
    setStore('availableAgents', []);
    setStore('customAgents', []);
  });

  it('defaults to dark mode with islands-dark/islands-light when no theme fields saved', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload());
    await loadState();

    expect(store.appearanceMode).toBe('dark');
    expect(store.darkThemePreset).toBe('islands-dark');
    expect(store.lightThemePreset).toBe('islands-light');
    expect(store.darkThemeCustomId).toBeNull();
    expect(store.lightThemeCustomId).toBeNull();
  });

  it('restores explicit appearanceMode values', async () => {
    for (const mode of ['light', 'dark', 'system'] as const) {
      mockInvoke.mockResolvedValueOnce(basePayload({ appearanceMode: mode }));
      await loadState();
      expect(store.appearanceMode).toBe(mode);
    }
  });

  it('falls back to dark for an invalid appearanceMode value', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload({ appearanceMode: 'solarized' }));
    await loadState();
    expect(store.appearanceMode).toBe('dark');
  });

  it('restores a valid darkThemePreset', async () => {
    mockInvoke.mockResolvedValueOnce(
      basePayload({ appearanceMode: 'dark', darkThemePreset: 'classic' }),
    );
    await loadState();
    expect(store.darkThemePreset).toBe('classic');
  });

  it('falls back to islands-dark for an invalid darkThemePreset', async () => {
    mockInvoke.mockResolvedValueOnce(
      basePayload({ appearanceMode: 'dark', darkThemePreset: 'not-a-theme' }),
    );
    await loadState();
    expect(store.darkThemePreset).toBe('islands-dark');
  });

  it('restores a valid lightThemePreset', async () => {
    mockInvoke.mockResolvedValueOnce(
      basePayload({ appearanceMode: 'light', lightThemePreset: 'islands-light' }),
    );
    await loadState();
    expect(store.lightThemePreset).toBe('islands-light');
  });

  it('falls back to islands-light for an invalid lightThemePreset', async () => {
    mockInvoke.mockResolvedValueOnce(
      basePayload({ appearanceMode: 'light', lightThemePreset: 'bogus' }),
    );
    await loadState();
    expect(store.lightThemePreset).toBe('islands-light');
  });

  it('restores customId strings and nulls non-strings', async () => {
    mockInvoke.mockResolvedValueOnce(
      basePayload({
        appearanceMode: 'dark',
        darkThemeCustomId: 'my-custom',
        lightThemeCustomId: 42,
      }),
    );
    await loadState();
    expect(store.darkThemeCustomId).toBe('my-custom');
    expect(store.lightThemeCustomId).toBeNull();
  });

  it('backward compat: old themePreset=islands-light migrates to light mode', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload({ themePreset: 'islands-light' }));
    await loadState();
    expect(store.appearanceMode).toBe('light');
    expect(store.lightThemePreset).toBe('islands-light');
  });

  it('backward compat: old themePreset=classic (dark) migrates to dark mode', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload({ themePreset: 'classic' }));
    await loadState();
    expect(store.appearanceMode).toBe('dark');
    expect(store.darkThemePreset).toBe('classic');
  });

  it('backward compat: invalid old themePreset leaves dark mode with islands-dark', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload({ themePreset: 'legacy-unknown' }));
    await loadState();
    expect(store.appearanceMode).toBe('dark');
    expect(store.darkThemePreset).toBe('islands-dark');
  });
});
