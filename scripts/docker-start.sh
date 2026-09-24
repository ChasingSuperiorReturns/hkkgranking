#!/bin/sh
set -e

# Older deployments pointed DATABASE_URL at /tmp/dev.db; give them a copy of the bundled database.
if [ "$DATABASE_URL" = "file:/tmp/dev.db" ] && [ -f /app/prisma/dev.db ] && [ ! -f /tmp/dev.db ]; then
  cp /app/prisma/dev.db /tmp/dev.db
fi

# Create any missing tables. Stops, rather than deleting data, if a schema change would lose data.
npx prisma db push --skip-generate

exec node dist/index.js
