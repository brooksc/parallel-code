// Integration tests for coordinator-scoped task access in the remote HTTP server.
// Verifies that a coordinator can only see and control its own sub-tasks.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { Coordinator } from '../mcp/coordinator.js';
import type { ApiTaskSummary, ApiTaskDetail } from '../mcp/types.js';

vi.mock('../ipc/pty.js', () => ({
  writeToAgent: vi.fn(),
  resizeAgent: vi.fn(),
  killAgent: vi.fn(),
  subscribeToAgent: vi.fn(),
  unsubscribeFromAgent: vi.fn(),
  getAgentScrollback: vi.fn(() => null),
  getActiveAgentIds: vi.fn(() => []),
  getAgentMeta: vi.fn(() => null),
  getAgentCols: vi.fn(() => 80),
  onPtyEvent: vi.fn(() => vi.fn()), // returns an unsubscribe fn
}));

vi.mock('./protocol.js', () => ({
  parseClientMessage: vi.fn(() => null),
}));

const { startRemoteServer } = await import('./server.js');

// --- Minimal task fixtures ---

const COORD_A = 'coordinator-a';
const COORD_B = 'coordinator-b';

const taskA: ApiTaskDetail = {
  id: 'task-a-1',
  name: 'Task A',
  branchName: 'task/task-a',
  worktreePath: '/tmp/task-a',
  projectId: 'proj-1',
  agentId: 'agent-a',
  status: 'idle',
  coordinatorTaskId: COORD_A,
  exitCode: null,
};

const taskB: ApiTaskDetail = {
  id: 'task-b-1',
  name: 'Task B',
  branchName: 'task/task-b',
  worktreePath: '/tmp/task-b',
  projectId: 'proj-1',
  agentId: 'agent-b',
  status: 'idle',
  coordinatorTaskId: COORD_B,
  exitCode: null,
};

const summaryA: ApiTaskSummary = {
  id: taskA.id,
  name: taskA.name,
  branchName: taskA.branchName,
  status: taskA.status,
  coordinatorTaskId: taskA.coordinatorTaskId,
};

const summaryB: ApiTaskSummary = {
  id: taskB.id,
  name: taskB.name,
  branchName: taskB.branchName,
  status: taskB.status,
  coordinatorTaskId: taskB.coordinatorTaskId,
};

function makeMockCoordinator(): Coordinator {
  const tasks = new Map<string, ApiTaskDetail>([
    [taskA.id, taskA],
    [taskB.id, taskB],
  ]);

  return {
    listTasks: () => [summaryA, summaryB],
    getTaskStatus: (id: string) => tasks.get(id) ?? null,
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    waitForIdle: vi.fn().mockResolvedValue({ reason: 'idle' }),
    getTaskDiff: vi.fn().mockResolvedValue({ files: [], diff: '' }),
    getTaskOutput: vi.fn().mockReturnValue('output'),
    mergeTask: vi.fn().mockResolvedValue({ mainBranch: 'main', linesAdded: 0, linesRemoved: 0 }),
    closeTask: vi.fn().mockResolvedValue(undefined),
    reviewAndMergeTask: vi.fn().mockResolvedValue({
      diff: { files: [], diff: '' },
      merge: { mainBranch: 'main', linesAdded: 0, linesRemoved: 0 },
    }),
    createTask: vi.fn().mockResolvedValue(taskA),
    signalDone: vi.fn().mockReturnValue(true),
    waitForSignalDone: vi.fn().mockResolvedValue({
      taskId: taskA.id,
      name: taskA.name,
      status: 'idle',
      signalDoneAt: new Date().toISOString(),
      remaining: 0,
    }),
  } as unknown as Coordinator;
}

// --- Test helpers ---

let serverToken = '';
let serverPort = 0;
let serverStop: () => Promise<void>;

async function startServer(coordinator: Coordinator) {
  const srv = await startRemoteServer({
    port: 0, // random port
    host: '0.0.0.0',
    staticDir: '/nonexistent',
    getTaskName: (id) => id,
    getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
    getCoordinator: () => coordinator,
  });
  serverToken = srv.token;
  serverPort = srv.port;
  serverStop = srv.stop;
  return srv;
}

function httpRequest(
  method: string,
  path: string,
  body?: unknown,
  coordinatorId?: string,
): Promise<{ status: number; json: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${serverToken}`,
      'Content-Type': 'application/json',
    };
    if (coordinatorId) headers['X-Coordinator-Id'] = coordinatorId;
    if (bodyStr) headers['Content-Length'] = String(Buffer.byteLength(bodyStr));

    const req = http.request(
      { hostname: '127.0.0.1', port: serverPort, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          resolve({
            status: res.statusCode ?? 0,
            json: () => Promise.resolve(JSON.parse(raw) as unknown),
          });
        });
      },
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const get = (path: string, coordinatorId?: string) =>
  httpRequest('GET', path, undefined, coordinatorId);
const post = (path: string, body: unknown, coordinatorId?: string) =>
  httpRequest('POST', path, body, coordinatorId);
const del = (path: string, coordinatorId?: string) =>
  httpRequest('DELETE', path, undefined, coordinatorId);

// --- Tests ---

describe('coordinator scoping', () => {
  let mockCoord: Coordinator;

  beforeEach(async () => {
    mockCoord = makeMockCoordinator();
    await startServer(mockCoord);
  });

  afterEach(async () => {
    await serverStop();
  });

  describe('list_tasks', () => {
    it('returns all tasks when no X-Coordinator-Id header', async () => {
      const res = await get('/api/tasks');
      expect(res.status).toBe(200);
      const tasks = (await res.json()) as ApiTaskSummary[];
      expect(tasks.map((t) => t.id).sort()).toEqual([taskA.id, taskB.id].sort());
    });

    it('returns only coordinator A tasks when X-Coordinator-Id is coordinator-a', async () => {
      const res = await get('/api/tasks', COORD_A);
      expect(res.status).toBe(200);
      const tasks = (await res.json()) as ApiTaskSummary[];
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(taskA.id);
    });

    it('returns only coordinator B tasks when X-Coordinator-Id is coordinator-b', async () => {
      const res = await get('/api/tasks', COORD_B);
      expect(res.status).toBe(200);
      const tasks = (await res.json()) as ApiTaskSummary[];
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(taskB.id);
    });
  });

  describe('get_task_status', () => {
    it('allows coordinator A to access its own task', async () => {
      const res = await get(`/api/tasks/${taskA.id}`, COORD_A);
      expect(res.status).toBe(200);
    });

    it('returns 403 when coordinator A accesses coordinator B task', async () => {
      const res = await get(`/api/tasks/${taskB.id}`, COORD_A);
      expect(res.status).toBe(403);
    });

    it('allows unscoped caller to access any task', async () => {
      const resA = await get(`/api/tasks/${taskA.id}`);
      expect(resA.status).toBe(200);
      const resB = await get(`/api/tasks/${taskB.id}`);
      expect(resB.status).toBe(200);
    });
  });

  describe('send_prompt', () => {
    it('allows coordinator A to send prompt to its own task', async () => {
      const res = await post(`/api/tasks/${taskA.id}/prompt`, { prompt: 'hello' }, COORD_A);
      expect(res.status).toBe(200);
    });

    it('returns 403 when coordinator A sends prompt to coordinator B task', async () => {
      const res = await post(`/api/tasks/${taskB.id}/prompt`, { prompt: 'hello' }, COORD_A);
      expect(res.status).toBe(403);
    });
  });

  describe('get_task_diff', () => {
    it('allows coordinator A to get diff of its own task', async () => {
      const res = await get(`/api/tasks/${taskA.id}/diff`, COORD_A);
      expect(res.status).toBe(200);
    });

    it('returns 403 when coordinator A gets diff of coordinator B task', async () => {
      const res = await get(`/api/tasks/${taskB.id}/diff`, COORD_A);
      expect(res.status).toBe(403);
    });
  });

  describe('get_task_output', () => {
    it('allows coordinator A to get output of its own task', async () => {
      const res = await get(`/api/tasks/${taskA.id}/output`, COORD_A);
      expect(res.status).toBe(200);
    });

    it('returns 403 when coordinator A gets output of coordinator B task', async () => {
      const res = await get(`/api/tasks/${taskB.id}/output`, COORD_A);
      expect(res.status).toBe(403);
    });
  });

  describe('merge_task', () => {
    it('allows coordinator A to merge its own task', async () => {
      const res = await post(`/api/tasks/${taskA.id}/merge`, {}, COORD_A);
      expect(res.status).toBe(200);
    });

    it('returns 403 when coordinator A merges coordinator B task', async () => {
      const res = await post(`/api/tasks/${taskB.id}/merge`, {}, COORD_A);
      expect(res.status).toBe(403);
    });
  });

  describe('close_task', () => {
    it('allows coordinator A to close its own task', async () => {
      const res = await del(`/api/tasks/${taskA.id}`, COORD_A);
      expect(res.status).toBe(200);
    });

    it('returns 403 when coordinator A closes coordinator B task', async () => {
      const res = await del(`/api/tasks/${taskB.id}`, COORD_A);
      expect(res.status).toBe(403);
    });
  });

  describe('review_and_merge_task', () => {
    it('allows coordinator A to review-merge its own task', async () => {
      const res = await post(`/api/tasks/${taskA.id}/review-merge`, {}, COORD_A);
      expect(res.status).toBe(200);
    });

    it('returns 403 when coordinator A review-merges coordinator B task', async () => {
      const res = await post(`/api/tasks/${taskB.id}/review-merge`, {}, COORD_A);
      expect(res.status).toBe(403);
    });
  });

  describe('signal_done (called by sub-tasks, no coordinator header)', () => {
    it('allows signal_done without coordinator header (sub-task flow)', async () => {
      const res = await post(`/api/tasks/${taskA.id}/done`, {});
      expect(res.status).toBe(200);
    });

    it('allows signal_done for any task when no coordinator header', async () => {
      const res = await post(`/api/tasks/${taskB.id}/done`, {});
      expect(res.status).toBe(200);
    });
  });
});
