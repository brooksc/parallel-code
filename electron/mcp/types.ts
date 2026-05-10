// Shared types for the MCP coordinating-agent system.

export interface CoordinatedTask {
  id: string;
  name: string;
  projectId: string;
  projectRoot: string; // snapshot at creation; prevents stale root if setDefaultProject is called for another project later
  branchName: string;
  baseBranch?: string; // branch the worktree was forked from; merge target for merge_task
  worktreePath: string;
  agentId: string;
  coordinatorTaskId: string;
  status: 'creating' | 'running' | 'idle' | 'exited' | 'error';
  exitCode: number | null;
  pendingPrompt?: string;
  mcpConfigPath?: string; // path to per-task tmp config, deleted on cleanup
  preambleFileExistedBefore?: boolean; // true if the preamble file existed before injection (even if empty)
  signalDoneAt?: Date; // set when sub-task explicitly calls signal_done
  signalDoneConsumed?: boolean; // true after wait_for_signal_done returns this task's signal
  // Coordinator notification lifecycle flags
  assignedPromptDelivered?: boolean;
  reviewNotificationQueued?: boolean;
  /** When the coordinator runs in Docker, sub-tasks are spawned via `docker exec`.
   *  Storing the container name here lets cleanupTask kill the inner process even
   *  after the coordinator state is gone. */
  dockerContainerName?: string | null;
}

export interface WaitForSignalDoneResult {
  taskId: string;
  name: string;
  status: string;
  signalDoneAt: string; // ISO timestamp
  remaining: number; // unconsumed signals + still-running tasks for this coordinator
}

export interface PendingNotification {
  id: string;
  taskId: string;
  taskName: string;
  branchName: string;
  state: 'idle' | 'exited';
  exitCode: number | null;
  completedAt: Date;
}

export interface CoordinatorState {
  taskId: string;
  projectId: string;
  projectRoot: string;
  worktreePath?: string;
  /** Docker container name for this coordinator, used to spawn sub-tasks via `docker exec`. */
  dockerContainerName?: string | null;
  /** Per-coordinator MCP server info; set after the remote server starts. */
  mcpServerInfo: {
    serverUrl: string;
    token: string;
    subtaskToken: string;
    serverPath: string;
  } | null;
  /** Per-coordinator agent spawn defaults; set when the coordinator registers. */
  spawnDefaults: { command: string; args: string[] };
  pendingNotifications: PendingNotification[];
  /** batchId → array of pendingNotification IDs included in that batch */
  stagedBatches: Map<string, string[]>;
  /** Bounded to last 64 to prevent unbounded growth */
  ackedBatchIds: string[];
  restageTimer: ReturnType<typeof setTimeout> | null;
  /** Whether to pass skipPermissions to sub-tasks created by this coordinator. */
  propagateSkipPermissions: boolean;
  /** Path to the .mcp.json file written for this coordinator. */
  mcpJsonPath: string;
  /** True if Parallel Code created .mcp.json from scratch; false if it was pre-existing. */
  createdMcpJson: boolean;
}

// --- MCP tool input schemas ---

export interface CreateTaskInput {
  name: string;
  prompt?: string;
  projectId?: string;
}

export type ListTasksInput = Record<string, never>;

export interface GetTaskStatusInput {
  taskId: string;
}

export interface SendPromptInput {
  taskId: string;
  prompt: string;
}

export interface WaitForIdleInput {
  taskId: string;
  timeoutMs?: number;
}

export interface GetTaskDiffInput {
  taskId: string;
}

export interface GetTaskOutputInput {
  taskId: string;
}

export interface MergeTaskInput {
  taskId: string;
  squash?: boolean;
  message?: string;
  cleanup?: boolean;
}

export interface CloseTaskInput {
  taskId: string;
}

// --- API request/response types ---

export interface ApiTaskSummary {
  id: string;
  name: string;
  branchName: string;
  status: string;
  coordinatorTaskId: string;
  signalDoneAt?: string; // ISO timestamp, set when sub-task called signal_done
}

export interface ApiTaskDetail extends ApiTaskSummary {
  worktreePath: string;
  projectId: string;
  agentId: string;
  exitCode: number | null;
  pendingPrompt?: string;
}

export interface ApiDiffResult {
  files: Array<{
    path: string;
    lines_added: number;
    lines_removed: number;
    status: string;
    committed: boolean;
  }>;
  diff: string;
  truncated?: boolean;
  originalSizeBytes?: number;
}

export interface ApiMergeResult {
  mainBranch: string;
  linesAdded: number;
  linesRemoved: number;
}

export interface ApiReviewAndMergeResult {
  diff: ApiDiffResult;
  merge: ApiMergeResult;
}
