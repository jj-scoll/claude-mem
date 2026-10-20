#!/usr/bin/env bash
# Keep the jj-scoll/claude-mem fork current with thedotmack/claude-mem.
#
# Usage (run by hand, from anywhere):
#   scripts/sync-fork.sh              # fetch, rebase, rebuild, test, push (--force-with-lease)
#   scripts/sync-fork.sh --no-push    # everything except the push
#
# Steps: fetch upstream -> rebase fork commits on upstream/main -> rebuild the
# plugin bundle -> run the observer tests -> push fork main.
# A conflict limited to generated files (plugin/) is resolved by taking the
# upstream copy and rebuilding. A conflict in anything else stops the script
# with the rebase aborted and your branch untouched.
set -euo pipefail

PUSH=1
[ "${1:-}" = "--no-push" ] && PUSH=0

cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

BRANCH=main
OBSERVER_TESTS=(
  tests/sdk/observer-effort-cache-ttl.test.ts
  tests/worker/claude-provider-standalone-effort.test.ts
  tests/sdk/observer-thinking-option.test.ts
  tests/security/observer-tool-enforcement.test.ts
)

[ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || { echo "sync-fork: check out $BRANCH first" >&2; exit 1; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "sync-fork: working tree has uncommitted changes" >&2; exit 1; }

git fetch upstream
if git merge-base --is-ancestor upstream/main HEAD; then
  echo "sync-fork: already based on upstream/main ($(git rev-parse --short upstream/main))"
else
  if ! git rebase upstream/main; then
    while [ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ]; do
      conflicted=$(git diff --name-only --diff-filter=U)
      real=$(printf '%s\n' "$conflicted" | grep -v '^plugin/' || true)
      if [ -n "$real" ]; then
        git rebase --abort
        echo "sync-fork: SOURCE CONFLICT in the files below. Rebase aborted; $BRANCH is unchanged." >&2
        echo "$real" >&2
        echo "Resolve by hand: git rebase upstream/main, fix, git add, git rebase --continue, then re-run." >&2
        exit 2
      fi
      # Generated bundle only: take upstream's copy now, rebuild after the rebase.
      printf '%s\n' "$conflicted" | xargs -r git checkout --ours --
      printf '%s\n' "$conflicted" | xargs -r git add --
      GIT_EDITOR=true git rebase --continue || true
    done
  fi
fi

echo "sync-fork: rebuilding plugin bundle"
bun install
npm run build

if [ -n "$(git status --porcelain plugin)" ]; then
  # Fold the rebuilt bundle into the first fork commit that touches plugin/.
  target=$(git log upstream/main..HEAD --reverse --format=%H -- plugin | head -n 1)
  git add -A plugin
  if [ -n "$target" ]; then
    git commit -q --fixup="$target"
    GIT_SEQUENCE_EDITOR=true git rebase -q --autosquash upstream/main
  else
    git commit -q -m "chore: rebuild plugin bundle"
  fi
fi

echo "sync-fork: running observer tests"
bun test "${OBSERVER_TESTS[@]}"

if [ "$PUSH" = 1 ]; then
  git push --force-with-lease origin "$BRANCH"
else
  echo "sync-fork: --no-push given; skipped push"
fi
