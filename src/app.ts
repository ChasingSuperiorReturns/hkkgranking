import express, { NextFunction, Request, Response } from 'express';
import compression from 'compression';
import cors from 'cors';
import path from 'path';
import cookieParser from 'cookie-parser';
import { router as authRouter } from './routes/auth';
import { router as kindergartenRouter } from './routes/kindergarten';
import { router as reviewRouter } from './routes/review';
import { getAllowedOrigins, getTrustProxy } from './config';

export function createApp() {
  const app = express();
  const publicDir = path.resolve(__dirname, '../public');

  app.disable('x-powered-by');
  // Hosting platforms put a proxy in front of the app; trust it so req.ip is the visitor's IP.
  app.set('trust proxy', getTrustProxy());

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });
  app.use(compression());
  // The site calls its own API same-origin; only the configured site URLs may make credentialed calls.
  app.use(cors({ origin: getAllowedOrigins(), credentials: true }));
  app.use(express.json({ limit: '20kb' }));
  app.use(cookieParser());
  app.use(express.static(publicDir));

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/kindergartens', kindergartenRouter);
  app.use('/api/reviews', reviewRouter);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);

    // Malformed or oversized JSON bodies from express.json().
    const status = (err as { status?: number })?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return res.status(status).json({ error: 'Invalid request' });
    }

    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  });

  return app;
}
