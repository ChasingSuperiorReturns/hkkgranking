import express, { Request, Response } from 'express';
import { prisma } from '../models/prismaClient';
import { authenticate } from '../middleware/auth';
import { verifyCaptchaToken } from '../utils/captcha';
import { reviewWriteLimiter } from '../middleware/rateLimit';

const router = express.Router();

router.post('/', authenticate, reviewWriteLimiter, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string | undefined;
  const { kindergartenId, rating, comment, captchaToken } = req.body as {
    kindergartenId?: string;
    rating?: number;
    comment?: string;
    captchaToken?: string;
  };

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!kindergartenId || typeof rating !== 'number') {
    return res.status(400).json({ error: 'kindergartenId and rating are required' });
  }

  if (rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5' });
  }

  try {
    const captchaResult = await verifyCaptchaToken(captchaToken, req.ip);
    if (!captchaResult.success) {
      return res.status(400).json({ error: 'CAPTCHA validation failed' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    const requireEmailVerified = (process.env.REQUIRE_EMAIL_VERIFIED || 'true').toLowerCase() !== 'false';
    const emailVerifiedAt = (user as any)?.emailVerifiedAt as Date | null | undefined;
    if (requireEmailVerified && !emailVerifiedAt) {
      return res.status(403).json({
        error: 'Email verification required before submitting a review',
      });
    }

    const existing = await prisma.review.findFirst({
      where: {
        userId,
        kindergartenId,
      },
    });

    if (existing) {
      return res.status(409).json({ error: 'You can only review each kindergarten once.' });
    }

    const review = await prisma.review.create({
      data: {
        userId,
        kindergartenId,
        rating,
        comment,
      },
      include: {
        user: {
          select: {
            name: true,
          },
        },
      },
    });

    return res.status(201).json(review);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to submit review' });
  }
});

export { router };
