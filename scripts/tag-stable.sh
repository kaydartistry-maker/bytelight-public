#!/usr/bin/env bash
# tag-stable.sh <tag-name> — cut a stable tag that means something.
#
# A stable tag is a claim: "this commit was checked and deployed working."
# The 09-02 audit found the claim not holding under momentum — stable tags
# cut on same-day repairs, the same fix shipping twice, 54 tags in one
# month. This script makes the machine-checked half of the claim a
# precondition instead of a memory:
#
#   1. Working tree is clean (you tag what is committed, not what you meant).
#   2. npm run check is green, right now, on this box.
#   3. npm test is green, right now, on this box.
#   4. Every build output (shared/dist, backend/dist, frontend/build) is
#      newer than HEAD — a stale dist means what's *running* is not what
#      you're tagging.
#
# What it cannot check is the half that actually gates stable: the operator drove
# the thing by hand. Run this only after the smoke card is done. The tag
# text records both halves.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TAG_NAME="${1:-}"
if [[ -z "$TAG_NAME" ]]; then
  echo "usage: scripts/tag-stable.sh <tag-name>   (e.g. stable-$(date +%Y-%m-%d)-wave0)" >&2
  exit 2
fi

if git rev-parse -q --verify "refs/tags/$TAG_NAME" >/dev/null; then
  echo "REFUSED: tag '$TAG_NAME' already exists." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain -uno)" ]]; then
  echo "REFUSED: tracked files have uncommitted changes. Commit or stash first — a stable tag points at a commit, not a mood." >&2
  git status --short -uno >&2
  exit 1
fi

UNTRACKED_COUNT=$(git status --porcelain | grep -c '^??' || true)
if [[ "$UNTRACKED_COUNT" -gt 0 ]]; then
  echo "note: $UNTRACKED_COUNT untracked path(s) present (not part of the tag; make sure none of them is source the build reads)."
fi

echo "== npm run check =="
npm run check

echo "== npm test =="
npm test

HEAD_TIME=$(git log -1 --format=%ct HEAD)
STALE=()
for OUT in packages/shared/dist packages/backend/dist packages/frontend/build; do
  if [[ ! -d "$OUT" ]]; then
    STALE+=("$OUT (missing)")
    continue
  fi
  NEWEST=$(find "$OUT" -type f -printf '%T@\n' 2>/dev/null | sort -n | tail -1 | cut -d. -f1)
  if [[ -z "$NEWEST" || "$NEWEST" -lt "$HEAD_TIME" ]]; then
    STALE+=("$OUT")
  fi
done

if [[ ${#STALE[@]} -gt 0 ]]; then
  echo "REFUSED: build output older than HEAD: ${STALE[*]}" >&2
  echo "You would be tagging a commit whose build has never run. npm run build, smoke, then tag." >&2
  exit 1
fi

read -r -p "Did the operator drive the smoke card by hand for this state? [y/N] " OPERATOR_SMOKE
if [[ "$OPERATOR_SMOKE" != "y" && "$OPERATOR_SMOKE" != "Y" ]]; then
  echo "REFUSED: the human smoke is the real gate. Machine-green is necessary, not sufficient." >&2
  exit 1
fi

git tag -a "$TAG_NAME" -m "stable: check+test green on deploy box $(date -u +%Y-%m-%dT%H:%MZ); dist fresh; the operator-smoked."
echo "Tagged $TAG_NAME at $(git rev-parse --short HEAD). Push with: git push origin $TAG_NAME"
