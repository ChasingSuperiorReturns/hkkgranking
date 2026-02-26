import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import path from 'path';
import cookieParser from 'cookie-parser';
import { router as authRouter } from './routes/auth';
import { router as kindergartenRouter } from './routes/kindergarten';
import { router as reviewRouter } from './routes/review';
import { prisma } from './models/prismaClient';

dotenv.config();

const app = express();
const publicDir = path.resolve(__dirname, '../public');

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.static(publicDir));

// Routes
app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.use('/api/auth', authRouter);
app.use('/api/kindergartens', kindergartenRouter);
app.use('/api/reviews', reviewRouter);

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;

// Auto-seed if database is empty (first deploy)
async function autoSeed() {
  try {
    const count = await prisma.kindergarten.count();
    if (count === 0) {
      console.log('Database empty — running auto-seed...');
      await import('./scripts/importGovKgp');
    } else {
      console.log(`Database has ${count} kindergartens — skipping seed.`);
    }
  } catch (err) {
    console.error('Auto-seed check failed:', err);
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Express server listening on port ${PORT}`);
  autoSeed();
});
