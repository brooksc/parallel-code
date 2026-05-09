// Main-process coordinator for managing sub-agent tasks.
// Manages task lifecycle independently of the SolidJS renderer,
// using existing backend primitives (pty, git, tasks).

import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const execAsync = promisify(execFile);
import type { BrowserWindow } from 'electron';
import { createTask as createBackendTask, deleteTask } from '../ipc/tasks.js';
import {
  spawnAgent,
  writeToAgent,
  killAgent,
  subscribeToAgent,
  unsubscribeFromAgent,
  getAgentScrollback,
  onPtyEvent,
} from '../ipc/pty.js';
import { getChangedFiles, getAllFileDiffs, mergeTask as gitMergeTask } from '../ipc/git.js';
import { stripAnsi, chunkContainsAgentPrompt } from './prompt-detect.js';
import { SUB_TASK_PREAMBLE } from './sub-task-preamble.js';
import { warn as logWarn } from '../log.js';
import type {
  CoordinatedTask,
  PendingNotification,
  CoordinatorState,
  ApiTaskSummary,
  ApiTaskDetail,
  ApiDiffResult,
  WaitForSignalDoneResult,
} from './types.js';
import { IPC } from '../ipc/channels.js';

const DEFAULT_WAIT_TIMEOUT_MS = 300_000; // 5 minutes
const PROMPT_WRITE_DELAY_MS = 50;
const REST_COORDINATOR_SENTINEL = 'api';

export class Coordinator {
  private tasks = new Map<string, CoordinatedTask>();
  private tailBuffers = new Map<string, string>();
  private idleResolvers = new Map<
    string,
    Array<(result: { reason: 'idle' | 'human_control' | 'exited' }) => void>
  >();
  private anySignalResolvers = new Map<string, Array<(result: WaitForSignalDoneResult) => void>>();
  private subscribers = new Map<string, (encoded: string) => void>();
  private decoders = new Map<string, TextDecoder>();
  private controlMap = new Map<string, 'coordinator' | 'human'>();
  private blockedByHumanControl = new Set<string>();
  private closingTaskIds = new Set<string>();
  private activeSignalWaitCounts = new Map<string, number>();
  private win: BrowserWindow | null = null;
  private projectRoot: string | null = null;
  private projectId: string | null = null;
  private defaultCoordinatorTaskId: string | null = null;
  private mcpServerInfo: { serverUrl: string; token: string; serverPath: string } | null = null;
  private coordinatorSpawnDefaults: { command: string; args: string[] } = {
    command: 'claude',
    args: [],
  };
  private dockerContainerName: string | null = null;
  private coordinators = new Map<string, CoordinatorState>();
  private notificationDelayMs = 30_000;
  private readonly COORDINATOR_RESTAMP_DELAY_MS = 5 * 60_000;
  private readonly MAX_ACKED_BATCH_IDS = 64;
  constructor() {
    // Listen for PTY exits to update task status when agents are killed externally
    // (e.g., user closes a child task from the UI).
    // No cleanup needed — coordinator lives for the entire app lifetime.
    onPtyEvent('exit', (agentId, data) => {
      for (const task of this.tasks.values()) {
        if (task.agentId === agentId) {
          const { exitCode } = (data ?? {}) as { exitCode?: number };
          task.status = 'exited';
          task.exitCode = exitCode ?? null;
          // Resolve any idle waiters so they don't hang
          const resolvers = this.idleResolvers.get(task.id);
          if (resolvers?.length) {
            for (const resolve of resolvers) resolve({ reason: 'exited' });
            this.idleResolvers.delete(task.id);
          }
          if (this.closingTaskIds.has(task.id)) break;
          this.maybeQueueReviewNotification(task, 'exited', exitCode ?? null);
          break;
        }
      }
    });

    // Re-subscribe our output callback when the renderer respawns a managed agent.
    // TerminalView kills the existing PTY (clearing all subscribers) then spawns a
    // new one with the same agentId.  Without this, our outputCb is lost and we
    // can never detect idle for that sub-task.
    onPtyEvent('spawn', (agentId) => {
      const outputCb = this.subscribers.get(agentId);
      if (!outputCb) return; // not a coordinated agent, or initial spawn (not yet subscribed)
      this.tailBuffers.set(agentId, ''); // discard stale data from the killed PTY
      for (const task of this.tasks.values()) {
        if (task.agentId === agentId && task.status === 'exited') {
          task.status = 'running';
          task.exitCode = null;
          break;
        }
      }
      subscribeToAgent(agentId, outputCb);
    });
  }

  setTaskControl(taskId: string, who: 'coordinator' | 'human'): void {
    if (!this.tasks.has(taskId)) {
      console.warn(`setTaskControl: unknown taskId ${taskId}`);
      return;
    }
    this.controlMap.set(taskId, who);
    if (who === 'coordinator') {
      // Fire any idle resolvers that were queued while human had control
      const resolvers = this.idleResolvers.get(taskId);
      if (resolvers?.length) {
        for (const resolve of resolvers) resolve({ reason: 'human_control' });
        this.idleResolvers.delete(taskId);
      }
      // Notify coordinator if it tried to send a prompt while blocked
      if (this.blockedByHumanControl.has(taskId)) {
        this.blockedByHumanControl.delete(taskId);
        const task = this.tasks.get(taskId);
        const coordinator = task ? this.coordinators.get(task.coordinatorTaskId) : null;
        if (task && coordinator) {
          this.notifyRenderer(IPC.MCP_CoordinatorNotificationStaged, {
            coordinatorTaskId: coordinator.taskId,
            batchId: randomUUID(),
            notificationIds: [],
            text: `[Control update]\nTask "${task.name}" has been returned to coordinator control. You may now resume sending prompts to it.`,
            autoFireAt: Date.now() + 2_000,
          });
        }
      }
    }
  }

  setWindow(win: BrowserWindow): void {
    this.win = win;
  }

  setNotificationDelayMs(ms: number): void {
    this.notificationDelayMs = Math.max(5_000, Math.min(300_000, ms));
  }

  setDefaultProject(projectId: string, projectRoot: string, coordinatorTaskId?: string): void {
    this.projectId = projectId;
    this.projectRoot = projectRoot;
    if (coordinatorTaskId) this.defaultCoordinatorTaskId = coordinatorTaskId;
  }

  setMCPServerInfo(serverUrl: string, token: string, serverPath: string): void {
    this.mcpServerInfo = { serverUrl, token, serverPath };
    // Rewrite config files for existing tasks so they reconnect after a port/token rotation.
    for (const task of this.tasks.values()) {
      if (task.mcpConfigPath) {
        const mcpConfig = {
          mcpServers: {
            'parallel-code': {
              type: 'stdio' as const,
              command: 'node',
              args: [serverPath, '--url', serverUrl, '--token', token, '--task-id', task.id],
            },
          },
        };
        writeFileSync(task.mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
      }
    }
  }

  setCoordinatorSpawnDefaults(command: string, args: string[]): void {
    this.coordinatorSpawnDefaults = { command, args };
  }

  setDockerContainerName(name: string | null): void {
    this.dockerContainerName = name;
  }

  private maybeQueueReviewNotification(
    task: CoordinatedTask,
    state: 'idle' | 'exited',
    exitCode: number | null,
    delayOverrideMs?: number,
  ): void {
    // Always notify for exits — a task killed before prompt delivery still needs to be
    // reported so the coordinator doesn't think it's still running.
    if (!task.assignedPromptDelivered && state !== 'exited') return;

    const coordinator = this.coordinators.get(task.coordinatorTaskId);
    if (!coordinator) {
      if (task.reviewNotificationQueued) return;
      task.reviewNotificationQueued = true;
      this.notifyRenderer(IPC.MCP_CoordinatorOrphanedNotification, {
        subTaskId: task.id,
        notificationId: randomUUID(),
        state,
        text: `"${task.name}" ${state === 'exited' ? `terminated (exit ${exitCode})` : 'ready for review'} — branch: ${task.branchName}`,
      });
      return;
    }

    if (task.reviewNotificationQueued && state === 'exited') {
      const existing = coordinator.pendingNotifications.find((n) => n.taskId === task.id);
      if (existing && existing.state === 'idle') {
        existing.state = 'exited';
        existing.exitCode = exitCode;
        this.stageBatch(coordinator);
        return;
      }
      return;
    }

    if (task.reviewNotificationQueued) return;
    task.reviewNotificationQueued = true;

    const notification: PendingNotification = {
      id: randomUUID(),
      taskId: task.id,
      taskName: task.name,
      branchName: task.branchName,
      state,
      exitCode,
      completedAt: new Date(),
    };
    coordinator.pendingNotifications.push(notification);
    this.stageBatch(coordinator, delayOverrideMs);
  }

  private stageBatch(coordinator: CoordinatorState, delayOverrideMs?: number): void {
    const pending = coordinator.pendingNotifications;
    if (pending.length === 0) return;
    if (this.hasActiveSignalWaiter(coordinator.taskId)) {
      logWarn('coordinator.notification', 'stageBatch skipped', {
        coordinatorTaskId: coordinator.taskId,
        reason: 'active_signal_wait',
        activeWaitCount: this.activeSignalWaitCounts.get(coordinator.taskId) ?? 0,
        pendingTaskIds: this.pendingNotificationTaskIds(coordinator),
      });
      if (coordinator.restageTimer) {
        clearTimeout(coordinator.restageTimer);
        coordinator.restageTimer = null;
      }
      return;
    }

    const batchId = randomUUID();
    const notificationIds = pending.map((n) => n.id);
    coordinator.stagedBatches.set(batchId, notificationIds);

    const anyNonZero = pending.some((n) => n.exitCode !== null && n.exitCode !== 0);
    const defaultDelay = anyNonZero
      ? Math.max(10_000, this.notificationDelayMs / 4)
      : this.notificationDelayMs;
    const delay = delayOverrideMs ?? defaultDelay;
    const autoFireAt = Date.now() + delay;

    const text = this.formatNotificationText(pending);

    logWarn('coordinator.notification', 'stageBatch emitted', {
      coordinatorTaskId: coordinator.taskId,
      batchId,
      notificationIds,
      pendingTaskIds: this.pendingNotificationTaskIds(coordinator),
      delayMs: delay,
      autoFireAt,
    });

    this.notifyRenderer(IPC.MCP_CoordinatorNotificationStaged, {
      coordinatorTaskId: coordinator.taskId,
      batchId,
      notificationIds,
      text,
      autoFireAt,
    });

    if (coordinator.restageTimer) clearTimeout(coordinator.restageTimer);
    coordinator.restageTimer = setTimeout(() => {
      coordinator.restageTimer = null;
      if (coordinator.pendingNotifications.length > 0) {
        this.stageBatch(coordinator);
      }
    }, this.COORDINATOR_RESTAMP_DELAY_MS);
  }

  private formatNotificationText(pending: PendingNotification[]): string {
    const header = `[Sub-task update — ${pending.length} task(s) completed]`;
    const lines = pending.map((n) => {
      const status = n.state === 'exited' ? `terminated (exit ${n.exitCode})` : 'ready for review';
      const line = `- "${n.taskName}" ${status} — branch: ${n.branchName}`;
      const warn =
        n.exitCode !== null && n.exitCode !== 0
          ? '\n  ⚠️  Non-zero exit — may need attention. Consider spawning a follow-up agent.'
          : '';
      return line + warn;
    });
    const footer =
      "Please review each completed task: check its diff, confirm the work looks correct, then commit and merge what's ready. If there are items remaining on the backlog, spawn the next batch.";
    return [header, '', ...lines, '', footer].join('\n');
  }

  async createTask(opts: {
    name: string;
    prompt?: string;
    coordinatorTaskId: string;
    projectId?: string;
    projectRoot?: string;
    agentCommand?: string;
    agentArgs?: string[];
    skipPermissions?: boolean;
    baseBranch?: string;
  }): Promise<CoordinatedTask> {
    const root = opts.projectRoot ?? this.projectRoot;
    const projId = opts.projectId ?? this.projectId;
    if (!root || !projId) throw new Error('No project configured for coordinator');

    // Create worktree + branch via existing backend
    const result = await createBackendTask(
      opts.name,
      root,
      ['.claude', 'node_modules'],
      'task',
      opts.baseBranch,
    );

    const coordinatorId =
      opts.coordinatorTaskId !== REST_COORDINATOR_SENTINEL
        ? opts.coordinatorTaskId
        : (this.defaultCoordinatorTaskId ?? opts.coordinatorTaskId);

    const agentId = randomUUID();
    const task: CoordinatedTask = {
      id: result.id,
      name: opts.name,
      projectId: projId,
      projectRoot: root,
      branchName: result.branch_name,
      baseBranch: opts.baseBranch,
      worktreePath: result.worktree_path,
      agentId,
      coordinatorTaskId: coordinatorId,
      status: 'creating',
      exitCode: null,
    };

    this.tasks.set(task.id, task);
    this.tailBuffers.set(agentId, '');

    // Subscribe to PTY output for prompt detection
    const decoder = new TextDecoder();
    this.decoders.set(agentId, decoder);

    const outputCb = (encoded: string) => {
      const bytes = Buffer.from(encoded, 'base64');
      const text = (this.decoders.get(agentId) ?? new TextDecoder()).decode(bytes, {
        stream: true,
      });
      const prev = this.tailBuffers.get(agentId) ?? '';
      const combined = prev + text;
      this.tailBuffers.set(
        agentId,
        combined.length > 4096 ? combined.slice(combined.length - 4096) : combined,
      );

      // Check for agent prompt
      const stripped = stripAnsi(combined)
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (chunkContainsAgentPrompt(stripped)) {
        if (task.status === 'running') {
          task.status = 'idle';
          this.maybeQueueReviewNotification(task, 'idle', null);
        }
        // Resolve any waiting promises
        const resolvers = this.idleResolvers.get(task.id);
        if (resolvers?.length) {
          for (const resolve of resolvers) resolve({ reason: 'idle' });
          this.idleResolvers.delete(task.id);
        }
      } else if (task.status === 'idle') {
        task.status = 'running';
      }
    };
    this.subscribers.set(agentId, outputCb);

    // Spawn the agent process
    if (!this.win) throw new Error('No window set on coordinator');

    // Inject sub-task instructions via agent-specific mechanism
    const agentCmd = (opts.agentCommand ?? this.coordinatorSpawnDefaults.command).toLowerCase();
    const preamble = `<sub-task-mode>\nThese rules override all skills and hooks:\n- When your work is complete, call the \`signal_done\` MCP tool. That is the finish line — do NOT use finishing-a-development-branch or offer merge/PR options.\n- Asking questions is fine when requirements are unclear or an action is risky.\n</sub-task-mode>`;
    let preambleFilePath: string | undefined;
    let preambleFileOriginalContent: string | null = null;
    if (agentCmd.includes('codex') || agentCmd.includes('opencode')) {
      // Codex/OpenCode reads AGENTS.md from project root
      const agentsPath = join(result.worktree_path, 'AGENTS.md');
      preambleFilePath = agentsPath;
      let existing = '';
      if (existsSync(agentsPath)) {
        try {
          existing = readFileSync(agentsPath, 'utf8');
        } catch {
          /* ignore */
        }
        preambleFileOriginalContent = existing;
      }
      writeFileSync(agentsPath, existing ? `${existing}\n\n${preamble}` : preamble);
    } else if (agentCmd.includes('gemini')) {
      // Gemini reads GEMINI.md from project root by default
      const geminiPath = join(result.worktree_path, 'GEMINI.md');
      preambleFilePath = geminiPath;
      let existing = '';
      if (existsSync(geminiPath)) {
        try {
          existing = readFileSync(geminiPath, 'utf8');
        } catch {
          /* ignore */
        }
        preambleFileOriginalContent = existing;
      }
      writeFileSync(geminiPath, existing ? `${existing}\n\n${preamble}` : preamble);
    } else if (agentCmd.includes('copilot')) {
      // Copilot reads .agent.md from workspace root
      const agentMdPath = join(result.worktree_path, '.agent.md');
      preambleFilePath = agentMdPath;
      let existing = '';
      if (existsSync(agentMdPath)) {
        try {
          existing = readFileSync(agentMdPath, 'utf8');
        } catch {
          /* ignore */
        }
        preambleFileOriginalContent = existing;
      }
      writeFileSync(agentMdPath, existing ? `${existing}\n\n${preamble}` : preamble);
    } else {
      // Claude and fallback: settings.local.json (gitignored, no restore needed)
      const settingsDir = join(result.worktree_path, '.claude');
      const settingsPath = join(settingsDir, 'settings.local.json');
      mkdirSync(settingsDir, { recursive: true });
      let existingSettings: Record<string, unknown> = {};
      if (existsSync(settingsPath)) {
        try {
          existingSettings = JSON.parse(readFileSync(settingsPath, 'utf8'));
        } catch {
          /* ignore */
        }
      }
      existingSettings.systemPrompt = existingSettings.systemPrompt
        ? `${existingSettings.systemPrompt}\n\n${preamble}`
        : preamble;
      writeFileSync(settingsPath, JSON.stringify(existingSettings, null, 2));
    }
    task.preambleFileExistedBefore = preambleFileOriginalContent !== null;

    try {
      // Write a per-sub-task MCP config so the agent can call signal_done.
      // In Docker mode the config is written inside the worktree (accessible via volume mount);
      // in native mode it goes to the host temp directory.
      let subTaskMcpConfigPath: string | undefined;
      if (this.mcpServerInfo) {
        const { serverUrl, token, serverPath } = this.mcpServerInfo;
        const mcpConfig = {
          mcpServers: {
            'parallel-code': {
              type: 'stdio' as const,
              command: 'node',
              args: [serverPath, '--url', serverUrl, '--token', token, '--task-id', task.id],
            },
          },
        };
        const configPath = this.dockerContainerName
          ? join(result.worktree_path, '.mcp.json')
          : join(tmpdir(), `parallel-code-subtask-${task.id}.json`);
        writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
        subTaskMcpConfigPath = configPath;
        task.mcpConfigPath = configPath;
      }

      const agentCommand = opts.agentCommand ?? this.coordinatorSpawnDefaults.command;
      const agentArgs = opts.agentArgs ?? this.coordinatorSpawnDefaults.args;
      const baseArgs = [
        ...agentArgs,
        ...(opts.skipPermissions ? ['--dangerously-skip-permissions'] : []),
      ];
      // In Docker mode, pass --mcp-config only when NOT using .mcp.json auto-discovery
      // (.mcp.json in the worktree is auto-discovered by Claude Code).
      const mcpArgs =
        subTaskMcpConfigPath && !this.dockerContainerName
          ? ['--mcp-config', subTaskMcpConfigPath]
          : [];
      const agentFinalArgs = [...baseArgs, ...mcpArgs];

      // When the coordinator runs in Docker, spawn sub-agents via `docker exec` into
      // the same container so they share the mounted project filesystem.
      let command: string;
      let args: string[];
      if (this.dockerContainerName) {
        command = 'docker';
        args = [
          'exec',
          '-i',
          '-w',
          result.worktree_path,
          this.dockerContainerName,
          agentCommand,
          ...agentFinalArgs,
        ];
      } else {
        command = agentCommand;
        args = agentFinalArgs;
      }

      const channelId = randomUUID();

      spawnAgent(this.win, {
        taskId: task.id,
        agentId,
        command,
        args,
        cwd: result.worktree_path,
        env: {},
        cols: 120,
        rows: 40,
        onOutput: { __CHANNEL_ID__: channelId },
      });

      // Subscribe for output monitoring
      subscribeToAgent(agentId, outputCb);
      task.status = 'running';

      // Check scrollback in case the prompt was emitted before we subscribed
      const scrollback = getAgentScrollback(agentId);
      if (scrollback) {
        const decoded = Buffer.from(scrollback, 'base64').toString('utf8');
        const stripped = stripAnsi(decoded)
          // eslint-disable-next-line no-control-regex
          .replace(/[\x00-\x1f\x7f]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (chunkContainsAgentPrompt(stripped)) {
          task.status = 'idle';
          this.maybeQueueReviewNotification(task, 'idle', null);
        }
      }

      // Notify renderer with the prompt — the renderer sets it as initialPrompt
      // on the task, and PromptInput auto-delivers it using the same code path
      // as manually created tasks (stability checks, quiescence detection, etc.)
      // For renderer storage: agentCommand/agentArgs are used to restart the agent from the UI.
      // In docker mode, we store the `docker exec <container> <agentCommand>` form so restarts work.
      const notifyAgentArgs = this.dockerContainerName
        ? ['exec', '-i', this.dockerContainerName, agentCommand, ...agentArgs]
        : agentArgs;
      this.notifyRenderer(IPC.MCP_TaskCreated, {
        taskId: task.id,
        name: task.name,
        projectId: task.projectId,
        branchName: task.branchName,
        worktreePath: task.worktreePath,
        agentId: task.agentId,
        coordinatorTaskId: task.coordinatorTaskId,
        prompt: opts.prompt ? SUB_TASK_PREAMBLE + opts.prompt : opts.prompt,
        mcpConfigPath: subTaskMcpConfigPath,
        agentCommand: command,
        agentArgs: notifyAgentArgs,
        skipPermissions: opts.skipPermissions ?? false,
      });

      return task;
    } catch (err) {
      if (preambleFilePath !== undefined) {
        try {
          if (preambleFileOriginalContent !== null) {
            writeFileSync(preambleFilePath, preambleFileOriginalContent);
          } else {
            unlinkSync(preambleFilePath);
          }
        } catch {
          /* ignore cleanup errors */
        }
      }
      throw err;
    }
  }

  listTasks(): ApiTaskSummary[] {
    return Array.from(this.tasks.values()).map((t) => ({
      id: t.id,
      name: t.name,
      branchName: t.branchName,
      status: t.status,
      coordinatorTaskId: t.coordinatorTaskId,
      signalDoneAt: t.signalDoneAt?.toISOString(),
    }));
  }

  getTaskStatus(taskId: string): ApiTaskDetail | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    return {
      id: task.id,
      name: task.name,
      branchName: task.branchName,
      worktreePath: task.worktreePath,
      projectId: task.projectId,
      agentId: task.agentId,
      status: task.status,
      coordinatorTaskId: task.coordinatorTaskId,
      exitCode: task.exitCode,
      pendingPrompt: task.pendingPrompt,
      signalDoneAt: task.signalDoneAt?.toISOString(),
    };
  }

  async sendPrompt(taskId: string, prompt: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (this.controlMap.get(taskId) === 'human') {
      this.blockedByHumanControl.add(taskId);
      throw new Error(
        'Task is under human control. Return control to coordinator before sending prompts.',
      );
    }

    // Send text then Enter separately (like the frontend does)
    writeToAgent(task.agentId, prompt);
    await new Promise((r) => setTimeout(r, PROMPT_WRITE_DELAY_MS));
    writeToAgent(task.agentId, '\r');
    task.status = 'running';
    task.pendingPrompt = undefined;
  }

  waitForIdle(
    taskId: string,
    timeoutMs?: number,
  ): Promise<{ reason: 'idle' | 'human_control' | 'exited' }> {
    return this.waitForIdleInternal(taskId, timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  }

  private waitForIdleInternal(
    taskId: string,
    timeoutMs: number,
  ): Promise<{ reason: 'idle' | 'human_control' | 'exited' }> {
    const task = this.tasks.get(taskId);
    if (!task) return Promise.reject(new Error(`Task not found: ${taskId}`));
    if (this.controlMap.get(taskId) === 'human') {
      return Promise.resolve({ reason: 'human_control' }); // resolve immediately — caller gets control-change event instead
    }
    if (task.status === 'exited') return Promise.resolve({ reason: 'exited' });
    if (task.status === 'idle') return Promise.resolve({ reason: 'idle' });

    return new Promise((resolve, reject) => {
      const timerRef = { value: undefined as ReturnType<typeof setTimeout> | undefined };

      const wrappedResolve = (result: { reason: 'idle' | 'human_control' | 'exited' }) => {
        if (timerRef.value !== undefined) clearTimeout(timerRef.value);
        resolve(result);
      };

      timerRef.value = setTimeout(() => {
        const resolvers = this.idleResolvers.get(taskId);
        if (resolvers) {
          const idx = resolvers.indexOf(wrappedResolve);
          if (idx >= 0) resolvers.splice(idx, 1);
        }
        reject(new Error(`Timed out waiting for task ${taskId} to become idle`));
      }, timeoutMs);

      let resolvers = this.idleResolvers.get(taskId);
      if (!resolvers) {
        resolvers = [];
        this.idleResolvers.set(taskId, resolvers);
      }
      resolvers.push(wrappedResolve);
    });
  }

  async getTaskDiff(taskId: string): Promise<ApiDiffResult> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const [files, diff] = await Promise.all([
      getChangedFiles(task.worktreePath),
      getAllFileDiffs(task.worktreePath),
    ]);

    return { files, diff };
  }

  getTaskOutput(taskId: string): string {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // Try scrollback buffer first, fall back to tail buffer
    const scrollback = getAgentScrollback(task.agentId);
    if (scrollback) {
      const decoded = Buffer.from(scrollback, 'base64').toString('utf8');
      return stripAnsi(decoded);
    }
    return stripAnsi(this.tailBuffers.get(task.agentId) ?? '');
  }

  async mergeTask(
    taskId: string,
    opts?: { squash?: boolean; message?: string; cleanup?: boolean },
  ): Promise<{ mainBranch: string; linesAdded: number; linesRemoved: number }> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const root = task.projectRoot;

    // Strip injected preamble files before staging so they don't land in history,
    // then auto-commit any uncommitted changes in the task worktree before merging.
    if (task.worktreePath) {
      this.stripPreambleFromBranch(task);
      try {
        await execAsync('git', ['add', '-A'], { cwd: task.worktreePath });
        await execAsync('git', ['commit', '-m', 'WIP: auto-commit before merge'], {
          cwd: task.worktreePath,
        });
      } catch {
        // Commit failed — check if uncommitted changes still exist
        const { stdout: statusOut } = await execAsync('git', ['status', '--porcelain'], {
          cwd: task.worktreePath,
        });
        if (statusOut.trim()) {
          throw new Error(
            `Auto-commit failed and the task worktree still has uncommitted changes. ` +
              `Please commit or discard changes in ${task.worktreePath} before merging.`,
          );
        }
        // Nothing to commit — swallow silently
      }
    }

    const coordinatorState = this.coordinators.get(task.coordinatorTaskId);
    const result = await gitMergeTask(
      root,
      task.branchName,
      opts?.squash ?? false,
      opts?.message ?? null,
      opts?.cleanup ?? false,
      task.baseBranch,
      task.worktreePath,
      coordinatorState?.worktreePath,
    );

    if (opts?.cleanup) {
      await this.cleanupTask(taskId);
    }

    return {
      mainBranch: result.main_branch,
      linesAdded: result.lines_added,
      linesRemoved: result.lines_removed,
    };
  }

  async reviewAndMergeTask(
    taskId: string,
    opts?: { squash?: boolean; message?: string },
  ): Promise<{
    diff: ApiDiffResult;
    merge: { mainBranch: string; linesAdded: number; linesRemoved: number };
  }> {
    const diff = await this.getTaskDiff(taskId);
    const merge = await this.mergeTask(taskId, { ...opts, cleanup: true });
    return { diff, merge };
  }

  async closeTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    await this.cleanupTask(taskId);
  }

  private stripPreambleFromBranch(task: CoordinatedTask): void {
    const PREAMBLE_START = '<sub-task-mode>';
    const worktreePath = task.worktreePath;
    for (const filename of ['AGENTS.md', 'GEMINI.md', '.agent.md']) {
      const filePath = join(worktreePath, filename);
      if (!existsSync(filePath)) continue;
      let content: string;
      try {
        content = readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      const idx = content.indexOf(PREAMBLE_START);
      if (idx === -1) continue;
      // Remove the preamble block and any preceding \n\n separator
      const stripped = content.slice(0, idx).replace(/\n\n$/, '');
      if (stripped.trim()) {
        writeFileSync(filePath, stripped);
      } else if (task.preambleFileExistedBefore) {
        // File existed before injection (even if empty) — restore to pre-injection bytes
        writeFileSync(filePath, stripped);
      } else {
        // File was created solely for the preamble — remove it so git add -A won't pick it up
        unlinkSync(filePath);
      }
    }
  }

  private async cleanupTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    this.closingTaskIds.add(taskId);
    this.suppressPendingNotificationForTask(task);

    // Unsubscribe from PTY output
    const cb = this.subscribers.get(task.agentId);
    if (cb) {
      unsubscribeFromAgent(task.agentId, cb);
      this.subscribers.delete(task.agentId);
    }

    // Kill the agent
    try {
      killAgent(task.agentId);
    } catch {
      /* already dead */
    }

    // Remove worktree
    try {
      await deleteTask({
        agentIds: [task.agentId],
        branchName: task.branchName,
        deleteBranch: true,
        projectRoot: task.projectRoot,
      });
    } catch (err) {
      console.warn('Failed to delete coordinated task worktree:', err);
    }

    // Clean up internal state
    this.tailBuffers.delete(task.agentId);
    this.decoders.delete(task.agentId);
    this.idleResolvers.delete(taskId);
    // Delete per-task MCP config tmp file
    if (task.mcpConfigPath) {
      try {
        unlinkSync(task.mcpConfigPath);
      } catch {
        /* already gone */
      }
    }
    this.tasks.delete(taskId);
    this.blockedByHumanControl.delete(taskId);
    this.closingTaskIds.delete(taskId);

    // Notify renderer
    this.notifyRenderer(IPC.MCP_TaskClosed, { taskId });
  }

  getTask(taskId: string): CoordinatedTask | undefined {
    return this.tasks.get(taskId);
  }

  registerCoordinator(coordinatorTaskId: string, projectId: string, worktreePath?: string): void {
    if (this.coordinators.has(coordinatorTaskId)) return;
    this.coordinators.set(coordinatorTaskId, {
      taskId: coordinatorTaskId,
      projectId,
      worktreePath,
      pendingNotifications: [],
      stagedBatches: new Map(),
      ackedBatchIds: [],
      restageTimer: null,
    });
  }

  deregisterCoordinator(coordinatorTaskId: string): void {
    const coordinator = this.coordinators.get(coordinatorTaskId);
    if (!coordinator) return;
    if (coordinator.restageTimer) clearTimeout(coordinator.restageTimer);
    if (coordinator.pendingNotifications.length > 0 || coordinator.stagedBatches.size > 0) {
      logWarn('coordinator.notification', 'staged notification cleared', {
        coordinatorTaskId: coordinator.taskId,
        reason: 'deregister',
        pendingTaskIds: this.pendingNotificationTaskIds(coordinator),
      });
      this.notifyRenderer(IPC.MCP_CoordinatorNotificationCleared, {
        coordinatorTaskId: coordinator.taskId,
      });
    }
    this.coordinators.delete(coordinatorTaskId);
  }

  markPromptDelivered(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) task.assignedPromptDelivered = true;
  }

  rescheduleRestageTimer(coordinatorTaskId: string): void {
    const coordinator = this.coordinators.get(coordinatorTaskId);
    if (!coordinator || coordinator.pendingNotifications.length === 0) return;
    if (this.hasActiveSignalWaiter(coordinatorTaskId)) {
      logWarn('coordinator.notification', 'restage skipped', {
        coordinatorTaskId,
        reason: 'active_signal_wait',
        activeWaitCount: this.activeSignalWaitCounts.get(coordinatorTaskId) ?? 0,
        pendingTaskIds: this.pendingNotificationTaskIds(coordinator),
      });
      return;
    }
    if (coordinator.restageTimer) clearTimeout(coordinator.restageTimer);
    coordinator.restageTimer = setTimeout(() => {
      coordinator.restageTimer = null;
      if (coordinator.pendingNotifications.length > 0) {
        this.stageBatch(coordinator);
      }
    }, this.COORDINATOR_RESTAMP_DELAY_MS);
  }

  dropNotification(coordinatorTaskId: string, batchId: string): void {
    const coordinator = this.coordinators.get(coordinatorTaskId);
    const affectedTaskIds: string[] = [];
    if (coordinator) {
      const pendingIds = coordinator.stagedBatches.get(batchId);
      if (pendingIds) {
        for (const notifId of pendingIds) {
          const notif = coordinator.pendingNotifications.find((n) => n.id === notifId);
          if (notif) affectedTaskIds.push(notif.taskId);
        }
      }
    }
    this.ackNotification(coordinatorTaskId, batchId);
    for (const taskId of affectedTaskIds) {
      this.notifyRenderer(IPC.MCP_TaskStateSync, { taskId, needsReview: true });
    }
  }

  ackNotification(coordinatorTaskId: string, batchId: string): void {
    const coordinator = this.coordinators.get(coordinatorTaskId);
    if (!coordinator) return;

    if (coordinator.ackedBatchIds.includes(batchId)) return;

    const pendingIds = coordinator.stagedBatches.get(batchId);
    if (pendingIds) {
      coordinator.pendingNotifications = coordinator.pendingNotifications.filter((n) => {
        if (pendingIds.includes(n.id)) {
          const task = this.tasks.get(n.taskId);
          if (task) task.reviewNotificationQueued = false;
          return false;
        }
        return true;
      });
      coordinator.stagedBatches.delete(batchId);
    }

    coordinator.ackedBatchIds.push(batchId);
    if (coordinator.ackedBatchIds.length > this.MAX_ACKED_BATCH_IDS) {
      coordinator.ackedBatchIds.shift();
    }

    if (coordinator.pendingNotifications.length === 0 && coordinator.restageTimer) {
      clearTimeout(coordinator.restageTimer);
      coordinator.restageTimer = null;
    }
  }

  hasActiveCoordinator(): boolean {
    return this.coordinators.size > 0;
  }

  signalDone(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.assignedPromptDelivered = true;
    task.signalDoneAt = new Date();
    task.signalDoneConsumed = false;

    const coordinatorId = task.coordinatorTaskId;
    const anyResolvers = this.anySignalResolvers.get(coordinatorId);
    const firstAnyResolver = anyResolvers?.length ? anyResolvers.shift() : undefined;
    if (firstAnyResolver) {
      task.signalDoneConsumed = true;
      // Suppress before finishSignalWait so it doesn't re-stage
      this.suppressPendingNotificationForTask(task);
      const remaining = this.countRemaining(coordinatorId);
      firstAnyResolver({ taskId, name: task.name, remaining });
      this.finishSignalWait(coordinatorId);
      // Tell renderer — coordinator already gets result via MCP return value, no UI notification needed
      this.notifyRenderer(IPC.MCP_TaskStateSync, { taskId, signalDoneReceived: true });
      logWarn('coordinator.signal_wait', 'wait_for_signal_done finish', {
        taskId,
        coordinatorTaskId: coordinatorId,
        reason: 'signal',
        activeWaitCount: this.activeSignalWaitCounts.get(coordinatorId) ?? 0,
      });
      return;
    }

    // No active waiter — notify via UI so coordinator sees the completion
    this.notifyRenderer(IPC.MCP_TaskStateSync, { taskId, signalDoneReceived: true });
    const state: 'idle' | 'exited' = task.status === 'exited' ? 'exited' : 'idle';
    this.maybeQueueReviewNotification(task, state, task.exitCode ?? null, 5_000);
  }

  private suppressPendingNotificationForTask(task: CoordinatedTask): void {
    const coordinator = this.coordinators.get(task.coordinatorTaskId);
    if (!coordinator) return;

    const toRemove = coordinator.pendingNotifications.filter((n) => n.taskId === task.id);
    if (toRemove.length === 0) return;

    const removeIds = new Set(toRemove.map((n) => n.id));
    coordinator.pendingNotifications = coordinator.pendingNotifications.filter(
      (n) => n.taskId !== task.id,
    );
    task.reviewNotificationQueued = false;

    for (const [batchId, notifIds] of coordinator.stagedBatches) {
      const remaining = notifIds.filter((id) => !removeIds.has(id));
      if (remaining.length === 0) {
        coordinator.stagedBatches.delete(batchId);
      } else {
        coordinator.stagedBatches.set(batchId, remaining);
      }
    }

    if (coordinator.pendingNotifications.length === 0) {
      if (coordinator.restageTimer) {
        clearTimeout(coordinator.restageTimer);
        coordinator.restageTimer = null;
      }
      logWarn('coordinator.notification', 'staged notification cleared', {
        coordinatorTaskId: coordinator.taskId,
        reason: 'all_suppressed',
        taskId: task.id,
      });
      this.notifyRenderer(IPC.MCP_CoordinatorNotificationCleared, {
        coordinatorTaskId: coordinator.taskId,
      });
    } else {
      // Re-stage with remaining notifications so text is updated
      this.stageBatch(coordinator);
    }
  }

  waitForSignalDone(
    coordinatorTaskId: string,
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  ): Promise<WaitForSignalDoneResult> {
    if (!this.coordinators.has(coordinatorTaskId)) {
      return Promise.reject(new Error(`Coordinator not found: ${coordinatorTaskId}`));
    }
    // Return immediately if there's an unconsumed signal
    for (const task of this.tasks.values()) {
      if (
        task.coordinatorTaskId === coordinatorTaskId &&
        task.signalDoneAt &&
        !task.signalDoneConsumed
      ) {
        task.signalDoneConsumed = true;
        const remaining = this.countRemaining(coordinatorTaskId);
        return Promise.resolve({ taskId: task.id, name: task.name, remaining });
      }
    }

    this.beginSignalWait(coordinatorTaskId);
    logWarn('coordinator.signal_wait', 'wait_for_signal_done start', {
      coordinatorTaskId,
      activeWaitCount: this.activeSignalWaitCounts.get(coordinatorTaskId) ?? 0,
      timeoutMs,
    });

    return new Promise((resolve, reject) => {
      const timerRef = { value: undefined as ReturnType<typeof setTimeout> | undefined };

      const wrapped = (result: WaitForSignalDoneResult) => {
        if (timerRef.value !== undefined) clearTimeout(timerRef.value);
        resolve(result);
      };

      timerRef.value = setTimeout(() => {
        const resolvers = this.anySignalResolvers.get(coordinatorTaskId);
        if (resolvers) {
          const idx = resolvers.indexOf(wrapped);
          if (idx >= 0) resolvers.splice(idx, 1);
        }
        this.finishSignalWait(coordinatorTaskId);
        logWarn('coordinator.signal_wait', `wait_for_signal_done timed out after ${timeoutMs}ms`, {
          coordinatorTaskId,
          reason: 'timeout',
          timeoutMs,
          activeWaitCount: this.activeSignalWaitCounts.get(coordinatorTaskId) ?? 0,
        });
        reject(new Error(`Timed out waiting for any signal_done`));
      }, timeoutMs);

      let resolvers = this.anySignalResolvers.get(coordinatorTaskId);
      if (!resolvers) {
        resolvers = [];
        this.anySignalResolvers.set(coordinatorTaskId, resolvers);
      }
      resolvers.push(wrapped);
    });
  }

  private countRemaining(coordinatorTaskId: string): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.coordinatorTaskId !== coordinatorTaskId) continue;
      if (task.signalDoneConsumed) continue; // coordinator already processed this one
      if (task.status === 'exited' && !task.signalDoneAt) continue; // exited without signal — handled by UI
      count++;
    }
    return count;
  }

  private beginSignalWait(coordinatorTaskId: string): void {
    this.activeSignalWaitCounts.set(
      coordinatorTaskId,
      (this.activeSignalWaitCounts.get(coordinatorTaskId) ?? 0) + 1,
    );
    const coordinator = this.coordinators.get(coordinatorTaskId);
    if (coordinator) {
      this.clearStagedNotificationForCoordinator(coordinator);
    }
  }

  private finishSignalWait(coordinatorTaskId: string): void {
    const current = this.activeSignalWaitCounts.get(coordinatorTaskId) ?? 0;
    if (current <= 1) {
      this.activeSignalWaitCounts.delete(coordinatorTaskId);
    } else {
      this.activeSignalWaitCounts.set(coordinatorTaskId, current - 1);
      return;
    }

    const coordinator = this.coordinators.get(coordinatorTaskId);
    if (coordinator && coordinator.pendingNotifications.length > 0) {
      this.stageBatch(coordinator);
    }
  }

  private hasActiveSignalWaiter(coordinatorTaskId: string): boolean {
    return (this.activeSignalWaitCounts.get(coordinatorTaskId) ?? 0) > 0;
  }

  private clearStagedNotificationForCoordinator(coordinator: CoordinatorState): void {
    if (coordinator.restageTimer) {
      clearTimeout(coordinator.restageTimer);
      coordinator.restageTimer = null;
    }
    if (coordinator.stagedBatches.size === 0) return;
    coordinator.stagedBatches.clear();
    logWarn('coordinator.notification', 'staged notification cleared', {
      coordinatorTaskId: coordinator.taskId,
      reason: 'signal_wait_started',
      pendingTaskIds: this.pendingNotificationTaskIds(coordinator),
    });
    this.notifyRenderer(IPC.MCP_CoordinatorNotificationCleared, {
      coordinatorTaskId: coordinator.taskId,
    });
  }

  private pendingNotificationTaskIds(coordinator: CoordinatorState): string[] {
    return coordinator.pendingNotifications.map((n) => n.taskId);
  }

  private notifyRenderer(channel: string, data: unknown): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, data);
    }
  }
}
