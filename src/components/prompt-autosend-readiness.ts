import { normalizeCurrentFrame } from '../store/taskStatus';

const STARTUP_BLOCKING_PATTERNS: RegExp[] = [
  /\bmodel:\s*loading\b/i,
  /\bBooting\s+MCP\s+server\b/i,
  /\bStarting\s+MCP\s+servers?\b/i,
];

export function isStartupBlockingAutoSend(tail: string): boolean {
  const frame = normalizeCurrentFrame(tail);
  if (!frame) return false;
  return STARTUP_BLOCKING_PATTERNS.some((re) => re.test(frame));
}
