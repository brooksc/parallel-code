import { describe, expect, it } from 'vitest';
import {
  clearPendingNotification,
  reconcilePendingNotification,
  type NotificationType,
} from './desktopNotifications';

describe('reconcilePendingNotification', () => {
  it('drops a queued notification when the task recovers before flush', () => {
    const pending = new Map<string, NotificationType>([['task-1', 'error']]);

    const result = reconcilePendingNotification(pending, 'task-1', 'error', 'active');

    expect(result).toBeNull();
    expect(pending.has('task-1')).toBe(false);
  });

  it('keeps scheduling real error transitions', () => {
    const pending = new Map<string, NotificationType>();

    const result = reconcilePendingNotification(pending, 'task-1', 'active', 'error');

    expect(result).toBe('error');
  });

  it('does not notify during initial population', () => {
    const pending = new Map<string, NotificationType>();

    const result = reconcilePendingNotification(pending, 'task-1', undefined, 'error');

    expect(result).toBeNull();
    expect(pending.has('task-1')).toBe(false);
  });

  it('drops queued notifications for removed tasks', () => {
    const pending = new Map<string, NotificationType>([['task-1', 'error']]);

    clearPendingNotification(pending, 'task-1');

    expect(pending.has('task-1')).toBe(false);
  });
});
