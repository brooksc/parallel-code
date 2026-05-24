import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSetStore, mockMarkAgentSpawned } = vi.hoisted(() => ({
  mockSetStore: vi.fn(),
  mockMarkAgentSpawned: vi.fn(),
}));

let mockAgents: Record<string, AgentLike> = {};

interface AgentLike {
  id: string;
  taskId: string;
  def: AgentDefLike;
  resumed: boolean;
  status: 'running' | 'exited';
  exitCode: number | null;
  signal: string | null;
  lastOutput: string[];
  generation: number;
  spawnDelayMs?: number;
  attachExisting?: boolean;
}

interface AgentDefLike {
  id: string;
  name: string;
  command: string;
  args: string[];
  resume_args: string[];
  skip_permissions_args: string[];
  description: string;
}

function applySetStore(...args: unknown[]): void {
  if (args.length === 1 && typeof args[0] === 'function') {
    (args[0] as (s: { agents: Record<string, AgentLike> }) => void)({ agents: mockAgents });
  }
}

vi.mock('./core', () => ({
  store: new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (prop === 'agents') return mockAgents;
      return undefined;
    },
  }),
  setStore: mockSetStore,
}));

vi.mock('./taskStatus', () => ({
  markAgentSpawned: mockMarkAgentSpawned,
  refreshTaskStatus: vi.fn(),
  clearAgentActivity: vi.fn(),
}));

vi.mock('./persistence', () => ({ saveState: vi.fn() }));
vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));

import { restartAgent, switchAgent } from './agents';

const codexDef: AgentDefLike = {
  id: 'codex',
  name: 'Codex',
  command: 'codex',
  args: [],
  resume_args: ['resume', '--last'],
  skip_permissions_args: [],
  description: '',
};

function exitedAgent(overrides: Partial<AgentLike> = {}): AgentLike {
  return {
    id: 'agent-1',
    taskId: 'task-1',
    def: codexDef,
    resumed: false,
    status: 'exited',
    exitCode: 1,
    signal: '1',
    lastOutput: ['interrupted'],
    generation: 2,
    spawnDelayMs: 500,
    attachExisting: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSetStore.mockImplementation((...args: unknown[]) => applySetStore(...args));
  mockAgents = { 'agent-1': exitedAgent() };
});

describe('restartAgent', () => {
  it('marks the next terminal mount as an explicit process replacement', () => {
    restartAgent('agent-1', true);

    expect(mockAgents['agent-1']).toMatchObject({
      status: 'running',
      exitCode: null,
      signal: null,
      lastOutput: [],
      resumed: true,
      generation: 3,
      attachExisting: false,
    });
    expect(mockAgents['agent-1'].spawnDelayMs).toBeUndefined();
    expect(mockMarkAgentSpawned).toHaveBeenCalledWith('agent-1');
  });
});

describe('switchAgent', () => {
  it('marks the next terminal mount as an explicit process replacement', () => {
    const claudeDef: AgentDefLike = {
      ...codexDef,
      id: 'claude',
      name: 'Claude',
      command: 'claude',
    };

    switchAgent('agent-1', claudeDef);

    expect(mockAgents['agent-1']).toMatchObject({
      def: claudeDef,
      status: 'running',
      exitCode: null,
      signal: null,
      lastOutput: [],
      resumed: false,
      generation: 3,
      attachExisting: false,
    });
    expect(mockAgents['agent-1'].spawnDelayMs).toBeUndefined();
    expect(mockMarkAgentSpawned).toHaveBeenCalledWith('agent-1');
  });
});
