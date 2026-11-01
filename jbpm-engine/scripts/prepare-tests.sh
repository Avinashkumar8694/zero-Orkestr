#!/bin/sh
# Everything the full test suite needs that is not plain TypeScript. Idempotent and quiet; run automatically by `npm test` (pretest).
#   1. the Java sidecar classes   (needs any JDK 17+; Homebrew's openjdk@17/21 is found automatically)
#   2. the extracted policy kjar  (extracted_projects/policy_system, from the zip in the repo root; used by the re-import journeys)
#   3. the mock integration server's dependencies (mock_server; the journey test starts and stops the server itself)
# A missing JDK, zip or npm only skips that part — the tests that need it then say so, they never hang.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
( cd "$ROOT/jbpm-engine/server" && npm run build:sidecar >/dev/null 2>&1 ) || true
ZIP="$ROOT/MySpace_policy_system (9).zip"
DEST="$ROOT/extracted_projects/policy_system"
if [ -f "$ZIP" ] && [ ! -f "$DEST/pom.xml" ] && command -v unzip >/dev/null 2>&1; then
  TMP="$(mktemp -d)" && unzip -q -o "$ZIP" -d "$TMP" && mkdir -p "$DEST" && cp -R "$TMP/project/." "$DEST/" && rm -rf "$TMP"
fi
if [ -f "$ROOT/mock_server/package.json" ] && [ ! -d "$ROOT/mock_server/node_modules" ]; then
  ( cd "$ROOT/mock_server" && npm ci --no-audit --no-fund >/dev/null 2>&1 ) || true
fi
exit 0
