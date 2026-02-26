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

# Expose port
EXPOSE 8080

CMD ["node", "dist/index.js"]
