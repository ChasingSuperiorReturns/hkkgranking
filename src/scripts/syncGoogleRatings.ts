import dotenv from 'dotenv';
import { prisma } from '../models/prismaClient';

dotenv.config();

const mapsApiKey = process.env.GOOGLE_MAPS_API_KEY;

if (!mapsApiKey) {
  console.error('Missing GOOGLE_MAPS_API_KEY in environment.');
  process.exit(1);
}

type FindPlaceResponse = {
  candidates?: Array<{ place_id?: string }>;
  status?: string;
};

type PlaceDetailsResponse = {
  result?: {
    place_id?: string;
    rating?: number;
    user_ratings_total?: number;
    formatted_address?: string;
  };
  status?: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSearchInput(school: {
  name: string;
  chineseName: string | null;
  district: string | null;
  address: string;
}) {
  const primaryName = school.chineseName && school.chineseName.trim() ? school.chineseName : school.name;
  const district = school.district ?? '';
  return `${primaryName} ${district} Hong Kong`.trim();
}

async function findPlaceId(input: string) {
  const url = new URL('https://maps.googleapis.com/maps/api/place/findplacefromtext/json');
  url.searchParams.set('input', input);
  url.searchParams.set('inputtype', 'textquery');
  url.searchParams.set('fields', 'place_id');
  url.searchParams.set('language', 'zh-HK');
  url.searchParams.set('key', mapsApiKey!);

  const response = await fetch(url.toString());
  if (!response.ok) return null;

  const json = (await response.json()) as FindPlaceResponse;
  const placeId = json.candidates?.[0]?.place_id;
  return placeId || null;
}

async function fetchPlaceRating(placeId: string) {
  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  url.searchParams.set('place_id', placeId);
  url.searchParams.set('fields', 'place_id,rating,user_ratings_total,formatted_address');
  url.searchParams.set('key', mapsApiKey!);

  const response = await fetch(url.toString());
  if (!response.ok) return null;

  const json = (await response.json()) as PlaceDetailsResponse;
  if (!json.result) return null;

  return {
    placeId: json.result.place_id || placeId,
    rating: typeof json.result.rating === 'number' ? json.result.rating : null,
    ratingsTotal:
      typeof json.result.user_ratings_total === 'number' ? json.result.user_ratings_total : null,
    formattedAddress:
      typeof json.result.formatted_address === 'string' ? json.result.formatted_address : null,
  };
}

async function run() {
  const schools = (await (prisma as any).kindergarten.findMany({
    select: {
      id: true,
      name: true,
      chineseName: true,
      district: true,
      address: true,
      googlePlaceId: true,
    },
    orderBy: { name: 'asc' },
  })) as Array<{
    id: string;
    name: string;
    chineseName: string | null;
    district: string | null;
    address: string;
    googlePlaceId?: string | null;
  }>;

  let updated = 0;
  let missing = 0;

  for (const school of schools) {
    try {
      const existingPlaceId = school.googlePlaceId || null;
      const placeId = existingPlaceId || (await findPlaceId(buildSearchInput(school)));

      if (!placeId) {
        missing += 1;
        continue;
      }

      const details = await fetchPlaceRating(placeId);
      if (!details) {
        missing += 1;
        continue;
      }

      await (prisma as any).kindergarten.update({
        where: { id: school.id },
        data: {
          googlePlaceId: details.placeId,
          googleReviewScore: details.rating,
          googleReviewCount: details.ratingsTotal,
          googleFormattedAddress: details.formattedAddress,
          googleUpdatedAt: new Date(),
        },
      });

      updated += 1;
      await sleep(80);
    } catch (error) {
      console.warn('Failed to sync rating for school:', school.name, error);
      missing += 1;
    }
  }

  console.log(`Google rating sync complete. updated=${updated} missing=${missing} total=${schools.length}`);
}

run()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
