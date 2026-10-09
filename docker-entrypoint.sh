#!/usr/bin/env bash
# Drop privileges to the host uid/gid when provided (so bind-mounted sandbox
# files are host-owned on Linux), then run the long-lived agent.
set -e

mkdir -p /transcripts 2>/dev/null || true

if [ -n "${HOST_UID:-}" ] && [ -n "${HOST_GID:-}" ] && [ -x /usr/bin/setpriv ]; then
  groupmod -o -g "${HOST_GID}" agent >/dev/null 2>&1 || true
  usermod -o -u "${HOST_UID}" -g "${HOST_GID}" agent >/dev/null 2>&1 || true
  chown -R agent:agent /home/agent >/dev/null 2>&1 || true
  for d in /sandbox /transcripts /agent-run; do
    chown agent:agent "$d" >/dev/null 2>&1 || true
  done
  exec setpriv --reuid=agent --regid=agent --init-groups -- \
    /usr/bin/env HOME=/home/agent node /app/agent/main.mjs
fi

exec node /app/agent/main.mjs
