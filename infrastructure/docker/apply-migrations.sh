#!/bin/sh
# Applies data/migrations/V*.sql then data/migrations/pending/*.sql, each once, in order.
# Uses the standard libpq variables (PGHOST, PGUSER, PGPASSWORD, PGDATABASE).
#   sh infrastructure/docker/apply-migrations.sh data/migrations
set -eu

dir="${1:-/migrations}"

psql -v ON_ERROR_STOP=1 -q -c \
  "CREATE TABLE IF NOT EXISTS schema_migrations (file TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"

apply() {
  file="$1"
  name="pending/$(basename "$file")"
  case "$file" in
    */pending/*) ;;
    *) name="$(basename "$file")" ;;
  esac
  # psql only interpolates :'var' in scripts read from stdin/files, not in -c.
  done_already="$(echo "SELECT 1 FROM schema_migrations WHERE file = :'name'" | psql -tA -v name="$name")"
  if [ -n "$done_already" ]; then
    return 0
  fi
  echo "applying $name"
  psql -v ON_ERROR_STOP=1 -q -f "$file"
  echo "INSERT INTO schema_migrations (file) VALUES (:'name')" | psql -v ON_ERROR_STOP=1 -q -v name="$name"
}

for f in $(ls "$dir"/V*.sql | sort); do
  apply "$f"
done
if ls "$dir"/pending/*.sql >/dev/null 2>&1; then
  for f in $(ls "$dir"/pending/*.sql | sort); do
    apply "$f"
  done
fi
echo "migrations up to date"
