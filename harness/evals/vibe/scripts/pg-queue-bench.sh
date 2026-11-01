#!/usr/bin/env bash
# Is a Postgres queue enough for a monthly batch of 5 000 rows? Both PayslipRun agents built one
# (FOR UPDATE SKIP LOCKED); the platform guidance and our rule buy a Valkey stream instead.
# This measures only the QUEUE (claim + complete one row), on the platform's own Postgres, in a
# throwaway database. Rendering a PDF costs orders of magnitude more than a claim.
#   bash pg-queue-bench.sh [rows=5000] [workers=4]
set -eu
ROWS="${1:-5000}"; WORKERS="${2:-4}"
PG="podman exec -i postgres.internal"
$PG psql -U postgres -qc "DROP DATABASE IF EXISTS qbench WITH (FORCE);" -c "CREATE DATABASE qbench;" >/dev/null
$PG psql -U postgres -d qbench -q <<SQL
CREATE TABLE jobs (id serial PRIMARY KEY, status text NOT NULL DEFAULT 'pending', claimed_at timestamptz, done_at timestamptz);
INSERT INTO jobs (status) SELECT 'pending' FROM generate_series(1, $ROWS);
CREATE INDEX jobs_pending ON jobs (id) WHERE status = 'pending';
SQL
cat > /tmp/qbench.sql <<'SQL'
WITH c AS (SELECT id FROM jobs WHERE status = 'pending' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
UPDATE jobs SET status = 'running', claimed_at = now() FROM c WHERE jobs.id = c.id RETURNING jobs.id AS jid \gset
UPDATE jobs SET status = 'done', done_at = now() WHERE id = :jid;
SQL
$PG bash -c "cat > /tmp/qbench.sql" < /tmp/qbench.sql
PER=$((ROWS / WORKERS))
START=$(date +%s.%N)
$PG pgbench -U postgres -n -f /tmp/qbench.sql -c "$WORKERS" -j "$WORKERS" -t "$PER" qbench 2>&1 | grep -E "tps|latency average|number of transactions actually"
END=$(date +%s.%N)
$PG psql -U postgres -d qbench -Atc "select 'done=' || count(*) filter (where status='done') || ' still_pending=' || count(*) filter (where status='pending') || ' stuck_running=' || count(*) filter (where status='running') from jobs;"
python3 -c "print('wall time for $ROWS claims with $WORKERS workers: %.2f s' % ($END - $START))"
$PG psql -U postgres -qc "DROP DATABASE IF EXISTS qbench WITH (FORCE);" >/dev/null
