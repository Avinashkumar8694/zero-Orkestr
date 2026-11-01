#!/bin/sh
# Real multi-replica test: separate processes, real Postgres + Redis. Uses PG_URL / REDIS_URL when set, else starts throw-away Docker containers.
set -e
cd "$(dirname "$0")/../server"
if [ -z "$PG_URL" ]; then
  docker rm -f orkestr-live-pg >/dev/null 2>&1 || true
  docker run -d --name orkestr-live-pg -e POSTGRES_USER=jbpm -e POSTGRES_PASSWORD=jbpm -e POSTGRES_DB=jbpm -p 5439:5432 postgres:16-alpine >/dev/null
  export PG_URL=postgresql://jbpm:jbpm@localhost:5439/jbpm; STARTED_PG=1
fi
if [ -z "$REDIS_URL" ]; then
  docker rm -f orkestr-live-redis >/dev/null 2>&1 || true
  docker run -d --name orkestr-live-redis -p 6390:6379 redis:7-alpine >/dev/null
  export REDIS_URL=redis://localhost:6390; STARTED_REDIS=1
fi
sleep 4
rc=0
node --import tsx --test test/live/*.test.ts test/cluster.test.ts test/pg/*.test.ts || rc=$?
[ -n "$STARTED_PG" ] && docker rm -f orkestr-live-pg >/dev/null 2>&1 || true
[ -n "$STARTED_REDIS" ] && docker rm -f orkestr-live-redis >/dev/null 2>&1 || true
exit $rc
