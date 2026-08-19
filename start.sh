#!/bin/sh
# Movie & TV Stream Search Site - runtime launcher (POSIX sh).
#
# The Pterodactyl/Calagopus startup command just runs this file:
#     sh /home/container/start.sh
# All shell logic lives here in a real file (parsed directly by sh) instead
# of in the panel's startup string, which is eval'd and cannot reliably
# handle multi-statement if/then/fi blocks under BusyBox ash.

cd /home/container 2>/dev/null || cd "$(dirname "$0")" || exit 1

UPDATED=0

# Normalize GIT_ADDRESS into $ADDR (ensuring a .git suffix).
normalize_addr() {
    ADDR="${GIT_ADDRESS}"
    case "${ADDR}" in
        *.git) ;;
        *) ADDR="${ADDR}.git" ;;
    esac
}

fresh_clone() {
    normalize_addr
    rm -rf /tmp/app
    if git clone --depth 1 --single-branch --branch "${BRANCH:-main}" "${ADDR}" /tmp/app; then
        cp -a /tmp/app/. /home/container/
        rm -rf /tmp/app
        UPDATED=1
    else
        echo "git clone failed - check GIT_ADDRESS / BRANCH."
    fi
}

# 1) Self-heal: fetch the app if it isn't here yet.
if [ ! -f package.json ] && [ -n "${GIT_ADDRESS}" ]; then
    echo "App files not found - cloning ${GIT_ADDRESS} ..."
    fresh_clone
fi

# 2) Optional update-on-boot (works for both git and manual installs).
if [ "${AUTO_UPDATE}" = "1" ] && [ -n "${GIT_ADDRESS}" ]; then
    if [ -d .git ]; then
        echo "Updating (git pull) ..."
        if git pull; then UPDATED=1; else echo "git pull failed, using existing files"; fi
    else
        echo "Updating (fresh fetch from ${GIT_ADDRESS}) ..."
        fresh_clone
    fi
fi

# 3) Install dependencies when missing, or after an update (deps may have changed).
if [ -f package.json ] && { [ ! -d node_modules ] || [ "${UPDATED}" = "1" ]; }; then
    echo "Installing dependencies ..."
    npm install --omit=dev --no-audit --no-fund
fi

echo "Starting server ..."
# exec so node becomes the main process and receives stop signals directly.
exec node "${MAIN_FILE:-server.js}"
