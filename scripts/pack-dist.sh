#!/usr/bin/env bash
# Build the hand-out archive: sources + the packaged .vsix + INSTALL.md.
#
# node_modules is committed to this repo, and it holds a darwin-arm64 esbuild
# binary — shipping it means the archive does not build on any other platform.
# `git archive` honours the `export-ignore` rules in .gitattributes, which is
# where that exclusion lives; do not swap this for a plain `zip -r`.
set -euo pipefail

cd "$(dirname "$0")/.."
version=$(node -p "require('./package.json').version")
vsix="omp-code-${version}.vsix"
out="omp-code-${version}-src+vsix.zip"

[ -f "$vsix" ] || { echo "missing $vsix — run: npm run package" >&2; exit 1; }

if ! git diff --quiet HEAD -- . ':(exclude)node_modules'; then
  echo "warning: uncommitted changes are NOT in the archive (git archive reads HEAD)" >&2
fi

staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT

git archive --format=tar --prefix=omp-code/ HEAD | tar -x -C "$staging"
cp "$vsix" "$staging/omp-code/"

if [ -d "$staging/omp-code/node_modules" ]; then
  echo "node_modules leaked into the archive — check .gitattributes" >&2
  exit 1
fi

rm -f "$out"
(cd "$staging" && zip -qr "$OLDPWD/$out" omp-code)
echo "built $out ($(unzip -l "$out" | tail -1 | awk '{print $2}') files, $(du -h "$out" | cut -f1))"
