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

describe('lazy coordinator lookup — server started before coordinator exists', () => {
  let stop: () => Promise<void>;
  let token = '';
  let port = 0;

  afterEach(async () => {
    await stop();
  });

  it('returns 503 when coordinator is null at request time, then works after coordinator is set', async () => {
    let coord: Coordinator | null = null;

    const srv = await startRemoteServer({
      port: 0,
      host: '0.0.0.0',
      staticDir: '/nonexistent',
      getTaskName: (id) => id,
      getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
      getCoordinator: () => coord,
    });
    token = srv.token;
    port = srv.port;
    stop = srv.stop;

    const req = (method: string, path: string, body?: unknown) =>
      new Promise<{ status: number; json: () => Promise<unknown> }>((resolve, reject) => {
        const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        };
        if (bodyStr) headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
        const r = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString();
            resolve({ status: res.statusCode ?? 0, json: () => Promise.resolve(JSON.parse(raw)) });
          });
        });
        r.on('error', reject);
        if (bodyStr) r.write(bodyStr);
        r.end();
      });

    // Coordinator routes should return 503 when no coordinator is present
    const before = await req('GET', '/api/tasks');
    expect(before.status).toBe(503);
    expect(await before.json()).toMatchObject({ error: 'coordinator not available' });

    // POST /api/tasks should also return 503
    const beforePost = await req('POST', '/api/tasks', { name: 'test' });
    expect(beforePost.status).toBe(503);

    // Non-coordinator routes (agents list) should still work
    const agents = await req('GET', '/api/agents');
    expect(agents.status).toBe(200);

    // Set coordinator
    coord = makeMockCoordinator();

    // Now coordinator routes should work
    const after = await req('GET', '/api/tasks');
    expect(after.status).toBe(200);

    // signal_done should work too
    const done = await req('POST', `/api/tasks/${taskA.id}/done`, {});
    expect(done.status).toBe(200);
  });
});

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

// ─── Subtask token access control ────────────────────────────────────────────

describe('subtask token — restricted to signal_done only', () => {
  let subtaskToken = '';
  let stop: () => Promise<void>;

  beforeEach(async () => {
    const coord = makeMockCoordinator();
    const srv = await startServer(coord);
    subtaskToken = srv.subtaskToken;
    stop = srv.stop;
  });

  afterEach(async () => {
    await stop();
  });

  function subtaskRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number }> {
    return new Promise((resolve, reject) => {
      const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${subtaskToken}`,
        'Content-Type': 'application/json',
      };
      if (bodyStr) headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
      const req = http.request(
        { hostname: '127.0.0.1', port: serverPort, path, method, headers },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  it('subtaskToken is defined and differs from coordinator token', () => {
    expect(subtaskToken).toBeTruthy();
    expect(subtaskToken).not.toBe(serverToken);
  });

  it('POST /api/tasks/{id}/done is allowed with subtaskToken', async () => {
    const res = await subtaskRequest('POST', `/api/tasks/${taskA.id}/done`, {});
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('GET /api/tasks returns 403 with subtaskToken', async () => {
    const res = await subtaskRequest('GET', '/api/tasks');
    expect(res.status).toBe(403);
  });

  it('POST /api/tasks returns 403 with subtaskToken', async () => {
    const res = await subtaskRequest('POST', '/api/tasks', { name: 'x', prompt: 'y' });
    expect(res.status).toBe(403);
  });

  it('GET /api/agents returns 403 with subtaskToken', async () => {
    const res = await subtaskRequest('GET', '/api/agents');
    expect(res.status).toBe(403);
  });

  it('DELETE /api/tasks/{id} returns 403 with subtaskToken', async () => {
    const res = await subtaskRequest('DELETE', `/api/tasks/${taskA.id}`);
    expect(res.status).toBe(403);
  });

  it('POST /api/tasks/{id}/merge returns 403 with subtaskToken', async () => {
    const res = await subtaskRequest('POST', `/api/tasks/${taskA.id}/merge`);
    expect(res.status).toBe(403);
  });

  it('coordinator token still has full access to task routes', async () => {
    const res = await get('/api/tasks');
    expect(res.status).toBe(200);
  });
});
