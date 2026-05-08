// Main-process coordinator for managing sub-agent tasks.
// Manages task lifecycle independently of the SolidJS renderer,
// using existing backend primitives (pty, git, tasks).

import { randomUUID } from 'crypto';
import { writeFileSync, unlinkSync, readFileSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
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
import type {
  CoordinatedTask,
  PendingNotification,
  CoordinatorState,
  ApiTaskSummary,
  ApiTaskDetail,
  ApiDiffResult,
} from './types.js';
import { IPC } from '../ipc/channels.js';

const DEFAULT_WAIT_TIMEOUT_MS = 300_000; // 5 minutes
const PROMPT_WRITE_DELAY_MS = 50;

export class Coordinator {
  private tasks = new Map<string, CoordinatedTask>();
  private tailBuffers = new Map<string, string>();
  private idleResolvers = new Map<string, Array<() => void>>();
  private signalDoneResolvers = new Map<string, Array<() => void>>();
  private subscribers = new Map<string, (encoded: string) => void>();
  private decoders = new Map<string, TextDecoder>();
  private controlMap = new Map<string, 'coordinator' | 'human'>();
  private blockedByHumanControl = new Set<string>();
  private win: BrowserWindow | null = null;
  private projectRoot: string | null = null;
  private projectId: string | null = null;
  private defaultCoordinatorTaskId: string | null = null;
  private mcpServerInfo: { serverUrl: string; token: string; serverPath: string } | null = null;
  private coordinatorSpawnDefaults: { command: string; args: string[] } = {
    command: 'claude',
    args: [],
  };
  private coordinators = new Map<string, CoordinatorState>();
  private notificationDelayMs = 60_000;
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
            for (const resolve of resolvers) resolve();
            this.idleResolvers.delete(task.id);
          }
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
    this.controlMap.set(taskId, who);
    if (who === 'coordinator') {
      // Fire any idle resolvers that were queued while human had control
      const resolvers = this.idleResolvers.get(taskId);
      if (resolvers?.length) {
        for (const resolve of resolvers) resolve();
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
      opts.coordinatorTaskId !== 'api'
        ? opts.coordinatorTaskId
        : (this.defaultCoordinatorTaskId ?? opts.coordinatorTaskId);

    const agentId = randomUUID();
    const task: CoordinatedTask = {
      id: result.id,
      name: opts.name,
      projectId: projId,
      projectRoot: root,
      branchName: result.branch_name,
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
        // Restore CLAUDE.md after first idle — agent has loaded it by now
        if (!task.claudeMdRestored && task.claudeMdPath) {
          task.claudeMdRestored = true;
          const p = task.claudeMdPath;
          const orig = task.claudeMdOriginal;
          const wt = task.worktreePath;
          setTimeout(() => {
            try {
              if (orig !== null && orig !== undefined) {
                // File pre-existed — restore original content and let git see it as clean
                writeFileSync(p, orig);
                execSync('git restore CLAUDE.md', { cwd: wt, stdio: 'ignore' });
              } else {
                // We created it — git never tracked it, just delete
                unlinkSync(p);
              }
            } catch {
              // best-effort
            }
          }, 3_000);
        }
        // Resolve any waiting promises
        const resolvers = this.idleResolvers.get(task.id);
        if (resolvers?.length) {
          for (const resolve of resolvers) resolve();
          this.idleResolvers.delete(task.id);
        }
      } else if (task.status === 'idle') {
        task.status = 'running';
      }
    };
    this.subscribers.set(agentId, outputCb);

    // Spawn the agent process
    if (!this.win) throw new Error('No window set on coordinator');

    // Inject sub-task instructions into CLAUDE.md so they override skills/hooks.
    // Restored after first idle (agent has loaded it by then) to prevent commits.
    const claudeMdPath = join(result.worktree_path, 'CLAUDE.md');
    const subtaskBlock = `\n<!-- parallel-code-subtask-start -->\n## Sub-task mode (Parallel Code coordination — auto-removed on startup)\n\nThese rules override all skills and hooks:\n- When your work is complete, call the \`signal_done\` MCP tool. That is the finish line — do NOT use finishing-a-development-branch or offer merge/PR options.\n- Asking questions is fine when requirements are unclear or an action is risky.\n<!-- parallel-code-subtask-end -->\n`;
    if (existsSync(claudeMdPath)) {
      task.claudeMdOriginal = readFileSync(claudeMdPath, 'utf8');
      appendFileSync(claudeMdPath, subtaskBlock);
    } else {
      task.claudeMdOriginal = null;
      writeFileSync(claudeMdPath, subtaskBlock.trimStart());
    }
    task.claudeMdPath = claudeMdPath;

    // Write a per-sub-task MCP config so the agent can call signal_done
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
      const configPath = join(tmpdir(), `parallel-code-subtask-${task.id}.json`);
      writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
      subTaskMcpConfigPath = configPath;
      task.mcpConfigPath = configPath;
    }

    const command = opts.agentCommand ?? this.coordinatorSpawnDefaults.command;
    const baseArgs = [
      ...(opts.agentArgs ?? this.coordinatorSpawnDefaults.args),
      ...(opts.skipPermissions ? ['--dangerously-skip-permissions'] : []),
    ];
    const args = subTaskMcpConfigPath
      ? [...baseArgs, '--mcp-config', subTaskMcpConfigPath]
      : baseArgs;
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
      agentArgs: opts.agentArgs ?? this.coordinatorSpawnDefaults.args,
      skipPermissions: opts.skipPermissions ?? false,
    });

    return task;
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

  waitForIdle(taskId: string, timeoutMs?: number): Promise<void> {
    return this.waitForIdleInternal(taskId, timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  }

  private waitForIdleInternal(taskId: string, timeoutMs: number): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return Promise.reject(new Error(`Task not found: ${taskId}`));
    if (this.controlMap.get(taskId) === 'human') {
      return Promise.resolve(); // resolve immediately — caller gets control-change event instead
    }
    if (task.status === 'idle' || task.status === 'exited') return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timerRef = { value: undefined as ReturnType<typeof setTimeout> | undefined };

      const wrappedResolve = () => {
        if (timerRef.value !== undefined) clearTimeout(timerRef.value);
        resolve();
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

    const result = await gitMergeTask(
      root,
      task.branchName,
      opts?.squash ?? false,
      opts?.message ?? null,
      opts?.cleanup ?? false,
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

  async closeTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    await this.cleanupTask(taskId);
  }

  private async cleanupTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

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
    this.signalDoneResolvers.delete(taskId);
    // Delete per-task MCP config tmp file
    if (task.mcpConfigPath) {
      try {
        unlinkSync(task.mcpConfigPath);
      } catch {
        /* already gone */
      }
    }
    // Restore CLAUDE.md if agent exited before first idle
    if (!task.claudeMdRestored && task.claudeMdPath) {
      task.claudeMdRestored = true;
      try {
        if (task.claudeMdOriginal !== null && task.claudeMdOriginal !== undefined) {
          writeFileSync(task.claudeMdPath, task.claudeMdOriginal);
          execSync('git restore CLAUDE.md', { cwd: task.worktreePath, stdio: 'ignore' });
        } else {
          unlinkSync(task.claudeMdPath);
        }
      } catch {
        /* best-effort */
      }
    }
    this.tasks.delete(taskId);
    this.blockedByHumanControl.delete(taskId);

    // Notify renderer
    this.notifyRenderer(IPC.MCP_TaskClosed, { taskId });
  }

  getTask(taskId: string): CoordinatedTask | undefined {
    return this.tasks.get(taskId);
  }

  registerCoordinator(coordinatorTaskId: string, projectId: string): void {
    if (this.coordinators.has(coordinatorTaskId)) return;
    this.coordinators.set(coordinatorTaskId, {
      taskId: coordinatorTaskId,
      projectId,
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
    this.coordinators.delete(coordinatorTaskId);
  }

  markPromptDelivered(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) task.assignedPromptDelivered = true;
  }

  rescheduleRestageTimer(coordinatorTaskId: string): void {
    const coordinator = this.coordinators.get(coordinatorTaskId);
    if (!coordinator || coordinator.pendingNotifications.length === 0) return;
    if (coordinator.restageTimer) clearTimeout(coordinator.restageTimer);
    coordinator.restageTimer = setTimeout(() => {
      coordinator.restageTimer = null;
      if (coordinator.pendingNotifications.length > 0) {
        this.stageBatch(coordinator);
      }
    }, this.COORDINATOR_RESTAMP_DELAY_MS);
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
    // Resolve any waiters blocked on wait_for_signal_done
    const resolvers = this.signalDoneResolvers.get(taskId);
    if (resolvers?.length) {
      for (const resolve of resolvers) resolve();
      this.signalDoneResolvers.delete(taskId);
    }
    // Tell renderer so the sub-task chip can show a completion indicator
    this.notifyRenderer(IPC.MCP_TaskStateSync, { taskId, signalDoneReceived: true });
    const state: 'idle' | 'exited' = task.status === 'exited' ? 'exited' : 'idle';
    this.maybeQueueReviewNotification(task, state, task.exitCode ?? null, 5_000);
  }

  waitForSignalDone(taskId: string, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return Promise.reject(new Error(`Task not found: ${taskId}`));
    if (task.signalDoneAt) return Promise.resolve(); // already signalled

    return new Promise((resolve, reject) => {
      const timerRef = { value: undefined as ReturnType<typeof setTimeout> | undefined };

      const wrapped = () => {
        if (timerRef.value !== undefined) clearTimeout(timerRef.value);
        resolve();
      };

      timerRef.value = setTimeout(() => {
        const resolvers = this.signalDoneResolvers.get(taskId);
        if (resolvers) {
          const idx = resolvers.indexOf(wrapped);
          if (idx >= 0) resolvers.splice(idx, 1);
        }
        reject(new Error(`Timed out waiting for signal_done from task ${taskId}`));
      }, timeoutMs);

      let resolvers = this.signalDoneResolvers.get(taskId);
      if (!resolvers) {
        resolvers = [];
        this.signalDoneResolvers.set(taskId, resolvers);
      }
      resolvers.push(wrapped);
    });
  }

  private notifyRenderer(channel: string, data: unknown): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, data);
    }
  }
}
