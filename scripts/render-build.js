#!/usr/bin/env node
/**
 * Render build script:
 * 1. Copy PostgreSQL schema into place
 * 2. Generate Prisma client
 * 3. Build TypeScript
 * 4. Push schema to database
 * 5. Seed data if database is empty
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: path.resolve(__dirname, '..') });
}

// Step 1: Use PostgreSQL schema if on Render (DATABASE_URL starts with postgres)
const dbUrl = process.env.DATABASE_URL || '';
if (dbUrl.startsWith('postgres')) {
  console.log('\\n=== Using PostgreSQL schema ===');
  const pgSchema = path.resolve(__dirname, '..', 'prisma', 'schema.postgresql.prisma');
  const target = path.resolve(__dirname, '..', 'prisma', 'schema.prisma');
  if (fs.existsSync(pgSchema)) {
    fs.copyFileSync(pgSchema, target);
    console.log('Copied schema.postgresql.prisma -> schema.prisma');
  }
}

// Step 2: Install deps and generate
run('npm ci');
run('npx prisma generate');

// Step 3: Build TypeScript
run('npx tsc');

// Step 4: Push schema to DB
run('npx prisma db push --accept-data-loss');

console.log('\\n=== Build complete ===');
