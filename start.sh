#!/bin/sh
# Movie & TV Stream Search Site - runtime launcher (POSIX sh).
#
# The Pterodactyl/Calagopus startup command just runs this file:
#     sh /home/container/start.sh
# All shell logic lives here in a real file (parsed directly by sh) instead
# of in the panel's startup string, which is eval'd and cannot reliably
# handle multi-statement if/then/fi blocks under BusyBox ash.

cd /home/container 2>/dev/null || cd "$(dirname "$0")" || exit 1

# Self-heal: if the app files are missing (e.g. the install step could not
# populate them) but a git repo is configured, fetch them now.
if [ ! -f package.json ] && [ -n "${GIT_ADDRESS}" ]; then
    echo "App files not found - cloning ${GIT_ADDRESS} ..."
    ADDR="${GIT_ADDRESS}"
    case "${ADDR}" in
        *.git) ;;
        *) ADDR="${ADDR}.git" ;;
    esac
    if git clone --depth 1 --single-branch --branch "${BRANCH:-main}" "${ADDR}" /tmp/app; then
        cp -a /tmp/app/. /home/container/
        rm -rf /tmp/app
    else
        echo "Clone failed - check GIT_ADDRESS / BRANCH."
    fi
fi

# Optional auto-update on boot.
if [ -d .git ] && [ "${AUTO_UPDATE}" = "1" ]; then
    echo "Updating from git ..."
    git pull || echo "git pull failed, using existing files"
fi

# Install dependencies if they are missing (node_modules is not committed).
if [ -f package.json ] && [ ! -d node_modules ]; then
    echo "Installing dependencies ..."
    npm install --omit=dev --no-audit --no-fund
fi

echo "Starting server ..."
# exec so node becomes the main process and receives stop signals directly.
exec node "${MAIN_FILE:-server.js}"
