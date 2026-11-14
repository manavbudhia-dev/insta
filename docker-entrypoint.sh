#!/bin/sh
# Starts as root only to fix ownership of the data volume, then runs the app as the unprivileged "node" user.
# If that is not possible (some platforms mount volumes in a way that forbids it) it falls back to running as before.
set -e
DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DIR" 2>/dev/null || true
  chown -R node:node "$DIR" 2>/dev/null || true
  if setpriv --reuid=node --regid=node --init-groups sh -c "test -w \"$DIR\"" 2>/dev/null; then
    exec setpriv --reuid=node --regid=node --init-groups "$@"
  fi
  echo "warning: $DIR is not writable by the unprivileged user; running as root" >&2
fi
exec "$@"
