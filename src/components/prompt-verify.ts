import { stripAnsi } from '../store/taskStatus';

/**
 * Polls until the opening snippet of `prompt` appears in `getTail(agentId)`,
 * returning true on success and false on timeout or abort.
 *
 * Returns false immediately when the signal is already aborted.  Otherwise
 * returns true immediately when:
 * - prompt is empty (nothing to verify)
 * - the snippet was already in preSendTail (pre-existing content, not a new echo)
 *
 * The snippet is the first 40 stripped characters of the prompt — enough to
 * uniquely identify it without risking false matches on short fragments.
 */
export async function pollUntilPromptAppearsInOutput(
  agentId: string,
  prompt: string,
  preSendTail: string,
  signal: AbortSignal,
  getTail: (agentId: string) => string,
  deadlineMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  // Check abort before the early-success paths: a superseded send must not be
  // reported as verified just because the prompt was empty or already visible.
  if (signal.aborted) return false;
  const snippet = stripAnsi(prompt).slice(0, 40);
  if (!snippet) return true;
  // Already visible before we sent — skip verification to avoid false positives.
  if (stripAnsi(preSendTail).includes(snippet)) return true;

  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (signal.aborted) return false;
    if (stripAnsi(getTail(agentId)).includes(snippet)) return true;
    await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
  }
  // Final check: the echo may have arrived during the last sleep or right at the
  // deadline boundary, after the loop's last in-loop check.
  return !signal.aborted && stripAnsi(getTail(agentId)).includes(snippet);
}
