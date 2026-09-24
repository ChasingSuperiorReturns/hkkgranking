#!/usr/bin/env node
/**
 * Render build script:
 * 1. Switch the schema to PostgreSQL
 * 2. Generate Prisma client, build TypeScript
 * 3. Push schema to DB
 * 4. Seed data from EDB if needed
 */
const { execSync } = require('child_process');

const run = (cmd) => {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: __dirname });
};

// Step 1: Use PostgreSQL if DATABASE_URL starts with postgres
const dbUrl = process.env.DATABASE_URL || '';
if (dbUrl.startsWith('postgres')) {
  console.log('PostgreSQL detected — switching schema provider...');
  run('node scripts/set-db-provider.js postgresql');
}

// Step 2: Generate & build
run('npx prisma generate');
run('npx tsc');

// Step 3: Push schema. Without --accept-data-loss this stops, instead of deleting reviews, if a
// schema change would drop data; add a migration for such changes instead.
run('npx prisma db push --skip-generate');

// Step 4: Check if data needs seeding
console.log('\nChecking if data needs seeding...');
run('node dist/scripts/checkAndSeed.js');
