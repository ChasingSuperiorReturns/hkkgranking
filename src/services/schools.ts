import { prisma } from '../models/prismaClient';
import { rankSchools, RankingResult, ReviewTotals } from './ranking';

// Every page needs the whole ranked list, so it is computed once and reused. A review written on
// this instance invalidates it immediately; other instances pick changes up within the TTL.
const CACHE_TTL_MS = 60 * 1000;

type Snapshot = RankingResult & { loadedAt: number };

let snapshot: Snapshot | null = null;
let pending: Promise<Snapshot> | null = null;
let generation = 0;

async function loadSnapshot(): Promise<Snapshot> {
  const [rows, totals] = await Promise.all([
    prisma.kindergarten.findMany({
      select: {
        id: true,
        externalId: true,
        name: true,
        chineseName: true,
        district: true,
        address: true,
        type: true,
        area: { select: { name: true } },
        googlePlaceId: true,
        googleReviewScore: true,
        googleReviewCount: true,
        googleFormattedAddress: true,
        googleUpdatedAt: true,
      },
    }),
    prisma.review.groupBy({
      by: ['kindergartenId'],
      _count: { _all: true },
      _sum: { rating: true },
    }),
  ]);

  const reviewTotals = new Map<string, ReviewTotals>(
    totals.map((row) => [row.kindergartenId, { count: row._count._all, sum: row._sum.rating ?? 0 }]),
  );

  return { ...rankSchools(rows, reviewTotals), loadedAt: Date.now() };
}

export async function getSchoolSnapshot(): Promise<Snapshot> {
  if (snapshot && Date.now() - snapshot.loadedAt < CACHE_TTL_MS) return snapshot;

  if (!pending) {
    const startedAt = generation;
    const load = loadSnapshot()
      .then((loaded) => {
        if (generation === startedAt) snapshot = loaded;
        return loaded;
      })
      .finally(() => {
        if (pending === load) pending = null;
      });
    pending = load;
  }
  return pending;
}

export function invalidateSchoolSnapshot() {
  generation += 1;
  snapshot = null;
  pending = null;
}
