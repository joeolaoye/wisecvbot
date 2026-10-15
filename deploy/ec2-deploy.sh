#!/bin/bash
set -euo pipefail

REVISION="${1:?Git revision is required}"
APP_DIR=/opt/wisecv/app
NEW_IMAGE="wisecv:${REVISION}"
OLD_IMAGE="$(docker inspect --format '{{.Config.Image}}' wisecv-app 2>/dev/null || true)"

cd "$APP_DIR"
git fetch --depth 1 origin "$REVISION"
git checkout --force --detach "$REVISION"

docker build --pull -t "$NEW_IMAGE" .

run_app() {
  local image="$1"
  docker run -d \
    --name wisecv-app \
    --network wisecv \
    --restart unless-stopped \
    --memory 640m \
    --memory-swap 1280m \
    --log-opt max-size=10m \
    --log-opt max-file=3 \
    --env-file /opt/wisecv/app/.env \
    --env-file /opt/wisecv/runtime.env \
    "$image" >/dev/null
}

docker rm -f wisecv-app >/dev/null 2>&1 || true
run_app "$NEW_IMAGE"

for attempt in $(seq 1 60); do
  if docker exec wisecv-app wget -qO- http://127.0.0.1:3000/healthz; then
    while read -r image; do
      if [ "$image" != "$NEW_IMAGE" ] && [ "$image" != "$OLD_IMAGE" ]; then
        docker image rm "$image" >/dev/null 2>&1 || true
      fi
    done < <(docker images wisecv --format '{{.Repository}}:{{.Tag}}')
    docker image prune -f >/dev/null
    docker builder prune -f --filter until=24h >/dev/null
    exit 0
  fi
  sleep 2
done

docker logs --tail 200 wisecv-app >&2 || true
docker rm -f wisecv-app >/dev/null 2>&1 || true

if [ -n "$OLD_IMAGE" ]; then
  echo "Deployment failed; restoring $OLD_IMAGE" >&2
  run_app "$OLD_IMAGE"
fi

exit 1
