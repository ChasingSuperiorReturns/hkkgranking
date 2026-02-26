FROM node:20-slim

WORKDIR /app

# Install OpenSSL for Prisma
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy prisma schema and generate client
COPY prisma ./prisma
RUN npx prisma generate

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# Copy public assets and database
COPY public ./public
COPY prisma/dev.db ./prisma/dev.db

# Expose port
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/index.js"]
