FROM node:22-slim

WORKDIR /app

# Install OpenSSL for Prisma
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Copy package files and install ALL deps (need @types/* for build)
COPY package.json package-lock.json ./
RUN npm ci

# sqlite (default) keeps data in a file inside the container, so reviews are lost whenever the
# container is replaced. Build with --build-arg DB_PROVIDER=postgresql and pass a PostgreSQL
# DATABASE_URL at runtime to keep data.
ARG DB_PROVIDER=sqlite

# Copy prisma schema (plus prisma/dev.db, if present, as initial data) and generate client
COPY prisma ./prisma
COPY scripts/set-db-provider.js ./scripts/
RUN node scripts/set-db-provider.js "$DB_PROVIDER" && npx prisma generate

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# Prune devDependencies after build
RUN npm prune --omit=dev

COPY public ./public
COPY scripts/docker-start.sh ./scripts/

ENV NODE_ENV=production
ENV PORT=8080
# SQLite paths are relative to prisma/, so this is /app/prisma/dev.db.
ENV DATABASE_URL=file:./dev.db

EXPOSE 8080

CMD ["sh", "scripts/docker-start.sh"]
