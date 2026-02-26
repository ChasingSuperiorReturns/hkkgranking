#!/usr/bin/env node
/**
 * Render build script:
 * 1. Swap schema to PostgreSQL
 * 2. Install deps, generate Prisma client, build TypeScript
 * 3. Push schema to DB
 * 4. Seed data from EDB if needed
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const run = (cmd) => {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: __dirname });
};

// Step 1: Use PostgreSQL schema if DATABASE_URL starts with postgres
const dbUrl = process.env.DATABASE_URL || '';
if (dbUrl.startsWith('postgres')) {
  console.log('PostgreSQL detected — swapping schema...');
  const pgSchema = path.join(__dirname, 'prisma', 'schema.postgresql.prisma');
  const target = path.join(__dirname, 'prisma', 'schema.prisma');
  if (fs.existsSync(pgSchema)) {
    fs.copyFileSync(pgSchema, target);
    console.log('  schema.prisma → PostgreSQL');
  }
}

// Step 2: Generate & build
run('npx prisma generate');
run('npx tsc');

// Step 3: Push schema
run('npx prisma db push --accept-data-loss');

// Step 4: Check if data needs seeding
console.log('\nChecking if data needs seeding...');
run('node dist/scripts/checkAndSeed.js');
