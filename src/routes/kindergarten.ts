import express, { Request, Response } from 'express';
import { prisma } from '../models/prismaClient';
import { optionalAuth } from '../middleware/auth';
import { getSchoolSnapshot } from '../services/schools';
import { RankedSchool } from '../services/ranking';
import { asyncHandler } from '../utils/asyncHandler';

const router = express.Router();

const SCHOOL_TYPES = new Set(['PUBLIC', 'PRIVATE', 'INTERNATIONAL']);

function filterSchools(schools: RankedSchool[], query: Request['query']) {
  const area = typeof query.area === 'string' ? query.area : '';
  const type = typeof query.type === 'string' ? query.type.toUpperCase() : '';

  return schools.filter(
    (school) =>
      (!area || school.area.name === area) && (!SCHOOL_TYPES.has(type) || school.type === type),
  );
}

// GET /api/kindergartens?area=&type= — schools ranked within each area.
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { schools } = await getSchoolSnapshot();
    res.json(filterSchools(schools, req.query));
  }),
);

router.get(
  '/areas',
  asyncHandler(async (_req: Request, res: Response) => {
    const { schools } = await getSchoolSnapshot();
    res.json([...new Set(schools.map((school) => school.area.name))].sort());
  }),
);

router.get(
  '/top-by-area',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.max(1, Math.min(20, Number(req.query.limit) || 5));
    const { schools } = await getSchoolSnapshot();

    const grouped = new Map<string, RankedSchool[]>();
    for (const school of schools) {
      const list = grouped.get(school.area.name) ?? [];
      if (list.length < limit) list.push(school);
      grouped.set(school.area.name, list);
    }

    res.json([...grouped.entries()].map(([area, areaSchools]) => ({ area, schools: areaSchools })));
  }),
);

router.get(
  '/:id',
  optionalAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const snapshot = await getSchoolSnapshot();
    const school = snapshot.byId.get(req.params.id);
    if (!school) {
      return res.status(404).json({ error: 'Kindergarten not found' });
    }

    const myReview = req.userId
      ? await prisma.review.findFirst({
          where: {
            userId: req.userId,
            kindergartenId: { in: snapshot.membersById.get(school.id) ?? [school.id] },
          },
          select: { rating: true, comment: true, createdAt: true },
        })
      : null;

    return res.json({ ...school, myReview });
  }),
);

export { router };
