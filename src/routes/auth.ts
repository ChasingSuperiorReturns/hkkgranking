import express, { Request, Response } from 'express';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { prisma } from '../models/prismaClient';
import { authenticate } from '../middleware/auth';
import { verifyCaptchaToken } from '../utils/captcha';
import { sendEmailVerificationCode } from '../utils/mailer';
import { emailOtpSendLimiter, emailOtpVerifyLimiter } from '../middleware/rateLimit';

const router = express.Router();
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const baseUrl = process.env.BASE_URL;
const oauthConfigured = Boolean(googleClientId && googleClientSecret && baseUrl);

if (oauthConfigured) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: googleClientId!,
        clientSecret: googleClientSecret!,
        callbackURL: `${baseUrl}/api/auth/google/callback`,
        passReqToCallback: true,
      },
      async (_req, _accessToken, _refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0].value;
          if (!email) return done(new Error('No email found'));
          let user = await prisma.user.findUnique({ where: { email } });
          if (!user) {
            user = await prisma.user.create({
              data: {
                googleId: profile.id,
                email,
                name: profile.displayName,
              },
            });
          }
          return done(null, user);
        } catch (err) {
          return done(err as Error);
        }
      },
    ),
  );
}

// Init passport middleware – must be after express-session is set up in main app
router.use(passport.initialize());

if (!oauthConfigured) {
  router.get('/google', (_req: Request, res: Response) => {
    res.status(503).json({
      error:
        'Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and BASE_URL.',
    });
  });

  router.get('/google/callback', (_req: Request, res: Response) => {
    res.status(503).json({
      error:
        'Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and BASE_URL.',
    });
  });
} else {
  router.get(
    '/google',
    passport.authenticate('google', { scope: ['profile', 'email'], session: false }),
  );

  router.get(
    '/google/callback',
    passport.authenticate('google', { failureRedirect: '/', session: false }),
    async (req: Request, res: Response) => {
      const user = req.user as any;
      if (!user) return res.redirect('/');

      const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET ?? 'secret', {
        expiresIn: '30d',
      });

      res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });

      res.redirect(process.env.FRONTEND_URL ?? '/');
    },
  );
}

router.get('/me', authenticate, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string | undefined;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      emailVerifiedAt: true,
      name: true,
      image: true,
      createdAt: true,
    },
  });

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return res.json(user);
});

function hashVerificationCode(code: string) {
  const salt = process.env.EMAIL_OTP_SECRET || process.env.JWT_SECRET || 'secret';
  return crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

function generateVerificationCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

router.post('/email/send-code', authenticate, emailOtpSendLimiter, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string | undefined;
  const captchaToken = (req.body?.captchaToken as string | undefined) ?? '';

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

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
  const codeHash = hashVerificationCode(code);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);

  await prisma.emailVerificationCode.updateMany({
    where: { userId, consumedAt: null },
    data: { consumedAt: now },
  });

  await prisma.emailVerificationCode.create({
    data: {
      userId,
      codeHash,
      expiresAt,
    },
  });

  const sendResult = await sendEmailVerificationCode(user.email, code);

  return res.status(200).json({
    message: sendResult.delivered ? 'Verification code sent' : 'SMTP not configured, code generated',
    emailVerified: false,
    ...(sendResult.codeExposed ? { devCode: code } : {}),
  });
});

router.post('/email/verify', authenticate, emailOtpVerifyLimiter, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string | undefined;
  const code = String(req.body?.code ?? '').trim();
  const captchaToken = (req.body?.captchaToken as string | undefined) ?? '';

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Invalid verification code format' });
  }

  const captchaResult = await verifyCaptchaToken(captchaToken, req.ip);
  if (!captchaResult.success) {
    return res.status(400).json({ error: 'CAPTCHA validation failed' });
  }

  const latestCode = await prisma.emailVerificationCode.findFirst({
    where: {
      userId,
      consumedAt: null,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  if (!latestCode) {
    return res.status(400).json({ error: 'No active verification code' });
  }

  if (latestCode.expiresAt.getTime() < Date.now()) {
    await prisma.emailVerificationCode.update({
      where: { id: latestCode.id },
      data: { consumedAt: new Date() },
    });
    return res.status(400).json({ error: 'Verification code expired' });
  }

  const expectedHash = hashVerificationCode(code);
  if (expectedHash !== latestCode.codeHash) {
    await prisma.emailVerificationCode.update({
      where: { id: latestCode.id },
      data: { attempts: { increment: 1 } },
    });
    return res.status(400).json({ error: 'Invalid verification code' });
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.emailVerificationCode.update({
      where: { id: latestCode.id },
      data: { consumedAt: now },
    }),
    prisma.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: now },
    }),
  ]);

  return res.status(200).json({ message: 'Email verified', emailVerified: true });
});

router.get('/captcha-config', (_req: Request, res: Response) => {
  const provider = (process.env.CAPTCHA_PROVIDER || 'recaptcha').toLowerCase();
  const siteKey = process.env.CAPTCHA_SITE_KEY || '';
  const requireEmailVerified =
    (process.env.REQUIRE_EMAIL_VERIFIED || 'true').toLowerCase() !== 'false';
  return res.json({ provider, siteKey, enabled: Boolean(siteKey), requireEmailVerified });
});

// Logout route – clears cookie and session
router.post('/logout', (_req, res) => {
  res.clearCookie('token');
  res.status(204).send();
});

export { router };
