import type { LandingState } from './types';

export function isLandedTaskState(state: LandingState | null | undefined): boolean {
  return (
    state === 'landed_pending_review' || state === 'landed_cleanup_failed' || state === 'reviewed'
  );
}
