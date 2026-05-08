import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- fs / child_process mocks (must come before dynamic import) ---
const mockWriteFileSync = vi.fn();
const mockReadFileSync = vi.fn(() => '# existing\n');
const mockExistsSync = vi.fn(() => false); // default: CLAUDE.md absent
const mockAppendFileSync = vi.fn();
const mockUnlinkSync = vi.fn();
const mockExecSync = vi.fn();

vi.mock('fs', () => ({
  writeFileSync: mockWriteFileSync,
  readFileSync: mockReadFileSync,
  existsSync: mockExistsSync,
  appendFileSync: mockAppendFileSync,
  unlinkSync: mockUnlinkSync,
}));

vi.mock('child_process', () => ({
  execSync: mockExecSync,
}));

// --- other mocks ---
const mockNotifyRenderer = vi.fn();
const mockOnPtyEvent = vi.fn();
const mockSpawnAgent = vi.fn();
const mockSubscribeToAgent = vi.fn();
const mockGetAgentScrollback = vi.fn(() => null);
const mockCreateBackendTask = vi.fn().mockResolvedValue({
  id: 'task-1',
  branch_name: 'task/test',
  worktree_path: '/tmp/test',
});

vi.mock('./prompt-detect.js', () => ({
  stripAnsi: (s: string) => s,
  chunkContainsAgentPrompt: (s: string) => s.includes('❯'),
}));

vi.mock('../ipc/pty.js', () => ({
  spawnAgent: mockSpawnAgent,
  writeToAgent: vi.fn(),
  killAgent: vi.fn(),
  subscribeToAgent: mockSubscribeToAgent,
  unsubscribeFromAgent: vi.fn(),
  getAgentScrollback: mockGetAgentScrollback,
  onPtyEvent: mockOnPtyEvent,
}));

vi.mock('../ipc/git.js', () => ({
  getChangedFiles: vi.fn().mockResolvedValue([]),
  getAllFileDiffs: vi.fn().mockResolvedValue(''),
  mergeTask: vi.fn(),
}));

vi.mock('../ipc/tasks.js', () => ({
  createTask: mockCreateBackendTask,
  deleteTask: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../ipc/channels.js', () => ({
  IPC: {
    MCP_TaskCreated: 'mcp_task_created',
    MCP_TaskClosed: 'mcp_task_closed',
    MCP_TaskStateSync: 'mcp_task_state_sync',
    MCP_CoordinatorNotificationStaged: 'mcp_coordinator_notification_staged',
    MCP_CoordinatorOrphanedNotification: 'mcp_coordinator_orphaned_notification',
  },
}));

// Import after mocks
const { Coordinator } = await import('./coordinator.js');

// --- helpers ---
function getExitHandler(): (agentId: string, data: unknown) => void {
  const call = mockOnPtyEvent.mock.calls.find((c) => c[0] === 'exit');
  if (!call) throw new Error('exit handler not registered');
  return call[1] as (agentId: string, data: unknown) => void;
}

function getOutputCb(): (encoded: string) => void {
  const call = mockSubscribeToAgent.mock.calls[0];
  if (!call) throw new Error('subscribeToAgent not called');
  return call[1] as (encoded: string) => void;
}

function getAgentId(): string {
  const call = mockSubscribeToAgent.mock.calls[0];
  if (!call) throw new Error('subscribeToAgent not called');
  return call[0] as string;
}

function encode(s: string): string {
  return Buffer.from(s).toString('base64');
}

const mockWin = {
  isDestroyed: () => false,
  webContents: { send: mockNotifyRenderer },
} as unknown as import('electron').BrowserWindow;

// ─── coordinator notification tests ───────────────────────────────────────────

describe('Coordinator coordinator notifications', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
  });

  it('does not notify when assignedPromptDelivered is false (startup idle)', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({
      name: 'test',
      prompt: 'do work',
      coordinatorTaskId: 'coord-1',
    });
    const outputCb = getOutputCb();
    outputCb(encode('Welcome ❯ '));
    expect(mockNotifyRenderer).not.toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.anything(),
    );
  });

  it('notifies coordinator when sub-task exits before prompt delivery (user closed early)', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({ name: 'test', prompt: 'do work', coordinatorTaskId: 'coord-1' });
    const agentId = getAgentId();
    const exitHandler = getExitHandler();
    // Never call markPromptDelivered — simulates user closing the task before prompt lands
    exitHandler(agentId, { exitCode: null });
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.objectContaining({ coordinatorTaskId: 'coord-1' }),
    );
  });

  it('notifies coordinator when sub-task idles after prompt delivery', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({
      name: 'test',
      prompt: 'do work',
      coordinatorTaskId: 'coord-1',
    });
    const outputCb = getOutputCb();

    coordinator.markPromptDelivered('task-1');

    outputCb(encode('Working... ❯ '));
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.objectContaining({
        coordinatorTaskId: 'coord-1',
        notificationIds: expect.any(Array),
      }),
    );
  });

  it('does not enqueue duplicate notification for repeated idles', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    const outputCb = getOutputCb();
    outputCb(encode('Done ❯ '));
    outputCb(encode('Still here '));
    outputCb(encode('Idle again ❯ '));
    const calls = mockNotifyRenderer.mock.calls.filter(
      (c) => c[0] === 'mcp_coordinator_notification_staged',
    );
    const lastPayload = calls[calls.length - 1]?.[1] as { notificationIds: string[] };
    expect(lastPayload.notificationIds).toHaveLength(1);
  });

  it('upgrades idle→exited on PTY exit without adding duplicate', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    const outputCb = getOutputCb();
    const agentId = getAgentId();
    const exitHandler = getExitHandler();
    outputCb(encode('Done ❯ '));
    mockNotifyRenderer.mockClear();
    exitHandler(agentId, { exitCode: 0 });
    const stagedCalls = mockNotifyRenderer.mock.calls.filter(
      (c) => c[0] === 'mcp_coordinator_notification_staged',
    );
    expect(stagedCalls).toHaveLength(1);
    const payload = stagedCalls[0][1] as { notificationIds: string[] };
    expect(payload.notificationIds).toHaveLength(1);
  });

  it('ack removes only the pending IDs in that batch', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({ name: 'task-a', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    const outputCb = getOutputCb();
    outputCb(encode('Done ❯ '));

    const stagedCallAck = mockNotifyRenderer.mock.calls.find(
      (c) => c[0] === 'mcp_coordinator_notification_staged',
    );
    if (!stagedCallAck) throw new Error('No staged call found');
    const { batchId } = stagedCallAck[1] as { batchId: string };

    coordinator.ackNotification('coord-1', batchId);
    const task = coordinator.getTask('task-1');
    expect(task?.reviewNotificationQueued).toBe(false);
  });

  it('ack is idempotent', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    const outputCb = getOutputCb();
    outputCb(encode('Done ❯ '));
    const stagedCallIdempotent = mockNotifyRenderer.mock.calls.find(
      (c) => c[0] === 'mcp_coordinator_notification_staged',
    );
    if (!stagedCallIdempotent) throw new Error('No staged call found');
    const { batchId } = stagedCallIdempotent[1] as { batchId: string };
    expect(() => {
      coordinator.ackNotification('coord-1', batchId);
      coordinator.ackNotification('coord-1', batchId);
    }).not.toThrow();
  });

  it('uses shortened delay for non-zero exit', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    const agentId = getAgentId();
    const exitHandler = getExitHandler();
    exitHandler(agentId, { exitCode: 1 });
    const stagedCallDelay = mockNotifyRenderer.mock.calls.find(
      (c) => c[0] === 'mcp_coordinator_notification_staged',
    );
    if (!stagedCallDelay) throw new Error('No staged call found');
    const { autoFireAt } = stagedCallDelay[1] as { autoFireAt: number };
    expect(autoFireAt - Date.now()).toBeLessThanOrEqual(15_500);
    expect(autoFireAt - Date.now()).toBeGreaterThan(9_000);
  });

  it('orphaned sub-task fires MCP_CoordinatorOrphanedNotification when no coordinator registered', async () => {
    await coordinator.createTask({
      name: 'orphan',
      prompt: 'do',
      coordinatorTaskId: 'missing-coord',
    });
    coordinator.markPromptDelivered('task-1');
    const outputCb = getOutputCb();
    outputCb(encode('Done ❯ '));
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_coordinator_orphaned_notification',
      expect.objectContaining({ subTaskId: 'task-1' }),
    );
  });
});

// ─── signal_done tests ────────────────────────────────────────────────────────

describe('Coordinator signal_done', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
  });

  it('stages notification with 5s delay without requiring markPromptDelivered', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.signalDone('task-1');

    const stagedCall = mockNotifyRenderer.mock.calls.find(
      (c) => c[0] === 'mcp_coordinator_notification_staged',
    );
    if (!stagedCall) throw new Error('No staged call found');
    const { autoFireAt } = stagedCall[1] as { autoFireAt: number };
    expect(autoFireAt - Date.now()).toBeLessThanOrEqual(5_500);
    expect(autoFireAt - Date.now()).toBeGreaterThan(4_000);
  });

  it('sends MCP_TaskStateSync to renderer', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.signalDone('task-1');

    expect(mockNotifyRenderer).toHaveBeenCalledWith('mcp_task_state_sync', {
      taskId: 'task-1',
      signalDoneReceived: true,
    });
  });

  it('sets signalDoneAt on the task', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const before = new Date();
    coordinator.signalDone('task-1');
    const after = new Date();
    const task = coordinator.getTask('task-1');
    expect(task?.signalDoneAt).toBeDefined();
    expect(task?.signalDoneAt?.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(task?.signalDoneAt?.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('is a no-op for unknown taskId', () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    expect(() => coordinator.signalDone('nonexistent-task')).not.toThrow();
    expect(mockNotifyRenderer).not.toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.anything(),
    );
  });
});

// ─── spawn defaults / skipPermissions tests ───────────────────────────────────

describe('Coordinator sub-agent spawn settings', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('defaults to bare claude command', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ command: 'claude' }),
    );
  });

  it('inherits coordinator command via setCoordinatorSpawnDefaults', async () => {
    coordinator.setCoordinatorSpawnDefaults('/usr/local/bin/claude', []);
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ command: '/usr/local/bin/claude' }),
    );
  });

  it('inherits coordinator base args (e.g. --model)', async () => {
    coordinator.setCoordinatorSpawnDefaults('claude', ['--model', 'claude-opus-4-7']);
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const spawnArgs = mockSpawnAgent.mock.calls[0][1].args as string[];
    expect(spawnArgs).toContain('--model');
    expect(spawnArgs).toContain('claude-opus-4-7');
  });

  it('adds --dangerously-skip-permissions when skipPermissions is true', async () => {
    await coordinator.createTask({
      name: 'test',
      prompt: 'do',
      coordinatorTaskId: 'coord-1',
      skipPermissions: true,
    });
    const spawnArgs = mockSpawnAgent.mock.calls[0][1].args as string[];
    expect(spawnArgs).toContain('--dangerously-skip-permissions');
  });

  it('does not add --dangerously-skip-permissions when skipPermissions is false', async () => {
    await coordinator.createTask({
      name: 'test',
      prompt: 'do',
      coordinatorTaskId: 'coord-1',
      skipPermissions: false,
    });
    const spawnArgs = mockSpawnAgent.mock.calls[0][1].args as string[];
    expect(spawnArgs).not.toContain('--dangerously-skip-permissions');
  });

  it('inherited args do not include --dangerously-skip-permissions (handled separately)', async () => {
    // skip_permissions_args should not be passed as agentArgs — only agentDef.args (base args)
    coordinator.setCoordinatorSpawnDefaults('claude', ['--model', 'claude-opus-4-7']);
    await coordinator.createTask({
      name: 'test',
      prompt: 'do',
      coordinatorTaskId: 'coord-1',
      skipPermissions: false,
    });
    const spawnArgs = mockSpawnAgent.mock.calls[0][1].args as string[];
    expect(spawnArgs).not.toContain('--dangerously-skip-permissions');
    expect(spawnArgs).toContain('--model');
  });

  it('spawns sub-agent in the sub-task worktree path', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cwd: '/tmp/test' }),
    );
  });
});

// ─── CLAUDE.md injection tests ────────────────────────────────────────────────

describe('Coordinator CLAUDE.md sub-task injection', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates CLAUDE.md when it does not exist, records null original', async () => {
    mockExistsSync.mockReturnValue(false);
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const claudeWrite = mockWriteFileSync.mock.calls.find((c) =>
      (c[0] as string).endsWith('CLAUDE.md'),
    );
    expect(claudeWrite).toBeDefined();
    expect(claudeWrite?.[1]).toContain('signal_done');
    expect(coordinator.getTask('task-1')?.claudeMdOriginal).toBeNull();
  });

  it('appends to existing CLAUDE.md, records original content', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('# Project\n');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    expect(mockAppendFileSync).toHaveBeenCalledWith(
      '/tmp/test/CLAUDE.md',
      expect.stringContaining('signal_done'),
    );
    expect(coordinator.getTask('task-1')?.claudeMdOriginal).toBe('# Project\n');
  });

  it('deletes CLAUDE.md (no git restore) when it was created fresh, 3s after first idle', async () => {
    vi.useFakeTimers();
    mockExistsSync.mockReturnValue(false);
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');

    const outputCb = getOutputCb();
    outputCb(encode('Working ❯ '));

    expect(mockUnlinkSync).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3_000);

    expect(mockUnlinkSync).toHaveBeenCalledWith('/tmp/test/CLAUDE.md');
    expect(mockExecSync).not.toHaveBeenCalled(); // no git restore for new files
  });

  it('restores original content + git restore when CLAUDE.md pre-existed', async () => {
    vi.useFakeTimers();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('# Existing\n');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');

    const outputCb = getOutputCb();
    outputCb(encode('Working ❯ '));
    vi.advanceTimersByTime(3_000);

    const restoreWrite = mockWriteFileSync.mock.calls.find(
      (c) => (c[0] as string).endsWith('CLAUDE.md') && c[1] === '# Existing\n',
    );
    expect(restoreWrite).toBeDefined();
    expect(mockExecSync).toHaveBeenCalledWith('git restore CLAUDE.md', expect.anything());
  });

  it('only restores CLAUDE.md once even with multiple idles', async () => {
    vi.useFakeTimers();
    mockExistsSync.mockReturnValue(false);
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');

    const outputCb = getOutputCb();
    outputCb(encode('Working ❯ '));
    vi.advanceTimersByTime(3_000);
    outputCb(encode('more work'));
    outputCb(encode('done ❯ '));
    vi.advanceTimersByTime(3_000);

    const unlinkCalls = mockUnlinkSync.mock.calls.filter((c) =>
      (c[0] as string).endsWith('CLAUDE.md'),
    );
    expect(unlinkCalls).toHaveLength(1);
  });

  it('cleans up CLAUDE.md on closeTask if agent never went idle', async () => {
    mockExistsSync.mockReturnValue(false);
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    await coordinator.closeTask('task-1');

    expect(mockUnlinkSync).toHaveBeenCalledWith('/tmp/test/CLAUDE.md');
  });
});

// ─── waitForIdle tests ────────────────────────────────────────────────────────

describe('Coordinator waitForIdle', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects for unknown taskId', async () => {
    await expect(coordinator.waitForIdle('nonexistent')).rejects.toThrow('Task not found');
  });

  it('resolves immediately when task is already idle', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    const outputCb = getOutputCb();
    outputCb(encode('Done ❯ '));
    await expect(coordinator.waitForIdle('task-1')).resolves.toBeUndefined();
  });

  it('resolves when agent outputs prompt', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const outputCb = getOutputCb();
    const waitPromise = coordinator.waitForIdle('task-1');
    outputCb(encode('working...'));
    outputCb(encode('Done ❯ '));
    await expect(waitPromise).resolves.toBeUndefined();
  });

  it('resolves immediately when task is under human control', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.setTaskControl('task-1', 'human');
    await expect(coordinator.waitForIdle('task-1')).resolves.toBeUndefined();
  });

  it('rejects after timeout when task never idles', async () => {
    vi.useFakeTimers();
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const waitPromise = coordinator.waitForIdle('task-1', 1_000);
    vi.advanceTimersByTime(1_001);
    await expect(waitPromise).rejects.toThrow('Timed out');
  });

  it('resolves when task exits (PTY exit fires idle resolvers)', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const agentId = getAgentId();
    const exitHandler = getExitHandler();
    const waitPromise = coordinator.waitForIdle('task-1');
    exitHandler(agentId, { exitCode: 0 });
    await expect(waitPromise).resolves.toBeUndefined();
  });

  it('fires pending idle resolvers when control returns to coordinator', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    // Queue a waiter while under human control — waitForIdle resolves immediately for 'human'
    // but if we queue first then hand off, the resolver fires on return
    // The real scenario: task is running, coordinator calls waitForIdle, user takes control, coordinator returns
    const waitPromise = coordinator.waitForIdle('task-1');
    // Without taking control it would wait for idle; now simulate returning control
    coordinator.setTaskControl('task-1', 'coordinator');
    await expect(waitPromise).resolves.toBeUndefined();
  });
});

// ─── waitForSignalDone tests ──────────────────────────────────────────────────

describe('Coordinator waitForSignalDone', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects for unknown taskId', async () => {
    await expect(coordinator.waitForSignalDone('nonexistent')).rejects.toThrow('Task not found');
  });

  it('resolves immediately if already signalled', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.signalDone('task-1');
    await expect(coordinator.waitForSignalDone('task-1')).resolves.toBeUndefined();
  });

  it('resolves when signalDone is called', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const waitPromise = coordinator.waitForSignalDone('task-1');
    coordinator.signalDone('task-1');
    await expect(waitPromise).resolves.toBeUndefined();
  });

  it('rejects after timeout when signal never arrives', async () => {
    vi.useFakeTimers();
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const waitPromise = coordinator.waitForSignalDone('task-1', 1_000);
    vi.advanceTimersByTime(1_001);
    await expect(waitPromise).rejects.toThrow('Timed out');
  });
});

// ─── sendPrompt tests ─────────────────────────────────────────────────────────

describe('Coordinator sendPrompt', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('rejects for unknown taskId', async () => {
    await expect(coordinator.sendPrompt('nonexistent', 'hello')).rejects.toThrow('Task not found');
  });

  it('rejects when task is under human control', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.setTaskControl('task-1', 'human');
    await expect(coordinator.sendPrompt('task-1', 'hello')).rejects.toThrow('human control');
  });

  it('notifies coordinator when control returns after a blocked send_prompt', async () => {
    await coordinator.createTask({ name: 'my-task', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.setTaskControl('task-1', 'human');
    await expect(coordinator.sendPrompt('task-1', 'hello')).rejects.toThrow('human control');
    mockNotifyRenderer.mockClear();

    coordinator.setTaskControl('task-1', 'coordinator');

    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.objectContaining({
        coordinatorTaskId: 'coord-1',
        text: expect.stringContaining('"my-task" has been returned to coordinator control'),
      }),
    );
  });

  it('does not notify coordinator when control returns without a prior blocked send_prompt', async () => {
    await coordinator.createTask({ name: 'my-task', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.setTaskControl('task-1', 'human');
    mockNotifyRenderer.mockClear();

    coordinator.setTaskControl('task-1', 'coordinator');

    expect(mockNotifyRenderer).not.toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.anything(),
    );
  });
});

// ─── deregisterCoordinator tests ──────────────────────────────────────────────

describe('Coordinator deregisterCoordinator', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
  });

  it('is a no-op for unknown coordinator', () => {
    expect(() => coordinator.deregisterCoordinator('nonexistent')).not.toThrow();
  });

  it('notifications go orphaned after coordinator is deregistered', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.deregisterCoordinator('coord-1');
    coordinator.markPromptDelivered('task-1');
    const outputCb = getOutputCb();
    outputCb(encode('Done ❯ '));
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_coordinator_orphaned_notification',
      expect.objectContaining({ subTaskId: 'task-1' }),
    );
  });

  it('hasActiveCoordinator returns false after deregister', () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    expect(coordinator.hasActiveCoordinator()).toBe(true);
    coordinator.deregisterCoordinator('coord-1');
    expect(coordinator.hasActiveCoordinator()).toBe(false);
  });
});

// ─── per-task projectRoot tests ───────────────────────────────────────────────

describe('Coordinator per-task projectRoot', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project-a');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('task stores the projectRoot at creation time', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(coordinator.getTask('task-1')?.projectRoot).toBe('/tmp/project-a');
  });

  it('later setDefaultProject does not affect existing task projectRoot', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.setDefaultProject('proj-2', '/tmp/project-b');
    expect(coordinator.getTask('task-1')?.projectRoot).toBe('/tmp/project-a');
  });
});

// ─── waiter resolver cleanup tests ───────────────────────────────────────────

describe('Coordinator waiter resolver cleanup on timeout', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes idle resolver after timeout so stale callback is not called on later idle', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const outputCb = getOutputCb();

    const p = coordinator.waitForIdle('task-1', 500);
    vi.advanceTimersByTime(501);
    await expect(p).rejects.toThrow('Timed out');

    // Now the task goes idle — no stale resolver should fire (no throw, no hang)
    let resolveCalled = false;
    const p2 = coordinator.waitForIdle('task-1', 500);
    p2.then(() => {
      resolveCalled = true;
    }).catch(() => {});
    outputCb(encode('Done ❯ '));
    await Promise.resolve(); // flush microtasks
    expect(resolveCalled).toBe(true);
  });

  it('removes signal_done resolver after timeout so stale callback is not called on later signal', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const p = coordinator.waitForSignalDone('task-1', 500);
    vi.advanceTimersByTime(501);
    await expect(p).rejects.toThrow('Timed out');

    // signalDone fires after timeout — should resolve a new waiter, not the stale one
    let resolveCalled = false;
    const p2 = coordinator.waitForSignalDone('task-1', 500);
    p2.then(() => {
      resolveCalled = true;
    }).catch(() => {});
    coordinator.signalDone('task-1');
    await Promise.resolve();
    expect(resolveCalled).toBe(true);
  });
});

// ─── MCP_TaskCreated spawn settings tests ────────────────────────────────────

describe('Coordinator MCP_TaskCreated spawn settings', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('includes agentCommand in MCP_TaskCreated payload', async () => {
    coordinator.setCoordinatorSpawnDefaults('/usr/local/bin/claude', []);
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_task_created',
      expect.objectContaining({ agentCommand: '/usr/local/bin/claude' }),
    );
  });

  it('includes agentArgs in MCP_TaskCreated payload (without --dangerously-skip-permissions)', async () => {
    coordinator.setCoordinatorSpawnDefaults('claude', ['--model', 'claude-opus-4-7']);
    await coordinator.createTask({
      name: 'test',
      prompt: 'do',
      coordinatorTaskId: 'coord-1',
      skipPermissions: true,
    });
    const payload = mockNotifyRenderer.mock.calls.find((c) => c[0] === 'mcp_task_created')?.[1] as {
      agentArgs: string[];
    };
    expect(payload.agentArgs).toContain('--model');
    expect(payload.agentArgs).toContain('claude-opus-4-7');
    expect(payload.agentArgs).not.toContain('--dangerously-skip-permissions');
  });

  it('includes skipPermissions true in MCP_TaskCreated payload', async () => {
    await coordinator.createTask({
      name: 'test',
      prompt: 'do',
      coordinatorTaskId: 'coord-1',
      skipPermissions: true,
    });
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_task_created',
      expect.objectContaining({ skipPermissions: true }),
    );
  });

  it('includes skipPermissions false when not set', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_task_created',
      expect.objectContaining({ skipPermissions: false }),
    );
  });
});

// ─── MCP config restart rewrite tests ────────────────────────────────────────

describe('Coordinator MCP config restart rewrite', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('rewrites MCP config for existing task when server info changes (restart)', async () => {
    coordinator.setMCPServerInfo('http://localhost:3001', 'old-token', '/path/to/server.js');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const task = coordinator.getTask('task-1');
    expect(task?.mcpConfigPath).toBeDefined();

    const initialWrite = mockWriteFileSync.mock.calls.find((c) =>
      (c[0] as string).includes('parallel-code-subtask-'),
    );
    expect(initialWrite).toBeDefined();
    if (!initialWrite) throw new Error('expected initial config write');
    const initialConfig = JSON.parse(initialWrite[1] as string) as {
      mcpServers: { 'parallel-code': { args: string[] } };
    };
    expect(initialConfig.mcpServers['parallel-code'].args).toContain('old-token');
    expect(initialConfig.mcpServers['parallel-code'].args).toContain('http://localhost:3001');

    // Simulate coordinator restart with new port/token
    mockWriteFileSync.mockClear();
    coordinator.setMCPServerInfo('http://localhost:3002', 'new-token', '/path/to/server.js');

    const rewriteCall = mockWriteFileSync.mock.calls.find((c) =>
      (c[0] as string).includes('parallel-code-subtask-'),
    );
    expect(rewriteCall).toBeDefined();
    if (!rewriteCall) throw new Error('expected rewrite call');
    // Path must be the same file the task already references
    expect(rewriteCall[0]).toBe(task?.mcpConfigPath);

    // Rewritten config is valid JSON with updated URL and token, preserving the task id
    const newConfig = JSON.parse(rewriteCall[1] as string) as {
      mcpServers: { 'parallel-code': { args: string[] } };
    };
    const newArgs = newConfig.mcpServers['parallel-code'].args;
    expect(newArgs).toContain('new-token');
    expect(newArgs).toContain('http://localhost:3002');
    expect(newArgs).toContain('task-1');
    // Old values must be gone
    expect(newArgs).not.toContain('old-token');
    expect(newArgs).not.toContain('http://localhost:3001');
  });

  it('does not write config files when no tasks exist on setMCPServerInfo', () => {
    coordinator.setMCPServerInfo('http://localhost:3001', 'old-token', '/path/to/server.js');
    mockWriteFileSync.mockClear();
    coordinator.setMCPServerInfo('http://localhost:3002', 'new-token', '/path/to/server.js');

    const configWrites = mockWriteFileSync.mock.calls.filter((c) =>
      (c[0] as string).includes('parallel-code-subtask-'),
    );
    expect(configWrites).toHaveLength(0);
  });

  it('rewrites configs for all existing tasks on restart', async () => {
    mockCreateBackendTask
      .mockResolvedValueOnce({ id: 'task-1', branch_name: 'task/a', worktree_path: '/tmp/a' })
      .mockResolvedValueOnce({ id: 'task-2', branch_name: 'task/b', worktree_path: '/tmp/b' });

    coordinator.setMCPServerInfo('http://localhost:3001', 'old-token', '/path/to/server.js');
    await coordinator.createTask({ name: 'task-a', prompt: 'do', coordinatorTaskId: 'coord-1' });
    await coordinator.createTask({ name: 'task-b', prompt: 'do', coordinatorTaskId: 'coord-1' });

    mockWriteFileSync.mockClear();
    coordinator.setMCPServerInfo('http://localhost:3002', 'new-token', '/path/to/server.js');

    const rewrites = mockWriteFileSync.mock.calls.filter((c) =>
      (c[0] as string).includes('parallel-code-subtask-'),
    );
    expect(rewrites).toHaveLength(2);

    for (const rewrite of rewrites) {
      const cfg = JSON.parse(rewrite[1] as string) as {
        mcpServers: { 'parallel-code': { args: string[] } };
      };
      expect(cfg.mcpServers['parallel-code'].args).toContain('new-token');
      expect(cfg.mcpServers['parallel-code'].args).toContain('http://localhost:3002');
    }
  });

  it('does not rewrite config for tasks that have no mcpConfigPath (spawned without MCP info)', async () => {
    // No setMCPServerInfo before createTask — task gets no mcpConfigPath
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(coordinator.getTask('task-1')?.mcpConfigPath).toBeUndefined();

    mockWriteFileSync.mockClear();
    coordinator.setMCPServerInfo('http://localhost:3002', 'new-token', '/path/to/server.js');

    const configWrites = mockWriteFileSync.mock.calls.filter((c) =>
      (c[0] as string).includes('parallel-code-subtask-'),
    );
    expect(configWrites).toHaveLength(0);
  });
});

// ─── preload allowlist regression test ───────────────────────────────────────

describe('preload.cjs MCP channel allowlist', () => {
  it('contains all MCP coordinator IPC channels', async () => {
    const { readFileSync } = await vi.importActual<typeof import('fs')>('fs');
    const path = await import('node:path');
    const preloadPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      '..',
      'preload.cjs',
    );
    const preload = readFileSync(preloadPath, 'utf8') as string;

    const required = [
      'mcp_task_created',
      'mcp_task_closed',
      'mcp_task_state_sync',
      'mcp_control_changed',
      'mcp_coordinator_notification_staged',
      'mcp_coordinator_orphaned_notification',
      'mcp_coordinator_registered',
      'mcp_coordinator_deregistered',
      'mcp_coordinator_notification_ack',
      'mcp_coordinated_task_prompt_delivered',
    ];

    for (const channel of required) {
      expect(preload, `preload.cjs missing channel: ${channel}`).toContain(`'${channel}'`);
    }
  });
});
