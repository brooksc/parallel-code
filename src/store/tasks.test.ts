import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const { mockInvoke, mockIsAgentBracketedPasteEnabled, mockSetStore, mockStore } = vi.hoisted(
  () => ({
    mockInvoke: vi.fn(),
    mockIsAgentBracketedPasteEnabled: vi.fn(),
    mockSetStore: vi.fn(),
    mockStore: {
      agents: {},
      tasks: {},
    } as {
      agents: Record<string, { status: string }>;
      tasks: Record<
        string,
        {
          initialPrompt?: string;
          lastPrompt?: string;
          agentIds?: string[];
          promptedAgentIds?: string[];
          stepsEnabled?: boolean;
        }
      >;
    },
  }),
);

vi.mock('../lib/ipc', () => ({
  Channel: vi.fn(),
  invoke: mockInvoke,
}));

vi.mock('./core', () => ({
  setStore: mockSetStore,
  store: mockStore,
  cleanupPanelEntries: vi.fn(),
}));

vi.mock('./persistence', () => ({
  saveState: vi.fn(),
}));

vi.mock('./focus', () => ({
  setTaskFocusedPanel: vi.fn(),
}));

vi.mock('./projects', () => ({
  getProject: vi.fn(),
  getProjectBranchPrefix: vi.fn(),
  getProjectPath: vi.fn(),
  isProjectMissing: vi.fn(),
}));

vi.mock('../lib/bookmarks', () => ({
  setPendingShellCommand: vi.fn(),
}));

vi.mock('./taskStatus', () => ({
  clearAgentActivity: vi.fn(),
  clearTaskGitStatusTracking: vi.fn(),
  isAgentBracketedPasteEnabled: mockIsAgentBracketedPasteEnabled,
  isAgentIdle: vi.fn(),
  markAgentBusy: vi.fn(),
  markAgentSpawned: vi.fn(),
  rescheduleTaskStatusPolling: vi.fn(),
}));

vi.mock('./completion', () => ({
  recordMergedLines: vi.fn(),
  recordTaskCompleted: vi.fn(),
}));

vi.mock('../lib/log', () => ({
  warn: vi.fn(),
}));

import { pasteDelayMs, sendPrompt } from './tasks';

function writePayloads(): string[] {
  return mockInvoke.mock.calls
    .filter(([channel]) => channel === IPC.WriteToAgent)
    .map(([, payload]) => payload.data);
}

describe('sendPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(undefined);
    mockIsAgentBracketedPasteEnabled.mockReturnValue(false);
    mockStore.agents = { 'agent-1': { status: 'running' } };
    mockStore.tasks = {
      'task-1': {
        lastPrompt: '',
        agentIds: ['agent-1'],
      },
    };
  });

  it('wraps prompt text in bracketed paste when the agent enabled it', async () => {
    mockIsAgentBracketedPasteEnabled.mockReturnValue(true);

    await sendPrompt('task-1', 'agent-1', 'hello Codex');

    expect(writePayloads()).toEqual(['\x1b[I', '\x1b[200~hello Codex\x1b[201~', '\r']);
    expect(mockSetStore).toHaveBeenCalledWith('tasks', 'task-1', 'lastPrompt', 'hello Codex');
  });

  it('sends raw prompt text when bracketed paste is not enabled', async () => {
    await sendPrompt('task-1', 'agent-1', 'hello Codex');

    expect(writePayloads()).toEqual(['\x1b[I', 'hello Codex', '\r']);
  });

  it('keeps Enter outside the bracketed paste block', async () => {
    mockIsAgentBracketedPasteEnabled.mockReturnValue(true);

    await sendPrompt('task-1', 'agent-1', 'line 1\nline 2');

    expect(writePayloads()).toEqual(['\x1b[I', '\x1b[200~line 1\nline 2\x1b[201~', '\r']);
  });

  it('injects steps instructions for each agent first prompt', async () => {
    mockStore.agents['agent-2'] = { status: 'running' };
    mockStore.tasks['task-1'] = {
      lastPrompt: 'already prompted first agent',
      agentIds: ['agent-1', 'agent-2'],
      promptedAgentIds: ['agent-1'],
      stepsEnabled: true,
    };

    await sendPrompt('task-1', 'agent-2', 'hello from second agent');

    expect(writePayloads()[1]).toContain('hello from second agent');
    expect(writePayloads()[1]).toContain('IMPORTANT: Maintain .claude/steps.json');
    expect(mockSetStore).toHaveBeenCalledWith('tasks', 'task-1', 'promptedAgentIds', [
      'agent-1',
      'agent-2',
    ]);
  });

  it('does not inject steps instructions again for an already prompted agent', async () => {
    mockStore.tasks['task-1'] = {
      lastPrompt: 'already prompted first agent',
      agentIds: ['agent-1'],
      promptedAgentIds: ['agent-1'],
      stepsEnabled: true,
    };

    await sendPrompt('task-1', 'agent-1', 'follow up');

    expect(writePayloads()[1]).toBe('follow up');
  });

  it('does not duplicate steps instructions when sending the queued initial prompt', async () => {
    mockStore.tasks['task-1'] = {
      lastPrompt: '',
      agentIds: ['agent-1'],
      initialPrompt: 'queued initial prompt',
      stepsEnabled: true,
    };

    await sendPrompt('task-1', 'agent-1', 'queued initial prompt');

    expect(writePayloads()[1]).toBe('queued initial prompt');
    expect(mockSetStore).toHaveBeenCalledWith('tasks', 'task-1', 'promptedAgentIds', ['agent-1']);
    expect(mockSetStore).toHaveBeenCalledWith('tasks', 'task-1', 'initialPrompt', undefined);
  });

  it('injects steps instructions when a first manual prompt differs from the queued initial prompt', async () => {
    mockStore.tasks['task-1'] = {
      lastPrompt: '',
      agentIds: ['agent-1'],
      initialPrompt: 'queued initial prompt',
      stepsEnabled: true,
    };

    await sendPrompt('task-1', 'agent-1', 'manual replacement');

    expect(writePayloads()[1]).toContain('manual replacement');
    expect(writePayloads()[1]).toContain('IMPORTANT: Maintain .claude/steps.json');
  });
});

describe('pasteDelayMs', () => {
  it('returns 50ms for a short single-line prompt', () => {
    expect(pasteDelayMs('hello')).toBe(50);
  });

  it('scales by line count for a ~31-line prompt', () => {
    const text = Array.from({ length: 31 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(pasteDelayMs(text)).toBe(Math.min(500, Math.max(50, 31 * 15)));
  });

  it('caps at 500ms for a very large prompt', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(pasteDelayMs(text)).toBe(500);
  });
});
