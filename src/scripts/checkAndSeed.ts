/**
 * Check if database has data; if empty, run the EDB import.
 * Used by Render build to auto-seed on first deploy.
 */
import 'dotenv/config';
import { prisma } from '../models/prismaClient';
import { runGovImport } from './importGovKgp';

async function checkAndSeed() {
  const count = await prisma.kindergarten.count();
  console.log(`  Current kindergarten count: ${count}`);

  if (count > 0) {
    console.log('  Database already has data — skipping seed.');
    return;
  }

  console.log('  Database is empty — running EDB import...');
  await runGovImport();
}

checkAndSeed()
  .catch((err) => {
    console.error('Seed check failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
