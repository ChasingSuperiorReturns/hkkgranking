import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getJwtSecret, isProduction } from '../config';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export const SESSION_COOKIE = 'token';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const sessionCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'lax' as const,
  path: '/',
};

export function issueSession(res: Response, userId: string) {
  const token = jwt.sign({ sub: userId }, getJwtSecret(), {
    algorithm: 'HS256',
    expiresIn: Math.floor(SESSION_MAX_AGE_MS / 1000),
  });
  res.cookie(SESSION_COOKIE, token, { ...sessionCookieOptions, maxAge: SESSION_MAX_AGE_MS });
}

function readUserId(req: Request): string | undefined {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return undefined;
  try {
    const payload = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
    return typeof payload === 'object' && typeof payload.sub === 'string' ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const userId = readUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  req.userId = userId;
  next();
}

/** Sets req.userId when a valid session exists, but lets anonymous requests through. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  req.userId = readUserId(req);
  next();
}
