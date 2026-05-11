// Shared branch-name validator used by MCP, REST, and IPC paths.
// Conservative subset of git check-ref-format rules — no process spawn.

export function validateBranchName(value: unknown, field = 'baseBranch'): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  if (!value.trim()) throw new Error(`${field} must be a non-empty string`);
  if (value.startsWith('-')) throw new Error(`${field} must not start with "-"`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f ]/.test(value)) throw new Error(`${field} contains invalid characters`);
  // Reject path traversal sequences.
  if (/(?:^|\/)\.\.(?:\/|$)/.test(value)) throw new Error(`${field} contains path traversal`);
  // Reject shell metacharacters that could be dangerous in command arguments.
  if (/[`$(){}[\]<>\\'*?!#;|&"]/.test(value))
    throw new Error(`${field} contains invalid characters`);
  return value;
}
