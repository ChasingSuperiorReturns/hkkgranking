/**
 * Check if database has data; if empty, run the EDB import.
 * Used by Render build to auto-seed on first deploy.
 */
import { prisma } from '../models/prismaClient';
import dotenv from 'dotenv';
dotenv.config();

async function checkAndSeed() {
  const count = await prisma.kindergarten.count();
  console.log(`  Current kindergarten count: ${count}`);

  if (count > 0) {
    console.log('  Database already has data — skipping seed.');
    return;
  }

  console.log('  Database is empty — running EDB import...');

  // Dynamically import the import script to run it
  await import('./importGovKgp');
}

checkAndSeed()
  .catch((err) => {
    console.error('Seed check failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
