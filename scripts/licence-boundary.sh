#!/usr/bin/env bash
# Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
# modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
#
# Enforces the licence boundary around context/.
#
# Most of this repository is SSPL-1.0. context/ is MIT, and is separate for one
# reason: it is linked into applications, and SSPL is copyleft. A single import
# from core/ or worker/ would make it a derivative of SSPL code and carry that
# licence into everything downstream that depends on it.
#
# That import would look like an obvious cleanup - the shared constant is right
# there, and duplicating four characters looks silly until you know why. Nobody
# reviewing it would see a licence change. So the boundary is a build failure
# rather than a comment.
set -uo pipefail

PKG=context
fail() { echo "FAIL: $1" >&2; exit 1; }

[ -f "$PKG/LICENSE" ] || fail "$PKG/LICENSE is missing"
head -n 3 "$PKG/LICENSE" | grep -q 'MIT License' || fail "$PKG/LICENSE is not the MIT licence"

grep -q '"license": "MIT"' "$PKG/package.json" || fail "$PKG/package.json does not declare MIT"

# Any dependency on a workspace package is a licence problem, not just the ones
# named today, so this matches the scope rather than specific package names.
# `workspace:` catches a local package referenced under any other name.
if grep -nE '"@bemi-db/|workspace:' "$PKG/package.json" >/dev/null 2>&1; then
  grep -nE '"@bemi-db/|workspace:' "$PKG/package.json" >&2
  fail "$PKG depends on a workspace package"
fi

# Matched on the specifier appearing at all, not on `from '...'`. An earlier
# version keyed on static import syntax, which `require()`, dynamic `import()`
# and double-quoted specifiers all slip past - and a boundary that only holds
# for the syntax someone happened to think of is not a boundary. There is no
# legitimate reason to name an SSPL package in here at all, including in a
# comment, so any mention fails.
offenders=$(grep -rnF '@bemi-db/' "$PKG/src" 2>/dev/null || true)
if [ -n "$offenders" ]; then
  echo "$offenders" >&2
  fail "$PKG references an SSPL package"
fi

# A relative path leaving the package reaches SSPL code whatever it resolves
# to, so it is rejected on shape rather than destination - and again on the
# specifier rather than the import form.
escapes=$(grep -rnE "['\"]\.\./\.\." "$PKG/src" 2>/dev/null || true)
if [ -n "$escapes" ]; then
  echo "$escapes" >&2
  fail "$PKG references a path outside its own directory"
fi

# The SSPL notice must not appear here: it would assert the file is part of the
# fork and covered by SSPL, contradicting LICENSE in the same directory.
if grep -rl 'Part of a fork of Bemi' "$PKG" >/dev/null 2>&1; then
  grep -rl 'Part of a fork of Bemi' "$PKG" >&2
  fail "$PKG carries an SSPL modification notice"
fi

echo "Licence boundary intact: $PKG is MIT and independent of the SSPL packages."
