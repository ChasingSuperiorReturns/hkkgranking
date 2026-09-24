#!/usr/bin/env node
/**
 * Switches prisma/schema.prisma between SQLite (local development) and PostgreSQL (hosts where
 * data must survive restarts and redeploys):
 *
 *   node scripts/set-db-provider.js postgresql
 *
 * Run `npx prisma generate` afterwards.
 */
const fs = require('fs');
const path = require('path');

const provider = process.argv[2];
if (!['sqlite', 'postgresql'].includes(provider)) {
  console.error('Usage: node scripts/set-db-provider.js <sqlite|postgresql>');
  process.exit(1);
}

const schemaPath = path.resolve(__dirname, '..', 'prisma', 'schema.prisma');
const schema = fs.readFileSync(schemaPath, 'utf8');
const pattern = /(datasource\s+db\s*\{[^}]*?provider\s*=\s*)"[a-z]+"/;

if (!pattern.test(schema)) {
  console.error(`Could not find the datasource provider in ${schemaPath}`);
  process.exit(1);
}

fs.writeFileSync(schemaPath, schema.replace(pattern, `$1"${provider}"`));
console.log(`prisma/schema.prisma now uses ${provider}`);
