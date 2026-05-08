import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockStore = {
  activeTaskId: string | null;
  activeAgentId: string | null;
  tasks: Record<string, { id: string; agentIds: string[] }>;
  terminals: Record<string, unknown>;
  taskOrder: string[];
  collapsedTaskOrder: string[];
  projects: Array<{ id: string }>;
};

let mockStore: MockStore;

vi.mock('./core', () => ({
  store: new Proxy(
    {},
    {
      get(_target, prop) {
        return mockStore[prop as keyof MockStore];
      },
    },
  ),
  setStore: vi.fn((...args: unknown[]) => {
    const key = args[0] as keyof MockStore;
    const value = args[1];
    (mockStore as Record<string, unknown>)[key] = value;
  }),
}));

vi.mock('./focus', () => ({}));
vi.mock('./notification', () => ({ showNotification: vi.fn() }));
vi.mock('./projects', () => ({ pickAndAddProject: vi.fn() }));
vi.mock('./tasks', () => ({ reorderTask: vi.fn() }));

import { jumpToTask } from './navigation';

beforeEach(() => {
  mockStore = {
    activeTaskId: null,
    activeAgentId: null,
    tasks: {
      'task-1': { id: 'task-1', agentIds: ['agent-a'] },
      'task-2': { id: 'task-2', agentIds: ['agent-b'] },
      'task-3': { id: 'task-3', agentIds: ['agent-c'] },
    },
    terminals: {},
    taskOrder: ['task-1', 'task-2', 'task-3'],
    collapsedTaskOrder: [],
    projects: [],
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('jumpToTask', () => {
  it('switches to the task at the given 0-based index', () => {
    jumpToTask(1);
    expect(mockStore.activeTaskId).toBe('task-2');
  });

  it('switches to the first task with index 0', () => {
    jumpToTask(0);
    expect(mockStore.activeTaskId).toBe('task-1');
  });

  it('switches to the last task with index matching last position', () => {
    jumpToTask(2);
    expect(mockStore.activeTaskId).toBe('task-3');
  });

  it('does nothing when index is out of bounds', () => {
    mockStore.activeTaskId = 'task-1';
    jumpToTask(9);
    expect(mockStore.activeTaskId).toBe('task-1');
  });

  it('sets activeAgentId to first agent of the target task', () => {
    jumpToTask(1);
    expect(mockStore.activeAgentId).toBe('agent-b');
  });

  it('indexes taskOrder, not collapsed tasks', () => {
    // Collapsed tasks live in collapsedTaskOrder and must not be reachable
    // by index — the user can't see them, so jumping there would surprise.
    mockStore.taskOrder = ['task-1', 'task-2'];
    mockStore.collapsedTaskOrder = ['task-3'];
    jumpToTask(2);
    expect(mockStore.activeTaskId).toBe(null);
  });
});
