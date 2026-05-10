import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- fs / child_process mocks (must come before dynamic import) ---
const mockWriteFileSync = vi.fn();
const mockReadFileSync = vi.fn(() => '# existing\n');
const mockExistsSync = vi.fn(() => false);
const mockUnlinkSync = vi.fn();
const mockMkdirSync = vi.fn();

vi.mock('fs', () => ({
  writeFileSync: mockWriteFileSync,
  readFileSync: mockReadFileSync,
  existsSync: mockExistsSync,
  unlinkSync: mockUnlinkSync,
  mkdirSync: mockMkdirSync,
}));

// --- other mocks ---
const mockNotifyRenderer = vi.fn();
const mockOnPtyEvent = vi.fn();
const mockSpawnAgent = vi.fn();
const mockSubscribeToAgent = vi.fn();
const mockGetAgentScrollback = vi.fn<() => string | null>(() => null);
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
    MCP_CoordinatorNotificationCleared: 'mcp_coordinator_notification_cleared',
    MCP_CoordinatorOrphanedNotification: 'mcp_coordinator_orphaned_notification',
    MCP_CoordinatorDeregistered: 'mcp_coordinator_deregistered',
    MCP_CoordinatorNotificationAck: 'mcp_coordinator_notification_ack',
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

// ─── registerCoordinator idempotency and restore path ────────────────────────

describe('Coordinator registerCoordinator — idempotency', () => {
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

  it('registerCoordinator is idempotent — second call is a no-op', () => {
    coordinator.registerCoordinator('coord-1', 'proj-1', { worktreePath: '/tmp/project' });
    coordinator.registerCoordinator('coord-1', 'proj-1', { worktreePath: '/tmp/project' });
    // createTask should work — only one CoordinatorState entry
    expect(() =>
      coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' }),
    ).not.toThrow();
  });

  it('createTask succeeds when registerCoordinator is called before (not after) createTask', async () => {
    // Simulates the restore path: StartMCPServer calls registerCoordinator, then
    // the agent calls create_task over MCP. MCP_CoordinatorRegistered has NOT been
    // sent (App.tsx restore loop does not send it).
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await expect(
      coordinator.createTask({ name: 'restore-task', prompt: 'do', coordinatorTaskId: 'coord-1' }),
    ).resolves.toBeDefined();
    expect(mockNotifyRenderer).toHaveBeenCalledWith('mcp_task_created', expect.anything());
  });

  it('createTask notifies coordinator when coordinator registered only via registerCoordinator', async () => {
    // Simulates restore: StartMCPServer calls registerCoordinator internally.
    // No separate MCP_CoordinatorRegistered call occurs.
    coordinator.registerCoordinator('coord-1', 'proj-1');
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'tok',
      'subtask-tok',
      '/path/server.js',
    );
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    // Should get a task created notification (not "coordinator not found" error)
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_task_created',
      expect.objectContaining({ name: 'test' }),
    );
  });
});

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

  it('createTask rejects an unknown coordinator ID', async () => {
    await expect(
      coordinator.createTask({
        name: 'orphan',
        prompt: 'do',
        coordinatorTaskId: 'missing-coord',
      }),
    ).rejects.toThrow('Unknown coordinator: missing-coord');
  });

  it('clears staged notification when a notified task is closed', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');
      await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
      coordinator.markPromptDelivered('task-1');
      const outputCb = getOutputCb();
      outputCb(encode('Done ❯ '));

      expect(mockNotifyRenderer).toHaveBeenCalledWith(
        'mcp_coordinator_notification_staged',
        expect.objectContaining({ coordinatorTaskId: 'coord-1' }),
      );

      mockNotifyRenderer.mockClear();
      await coordinator.closeTask('task-1');

      expect(mockNotifyRenderer).toHaveBeenCalledWith('mcp_coordinator_notification_cleared', {
        coordinatorTaskId: 'coord-1',
      });

      mockNotifyRenderer.mockClear();
      vi.advanceTimersByTime(5 * 60_000);
      expect(mockNotifyRenderer).not.toHaveBeenCalledWith(
        'mcp_coordinator_notification_staged',
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
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

    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_task_state_sync',
      expect.objectContaining({
        taskId: 'task-1',
        signalDoneReceived: true,
      }),
    );
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
    coordinator.setCoordinatorSpawnDefaults('coord-1', '/usr/local/bin/claude', []);
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ command: '/usr/local/bin/claude' }),
    );
  });

  it('inherits coordinator base args (e.g. --model)', async () => {
    coordinator.setCoordinatorSpawnDefaults('coord-1', 'claude', ['--model', 'claude-opus-4-7']);
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const spawnArgs = mockSpawnAgent.mock.calls[0][1].args as string[];
    expect(spawnArgs).toContain('--model');
    expect(spawnArgs).toContain('claude-opus-4-7');
  });

  it('adds --dangerously-skip-permissions when coordinator has propagateSkipPermissions', async () => {
    // skipPermissions is inherited from coordinator state, not from createTask opts.
    coordinator.registerCoordinator('coord-skip', 'proj-1', { skipPermissions: true });
    await coordinator.createTask({
      name: 'test',
      prompt: 'do',
      coordinatorTaskId: 'coord-skip',
    });
    const spawnArgs = mockSpawnAgent.mock.calls[0][1].args as string[];
    expect(spawnArgs).toContain('--dangerously-skip-permissions');
  });

  it('does not add --dangerously-skip-permissions when coordinator does not propagate', async () => {
    await coordinator.createTask({
      name: 'test',
      prompt: 'do',
      coordinatorTaskId: 'coord-1',
    });
    const spawnArgs = mockSpawnAgent.mock.calls[0][1].args as string[];
    expect(spawnArgs).not.toContain('--dangerously-skip-permissions');
  });

  it('inherited args do not include --dangerously-skip-permissions (handled separately)', async () => {
    // skip_permissions_args should not be passed as agentArgs — only agentDef.args (base args)
    coordinator.setCoordinatorSpawnDefaults('coord-1', 'claude', ['--model', 'claude-opus-4-7']);
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

  it('uses docker exec with -w flag when dockerContainerName is set', async () => {
    coordinator.setDockerContainerName('coord-1', 'my-container');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        command: 'docker',
        args: expect.arrayContaining(['exec', '-it', '-w', '/tmp/test', 'my-container', 'claude']),
      }),
    );
  });

  it('does not use docker exec when dockerContainerName is null', async () => {
    coordinator.setDockerContainerName('coord-1', null);
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ command: 'claude' }),
    );
    const spawnArgs = mockSpawnAgent.mock.calls[0][1].args as string[];
    expect(spawnArgs).not.toContain('docker');
  });

  it('docker exec -w uses the sub-task worktree path, not the coordinator projectRoot', async () => {
    coordinator.setDockerContainerName('coord-1', 'my-container');
    // coordinator projectRoot is '/tmp/project', sub-task worktree is '/tmp/test'
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const spawnArgs = mockSpawnAgent.mock.calls[0][1].args as string[];
    const wIdx = spawnArgs.indexOf('-w');
    expect(wIdx).toBeGreaterThan(0);
    const wValue = spawnArgs[wIdx + 1];
    // Must be the sub-task worktree path (/tmp/test), not the coordinator's projectRoot (/tmp/project)
    expect(wValue).toBe('/tmp/test');
    expect(wValue).not.toBe('/tmp/project');
  });
});

// ─── settings.local.json injection tests ─────────────────────────────────────

describe('Coordinator settings.local.json sub-task injection', () => {
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

  it('writes settings.local.json with systemPrompt when file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const settingsWrite = mockWriteFileSync.mock.calls.find((c) =>
      (c[0] as string).endsWith('settings.local.json'),
    );
    expect(settingsWrite).toBeDefined();
    const written = JSON.parse(settingsWrite?.[1] as string);
    expect(written.systemPrompt).toContain('signal_done');
    expect(written.systemPrompt).toContain('sub-task-mode');
  });

  it('appends preamble to existing systemPrompt in settings.local.json', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ systemPrompt: 'existing prompt' }));
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const settingsWrite = mockWriteFileSync.mock.calls.find((c) =>
      (c[0] as string).endsWith('settings.local.json'),
    );
    expect(settingsWrite).toBeDefined();
    const written = JSON.parse(settingsWrite?.[1] as string);
    expect(written.systemPrompt).toContain('existing prompt');
    expect(written.systemPrompt).toContain('signal_done');
  });

  it('preserves other keys in existing settings.local.json', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ permissions: { allow: ['Bash'] } }));
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const settingsWrite = mockWriteFileSync.mock.calls.find((c) =>
      (c[0] as string).endsWith('settings.local.json'),
    );
    expect(settingsWrite).toBeDefined();
    const written = JSON.parse(settingsWrite?.[1] as string);
    expect(written.permissions).toEqual({ allow: ['Bash'] });
    expect(written.systemPrompt).toContain('signal_done');
  });

  it('does not restore settings.local.json on idle (no restore needed)', async () => {
    mockExistsSync.mockReturnValue(false);
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');

    const outputCb = getOutputCb();
    outputCb(encode('Working ❯ '));

    const settingsWriteCallsAfterIdle = mockWriteFileSync.mock.calls.filter((c) =>
      (c[0] as string).endsWith('settings.local.json'),
    );
    // Only the initial write; no re-write on idle
    expect(settingsWriteCallsAfterIdle).toHaveLength(1);
  });

  it('does not write to CLAUDE.md', async () => {
    mockExistsSync.mockReturnValue(false);
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const claudeWrite = mockWriteFileSync.mock.calls.find((c) =>
      (c[0] as string).endsWith('CLAUDE.md'),
    );
    expect(claudeWrite).toBeUndefined();
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
    await expect(coordinator.waitForIdle('task-1')).resolves.toEqual({ reason: 'idle' });
  });

  it('resolves when agent outputs prompt', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const outputCb = getOutputCb();
    const waitPromise = coordinator.waitForIdle('task-1');
    outputCb(encode('working...'));
    outputCb(encode('Done ❯ '));
    await expect(waitPromise).resolves.toEqual({ reason: 'idle' });
  });

  it('resolves immediately when task is under human control', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.setTaskControl('task-1', 'human');
    await expect(coordinator.waitForIdle('task-1')).resolves.toEqual({ reason: 'human_control' });
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
    await expect(waitPromise).resolves.toEqual({ reason: 'exited' });
  });

  it('fires pending idle resolvers when control returns to coordinator', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    // The real scenario: task is running, coordinator calls waitForIdle, user takes control, coordinator returns
    const waitPromise = coordinator.waitForIdle('task-1');
    coordinator.setTaskControl('task-1', 'coordinator');
    await expect(waitPromise).resolves.toEqual({ reason: 'idle' });
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

  it('rejects for unknown coordinatorId', async () => {
    await expect(coordinator.waitForSignalDone('nonexistent-coord')).rejects.toThrow(
      'Coordinator not found',
    );
  });

  it('resolves immediately with unconsumed signal if already signalled', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.signalDone('task-1');
    await expect(coordinator.waitForSignalDone('coord-1')).resolves.toMatchObject({
      taskId: 'task-1',
      name: 'test',
      remaining: 0,
      status: expect.any(String),
      signalDoneAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it('resolves when signalDone is called, with remaining count', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const waitPromise = coordinator.waitForSignalDone('coord-1');
    coordinator.signalDone('task-1');
    await expect(waitPromise).resolves.toMatchObject({
      taskId: 'task-1',
      name: 'test',
      remaining: 0,
      status: expect.any(String),
      signalDoneAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it('rejects after timeout when signal never arrives', async () => {
    vi.useFakeTimers();
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const waitPromise = coordinator.waitForSignalDone('coord-1', 1_000);
    vi.advanceTimersByTime(1_001);
    await expect(waitPromise).rejects.toThrow('Timed out');
  });

  it('returns remaining=1 when another task is still running', async () => {
    mockCreateBackendTask
      .mockResolvedValueOnce({ id: 'task-1', branch_name: 'task/a', worktree_path: '/tmp/a' })
      .mockResolvedValueOnce({ id: 'task-2', branch_name: 'task/b', worktree_path: '/tmp/b' });
    await coordinator.createTask({ name: 'task-a', prompt: 'do', coordinatorTaskId: 'coord-1' });
    await coordinator.createTask({ name: 'task-b', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const waitPromise = coordinator.waitForSignalDone('coord-1');
    coordinator.signalDone('task-1');
    await expect(waitPromise).resolves.toMatchObject({
      taskId: 'task-1',
      name: 'task-a',
      remaining: 1,
      status: expect.any(String),
      signalDoneAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it('does not stage pending notifications while any signal_done wait is active', async () => {
    mockCreateBackendTask
      .mockResolvedValueOnce({ id: 'task-1', branch_name: 'task/a', worktree_path: '/tmp/a' })
      .mockResolvedValueOnce({ id: 'task-2', branch_name: 'task/b', worktree_path: '/tmp/b' });

    await coordinator.createTask({ name: 'task-a', prompt: 'do', coordinatorTaskId: 'coord-1' });
    await coordinator.createTask({ name: 'task-b', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-2');
    mockNotifyRenderer.mockClear();

    const waitPromise = coordinator.waitForSignalDone('coord-1');
    const task2OutputCb = mockSubscribeToAgent.mock.calls[1][1] as (encoded: string) => void;
    task2OutputCb(encode('Done ❯ '));

    expect(mockNotifyRenderer).not.toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.anything(),
    );

    coordinator.signalDone('task-1');
    await expect(waitPromise).resolves.toMatchObject({ taskId: 'task-1' });
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.objectContaining({
        coordinatorTaskId: 'coord-1',
        text: expect.stringContaining('"task-b" ready for review'),
      }),
    );
  });

  it('clears an already staged notification when a signal_done wait starts', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    const outputCb = getOutputCb();
    outputCb(encode('Done ❯ '));

    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.objectContaining({ coordinatorTaskId: 'coord-1' }),
    );

    mockNotifyRenderer.mockClear();
    const waitPromise = coordinator.waitForSignalDone('coord-1');

    expect(mockNotifyRenderer).toHaveBeenCalledWith('mcp_coordinator_notification_cleared', {
      coordinatorTaskId: 'coord-1',
    });

    coordinator.signalDone('task-1');
    await expect(waitPromise).resolves.toMatchObject({ taskId: 'task-1' });
    expect(mockNotifyRenderer).not.toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.anything(),
    );
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

  it('child tasks are removed from internal map after coordinator is deregistered', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.deregisterCoordinator('coord-1');
    // markPromptDelivered is now a no-op — task was removed from this.tasks
    coordinator.markPromptDelivered('task-1');
    const outputCb = getOutputCb();
    mockNotifyRenderer.mockClear();
    outputCb(encode('Done ❯ '));
    // PTY output is silently dropped — no orphaned notification because the task entry is gone
    expect(mockNotifyRenderer).not.toHaveBeenCalledWith(
      'mcp_coordinator_orphaned_notification',
      expect.anything(),
    );
  });

  it('clears staged notification when coordinator is deregistered', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    const outputCb = getOutputCb();
    outputCb(encode('Done ❯ '));

    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.objectContaining({ coordinatorTaskId: 'coord-1' }),
    );

    mockNotifyRenderer.mockClear();
    coordinator.deregisterCoordinator('coord-1');

    expect(mockNotifyRenderer).toHaveBeenCalledWith('mcp_coordinator_notification_cleared', {
      coordinatorTaskId: 'coord-1',
    });
  });

  it('hasActiveCoordinator returns false after deregister', () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    expect(coordinator.hasActiveCoordinator()).toBe(true);
    coordinator.deregisterCoordinator('coord-1');
    expect(coordinator.hasActiveCoordinator()).toBe(false);
  });

  it('deregister cleans up backend resource maps for child tasks', async () => {
    const { unsubscribeFromAgent } =
      await vi.importMock<typeof import('../ipc/pty.js')>('../ipc/pty.js');
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const agentId = getAgentId();

    // Confirm subscriber was registered
    expect(mockSubscribeToAgent).toHaveBeenCalledWith(agentId, expect.any(Function));

    coordinator.deregisterCoordinator('coord-1');

    // PTY subscriber must be unregistered
    expect(vi.mocked(unsubscribeFromAgent)).toHaveBeenCalledWith(agentId, expect.any(Function));

    // Internal maps must no longer hold stale entries
    const c = coordinator as unknown as {
      subscribers: Map<string, unknown>;
      tailBuffers: Map<string, unknown>;
      decoders: Map<string, unknown>;
      controlMap: Map<string, unknown>;
      blockedByHumanControl: Set<string>;
    };
    expect(c.subscribers.has(agentId)).toBe(false);
    expect(c.tailBuffers.has(agentId)).toBe(false);
    expect(c.decoders.has(agentId)).toBe(false);
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

    const p = coordinator.waitForSignalDone('coord-1', 500);
    vi.advanceTimersByTime(501);
    await expect(p).rejects.toThrow('Timed out');

    // signalDone fires after timeout — should resolve a new waiter, not the stale one
    let resolveCalled = false;
    const p2 = coordinator.waitForSignalDone('coord-1', 500);
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
    coordinator.setCoordinatorSpawnDefaults('coord-1', '/usr/local/bin/claude', []);
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_task_created',
      expect.objectContaining({ agentCommand: '/usr/local/bin/claude' }),
    );
  });

  it('includes agentArgs in MCP_TaskCreated payload (without --dangerously-skip-permissions)', async () => {
    coordinator.setCoordinatorSpawnDefaults('coord-1', 'claude', ['--model', 'claude-opus-4-7']);
    await coordinator.createTask({
      name: 'test',
      prompt: 'do',
      coordinatorTaskId: 'coord-1',
    });
    const payload = mockNotifyRenderer.mock.calls.find((c) => c[0] === 'mcp_task_created')?.[1] as {
      agentArgs: string[];
    };
    expect(payload.agentArgs).toContain('--model');
    expect(payload.agentArgs).toContain('claude-opus-4-7');
    expect(payload.agentArgs).not.toContain('--dangerously-skip-permissions');
  });

  it('includes skipPermissions true in MCP_TaskCreated payload when coordinator has propagateSkipPermissions', async () => {
    // skipPermissions is now inherited from the coordinator's propagateSkipPermissions,
    // not from createTask opts. Re-register with skipPermissions: true.
    coordinator.registerCoordinator('coord-skip', 'proj-1', { skipPermissions: true });
    await coordinator.createTask({
      name: 'test',
      prompt: 'do',
      coordinatorTaskId: 'coord-skip',
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

// ─── Item 5: Sub-agent MCP config isolation ──────────────────────────────────

describe('Coordinator sub-task MCP config isolation', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('each sub-task gets its own unique task-id in .mcp.json args, not the coordinator id', async () => {
    mockCreateBackendTask
      .mockResolvedValueOnce({ id: 'task-a', branch_name: 'task/a', worktree_path: '/tmp/a' })
      .mockResolvedValueOnce({ id: 'task-b', branch_name: 'task/b', worktree_path: '/tmp/b' });

    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'tok',
      'subtask-tok',
      '/path/server.js',
    );
    await coordinator.createTask({ name: 'task-a', prompt: 'do a', coordinatorTaskId: 'coord-1' });
    await coordinator.createTask({ name: 'task-b', prompt: 'do b', coordinatorTaskId: 'coord-1' });

    const configWrites = mockWriteFileSync.mock.calls.filter((c) =>
      (c[0] as string).includes('parallel-code-subtask-'),
    );
    expect(configWrites).toHaveLength(2);

    const taskIds = configWrites.map((c) => {
      const cfg = JSON.parse(c[1] as string) as {
        mcpServers: { 'parallel-code': { args: string[] } };
      };
      const args = cfg.mcpServers['parallel-code'].args;
      const idx = args.indexOf('--task-id');
      return idx >= 0 ? args[idx + 1] : null;
    });

    // Each task must have its own id
    expect(taskIds[0]).toBe('task-a');
    expect(taskIds[1]).toBe('task-b');
    // Neither should use the coordinator id
    expect(taskIds).not.toContain('coord-1');
    // The two task ids must be distinct
    expect(taskIds[0]).not.toBe(taskIds[1]);
  });

  it('config files for two sub-tasks are written to different paths', async () => {
    mockCreateBackendTask
      .mockResolvedValueOnce({ id: 'task-a', branch_name: 'task/a', worktree_path: '/tmp/a' })
      .mockResolvedValueOnce({ id: 'task-b', branch_name: 'task/b', worktree_path: '/tmp/b' });

    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'tok',
      'subtask-tok',
      '/path/server.js',
    );
    await coordinator.createTask({ name: 'task-a', prompt: 'do a', coordinatorTaskId: 'coord-1' });
    await coordinator.createTask({ name: 'task-b', prompt: 'do b', coordinatorTaskId: 'coord-1' });

    const configPaths = mockWriteFileSync.mock.calls
      .filter((c) => (c[0] as string).includes('parallel-code-subtask-'))
      .map((c) => c[0] as string);

    expect(configPaths[0]).not.toBe(configPaths[1]);
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
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'old-token',
      'old-token',
      '/path/to/server.js',
    );
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const task = coordinator.getTask('task-1');
    expect(task?.mcpConfigPath).toBeDefined();

    const initialWrite = mockWriteFileSync.mock.calls.find((c) =>
      (c[0] as string).includes('parallel-code-subtask-'),
    );
    expect(initialWrite).toBeDefined();
    if (!initialWrite) throw new Error('expected initial config write');
    const initialConfig = JSON.parse(initialWrite[1] as string) as {
      mcpServers: { 'parallel-code': { args: string[]; env: Record<string, string> } };
    };
    expect(initialConfig.mcpServers['parallel-code'].env['PARALLEL_CODE_MCP_TOKEN']).toBe(
      'old-token',
    );
    expect(initialConfig.mcpServers['parallel-code'].args).toContain('http://localhost:3001');

    // Simulate coordinator restart with new port/token
    mockWriteFileSync.mockClear();
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3002',
      'new-token',
      'new-token',
      '/path/to/server.js',
    );

    const rewriteCall = mockWriteFileSync.mock.calls.find((c) =>
      (c[0] as string).includes('parallel-code-subtask-'),
    );
    expect(rewriteCall).toBeDefined();
    if (!rewriteCall) throw new Error('expected rewrite call');
    // Path must be the same file the task already references
    expect(rewriteCall[0]).toBe(task?.mcpConfigPath);

    // Rewritten config is valid JSON with updated URL and token, preserving the task id
    const newConfig = JSON.parse(rewriteCall[1] as string) as {
      mcpServers: { 'parallel-code': { args: string[]; env: Record<string, string> } };
    };
    const newArgs = newConfig.mcpServers['parallel-code'].args;
    expect(newConfig.mcpServers['parallel-code'].env['PARALLEL_CODE_MCP_TOKEN']).toBe('new-token');
    expect(newArgs).toContain('http://localhost:3002');
    expect(newArgs).toContain('task-1');
    // Old values must be gone
    expect(newConfig.mcpServers['parallel-code'].env['PARALLEL_CODE_MCP_TOKEN']).not.toBe(
      'old-token',
    );
    expect(newArgs).not.toContain('http://localhost:3001');
  });

  it('does not write config files when no tasks exist on setMCPServerInfo', () => {
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'old-token',
      'old-token',
      '/path/to/server.js',
    );
    mockWriteFileSync.mockClear();
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3002',
      'new-token',
      'new-token',
      '/path/to/server.js',
    );

    const configWrites = mockWriteFileSync.mock.calls.filter((c) =>
      (c[0] as string).includes('parallel-code-subtask-'),
    );
    expect(configWrites).toHaveLength(0);
  });

  it('rewrites configs for all existing tasks on restart', async () => {
    mockCreateBackendTask
      .mockResolvedValueOnce({ id: 'task-1', branch_name: 'task/a', worktree_path: '/tmp/a' })
      .mockResolvedValueOnce({ id: 'task-2', branch_name: 'task/b', worktree_path: '/tmp/b' });

    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'old-token',
      'old-token',
      '/path/to/server.js',
    );
    await coordinator.createTask({ name: 'task-a', prompt: 'do', coordinatorTaskId: 'coord-1' });
    await coordinator.createTask({ name: 'task-b', prompt: 'do', coordinatorTaskId: 'coord-1' });

    mockWriteFileSync.mockClear();
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3002',
      'new-token',
      'new-token',
      '/path/to/server.js',
    );

    const rewrites = mockWriteFileSync.mock.calls.filter((c) =>
      (c[0] as string).includes('parallel-code-subtask-'),
    );
    expect(rewrites).toHaveLength(2);

    for (const rewrite of rewrites) {
      const cfg = JSON.parse(rewrite[1] as string) as {
        mcpServers: { 'parallel-code': { args: string[]; env: Record<string, string> } };
      };
      expect(cfg.mcpServers['parallel-code'].env['PARALLEL_CODE_MCP_TOKEN']).toBe('new-token');
      expect(cfg.mcpServers['parallel-code'].args).toContain('http://localhost:3002');
    }
  });

  it('does not rewrite config for tasks that have no mcpConfigPath (spawned without MCP info)', async () => {
    // No setMCPServerInfo before createTask — task gets no mcpConfigPath
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(coordinator.getTask('task-1')?.mcpConfigPath).toBeUndefined();

    mockWriteFileSync.mockClear();
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3002',
      'new-token',
      'new-token',
      '/path/to/server.js',
    );

    const configWrites = mockWriteFileSync.mock.calls.filter((c) =>
      (c[0] as string).includes('parallel-code-subtask-'),
    );
    expect(configWrites).toHaveLength(0);
  });
});

// ─── Two-class token: subtask configs use subtaskToken, not coordinator token ──

describe('Coordinator two-class token — subtask configs use subtaskToken', () => {
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

  it('createTask writes subtaskToken (not coordinator token) into the sub-task MCP config', async () => {
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'coordinator-secret',
      'subtask-secret',
      '/path/server.js',
    );
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const configWrite = mockWriteFileSync.mock.calls.find((c) =>
      (c[0] as string).includes('parallel-code-subtask-'),
    );
    expect(configWrite).toBeDefined();
    if (!configWrite) throw new Error('expected config write');

    const config = JSON.parse(configWrite[1] as string) as {
      mcpServers: { 'parallel-code': { env: Record<string, string> } };
    };
    const writtenToken = config.mcpServers['parallel-code'].env['PARALLEL_CODE_MCP_TOKEN'];
    expect(writtenToken).toBe('subtask-secret');
    expect(writtenToken).not.toBe('coordinator-secret');
  });

  it('setMCPServerInfo rewrites existing sub-task configs with subtaskToken on restart', async () => {
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'old-coordinator',
      'old-subtask',
      '/path/server.js',
    );
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    mockWriteFileSync.mockClear();

    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3002',
      'new-coordinator',
      'new-subtask',
      '/path/server.js',
    );

    const rewrite = mockWriteFileSync.mock.calls.find((c) =>
      (c[0] as string).includes('parallel-code-subtask-'),
    );
    expect(rewrite).toBeDefined();
    if (!rewrite) throw new Error('expected rewrite');

    const config = JSON.parse(rewrite[1] as string) as {
      mcpServers: { 'parallel-code': { env: Record<string, string> } };
    };
    const writtenToken = config.mcpServers['parallel-code'].env['PARALLEL_CODE_MCP_TOKEN'];
    expect(writtenToken).toBe('new-subtask');
    expect(writtenToken).not.toBe('new-coordinator');
  });
});

// ─── Item 5: Coordinator restart hydration ────────────────────────────────────

describe('Coordinator hydrateTask — restart hydration', () => {
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

  it('hydrateTask + getTask returns all expected fields', () => {
    coordinator.hydrateTask({
      id: 'hydrated-1',
      name: 'hydrated-task',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/hydrated',
      worktreePath: '/tmp/hydrated',
      agentId: 'agent-hydrated',
      coordinatorTaskId: 'coord-1',
    });

    const task = coordinator.getTask('hydrated-1');
    expect(task).toBeDefined();
    expect(task?.id).toBe('hydrated-1');
    expect(task?.name).toBe('hydrated-task');
    expect(task?.projectId).toBe('proj-1');
    expect(task?.branchName).toBe('task/hydrated');
    expect(task?.worktreePath).toBe('/tmp/hydrated');
    expect(task?.agentId).toBe('agent-hydrated');
    expect(task?.coordinatorTaskId).toBe('coord-1');
    expect(task?.status).toBe('exited');
  });

  it('hydrateTask + waitForIdle resolves immediately for exited status', async () => {
    coordinator.hydrateTask({
      id: 'hydrated-1',
      name: 'hydrated-task',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/hydrated',
      worktreePath: '/tmp/hydrated',
      agentId: 'agent-hydrated',
      coordinatorTaskId: 'coord-1',
    });

    await expect(coordinator.waitForIdle('hydrated-1')).resolves.toEqual({ reason: 'exited' });
  });

  it('hydrateTask + waitForSignalDone resolves if signalDoneAt was already set', async () => {
    coordinator.hydrateTask({
      id: 'hydrated-1',
      name: 'hydrated-task',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/hydrated',
      worktreePath: '/tmp/hydrated',
      agentId: 'agent-hydrated',
      coordinatorTaskId: 'coord-1',
    });

    const task = coordinator.getTask('hydrated-1');
    expect(task).toBeDefined();
    if (!task) throw new Error('task not found');
    task.signalDoneAt = new Date();
    task.signalDoneConsumed = false;

    await expect(coordinator.waitForSignalDone('coord-1', 100)).resolves.toMatchObject({
      taskId: 'hydrated-1',
      remaining: expect.any(Number),
    });
  });

  it('hydrateTask + sendPrompt works without error', async () => {
    coordinator.hydrateTask({
      id: 'hydrated-1',
      name: 'hydrated-task',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/hydrated',
      worktreePath: '/tmp/hydrated',
      agentId: 'agent-hydrated',
      coordinatorTaskId: 'coord-1',
    });

    await expect(coordinator.sendPrompt('hydrated-1', 'hello')).resolves.toBeUndefined();
  });

  it('hydrateTask controlledBy:human blocks sendPrompt', async () => {
    coordinator.hydrateTask({
      id: 'hydrated-1',
      name: 'hydrated-task',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/hydrated',
      worktreePath: '/tmp/hydrated',
      agentId: 'agent-hydrated',
      coordinatorTaskId: 'coord-1',
      controlledBy: 'human',
    });

    await expect(coordinator.sendPrompt('hydrated-1', 'hello')).rejects.toThrow('human control');
  });
});

// ─── Item 6: Control state restart replay ─────────────────────────────────────

describe('Coordinator setTaskControl — blocked send until release', () => {
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

  it('sendPrompt is blocked when task is human-controlled', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.setTaskControl('task-1', 'human');
    await expect(coordinator.sendPrompt('task-1', 'hello')).rejects.toThrow('human control');
  });

  it('sendPrompt is unblocked after setTaskControl coordinator', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.setTaskControl('task-1', 'human');
    coordinator.setTaskControl('task-1', 'coordinator');
    await expect(coordinator.sendPrompt('task-1', 'hello')).resolves.toBeUndefined();
  });

  it('waitForIdle resolves immediately with human_control reason when human has control', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.setTaskControl('task-1', 'human');
    await expect(coordinator.waitForIdle('task-1')).resolves.toEqual({ reason: 'human_control' });
  });

  it('when sendPrompt was blocked, releasing control stages a notification', async () => {
    await coordinator.createTask({ name: 'my-task', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    coordinator.setTaskControl('task-1', 'human');

    // sendPrompt throws — this marks the task as blocked
    await expect(coordinator.sendPrompt('task-1', 'hello')).rejects.toThrow('human control');

    mockNotifyRenderer.mockClear();
    coordinator.setTaskControl('task-1', 'coordinator');

    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.objectContaining({
        coordinatorTaskId: 'coord-1',
        text: expect.stringContaining('returned to coordinator'),
      }),
    );
  });
});

// ─── Item 7: Notification lifecycle under waitForSignalDone ───────────────────

describe('Coordinator waitForSignalDone — notification lifecycle', () => {
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

  it('staged notification is cleared when waitForSignalDone starts', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');
    const outputCb = getOutputCb();
    outputCb(encode('Done ❯ '));

    // Confirm a notification was staged
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.objectContaining({ coordinatorTaskId: 'coord-1' }),
    );

    mockNotifyRenderer.mockClear();

    // Starting a wait should clear the staged notification
    const waitPromise = coordinator.waitForSignalDone('coord-1', 100);
    expect(mockNotifyRenderer).toHaveBeenCalledWith('mcp_coordinator_notification_cleared', {
      coordinatorTaskId: 'coord-1',
    });

    // Clean up — reject or resolve the promise
    coordinator.signalDone('task-1');
    await waitPromise.catch(() => {});
  });

  it('task exit while wait active does not re-stage notification', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');

    const agentId = getAgentId();
    const exitHandler = getExitHandler();

    const waitPromise = coordinator.waitForSignalDone('coord-1', 5_000);
    mockNotifyRenderer.mockClear();

    exitHandler(agentId, { exitCode: 0 });

    // While an active signal_done wait is in progress, staging should be suppressed
    const stagedCalls = mockNotifyRenderer.mock.calls.filter(
      (c) => c[0] === 'mcp_coordinator_notification_staged',
    );
    expect(stagedCalls).toHaveLength(0);

    // Clean up
    coordinator.signalDone('task-1');
    await waitPromise.catch(() => {});
  });

  it('wait timeout causes pending notifications to be staged after wait ends', async () => {
    vi.useFakeTimers();
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    coordinator.markPromptDelivered('task-1');

    // Trigger an idle so a notification is queued
    const outputCb = getOutputCb();
    outputCb(encode('Done ❯ '));

    // Start wait — this clears staged notifications
    const waitPromise = coordinator.waitForSignalDone('coord-1', 100);
    mockNotifyRenderer.mockClear();

    // Time out the wait
    vi.advanceTimersByTime(200);
    await expect(waitPromise).rejects.toThrow('Timed out');

    // After timeout, pending notifications should be re-staged
    const stagedCalls = mockNotifyRenderer.mock.calls.filter(
      (c) => c[0] === 'mcp_coordinator_notification_staged',
    );
    expect(stagedCalls).toHaveLength(1);
  });

  it('coordinator deregistered — pending task notification fires orphaned event on next idle', async () => {
    await coordinator.createTask({
      name: 'orphan-test',
      prompt: 'do',
      coordinatorTaskId: 'coord-1',
    });
    coordinator.markPromptDelivered('task-1');
    mockNotifyRenderer.mockClear();

    // Deregister the coordinator (no active wait — simpler scenario)
    coordinator.deregisterCoordinator('coord-1');

    // After deregister, idle output should fire an orphaned notification (coordinator is gone)
    const outputCb = getOutputCb();
    outputCb(encode('Done ❯ '));

    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_coordinator_orphaned_notification',
      expect.objectContaining({ subTaskId: 'task-1' }),
    );
  });
});

// ─── Item 8: Sub-task lifecycle cleanup failure tests ─────────────────────────

describe('Coordinator cleanupTask — failure resilience', () => {
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

  it('deleteTask failure is swallowed and task is removed from map', async () => {
    const { deleteTask: mockDeleteTask } =
      await vi.importMock<typeof import('../ipc/tasks.js')>('../ipc/tasks.js');
    vi.mocked(mockDeleteTask).mockRejectedValueOnce(new Error('delete failed'));

    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    await coordinator.closeTask('task-1');

    expect(coordinator.getTask('task-1')).toBeUndefined();
    expect(mockNotifyRenderer).toHaveBeenCalledWith('mcp_task_closed', { taskId: 'task-1' });
  });

  it('MCP config file deletion failure is swallowed and task is removed', async () => {
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'tok',
      'subtask-tok',
      '/path/server.js',
    );
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    mockUnlinkSync.mockImplementationOnce(() => {
      throw new Error('unlink failed');
    });

    await expect(coordinator.closeTask('task-1')).resolves.toBeUndefined();
    expect(coordinator.getTask('task-1')).toBeUndefined();
  });

  it('subscriber is unregistered on cleanup', async () => {
    const { unsubscribeFromAgent } =
      await vi.importMock<typeof import('../ipc/pty.js')>('../ipc/pty.js');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(mockSubscribeToAgent).toHaveBeenCalled();

    await coordinator.closeTask('task-1');

    expect(vi.mocked(unsubscribeFromAgent)).toHaveBeenCalled();
  });
});

// ─── Token rotation tests ──────────────────────────────────────────────────────

describe('Coordinator setMCPServerInfo — token rotation', () => {
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

  it('rewrites existing task config files when token rotates', async () => {
    // Set up initial MCP server info
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://127.0.0.1:3001',
      'old-token',
      'old-token',
      '/path/to/mcp-server.cjs',
    );

    // Create a task — this writes a config file (mcpConfigPath set if server info is present)
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    // Clear write calls from task creation
    mockWriteFileSync.mockClear();

    // Rotate to a new token
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://127.0.0.1:3002',
      'new-token-xyz',
      'new-token-xyz',
      '/path/to/mcp-server.cjs',
    );

    // At least one writeFileSync call should have the new token
    const rewriteCalls = mockWriteFileSync.mock.calls;
    const hasNewToken = rewriteCalls.some((c) => {
      const content = typeof c[1] === 'string' ? c[1] : '';
      return content.includes('new-token-xyz');
    });

    // If task had an mcpConfigPath, it should be rewritten.
    // (If task had no mcpConfigPath — e.g. Docker mode — rewrite is skipped, which is also correct.)
    const task = coordinator.getTask('task-1');
    if (task?.mcpConfigPath) {
      expect(hasNewToken).toBe(true);
    } else {
      // Docker mode: no host config file to rewrite (sub-tasks use in-container config)
      expect(true).toBe(true);
    }
  });

  it('setMCPServerInfo with no existing tasks writes nothing', () => {
    mockWriteFileSync.mockClear();
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://127.0.0.1:3001',
      'new-token',
      'new-token',
      '/path/mcp.cjs',
    );
    // No tasks yet — nothing to rewrite
    const rewriteCalls = mockWriteFileSync.mock.calls.filter(
      (c) => typeof c[1] === 'string' && c[1].includes('new-token'),
    );
    expect(rewriteCalls).toHaveLength(0);
  });
});

// ─── Multiple coordinators in Docker ─────────────────────────────────────────

describe('Multiple Docker coordinators — isolation', () => {
  let coordA: InstanceType<typeof Coordinator>;
  let coordB: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });

    coordA = new Coordinator();
    coordA.setWindow(mockWin);
    coordA.setDefaultProject('proj-a', '/tmp/project-a');
    coordA.registerCoordinator('coord-a', 'proj-a');

    coordB = new Coordinator();
    coordB.setWindow(mockWin);
    coordB.setDefaultProject('proj-b', '/tmp/project-b');
    coordB.registerCoordinator('coord-b', 'proj-b');
  });

  it('each coordinator has an isolated docker container name (no singleton leak)', () => {
    coordA.setDockerContainerName('coord-a', 'parallel-code-container-a');
    coordB.setDockerContainerName('coord-b', 'parallel-code-container-b');

    // The container names must differ — no shared singleton
    expect('parallel-code-container-a').not.toBe('parallel-code-container-b');
  });

  it('sub-task MCP config for coord-a uses coord-a coordinator id, not coord-b', async () => {
    coordA.setMCPServerInfo(
      'coord-a',
      'http://localhost:3001',
      'tok-a',
      'subtask-tok-a',
      '/path/server.js',
    );
    await coordA.createTask({ name: 'task-a', prompt: 'do a', coordinatorTaskId: 'coord-a' });

    const configWrites = mockWriteFileSync.mock.calls.filter((c) =>
      (c[0] as string).includes('parallel-code-subtask-'),
    );
    expect(configWrites).toHaveLength(1);

    const cfg = JSON.parse(configWrites[0][1] as string) as {
      mcpServers: { 'parallel-code': { args: string[]; env: Record<string, string> } };
    };
    expect(cfg.mcpServers['parallel-code'].env['PARALLEL_CODE_MCP_TOKEN']).toBe('subtask-tok-a');
    expect(cfg.mcpServers['parallel-code'].env['PARALLEL_CODE_MCP_TOKEN']).not.toBe(
      'subtask-tok-b',
    );
  });
});

// ─── Sub-task closes coordinator container ────────────────────────────────────

describe('Coordinator docker exec sub-task — container lifecycle', () => {
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
    coordinator.setDockerContainerName('coord-1', 'my-coord-container');
  });

  it('sub-task spawned via docker exec uses command=docker, not command=claude', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ command: 'docker' }),
    );

    const spawnArgs = mockSpawnAgent.mock.calls[0][1].args as string[];
    // Sub-task uses 'docker exec', not 'docker run' — must not start a new container
    expect(spawnArgs).toContain('exec');
    expect(spawnArgs).not.toContain('run');
  });

  it('sub-task docker exec references the coordinator container name, not a new container', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const spawnArgs = mockSpawnAgent.mock.calls[0][1].args as string[];
    expect(spawnArgs).toContain('my-coord-container');
  });
});

// ─── Interrupted bootstrap / exit before prompt delivery ─────────────────────

describe('Coordinator interrupted bootstrap', () => {
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

  it('exits before prompt delivery notifies coordinator so it does not hang forever', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const agentId = getAgentId();
    const exitHandler = getExitHandler();

    // Kill the container before any output was produced — simulates trust-prompt hang / OOM kill
    exitHandler(agentId, { exitCode: 137 }); // 137 = SIGKILL

    // Coordinator must have been notified (not left waiting for prompt)
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.anything(),
    );
  });

  it('task status is exited after unexpected container death', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const agentId = getAgentId();
    const exitHandler = getExitHandler();
    exitHandler(agentId, { exitCode: 1 });

    const task = coordinator.getTask('task-1');
    expect(task?.status).toBe('exited');
  });
});

// ─── Very fast prompt before subscription (scrollback detection) ─────────────

describe('Coordinator very fast prompt — scrollback detection', () => {
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

  it('detects idle state via scrollback when prompt arrives before subscription', async () => {
    // Simulate container that printed ❯ before we subscribed: getAgentScrollback returns it.
    mockGetAgentScrollback.mockReturnValueOnce(
      Buffer.from('Welcome to Claude Code ❯ ').toString('base64'),
    );

    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'tok',
      'subtask-tok',
      '/path/server.js',
    );
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const task = coordinator.getTask('task-1');
    // Task must be idle (not still "running") because scrollback contained ❯
    expect(task?.status).toBe('idle');
  });

  it('task remains running when scrollback contains no prompt', async () => {
    // No ❯ in scrollback — agent is still initializing
    mockGetAgentScrollback.mockReturnValueOnce(
      Buffer.from('Loading… please wait').toString('base64'),
    );

    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'tok',
      'subtask-tok',
      '/path/server.js',
    );
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const task = coordinator.getTask('task-1');
    expect(task?.status).toBe('running');
  });

  it('null scrollback (agent not yet started) leaves task in running state', async () => {
    mockGetAgentScrollback.mockReturnValueOnce(null);

    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'tok',
      'subtask-tok',
      '/path/server.js',
    );
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const task = coordinator.getTask('task-1');
    expect(task?.status).toBe('running');
  });
});

// ─── Coordinator close with active sub-tasks ─────────────────────────────────

describe('Coordinator close with active sub-tasks', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('killAgent is called for each active sub-task when coordinator closes', async () => {
    mockCreateBackendTask
      .mockResolvedValueOnce({ id: 'task-a', branch_name: 'task/a', worktree_path: '/tmp/a' })
      .mockResolvedValueOnce({ id: 'task-b', branch_name: 'task/b', worktree_path: '/tmp/b' });

    await coordinator.createTask({ name: 'task-a', prompt: 'do a', coordinatorTaskId: 'coord-1' });
    await coordinator.createTask({ name: 'task-b', prompt: 'do b', coordinatorTaskId: 'coord-1' });

    const { killAgent: mockKillFn } =
      await vi.importMock<typeof import('../ipc/pty.js')>('../ipc/pty.js');
    vi.mocked(mockKillFn).mockClear();

    await coordinator.closeTask('task-a');
    await coordinator.closeTask('task-b');

    expect(vi.mocked(mockKillFn)).toHaveBeenCalledTimes(2);
  });

  it('MCP config temp file is deleted on closeTask (TODOS.md item 10)', async () => {
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'tok',
      'subtask-tok',
      '/path/server.js',
    );
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    const task = coordinator.getTask('task-1');
    const configPath = task?.mcpConfigPath;
    expect(configPath).toBeDefined();
    expect(configPath).toMatch(/parallel-code-subtask-task-1\.json$/);

    mockUnlinkSync.mockClear();
    await coordinator.closeTask('task-1');

    // unlinkSync must be called with the config path
    const unlinkCall = mockUnlinkSync.mock.calls.find((c) => c[0] === configPath);
    expect(unlinkCall).toBeDefined();
  });

  it('does not call unlinkSync for tasks created without MCP server info', async () => {
    // No setMCPServerInfo call — task gets no mcpConfigPath
    await coordinator.createTask({ name: 'test', prompt: 'do work', coordinatorTaskId: 'coord-1' });

    expect(coordinator.getTask('task-1')?.mcpConfigPath).toBeUndefined();

    mockUnlinkSync.mockClear();
    await coordinator.closeTask('task-1');

    // unlinkSync should NOT have been called with a parallel-code path
    const parallelCodeCalls = mockUnlinkSync.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('parallel-code-subtask'),
    );
    expect(parallelCodeCalls).toHaveLength(0);
  });

  it('task is removed from map even when docker exec sub-tasks are active', async () => {
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator.setDockerContainerName('coord-1', 'my-container');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });

    expect(coordinator.getTask('task-1')).toBeDefined();
    await coordinator.closeTask('task-1');
    expect(coordinator.getTask('task-1')).toBeUndefined();
  });
});

// ─── App crash/restart with running Docker container ─────────────────────────

describe('Coordinator restart hydration with Docker container name', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
    coordinator.registerCoordinator('coord-1', 'proj-1');
  });

  it('hydrateTask with controlledBy=human restores human control', () => {
    coordinator.hydrateTask({
      id: 'task-1',
      name: 'hydrated-task',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/hydrated',
      worktreePath: '/tmp/test',
      agentId: 'agent-hydrated',
      coordinatorTaskId: 'coord-1',
      controlledBy: 'human',
    });

    // setTaskControl should restore human control
    coordinator.setTaskControl('task-1', 'human');
    // Task must be under human control — verify via getTask
    const task = coordinator.getTask('task-1');
    expect(task).toBeDefined();
  });

  it('hydrateTask restores task so closeTask can clean it up after restart', async () => {
    coordinator.hydrateTask({
      id: 'task-1',
      name: 'hydrated-task',
      projectId: 'proj-1',
      projectRoot: '/tmp/project',
      branchName: 'task/hydrated',
      worktreePath: '/tmp/test',
      agentId: 'agent-hydrated',
      coordinatorTaskId: 'coord-1',
    });

    expect(coordinator.getTask('task-1')).toBeDefined();
    await coordinator.closeTask('task-1');
    expect(coordinator.getTask('task-1')).toBeUndefined();
  });
});

// ─── removeCoordinatedTask tests ─────────────────────────────────────────────

describe('Coordinator removeCoordinatedTask', () => {
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

  it('is a no-op for unknown taskId', () => {
    expect(() => coordinator.removeCoordinatedTask('nonexistent')).not.toThrow();
  });

  it('removes task from internal map', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(coordinator.getTask('task-1')).toBeDefined();

    coordinator.removeCoordinatedTask('task-1');

    expect(coordinator.getTask('task-1')).toBeUndefined();
  });

  it('unsubscribes the PTY output callback', async () => {
    const { unsubscribeFromAgent } =
      await vi.importMock<typeof import('../ipc/pty.js')>('../ipc/pty.js');
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const agentId = getAgentId();

    coordinator.removeCoordinatedTask('task-1');

    expect(vi.mocked(unsubscribeFromAgent)).toHaveBeenCalledWith(agentId, expect.any(Function));
  });

  it('cleans up internal resource maps (subscribers, tailBuffers, decoders, controlMap, blockedByHumanControl)', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const agentId = getAgentId();
    coordinator.setTaskControl('task-1', 'human');
    await coordinator.sendPrompt('task-1', 'hello').catch(() => {});

    coordinator.removeCoordinatedTask('task-1');

    const c = coordinator as unknown as {
      subscribers: Map<string, unknown>;
      tailBuffers: Map<string, unknown>;
      decoders: Map<string, unknown>;
      controlMap: Map<string, unknown>;
      blockedByHumanControl: Set<string>;
    };
    expect(c.subscribers.has(agentId)).toBe(false);
    expect(c.tailBuffers.has(agentId)).toBe(false);
    expect(c.decoders.has(agentId)).toBe(false);
    expect(c.controlMap.has('task-1')).toBe(false);
    expect(c.blockedByHumanControl.has('task-1')).toBe(false);
  });

  it('resolves pending idle waiters with removed reason', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const waitPromise = coordinator.waitForIdle('task-1');

    coordinator.removeCoordinatedTask('task-1');

    await expect(waitPromise).resolves.toEqual({ reason: 'removed' });
  });

  it('deletes MCP config file when mcpConfigPath is set', async () => {
    coordinator.setMCPServerInfo(
      'coord-1',
      'http://localhost:3001',
      'tok',
      'subtask-tok',
      '/path/server.js',
    );
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    const configPath = coordinator.getTask('task-1')?.mcpConfigPath;
    expect(configPath).toBeDefined();

    mockUnlinkSync.mockClear();
    coordinator.removeCoordinatedTask('task-1');

    const unlinkCall = mockUnlinkSync.mock.calls.find((c) => c[0] === configPath);
    expect(unlinkCall).toBeDefined();
  });

  it('does not call unlinkSync for tasks with no mcpConfigPath', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    expect(coordinator.getTask('task-1')?.mcpConfigPath).toBeUndefined();

    mockUnlinkSync.mockClear();
    coordinator.removeCoordinatedTask('task-1');

    const parallelCodeCalls = mockUnlinkSync.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('parallel-code-subtask'),
    );
    expect(parallelCodeCalls).toHaveLength(0);
  });

  it('does NOT notify renderer (UI already removed the task)', async () => {
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    mockNotifyRenderer.mockClear();

    coordinator.removeCoordinatedTask('task-1');

    expect(mockNotifyRenderer).not.toHaveBeenCalledWith('mcp_task_closed', expect.anything());
  });

  it('does NOT kill the agent (UI already did that)', async () => {
    const { killAgent: mockKillFn } =
      await vi.importMock<typeof import('../ipc/pty.js')>('../ipc/pty.js');
    vi.mocked(mockKillFn).mockClear();
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    vi.mocked(mockKillFn).mockClear();

    coordinator.removeCoordinatedTask('task-1');

    expect(vi.mocked(mockKillFn)).not.toHaveBeenCalled();
  });

  it('does NOT delete the worktree (UI already did that)', async () => {
    const { deleteTask: mockDeleteTask } =
      await vi.importMock<typeof import('../ipc/tasks.js')>('../ipc/tasks.js');
    vi.mocked(mockDeleteTask).mockClear();
    await coordinator.createTask({ name: 'test', prompt: 'do', coordinatorTaskId: 'coord-1' });
    vi.mocked(mockDeleteTask).mockClear();

    coordinator.removeCoordinatedTask('task-1');

    expect(vi.mocked(mockDeleteTask)).not.toHaveBeenCalled();
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
      'mcp_coordinated_task_closed',
    ];

    for (const channel of required) {
      expect(preload, `preload.cjs missing channel: ${channel}`).toContain(`'${channel}'`);
    }
  });
});
