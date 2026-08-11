#!/usr/bin/env bash
set -e

# Ensure bun is in PATH
export PATH="$HOME/.bun/bin:$PATH"

if ! command -v bun &> /dev/null; then
    echo "Error: bun is required but not found in PATH." >&2
    echo "Please install Bun or run: curl -fsSL https://bun.sh/install | bash" >&2
    exit 1
fi

# Set default model if provided or fallback
if [ -z "$GOOGLE_GENERATIVE_AI_API_KEY" ] && [ -n "$GEMINI_API_KEY" ]; then
    export GOOGLE_GENERATIVE_AI_API_KEY="$GEMINI_API_KEY"
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec bun run --cwd "$DIR/packages/opencode" ./src/index.ts "$@"
