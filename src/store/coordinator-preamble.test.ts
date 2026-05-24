import { describe, expect, it } from 'vitest';
import { COORDINATOR_PREAMBLE } from './coordinator-preamble';

describe('COORDINATOR_PREAMBLE', () => {
  it('warns coordinators not to resend assignments based on startup placeholders', () => {
    expect(COORDINATOR_PREAMBLE).toContain('do NOT assume the initial assignment failed');
    expect(COORDINATOR_PREAMBLE).toContain('Improve documentation in @filename');
    expect(COORDINATOR_PREAMBLE).toContain('Wait briefly');
    expect(COORDINATOR_PREAMBLE).toContain('re-sending the full task');
  });
});
