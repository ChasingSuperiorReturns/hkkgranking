import express, { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../models/prismaClient';
import { authenticate } from '../middleware/auth';
import { verifyCaptchaToken } from '../utils/captcha';
import { reviewWriteLimiter } from '../middleware/rateLimit';
import { requireEmailVerified } from '../config';
import { getSchoolSnapshot, invalidateSchoolSnapshot } from '../services/schools';
import { asyncHandler } from '../utils/asyncHandler';

const router = express.Router();

export const MAX_COMMENT_LENGTH = 1000;

const reviewSelect = {
  id: true,
  kindergartenId: true,
  rating: true,
  comment: true,
  createdAt: true,
} as const;

/** Ids of the shown school and any duplicate records merged into it. */
async function resolveSchoolIds(kindergartenId: string): Promise<string[] | null> {
  const snapshot = await getSchoolSnapshot();
  const school = snapshot.byId.get(kindergartenId);
  if (school) {
    const members = snapshot.membersById.get(school.id) ?? [school.id];
    return [school.id, ...members.filter((id) => id !== school.id)];
  }

  // Added since the snapshot was built (e.g. right after an import).
  const exists = await prisma.kindergarten.findUnique({ where: { id: kindergartenId }, select: { id: true } });
  return exists ? [exists.id] : null;
}

// POST /api/reviews — rate a kindergarten. Each parent has one rating per school; posting again updates it.
router.post(
  '/',
  authenticate,
  reviewWriteLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const kindergartenId = typeof body.kindergartenId === 'string' ? body.kindergartenId : '';
    const { rating } = body;

    if (!kindergartenId || typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'kindergartenId and a whole-number rating from 1 to 5 are required' });
    }

    if (body.comment !== undefined && body.comment !== null && typeof body.comment !== 'string') {
      return res.status(400).json({ error: 'Comment must be text' });
    }
    const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
    if (comment.length > MAX_COMMENT_LENGTH) {
      return res.status(400).json({ error: `Comment must be at most ${MAX_COMMENT_LENGTH} characters` });
    }

    const captchaToken = typeof body.captchaToken === 'string' ? body.captchaToken : undefined;
    const captchaResult = await verifyCaptchaToken(captchaToken, req.ip);
    if (!captchaResult.success) {
      return res.status(400).json({ error: 'CAPTCHA validation failed' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } });
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (requireEmailVerified() && !user.emailVerifiedAt) {
      return res.status(403).json({ error: 'Email verification required before submitting a review' });
    }

    const schoolIds = await resolveSchoolIds(kindergartenId);
    if (!schoolIds) {
      return res.status(404).json({ error: 'Kindergarten not found' });
    }

    const data = { rating, comment: comment || null };
    const existing = await prisma.review.findFirst({
      where: { userId, kindergartenId: { in: schoolIds } },
      select: { id: true },
    });

    if (existing) {
      const review = await prisma.review.update({ where: { id: existing.id }, data, select: reviewSelect });
      invalidateSchoolSnapshot();
      return res.status(200).json({ ...review, updated: true });
    }

    try {
      const review = await prisma.review.create({
        data: { ...data, userId, kindergartenId: schoolIds[0] },
        select: reviewSelect,
      });
      invalidateSchoolSnapshot();
      return res.status(201).json({ ...review, updated: false });
    } catch (error) {
      // Two submissions raced past the lookup above; the unique index kept only one.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return res.status(409).json({ error: 'You have already rated this kindergarten.' });
      }
      throw error;
    }
  }),
);

export { router };
