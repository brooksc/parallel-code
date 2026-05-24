export function computeDisableStdin(controlledBy: 'coordinator' | 'human' | undefined): boolean {
  return controlledBy === 'coordinator';
}

export function shouldForwardTerminalInput(
  controlledBy: 'coordinator' | 'human' | undefined,
  ptyDetached: boolean,
): boolean {
  return !ptyDetached && !computeDisableStdin(controlledBy);
}
