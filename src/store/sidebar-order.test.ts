import { beforeEach, describe, expect, it } from 'vitest';
import { setStore } from './core';
import {
  computeGroupedTasks,
  computeSidebarTaskOrder,
  getCoordinatorChildren,
  isCoordinatedChild,
} from './sidebar-order';

beforeEach(() => {
  setStore('projects', [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'red' }]);
  setStore('taskOrder', ['coord-1', 'child-1', 'orphan-child', 'standalone']);
  setStore('collapsedTaskOrder', ['child-2']);
  setStore('tasks', {
    'coord-1': {
      id: 'coord-1',
      name: 'Coordinator',
      projectId: 'project-1',
      branchName: 'task/coord',
      worktreePath: '/repo/.worktrees/coord',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
      gitIsolation: 'worktree',
    },
    'child-1': {
      id: 'child-1',
      name: 'Child',
      projectId: 'project-1',
      branchName: 'task/child',
      worktreePath: '/repo/.worktrees/child',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
      gitIsolation: 'worktree',
      coordinatedBy: 'coord-1',
    },
    'child-2': {
      id: 'child-2',
      name: 'Collapsed child',
      projectId: 'project-1',
      branchName: 'task/child-2',
      worktreePath: '/repo/.worktrees/child-2',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
      gitIsolation: 'worktree',
      coordinatedBy: 'coord-1',
      collapsed: true,
    },
    'orphan-child': {
      id: 'orphan-child',
      name: 'Orphan child',
      projectId: 'project-1',
      branchName: 'task/orphan-child',
      worktreePath: '/repo/.worktrees/orphan-child',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
      gitIsolation: 'worktree',
      coordinatedBy: 'missing-coord',
    },
    standalone: {
      id: 'standalone',
      name: 'Standalone',
      projectId: 'project-1',
      branchName: 'task/standalone',
      worktreePath: '/repo/.worktrees/standalone',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
      gitIsolation: 'worktree',
    },
  });
});

describe('coordinated sidebar grouping', () => {
  it('returns coordinator children without flattening them into project groups', () => {
    expect(getCoordinatorChildren('coord-1')).toEqual({
      active: ['child-1'],
      collapsed: ['child-2'],
    });
    expect(isCoordinatedChild('child-1')).toBe(true);
    expect(isCoordinatedChild('orphan-child')).toBe(false);

    expect(computeGroupedTasks().grouped['project-1']).toEqual({
      active: ['coord-1', 'orphan-child', 'standalone'],
      collapsed: [],
    });
  });

  it('includes coordinator children in visual navigation order', () => {
    expect(computeSidebarTaskOrder()).toEqual([
      'coord-1',
      'child-1',
      'child-2',
      'orphan-child',
      'standalone',
    ]);
  });
});
