// Must run before any module reads process.env (the auth routes read OAuth settings on import).
import 'dotenv/config';
import { createApp } from './app';
import { getJwtSecret } from './config';
import { prisma } from './models/prismaClient';
import { invalidateSchoolSnapshot } from './services/schools';

// Fail fast (rather than on the first login) when production is missing its signing secret.
getJwtSecret();

const app = createApp();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;

// Auto-seed if database is empty (first deploy)
async function autoSeed() {
  try {
    const count = await prisma.kindergarten.count();
    if (count > 0) {
      console.log(`Database has ${count} kindergartens — skipping seed.`);
      return;
    }

    console.log('Database empty — running auto-seed...');
    const { runGovImport } = await import('./scripts/importGovKgp');
    await runGovImport();
    invalidateSchoolSnapshot();
  } catch (err) {
    console.error('Auto-seed failed:', err);
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Express server listening on port ${PORT}`);
  void autoSeed();
});
