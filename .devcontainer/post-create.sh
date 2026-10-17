#!/usr/bin/env bash
# postCreateCommand for .devcontainer/devcontainer.json.
#
# Deliberately short. postCreateCommand runs from scratch on every rebuild and
# VS Code holds the container "not ready" until it returns, so this file does
# only the things that are both fast and required before anything else works --
# fixing up the ownership of the named-volume mounts. Everything slow was split
# two ways:
#
#   - system packages (texlive, Playwright's shared libraries) moved into
#     .devcontainer/Dockerfile, where Docker caches them as image layers and a
#     rebuild skips them entirely
#   - the browser download and the bnb-ext dev build moved into
#     .devcontainer/deferred-setup.sh, launched detached at the bottom of this
#     file so they finish in the background while the workspace is already
#     usable
#
# Idempotent -- re-run it by hand from an integrated terminal if setup looks
# incomplete:
#   bash .devcontainer/post-create.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/home/node/.cache/ms-playwright}"
DEFERRED_LOG="/tmp/devcontainer-deferred-setup.log"

# Docker creates named-volume mounts (see devcontainer.json "mounts") owned by
# root, which leaves them unwritable by the "node" user that runs the tooling.
sudo chown -R node:node /home/node/.claude
sudo mkdir -p "$BROWSERS_PATH"
sudo chown -R node:node "$BROWSERS_PATH"

# Docker also creates any *parent* directory it has to invent in order to place
# a mount, and those are root-owned too. /home/node/.cache exists only because
# the ms-playwright volume above is mounted inside it, so nothing else can
# write there: `pnpm --filter bnb-ext test:e2e` logs EACCES for Electron's mesa
# shader cache and for VS Code's ~/.cache/Microsoft telemetry directory. Not
# recursive -- the volume's own contents are handled above.
sudo chown node:node /home/node/.cache

# Same problem, different owner: the claude-code devcontainer feature installs
# into npm's global prefix as root, so Claude Code's own updater can't replace
# the package. Background updates fail with "no_permissions" and the CLI goes
# stale without ever saying so. Group stays "npm" to match the rest of the
# prefix (it's setgid).
CLAUDE_CODE_PKG="$(npm -g config get prefix)/lib/node_modules/@anthropic-ai"
if [ -d "$CLAUDE_CODE_PKG" ]; then
	sudo chown -R node:npm "$CLAUDE_CODE_PKG"
fi

# Tell git that this directory is safe even though it's owned
# by a host user.
git config --global --add safe.directory "${REPO_ROOT}"

# Hand the rest off to a detached process and return immediately.
#
# setsid + </dev/null + redirected output is what actually detaches it: without
# all three the devcontainer CLI keeps waiting on the inherited stdout pipe and
# the "background" step blocks the build anyway.
setsid bash .devcontainer/deferred-setup.sh >"$DEFERRED_LOG" 2>&1 </dev/null &
disown

cat <<EOF

Container ready. The e2e browser download and the bnb-ext dev build are still
running in the background; follow them with

    tail -f $DEFERRED_LOG

They aren't needed for editing, \`pnpm test\`, \`pnpm build\`, or bnb-cli.
EOF
