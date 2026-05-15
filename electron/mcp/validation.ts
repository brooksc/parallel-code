// Shared branch-name validator used by MCP, REST, and IPC paths.
// Conservative subset of git check-ref-format rules — no process spawn.

export function validateBranchName(value: unknown, field = 'baseBranch'): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  if (!value.trim()) throw new Error(`${field} must be a non-empty string`);
  if (value.startsWith('-')) throw new Error(`${field} must not start with "-"`);
  if (value.startsWith('.')) throw new Error(`${field} must not start with "."`);
  if (value.startsWith('/')) throw new Error(`${field} must not start with "/"`);
  if (value.endsWith('/')) throw new Error(`${field} must not end with "/"`);
  if (value.endsWith('.lock')) throw new Error(`${field} must not end with ".lock"`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f ]/.test(value)) throw new Error(`${field} contains invalid characters`);
  // Reject path traversal sequences.
  if (/(?:^|\/)\.\.(?:\/|$)/.test(value)) throw new Error(`${field} contains path traversal`);
  // Reject shell metacharacters that could be dangerous in command arguments.
  if (/[`$(){}[\]<>\\'*?!#;|&"]/.test(value))
    throw new Error(`${field} contains invalid characters`);
  // Additional git check-ref-format rules.
  if (value.includes('@{')) throw new Error(`${field} must not contain "@{"`);
  if (value.includes('//')) throw new Error(`${field} must not contain "//"`);
  return value;
}

/** Validate that a value is a UUID (v4 format). Throws if invalid. */
export function validateUUID(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new Error(`${field} must be a valid UUID`);
  return value;
}
