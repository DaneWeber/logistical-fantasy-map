#!/usr/bin/env bash
# The slow half of container setup, launched detached by post-create.sh so that
# VS Code reports the container ready -- and the workspace becomes usable --
# without waiting for it.
#
# Nothing in here blocks editing, type-checking, `pnpm test`, or bnb-cli. It is
# only the e2e suite's browser download and the dev build of the VS Code
# extension, both of which are fine to land a minute or two into the session.
#
# Idempotent, so re-run it by hand from an integrated terminal if it failed:
#   bash .devcontainer/deferred-setup.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Not `set -e`: each step below is independently optional and reports its own
# failure, and one flaky download shouldn't skip the step after it.
failed=()

echo "=== $(date -Is) deferred setup starting ==="

# CI=true is load-bearing for both pnpm invocations below. pnpm checks that
# node_modules is up to date before `exec`/`run`, and against a bind-mounted
# node_modules installed from the host it wants to purge and reinstall -- a
# prompt that hard-fails with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY when
# there's no TTY, and there is no TTY here.

# Build, package, and install bnb-ext so the container ends up with the dev
# build of the extension active. Refresh it after editing bnb-ext's source with
# `pnpm ext:install`.
#
# First because it's the one a person is more likely to want early. It does
# build bnb-core into packages/bnb-core/dist, so a `pnpm build` started by hand
# in the first minute of a session can race it; re-run either one if the result
# looks stale.
echo "--- pnpm install"
if ! CI=true pnpm install --frozen-lockfile; then
	echo "error: dependency installation failed; deferred setup cannot continue." >&2
	exit 1
fi

echo "--- pnpm ext:install"
if ! CI=true pnpm run ext:install; then
	failed+=("pnpm ext:install")
fi

# The browser build itself (~650MB). Its shared libraries are already in the
# image (see .devcontainer/Dockerfile), so --with-deps no-ops on the apt side,
# and the download is skipped entirely whenever the named volume is warm --
# which is every rebuild that isn't the first.
#
# chromium only: the one browser the suite and CI both use
# (.github/workflows/bnb-web-prs.yml installs exactly this).
echo "--- playwright install chromium"
if ! CI=true pnpm --filter bnb-web exec playwright install --with-deps chromium; then
	failed+=("playwright install chromium")
fi

echo "=== $(date -Is) deferred setup finished ==="

if [ ${#failed[@]} -eq 0 ]; then
	echo "All deferred setup steps succeeded."
	exit 0
fi

echo >&2
echo "warning: ${#failed[@]} deferred setup step(s) failed (see above)." >&2
for step in "${failed[@]}"; do
	case "$step" in
	"pnpm ext:install")
		echo "  - the dev build of bnb-ext isn't installed. Retry with:" >&2
		echo "        pnpm ext:install" >&2
		;;
	"playwright install chromium")
		echo "  - the bnb-web e2e suite won't run. Retry with:" >&2
		echo "        pnpm --filter bnb-web run test:e2e:install" >&2
		;;
	esac
done
echo "Everything else in the container is ready to use." >&2
exit 1
