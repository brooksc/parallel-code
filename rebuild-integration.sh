#!/usr/bin/env bash
# Rebuilds the integration/all-prs worktree to latest main + PR 100 (orchestrator-control-v2).
# Run from anywhere in the repo.
set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
WORKTREE="$REPO_ROOT/.worktrees/integration"
PR_BRANCH="origin/feature/orchestrator-control-v2"

echo "==> Fetching origin..."
git -C "$REPO_ROOT" fetch origin

echo "==> Resetting integration worktree to origin/main..."
git -C "$WORKTREE" reset --hard origin/main

echo "==> Merging $PR_BRANCH..."
git -C "$WORKTREE" merge --no-edit "$PR_BRANCH"

echo ""
echo "Done. integration/all-prs is now at:"
git -C "$WORKTREE" log --oneline -3
