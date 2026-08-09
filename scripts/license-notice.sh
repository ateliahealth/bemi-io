#!/usr/bin/env bash
# Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
# modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
# SSPL-1.0 section 5(a) requires modified files to carry a prominent notice
# that they were changed. `add` inserts the notice, `check` fails if it is
# missing; the pre-commit hook runs `add` over staged files so a new file or a
# first edit picks it up without anyone remembering to.
set -euo pipefail

MODE="${1:-check}"
MARKER='Part of a fork of Bemi'
YEAR=2026
UPSTREAM='https://github.com/BemiHQ/bemi-io'

notice_body() {
  printf '%s %s (%s),\n' "$1" "$MARKER" "$UPSTREAM"
  printf '%s modified by Atelia Health, %s. Licensed under SSPL-1.0; see LICENSE.\n' "$1" "$YEAR"
}

prefix_for() {
  case "$1" in
    *.ts | *.mts | *.js | *.mjs) printf '%s' '//' ;;
    *.sql) printf '%s' '--' ;;
    *.sh | *.properties | *.yml | *.yaml | *Dockerfile | .githooks/*) printf '%s' '#' ;;
    *) printf '%s' '' ;;
  esac
}

# Tracked text files that can carry a comment. Lockfiles, JSON and the vendored
# docs site are excluded: no comment syntax, or not ours to annotate.
#
# context/ is excluded because it is not a fork of anything. It is original
# work under its own MIT licence, kept separate precisely so applications can
# link it without inheriting SSPL. Stamping an SSPL notice on those files would
# assert the opposite of what its LICENSE says, which is worse than no notice
# at all - scripts/licence-boundary.sh enforces the rest of that separation.
target_files() {
  git ls-files -- \
    '*.ts' '*.mts' '*.js' '*.mjs' '*.sh' '*.sql' '*.properties' '*.yml' '*.yaml' \
    '*Dockerfile' '.githooks/*' \
    ':!:docs/**' ':!:**/dist/**' ':!:pnpm-lock.yaml' ':!:*/pnpm-lock.yaml' ':!:context/**'
}

# Only the top of the file counts. A bare substring search would match this
# script's own MARKER assignment and quietly certify it as already annotated.
has_notice() {
  head -n 4 "$1" | grep -q "$MARKER"
}

# Only files this fork actually diverges from upstream on may claim to be
# modified. Asserting it on a pristine upstream file would be a false notice.
diverged_files() {
  git diff --name-only "$(git merge-base "$UPSTREAM_REF" HEAD)" HEAD
}

add_to() {
  file="$1"
  prefix="$2"
  tmp="$(mktemp)"
  if head -n 1 "$file" | grep -q '^#!'; then
    head -n 1 "$file" >"$tmp"
    notice_body "$prefix" >>"$tmp"
    tail -n +2 "$file" >>"$tmp"
  else
    notice_body "$prefix" >"$tmp"
    cat "$file" >>"$tmp"
  fi
  # Write through the existing inode rather than `mv`, which would replace the
  # file with mktemp's 0600 and silently drop the executable bit.
  cat "$tmp" >"$file"
  rm -f "$tmp"
}

UPSTREAM_REF="${UPSTREAM_REF:-upstream/main}"

if [ "$MODE" = "add" ]; then
  # Staged paths only, so the notice lands on what is actually being changed.
  candidates="$(git diff --cached --name-only --diff-filter=ACMR)"
elif [ "$MODE" = "backfill" ]; then
  candidates="$(diverged_files)"
elif git rev-parse --verify --quiet "$UPSTREAM_REF" >/dev/null; then
  candidates="$(diverged_files)"
else
  echo "warning: $UPSTREAM_REF not available; skipping notice check." >&2
  exit 0
fi
eligible="$(target_files)"

missing=''
while IFS= read -r file; do
  [ -n "$file" ] || continue
  [ -f "$file" ] || continue
  printf '%s\n' "$eligible" | grep -qxF "$file" || continue
  has_notice "$file" && continue
  prefix="$(prefix_for "$file")"
  [ -n "$prefix" ] || continue

  if [ "$MODE" = "add" ] || [ "$MODE" = "backfill" ]; then
    # `git add` below stages the whole working-tree file. If the file also has
    # unstaged edits, those would ride along into the commit, silently undoing
    # a deliberate partial stage. Refuse rather than decide for the author.
    if [ "$MODE" = "add" ] && ! git diff --quiet -- "$file"; then
      echo "error: $file needs a licence notice but has unstaged changes." >&2
      echo "       Staging it here would commit those too. Either:" >&2
      echo "         - stage the rest of the file and commit again, or" >&2
      echo "         - run 'pnpm run license:add', then 'git add $file'" >&2
      exit 1
    fi
    add_to "$file" "$prefix"
    git add "$file"
    echo "notice added: $file"
  else
    missing="${missing}${file}"$'\n'
  fi
done <<EOF
$candidates
EOF

if [ -n "$missing" ]; then
  echo "Missing SSPL-1.0 modification notice in:" >&2
  printf '%s' "$missing" | sed 's/^/  /' >&2
  echo "Run: pnpm run license:add" >&2
  exit 1
fi

if [ "$MODE" = "check" ]; then
  echo "All eligible files carry the modification notice."
fi
