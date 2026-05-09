import { describe, expect, it, vi, beforeEach } from 'vitest';

type MockTask = {
  controlledBy?: 'coordinator' | 'human';
  coordinatedBy?: string;
  agentIds: string[];
  shellAgentIds: string[];
  [key: string]: unknown;
};

let mockTasks: Record<string, MockTask> = {};
let mockAgents: Record<string, unknown> = {};
let mockTaskOrder: string[] = [];
const ipcHandlers = new Map<string, (data: unknown) => void>();

function applySetStore(...args: unknown[]): void {
  if (args.length === 1 && typeof args[0] === 'function') {
    (
      args[0] as (s: {
        tasks: Record<string, MockTask>;
        agents: Record<string, unknown>;
        taskOrder: string[];
      }) => void
    )({
      tasks: mockTasks,
      agents: mockAgents,
      taskOrder: mockTaskOrder,
    });
    return;
  }
  // Path-based: setStore('tasks', taskId, 'field', value)
  const value = args[args.length - 1];
  let target: Record<string, unknown> = {
    tasks: mockTasks,
    agents: mockAgents,
    taskOrder: mockTaskOrder,
  };
  for (let i = 0; i < args.length - 2; i++) {
    target = target[args[i] as string] as Record<string, unknown>;
  }
  target[args[args.length - 2] as string] = value;
}

vi.mock('solid-js/store', () => ({
  produce: (fn: (s: unknown) => void) => fn,
}));

vi.mock('./core', () => ({
  store: new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (prop === 'tasks') return mockTasks;
      if (prop === 'agents') return mockAgents;
      if (prop === 'taskOrder') return mockTaskOrder;
      if (prop === 'collapsedTaskOrder') return [];
      return undefined;
    },
  }),
  setStore: vi.fn((...args: unknown[]) => applySetStore(...args)),
  cleanupPanelEntries: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('../../electron/ipc/channels', () => ({
  IPC: {
    MCP_TaskCreated: 'mcp_task_created',
    MCP_TaskClosed: 'mcp_task_closed',
    MCP_CoordinatorNotificationStaged: 'mcp_coordinator_notification_staged',
    MCP_CoordinatorNotificationCleared: 'mcp_coordinator_notification_cleared',
    MCP_CoordinatorOrphanedNotification: 'mcp_coordinator_orphaned_notification',
    MCP_TaskStateSync: 'mcp_task_state_sync',
    MCP_ControlChanged: 'mcp_control_changed',
  },
}));
vi.mock('./persistence', () => ({ saveState: vi.fn() }));
vi.mock('./focus', () => ({ setTaskFocusedPanel: vi.fn() }));
vi.mock('./projects', () => ({
  getProject: vi.fn(),
  getProjectPath: vi.fn(),
  getProjectBranchPrefix: vi.fn(),
  isProjectMissing: vi.fn(),
}));
vi.mock('../lib/bookmarks', () => ({ setPendingShellCommand: vi.fn() }));
vi.mock('./taskStatus', () => ({
  markAgentSpawned: vi.fn(),
  markAgentBusy: vi.fn(),
  clearAgentActivity: vi.fn(),
  isAgentIdle: vi.fn(),
  rescheduleTaskStatusPolling: vi.fn(),
}));
vi.mock('./completion', () => ({
  recordMergedLines: vi.fn(),
  recordTaskCompleted: vi.fn(),
}));
vi.mock('../lib/log', () => ({ warn: vi.fn() }));
vi.mock('../lib/clean-task-name', () => ({ cleanTaskName: vi.fn() }));
vi.mock('./coordinator-preamble', () => ({ COORDINATOR_PREAMBLE: '' }));
vi.mock('./sidebar-order', () => ({ getCoordinatorChildren: vi.fn() }));
vi.mock('../lib/github-url', () => ({
  parseGitHubUrl: vi.fn(),
  taskNameFromGitHubUrl: vi.fn(),
}));

vi.stubGlobal('window', {
  electron: {
    ipcRenderer: {
      on: (_channel: string, handler: (data: unknown) => void) => {
        ipcHandlers.set(_channel, handler);
        return () => ipcHandlers.delete(_channel);
      },
    },
  },
});

import { initMCPListeners } from './tasks';

initMCPListeners();
const taskCreatedHandler = ipcHandlers.get('mcp_task_created');
if (!taskCreatedHandler) throw new Error('mcp_task_created handler not registered');

beforeEach(() => {
  mockTasks = {};
  mockAgents = {};
  mockTaskOrder = [];
});

const baseEvent = {
  taskId: 'sub-task-1',
  name: 'Sub Task',
  projectId: 'proj-1',
  branchName: 'task/sub-task-1',
  worktreePath: '/repo/.worktrees/sub-task-1',
  agentId: 'agent-sub-1',
  coordinatorTaskId: 'coordinator-1',
};

describe('MCP_TaskCreated IPC handler', () => {
  it('sets controlledBy to coordinator on the new sub-task', () => {
    taskCreatedHandler(baseEvent);
    expect(mockTasks['sub-task-1'].controlledBy).toBe('coordinator');
  });

  it('sets coordinatedBy to the coordinator task ID', () => {
    taskCreatedHandler(baseEvent);
    expect(mockTasks['sub-task-1'].coordinatedBy).toBe('coordinator-1');
  });

  it('regression: sub-tasks must not be created without controlledBy defined', () => {
    taskCreatedHandler(baseEvent);
    expect(mockTasks['sub-task-1'].controlledBy).toBeDefined();
  });
});
