import express, { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../models/prismaClient';

const router = express.Router();

const sampleKindergartens = [
  {
    id: 'sample-1',
    name: 'Happy Kids Kindergarten',
    chineseName: '快樂小朋友幼稚園',
    district: 'Tsim Sha Tsui',
    address: '1 Nathan Road, Tsim Sha Tsui',
    type: 'PRIVATE',
    area: { name: 'Kowloon' },
  },
  {
    id: 'sample-2',
    name: 'Sunshine International Kindergarten',
    chineseName: '陽光國際幼稚園',
    district: 'Central',
    address: '88 Queen\'s Road Central, Central',
    type: 'INTERNATIONAL',
    area: { name: 'Hong Kong Island' },
  },
  {
    id: 'sample-3',
    name: 'New Territories Public Nursery',
    chineseName: '新界公立幼兒學校',
    district: 'Sha Tin',
    address: '20 Sha Tin Centre Street, Sha Tin',
    type: 'PUBLIC',
    area: { name: 'New Territories' },
  },
];

function normalizeKeyPart(value: string | null | undefined) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractBracketContent(value: string | null | undefined) {
  const text = String(value ?? '');
  const match = text.match(/[（(]([^）)]+)[）)]/);
  return match ? normalizeKeyPart(match[1]) : '';
}

function extractStreamTag(name: string) {
  const value = normalizeKeyPart(name);
  if (value.includes('nonlocal') || value.includes('非本地')) return 'non-local';
  if (value.includes('local') || value.includes('本地')) return 'local';
  return '';
}

function normalizeSchoolBaseName(chineseName: string | null | undefined, englishName: string | null | undefined) {
  const source = chineseName && chineseName.trim() ? chineseName : englishName;
  return normalizeKeyPart(source)
    .replace(/（[^）]*）|\([^)]*\)/g, '')
    .replace(/kindergarten|nursery|pre\s*-?school|international/g, '')
    .replace(/幼稚園|幼兒園|幼兒學校|國際/g, '')
    .trim();
}

function dedupeSchools<T extends { externalId?: string | null; name?: string | null; chineseName?: string | null; district?: string | null; address?: string | null }>(schools: T[]) {
  const unique = new Map<string, T>();

  for (const school of schools) {
    const stream = extractStreamTag(String(school.chineseName ?? '') + ' ' + String(school.name ?? ''));
    const campus = extractBracketContent(school.chineseName) || extractBracketContent(school.name);
    const baseName = normalizeSchoolBaseName(school.chineseName, school.name);
    const district = normalizeKeyPart(school.district);
    const address = normalizeKeyPart(school.address);

    const key = [baseName, campus || district || address, stream].join('|');

    if (!unique.has(key)) {
      unique.set(key, school);
    }
  }

  return [...unique.values()];
}

function withStats<T extends { reviews?: Array<{ rating: number }> }>(school: T) {
  const reviews = school.reviews ?? [];
  const ratings = reviews.map((review) => review.rating);
  const avgRating = ratings.length
    ? Number((ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length).toFixed(1))
    : null;

  const googleRaw = (school as any).googleReviewScore ?? (school as any).googleScore ?? null;
  const googleRating =
    googleRaw === null || googleRaw === undefined || googleRaw === ''
      ? null
      : Number(Number(googleRaw).toFixed(1));

  let weightedScore: number | null = null;
  if (avgRating !== null && googleRating !== null) {
    weightedScore = Number((avgRating * 0.75 + googleRating * 0.25).toFixed(2));
  } else if (avgRating !== null) {
    weightedScore = avgRating;
  } else if (googleRating !== null) {
    weightedScore = googleRating;
  }

  return {
    ...school,
    reviews,
    avgRating,
    googleRating,
    weightedScore,
    reviewCount: reviews.length,
  };
}

// GET /api/kindergartens?area=&type=
router.get('/', async (req: Request, res: Response) => {
  const { area, type } = req.query as Record<string, string>;
  try {
    const filters: Prisma.KindergartenWhereInput = {};

    if (type) {
      const normalizedType = type.toUpperCase();
      if (
        normalizedType === 'PUBLIC' ||
        normalizedType === 'PRIVATE' ||
        normalizedType === 'INTERNATIONAL'
      ) {
        filters.type = normalizedType as any;
      }
    }
    if (area) {
      filters.area = {
        name: {
          equals: area,
        },
      };
    }

    const kindergartens = await prisma.kindergarten.findMany({
      where: filters,
      include: {
        area: true,
        reviews: {
          select: {
            id: true,
            rating: true,
            userId: true,
            createdAt: true,
            user: {
              select: {
                name: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { name: 'asc' },
    });

    const payload = dedupeSchools(kindergartens).map((school) => withStats(school));

    res.json(payload);
  } catch (err) {
    console.warn('Falling back to sample kindergarten data:', err);

    const filtered = sampleKindergartens.filter((school) => {
      const areaMatch = area ? school.area.name.toLowerCase() === area.toLowerCase() : true;
      const typeMatch = type ? school.type.toLowerCase() === type.toLowerCase() : true;
      return areaMatch && typeMatch;
    });

    res.json(
      filtered.map((item) => ({
        ...item,
        reviews: [],
        avgRating: null,
        reviewCount: 0,
      })),
    );
  }
});

router.get('/areas', async (_req: Request, res: Response) => {
  try {
    const areas = await prisma.area.findMany({
      orderBy: { name: 'asc' },
      select: { name: true },
    });
    res.json(areas.map((areaItem) => areaItem.name));
  } catch {
    res.json(['Hong Kong Island', 'Kowloon', 'New Territories']);
  }
});

router.get('/top-by-area', async (req: Request, res: Response) => {
  const limit = Math.max(1, Math.min(20, Number(req.query.limit ?? 5)));

  try {
    const schools = await prisma.kindergarten.findMany({
      include: {
        area: true,
        reviews: {
          select: {
            id: true,
            rating: true,
            userId: true,
            createdAt: true,
            user: {
              select: {
                name: true,
              },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    const grouped = new Map<string, any[]>();

    for (const school of dedupeSchools(schools).map((item) => withStats(item))) {
      const key = school.area?.name ?? 'Other';
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(school);
    }

    const result = [...grouped.entries()].map(([areaName, areaSchools]) => {
      const ranked = [...areaSchools].sort((a, b) => {
        const weightedA = a.weightedScore ?? -1;
        const weightedB = b.weightedScore ?? -1;
        if (weightedB !== weightedA) return weightedB - weightedA;
        if (b.reviewCount !== a.reviewCount) return b.reviewCount - a.reviewCount;
        return a.name.localeCompare(b.name);
      });

      return {
        area: areaName,
        schools: ranked.slice(0, limit),
      };
    });

    res.json(result);
  } catch {
    const byArea = new Map<string, any[]>();
    for (const school of sampleKindergartens) {
      const areaName = school.area.name;
      if (!byArea.has(areaName)) byArea.set(areaName, []);
      byArea.get(areaName)!.push({ ...school, reviews: [], avgRating: null, reviewCount: 0 });
    }
    res.json([...byArea.entries()].map(([areaName, schools]) => ({ area: areaName, schools })));
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;

  try {
    const school = await prisma.kindergarten.findUnique({
      where: { id },
      include: {
        area: true,
        reviews: {
          select: {
            id: true,
            rating: true,
            userId: true,
            createdAt: true,
            user: {
              select: {
                name: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!school) {
      return res.status(404).json({ error: 'Kindergarten not found' });
    }

    return res.json(withStats(school));
  } catch {
    return res.status(500).json({ error: 'Server error' });
  }
});

export { router };
