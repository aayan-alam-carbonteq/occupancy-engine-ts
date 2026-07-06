#!/usr/bin/env bash
# One-command bootstrap for occupancy-engine-ts. See AGENTS.md for the full harness.
set -euo pipefail

INSTALL_CMD="bun install"
VERIFY_CMD="bun run typecheck && bun test"
# Live single-address runs need the Python GraphQL server (separate repo) on :8000.
# The E2E test suite is self-contained (no server, no API key) and runs under VERIFY_CMD.
START_HINT="bun run run-address --address '1104 SPRING RUN RD' --zip 40514 --graphql-url http://127.0.0.1:8000/graphql"

echo "== occupancy-engine-ts init =="
echo "cwd: $(pwd)"
echo "bun: $(bun --version)  (pinned: $(cat .bun-version 2>/dev/null || echo '?'))"

echo "-- installing dependencies --"
eval "$INSTALL_CMD"

echo "-- verifying (typecheck + tests, incl. deterministic E2E) --"
eval "$VERIFY_CMD"

echo "-- ready --"
echo "Live run (needs Python GraphQL server on :8000):"
echo "  $START_HINT"
