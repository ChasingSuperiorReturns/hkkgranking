import crypto from 'crypto';

export const isProduction = process.env.NODE_ENV === 'production';

let jwtSecret: string | undefined;

/**
 * Secret used to sign session cookies. Production refuses to start without one; elsewhere a
 * random per-process secret is used so a forgotten JWT_SECRET can never mean a guessable key.
 */
export function getJwtSecret(): string {
  if (jwtSecret) return jwtSecret;

  if (process.env.JWT_SECRET) {
    jwtSecret = process.env.JWT_SECRET;
  } else if (isProduction) {
    throw new Error('JWT_SECRET must be set when NODE_ENV=production.');
  } else {
    console.warn('JWT_SECRET is not set; using a random secret (sessions reset on restart).');
    jwtSecret = crypto.randomBytes(32).toString('hex');
  }

  return jwtSecret;
}

export function getOtpSecret(): string {
  return process.env.EMAIL_OTP_SECRET || getJwtSecret();
}

export function requireEmailVerified(): boolean {
  return (process.env.REQUIRE_EMAIL_VERIFIED || 'true').toLowerCase() !== 'false';
}

/**
 * Number of reverse proxies in front of the app (Render, Cloud Run and most PaaS hosts use one).
 * Without this, every visitor shares the proxy's IP and therefore one rate-limit bucket.
 */
export function getTrustProxy(): number {
  const raw = process.env.TRUST_PROXY?.trim();
  const value = raw ? Number(raw) : 1;
  return Number.isInteger(value) && value >= 0 ? value : 1;
}

export function getAllowedOrigins(): string[] {
  const origins = new Set<string>();
  for (const value of [process.env.FRONTEND_URL, process.env.BASE_URL]) {
    if (!value) continue;
    try {
      origins.add(new URL(value).origin);
    } catch {
      console.warn(`Ignoring invalid URL in environment: ${value}`);
    }
  }
  return [...origins];
}
