import { describe, expect, it } from 'vitest';
import { computeDisableStdin, shouldForwardTerminalInput } from './terminalDisableStdin';

describe('computeDisableStdin', () => {
  it('disables stdin when task is coordinator-controlled', () => {
    expect(computeDisableStdin('coordinator')).toBe(true);
  });

  it('enables stdin when task is human-controlled', () => {
    expect(computeDisableStdin('human')).toBe(false);
  });

  it('enables stdin when controlledBy is undefined', () => {
    expect(computeDisableStdin(undefined)).toBe(false);
  });
});

describe('shouldForwardTerminalInput', () => {
  it('drops input while coordinator-controlled', () => {
    expect(shouldForwardTerminalInput('coordinator', false)).toBe(false);
  });

  it('drops input after the backend PTY is detached', () => {
    expect(shouldForwardTerminalInput('human', true)).toBe(false);
  });

  it('forwards input for human-controlled and uncoordinated live PTYs', () => {
    expect(shouldForwardTerminalInput('human', false)).toBe(true);
    expect(shouldForwardTerminalInput(undefined, false)).toBe(true);
  });
});
