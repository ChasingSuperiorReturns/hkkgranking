FROM node:20-slim

WORKDIR /app

# Install OpenSSL for Prisma
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Copy package files and install ALL deps (need @types/* for build)
COPY package.json package-lock.json ./
RUN npm ci

# Copy prisma schema and generate client
COPY prisma ./prisma
RUN npx prisma generate

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# Prune devDependencies after build
RUN npm prune --omit=dev

# Copy public assets and database
COPY public ./public
COPY prisma/dev.db ./prisma/dev.db

# Create startup script that copies DB to writable /tmp
RUN echo '#!/bin/sh\ncp -n /app/prisma/dev.db /tmp/dev.db 2>/dev/null || true\nexec node dist/index.js' > /app/start.sh && chmod +x /app/start.sh

# Expose port
EXPOSE 8080

CMD ["/app/start.sh"]
