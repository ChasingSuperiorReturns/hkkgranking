/**
 * Fetches each kindergarten's Google rating with the Places API (New).
 * Enable "Places API (New)" for the key's project; the legacy Places API is not available to new projects.
 * Makes about one request per school, so check your Maps Platform quota before running.
 *
 *   npm run sync:google-ratings                 update every school
 *   npm run sync:google-ratings -- --dry-run    report matches without saving
 *   npm run sync:google-ratings -- --limit=20   only the first 20 schools
 */
import 'dotenv/config';
import { prisma } from '../models/prismaClient';
import { schoolNameMatch } from '../utils/names';

const PLACES_URL = 'https://places.googleapis.com/v1';
const PLACE_FIELDS = ['id', 'displayName', 'formattedAddress', 'rating', 'userRatingCount'];
// Keeps text searches inside Hong Kong.
const HONG_KONG_BOUNDS = {
  low: { latitude: 22.15, longitude: 113.82 },
  high: { latitude: 22.57, longitude: 114.45 },
};
/** Below this, a search result is treated as a different place and ignored. */
export const MIN_NAME_MATCH = 0.6;
const REQUEST_DELAY_MS = 100;

export type Place = {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  rating?: number;
  userRatingCount?: number;
};

type SchoolToSync = {
  id: string;
  name: string;
  chineseName: string | null;
  district: string | null;
  googlePlaceId: string | null;
};

class PlacesApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function placesRequest<T>(url: string, init: RequestInit, fieldMask: string): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY!,
      'X-Goog-FieldMask': fieldMask,
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new PlacesApiError(body.error?.message || `HTTP ${response.status}`, response.status);
  }
  return (await response.json()) as T;
}

async function searchPlaces(query: string): Promise<Place[]> {
  const json = await placesRequest<{ places?: Place[] }>(
    `${PLACES_URL}/places:searchText`,
    {
      method: 'POST',
      body: JSON.stringify({
        textQuery: query,
        languageCode: 'zh-HK',
        regionCode: 'HK',
        pageSize: 5,
        locationRestriction: { rectangle: HONG_KONG_BOUNDS },
      }),
    },
    PLACE_FIELDS.map((field) => `places.${field}`).join(','),
  );
  return json.places ?? [];
}

async function getPlace(placeId: string): Promise<Place | null> {
  try {
    return await placesRequest<Place>(
      `${PLACES_URL}/places/${encodeURIComponent(placeId)}?languageCode=zh-HK`,
      { method: 'GET' },
      PLACE_FIELDS.join(','),
    );
  } catch (error) {
    // The stored place was removed or its id is no longer valid.
    if (error instanceof PlacesApiError && (error.status === 400 || error.status === 404)) return null;
    throw error;
  }
}

/** The search result whose name best matches the school, if any is close enough. */
export function pickBestPlace(candidates: Place[], schoolNames: Array<string | null>): Place | null {
  let best: Place | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = schoolNameMatch(candidate.displayName?.text, schoolNames);
    if (score >= MIN_NAME_MATCH && score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function buildSearchInput(school: SchoolToSync) {
  const primaryName = school.chineseName?.trim() ? school.chineseName : school.name;
  return `${primaryName} ${school.district ?? ''} Hong Kong`.trim();
}

async function syncSchool(school: SchoolToSync, dryRun: boolean): Promise<'updated' | 'unmatched' | 'cleared'> {
  const schoolNames = [school.chineseName, school.name];
  const label = school.chineseName || school.name;
  let place: Place | null = null;
  let storedPlaceRejected = false;

  if (school.googlePlaceId) {
    const stored = await getPlace(school.googlePlaceId);
    if (stored && schoolNameMatch(stored.displayName?.text, schoolNames) >= MIN_NAME_MATCH) {
      place = stored;
    } else {
      storedPlaceRejected = true;
    }
  }

  if (!place) {
    place = pickBestPlace(await searchPlaces(buildSearchInput(school)), schoolNames);
  }

  if (!place) {
    if (!storedPlaceRejected) {
      console.log(`No confident Google match for ${label}`);
      return 'unmatched';
    }
    // The saved listing belongs to a different (or deleted) place, so its rating is wrong.
    console.warn(`Clearing Google data for ${label}: the saved place does not match and no match was found`);
    if (!dryRun) {
      await prisma.kindergarten.update({
        where: { id: school.id },
        data: {
          googlePlaceId: null,
          googleReviewScore: null,
          googleReviewCount: null,
          googleFormattedAddress: null,
          googleUpdatedAt: null,
        },
      });
    }
    return 'cleared';
  }

  if (dryRun) {
    console.log(`${label} -> ${place.displayName?.text} (${place.rating ?? '-'} from ${place.userRatingCount ?? 0})`);
  } else {
    await prisma.kindergarten.update({
      where: { id: school.id },
      data: {
        googlePlaceId: place.id,
        googleReviewScore: typeof place.rating === 'number' ? place.rating : null,
        googleReviewCount: typeof place.userRatingCount === 'number' ? place.userRatingCount : null,
        googleFormattedAddress: place.formattedAddress ?? null,
        googleUpdatedAt: new Date(),
      },
    });
  }
  return 'updated';
}

async function run() {
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    throw new Error('Missing GOOGLE_MAPS_API_KEY in environment.');
  }

  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limit = Number(args.find((arg) => arg.startsWith('--limit='))?.split('=')[1]) || undefined;

  const schools = await prisma.kindergarten.findMany({
    select: { id: true, name: true, chineseName: true, district: true, googlePlaceId: true },
    orderBy: { name: 'asc' },
    take: limit,
  });

  const counts = { updated: 0, unmatched: 0, cleared: 0, failed: 0 };
  for (const school of schools) {
    try {
      counts[await syncSchool(school, dryRun)] += 1;
    } catch (error) {
      // A bad key, disabled API, missing billing or exhausted quota affects every request: stop.
      if (error instanceof PlacesApiError && [401, 403, 429].includes(error.status)) {
        throw new Error(`Places API refused the request (${error.status}): ${error.message}`);
      }
      console.warn(`Failed to sync rating for ${school.name}:`, error instanceof Error ? error.message : error);
      counts.failed += 1;
    }
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(
    `Google rating sync complete${dryRun ? ' (dry run, nothing saved)' : ''}. ` +
      `updated=${counts.updated} unmatched=${counts.unmatched} cleared=${counts.cleared} ` +
      `failed=${counts.failed} total=${schools.length}`,
  );
}

if (require.main === module) {
  run()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
