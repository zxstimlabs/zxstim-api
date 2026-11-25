#!/usr/bin/env bash
#
# Runs ON THE SERVER as the `deploy` user. The CI/CD workflow uploads it
# with compose.yaml to /opt/<stack>/ and runs it over Tailscale SSH:
#
#   deploy.sh <stack> <host-port> <image-ref>      (stdin: GHCR read token; omit if the image is public)
#
#   stack       zxstim-api (production, main) | zxstim-api-dev (develop)
#   host-port   127.0.0.1 port the app is published on (8003 | 8004)
#   image-ref   ghcr.io/zxstimlabs/zxstim-api:<commit-sha>
#
# Same script as zxstimlabs/eth-rpc's deploy/deploy.sh (it is generic over
# stack/port/image); keep the two in sync.
#
# The workflow writes the environment's secrets to /opt/<stack>/.env.next
# first. This script swaps it in, pulls, restarts, and health-checks
# /health. If the new version isn't healthy within 30s it rolls back to
# the previous image and .env, and exits non-zero (the workflow fails).
#
# Safe to keep in the public repo: it holds no secrets. Secrets reach the
# server only at deploy time (.env.next over SSH; registry token on stdin,
# never argv, held only in RAM). Its output lands in public workflow logs, so it never prints
# secret values or container logs.

set -euo pipefail

stack=$1 port=$2 image=$3
dir=/opt/$stack
cd "$dir"

compose() {
  local img=$1; shift
  IMAGE=$img HOST_PORT=$port docker compose -p "$stack" -f compose.yaml "$@"
}

healthy() {
  # -s without -S: connection resets while the app is still starting are
  # expected for the first second or two; don't print them.
  for _ in $(seq 1 30); do
    curl -fs -o /dev/null --max-time 2 "http://127.0.0.1:$port/health" && return 0
    sleep 1
  done
  return 1
}

# Registry login, only if a token was piped in (the image is private). The
# token is the workflow's short-lived GITHUB_TOKEN (packages: read). It goes
# into a throwaway Docker config on tmpfs (RAM), removed on exit, so it
# never touches disk and ~/.docker/config.json is never used. Docker's
# "stored unencrypted" warning refers to that file, so it's dropped;
# a failed login still stops the deploy. With no token (public image),
# pulls are anonymous.
token=""
[ -t 0 ] || token=$(cat)
if [ -n "$token" ]; then
  DOCKER_CONFIG=$(mktemp -d /dev/shm/deploy-docker.XXXXXX)
  export DOCKER_CONFIG
  trap 'rm -rf "$DOCKER_CONFIG"' EXIT
  if ! printf '%s' "$token" | docker login ghcr.io -u github-actions --password-stdin >/dev/null 2>&1; then
    echo "deploy: registry login to ghcr.io failed" >&2
    exit 1
  fi
fi
unset token

[ -s .env.next ] || { echo "deploy: missing .env.next" >&2; exit 1; }
prev_image=$(cat .image 2>/dev/null || true)
[ -f .env ] && cp -p .env .env.prev
mv .env.next .env
chmod 600 .env

echo "deploy: $stack ← $image (127.0.0.1:$port)"
compose "$image" pull --quiet
compose "$image" up -d --no-build --remove-orphans

if healthy; then
  echo "$image" > .image
  rm -f .env.prev
  docker image prune -f >/dev/null 2>&1 || true
  echo "deploy: healthy"
  exit 0
fi

echo "deploy: $image failed its health check" >&2
# Don't print container logs here: on a public repo the workflow log is
# public, and GitHub only masks exact secret values, not fragments.
echo "deploy: inspect on the server: docker compose -p $stack -f $dir/compose.yaml logs app" >&2
if [ -n "$prev_image" ]; then
  [ -f .env.prev ] && mv .env.prev .env
  compose "$prev_image" up -d --no-build --remove-orphans
  if healthy; then echo "deploy: rolled back to $prev_image" >&2; else echo "deploy: rollback to $prev_image is ALSO unhealthy" >&2; fi
fi
exit 1
