import express, { NextFunction, Request, Response } from 'express';
import passport from 'passport';
import { Profile, Strategy as GoogleStrategy } from 'passport-google-oauth20';
import crypto from 'crypto';
import { prisma } from '../models/prismaClient';
import { authenticate, issueSession, SESSION_COOKIE, sessionCookieOptions } from '../middleware/auth';
import { verifyCaptchaToken } from '../utils/captcha';
import { sendEmailVerificationCode } from '../utils/mailer';
import { emailOtpSendLimiter, emailOtpVerifyLimiter } from '../middleware/rateLimit';
import { getOtpSecret, requireEmailVerified } from '../config';
import { asyncHandler } from '../utils/asyncHandler';

const router = express.Router();
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const baseUrl = process.env.BASE_URL;
const oauthConfigured = Boolean(googleClientId && googleClientSecret && baseUrl);

const RETURN_TO_COOKIE = 'returnTo';
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

type GoogleProfile = Pick<Profile, 'id' | 'displayName' | 'emails' | 'photos'>;

/**
 * Finds or creates the account for a Google sign-in. Google reports whether it has verified the
 * email address; if so the account counts as verified and needs no emailed code.
 */
export async function upsertGoogleUser(profile: GoogleProfile) {
  const primaryEmail = profile.emails?.[0];
  const email = primaryEmail?.value?.trim();
  if (!email) throw new Error('Google account has no email address');

  const verifiedByGoogle = primaryEmail?.verified === true;
  const image = profile.photos?.[0]?.value ?? null;
  const name = profile.displayName || null;

  const existing =
    (await prisma.user.findUnique({ where: { googleId: profile.id } })) ??
    (await prisma.user.findUnique({ where: { email } }));

  if (!existing) {
    return prisma.user.create({
      data: { googleId: profile.id, email, name, image, emailVerifiedAt: verifiedByGoogle ? new Date() : null },
    });
  }

  // Only link a Google account to an existing account by email once Google has verified that email.
  if (existing.googleId !== profile.id && !verifiedByGoogle) {
    throw new Error('Google has not verified this email address');
  }

  return prisma.user.update({
    where: { id: existing.id },
    data: {
      googleId: existing.googleId ?? profile.id,
      name: name ?? existing.name,
      image: image ?? existing.image,
      ...(verifiedByGoogle && !existing.emailVerifiedAt ? { emailVerifiedAt: new Date() } : {}),
    },
  });
}

if (oauthConfigured) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: googleClientId!,
        clientSecret: googleClientSecret!,
        callbackURL: `${baseUrl}/api/auth/google/callback`,
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          return done(null, await upsertGoogleUser(profile));
        } catch (err) {
          return done(err as Error);
        }
      },
    ),
  );
}

router.use(passport.initialize());

/** Accepts only same-site paths such as "/?school=abc", never "//evil.example". */
function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  return value;
}

function oauthNotConfigured(_req: Request, res: Response) {
  res.status(503).json({
    error: 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and BASE_URL.',
  });
}

if (!oauthConfigured) {
  router.get('/google', oauthNotConfigured);
  router.get('/google/callback', oauthNotConfigured);
} else {
  // GET /api/auth/google?returnTo=/?school=<id> brings the parent back to the page they were on.
  router.get('/google', (req: Request, res: Response, next: NextFunction) => {
    const returnTo = safeReturnPath(req.query.returnTo);
    if (returnTo) {
      res.cookie(RETURN_TO_COOKIE, returnTo, {
        ...sessionCookieOptions,
        path: '/api/auth',
        maxAge: 10 * 60 * 1000,
      });
    }
    passport.authenticate('google', { scope: ['profile', 'email'], session: false })(req, res, next);
  });

  router.get('/google/callback', (req: Request, res: Response, next: NextFunction) => {
    passport.authenticate('google', { session: false }, (err: unknown, user: { id: string } | false) => {
      if (err || !user) {
        if (err) console.error('Google sign-in failed:', err);
        return res.redirect('/?login=failed');
      }

      issueSession(res, user.id);
      const returnTo = safeReturnPath(req.cookies?.[RETURN_TO_COOKIE]);
      res.clearCookie(RETURN_TO_COOKIE, { ...sessionCookieOptions, path: '/api/auth' });

      const frontendUrl = process.env.FRONTEND_URL;
      if (returnTo) return res.redirect(frontendUrl ? new URL(returnTo, frontendUrl).toString() : returnTo);
      return res.redirect(frontendUrl ?? '/');
    })(req, res, next);
  });
}

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, email: true, emailVerifiedAt: true, name: true, image: true, createdAt: true },
    });

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    return res.json({ ...user, canReview: !requireEmailVerified() || Boolean(user.emailVerifiedAt) });
  }),
);

function hashVerificationCode(code: string) {
  return crypto.createHmac('sha256', getOtpSecret()).update(code).digest('hex');
}

function generateVerificationCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashesMatch(expectedHex: string, actualHex: string) {
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(actualHex, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

router.post(
  '/email/send-code',
  authenticate,
  emailOtpSendLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const captchaToken = typeof req.body?.captchaToken === 'string' ? req.body.captchaToken : undefined;

    const captchaResult = await verifyCaptchaToken(captchaToken, req.ip);
    if (!captchaResult.success) {
      return res.status(400).json({ error: 'CAPTCHA validation failed' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, emailVerifiedAt: true },
    });

    if (!user || !user.email) {
      return res.status(400).json({ error: 'Account email not found' });
    }

    if (user.emailVerifiedAt) {
      return res.status(200).json({ message: 'Email already verified', emailVerified: true });
    }

    const code = generateVerificationCode();
    const now = new Date();

    await prisma.$transaction([
      prisma.emailVerificationCode.updateMany({
        where: { userId, consumedAt: null },
        data: { consumedAt: now },
      }),
      prisma.emailVerificationCode.create({
        data: { userId, codeHash: hashVerificationCode(code), expiresAt: new Date(now.getTime() + OTP_TTL_MS) },
      }),
    ]);

    let sendResult;
    try {
      sendResult = await sendEmailVerificationCode(user.email, code);
    } catch (error) {
      console.error('Failed to send verification email:', error);
      return res.status(502).json({ error: 'Could not send the verification email. Please try again later.' });
    }

    if (!sendResult.delivered && !sendResult.codeExposed) {
      console.error('Email verification requested but SMTP is not configured.');
      return res.status(503).json({ error: 'Email verification is not available right now.' });
    }

    return res.status(200).json({
      message: sendResult.delivered ? 'Verification code sent' : 'SMTP not configured, code generated',
      emailVerified: false,
      ...(sendResult.codeExposed ? { devCode: code } : {}),
    });
  }),
);

router.post(
  '/email/verify',
  authenticate,
  emailOtpVerifyLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const code = String(req.body?.code ?? '').trim();
    const captchaToken = typeof req.body?.captchaToken === 'string' ? req.body.captchaToken : undefined;

    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Invalid verification code format' });
    }

    const captchaResult = await verifyCaptchaToken(captchaToken, req.ip);
    if (!captchaResult.success) {
      return res.status(400).json({ error: 'CAPTCHA validation failed' });
    }

    const latestCode = await prisma.emailVerificationCode.findFirst({
      where: { userId, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!latestCode) {
      return res.status(400).json({ error: 'No active verification code' });
    }

    if (latestCode.expiresAt.getTime() < Date.now()) {
      await prisma.emailVerificationCode.update({ where: { id: latestCode.id }, data: { consumedAt: new Date() } });
      return res.status(400).json({ error: 'Verification code expired' });
    }

    if (!hashesMatch(latestCode.codeHash, hashVerificationCode(code))) {
      const attempts = latestCode.attempts + 1;
      const exhausted = attempts >= OTP_MAX_ATTEMPTS;
      await prisma.emailVerificationCode.update({
        where: { id: latestCode.id },
        data: { attempts, ...(exhausted ? { consumedAt: new Date() } : {}) },
      });
      return res.status(400).json({
        error: exhausted ? 'Too many incorrect attempts. Please request a new code.' : 'Invalid verification code',
      });
    }

    const now = new Date();
    await prisma.$transaction([
      prisma.emailVerificationCode.update({ where: { id: latestCode.id }, data: { consumedAt: now } }),
      prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: now } }),
    ]);

    return res.status(200).json({ message: 'Email verified', emailVerified: true });
  }),
);

router.get('/captcha-config', (_req: Request, res: Response) => {
  const provider = (process.env.CAPTCHA_PROVIDER || 'recaptcha').toLowerCase();
  const siteKey = process.env.CAPTCHA_SITE_KEY || '';
  return res.json({
    provider,
    siteKey,
    enabled: Boolean(siteKey),
    requireEmailVerified: requireEmailVerified(),
    googleLoginEnabled: oauthConfigured,
  });
});

router.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions);
  res.status(204).send();
});

export { router };
