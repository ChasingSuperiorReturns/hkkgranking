import { extractBracketContent, normalizeText } from '../utils/names';

/**
 * Ranking = Bayesian average of every rating a school has (parent ratings on this site plus its
 * Google rating), starting from `priorWeight` pseudo-ratings of `priorMean`. A school with one
 * 5-star rating therefore can't outrank one with hundreds of 4.6s, and a single hostile rating
 * can't sink a well-reviewed school. The prior sits below typical ratings on purpose, so a school
 * has to earn its place with real ratings.
 */
export const RANKING_PARAMS = {
  /** Where a school with few ratings starts. */
  priorMean: 3.5,
  /** Pseudo-ratings at `priorMean` added to every school. */
  priorWeight: 10,
  /** How many Google ratings one parent rating on this site counts as. */
  siteReviewWeight: 3,
};

export type SchoolRow = {
  id: string;
  externalId: string | null;
  name: string;
  chineseName: string | null;
  district: string | null;
  address: string;
  type: string;
  area: { name: string };
  googlePlaceId: string | null;
  googleReviewScore: number | null;
  googleReviewCount: number | null;
  googleFormattedAddress: string | null;
  googleUpdatedAt: Date | null;
};

export type ReviewTotals = { count: number; sum: number };

export type RankedSchool = SchoolRow & {
  /** Average parent rating on this site. */
  avgRating: number | null;
  reviewCount: number;
  googleRating: number | null;
  /** Ranking score (see RANKING_PARAMS); null when the school has no ratings at all. */
  weightedScore: number | null;
  /** 1-based position within its area; null for schools without ratings. */
  areaRank: number | null;
  areaTotal: number;
};

export type RankingResult = {
  schools: RankedSchool[];
  /** Every school id (including hidden duplicates) -> the school shown for it. */
  byId: Map<string, RankedSchool>;
  /** Shown school id -> ids of all duplicate records merged into it. */
  membersById: Map<string, string[]>;
};

const GENERIC_WORDS = /kindergarten|nursery|preschool|international/g;
const GENERIC_WORDS_ZH = /幼稚園|幼兒園|幼兒學校|國際/g;

function streamTag(school: SchoolRow): string {
  const text = normalizeText(`${school.chineseName ?? ''} ${school.name}`);
  if (text.includes('nonlocal') || text.includes('非本地')) return 'non-local';
  if (text.includes('local') || text.includes('本地')) return 'local';
  return '';
}

/**
 * Records that describe the same school (e.g. listed once per session or with different
 * punctuation) share a key: base name without generic words, plus campus or district, plus stream.
 */
export function dedupeKey(school: SchoolRow): string {
  const source = school.chineseName?.trim() ? school.chineseName : school.name;
  const withoutBrackets = String(source).replace(/[（(][^）)]*[）)]/g, '');
  const baseName =
    normalizeText(withoutBrackets).replace(GENERIC_WORDS, '').replace(GENERIC_WORDS_ZH, '') ||
    normalizeText(source);
  const campus = extractBracketContent(school.chineseName) || extractBracketContent(school.name);
  const location = campus || normalizeText(school.district) || normalizeText(school.address);
  return [baseName, location, streamTag(school)].join('|');
}

function isKindergartenNamed(school: SchoolRow) {
  return /kindergarten/i.test(school.name) || /幼稚園/.test(school.chineseName ?? '');
}

function compareRepresentative(a: SchoolRow, b: SchoolRow) {
  const kindergartenFirst = Number(!isKindergartenNamed(a)) - Number(!isKindergartenNamed(b));
  if (kindergartenFirst !== 0) return kindergartenFirst;
  return a.name.localeCompare(b.name) || (a.externalId ?? a.id).localeCompare(b.externalId ?? b.id);
}

function googleVotes(school: Pick<SchoolRow, 'googleReviewScore' | 'googleReviewCount'>) {
  if (school.googleReviewScore === null || school.googleReviewScore === undefined) return 0;
  return Math.max(1, school.googleReviewCount ?? 1);
}

export function rankingScore(
  reviews: ReviewTotals,
  google: Pick<SchoolRow, 'googleReviewScore' | 'googleReviewCount'>,
  params = RANKING_PARAMS,
): number | null {
  const siteVotes = reviews.count * params.siteReviewWeight;
  const gVotes = googleVotes(google);
  if (siteVotes + gVotes === 0) return null;

  const total = reviews.sum * params.siteReviewWeight + (google.googleReviewScore ?? 0) * gVotes;
  return (params.priorMean * params.priorWeight + total) / (params.priorWeight + siteVotes + gVotes);
}

const round = (value: number | null, digits: number) =>
  value === null ? null : Number(value.toFixed(digits));

export function rankSchools(
  rows: SchoolRow[],
  reviewTotals: Map<string, ReviewTotals>,
  params = RANKING_PARAMS,
): RankingResult {
  const buckets = new Map<string, SchoolRow[]>();
  for (const row of rows) {
    const key = dedupeKey(row);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }

  const groups = [...buckets.values()].map((members) => {
    const [representative] = [...members].sort(compareRepresentative);
    const reviews = members.reduce<ReviewTotals>(
      (acc, member) => {
        const totals = reviewTotals.get(member.id);
        return totals ? { count: acc.count + totals.count, sum: acc.sum + totals.sum } : acc;
      },
      { count: 0, sum: 0 },
    );
    // Use the Google listing backed by the most ratings among the duplicates.
    const googleSource = [...members].sort((a, b) => googleVotes(b) - googleVotes(a))[0];
    const school: SchoolRow = {
      ...representative,
      googlePlaceId: googleSource.googlePlaceId,
      googleReviewScore: googleSource.googleReviewScore,
      googleReviewCount: googleSource.googleReviewCount,
      googleFormattedAddress: googleSource.googleFormattedAddress,
      googleUpdatedAt: googleSource.googleUpdatedAt,
    };
    return { school, reviews, memberIds: members.map((member) => member.id) };
  });

  const scored = groups.map(({ school, reviews, memberIds }) => ({
    school,
    reviews,
    memberIds,
    score: rankingScore(reviews, school, params),
    votes: reviews.count * params.siteReviewWeight + googleVotes(school),
  }));

  const byArea = new Map<string, typeof scored>();
  for (const entry of scored) {
    const list = byArea.get(entry.school.area.name);
    if (list) list.push(entry);
    else byArea.set(entry.school.area.name, [entry]);
  }

  const result: RankingResult = { schools: [], byId: new Map(), membersById: new Map() };
  for (const areaName of [...byArea.keys()].sort()) {
    const entries = byArea.get(areaName)!.sort(
      (a, b) =>
        (b.score ?? -1) - (a.score ?? -1) ||
        b.votes - a.votes ||
        a.school.name.localeCompare(b.school.name),
    );

    entries.forEach((entry, index) => {
      const ranked: RankedSchool = {
        ...entry.school,
        avgRating: entry.reviews.count ? round(entry.reviews.sum / entry.reviews.count, 1) : null,
        reviewCount: entry.reviews.count,
        googleRating: round(entry.school.googleReviewScore, 1),
        weightedScore: round(entry.score, 2),
        areaRank: entry.score === null ? null : index + 1,
        areaTotal: entries.length,
      };
      result.schools.push(ranked);
      result.membersById.set(ranked.id, entry.memberIds);
      for (const id of entry.memberIds) result.byId.set(id, ranked);
    });
  }

  return result;
}
