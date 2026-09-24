import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeKey, rankingScore, rankSchools, SchoolRow } from '../src/services/ranking';

let sequence = 0;
function school(overrides: Partial<SchoolRow> & { name: string }): SchoolRow {
  sequence += 1;
  return {
    id: `school-${sequence}`,
    externalId: `kgp-${sequence}`,
    chineseName: null,
    district: 'Tuen Mun',
    address: '',
    type: 'PUBLIC',
    area: { name: 'tuenmun' },
    googlePlaceId: null,
    googleReviewScore: null,
    googleReviewCount: null,
    googleFormattedAddress: null,
    googleUpdatedAt: null,
    ...overrides,
  };
}

const noReviews = { count: 0, sum: 0 };

test('score is a Bayesian average starting from 10 ratings of 3.5', () => {
  // (3.5 * 10 + 5 * 3 + 4.6 * 120) / (10 + 3 + 120)
  const score = rankingScore({ count: 1, sum: 5 }, { googleReviewScore: 4.6, googleReviewCount: 120 });
  assert.equal(Number(score!.toFixed(3)), 4.526);
});

test('a single 5-star rating does not outrank a well-reviewed school', () => {
  const lone = school({ name: 'Lone Star Kindergarten', googleReviewScore: 5, googleReviewCount: 1 });
  const popular = school({ name: 'Popular Kindergarten', googleReviewScore: 4.6, googleReviewCount: 120 });

  const { schools } = rankSchools([lone, popular], new Map());

  assert.deepEqual(
    schools.map((s) => [s.name, s.areaRank]),
    [
      ['Popular Kindergarten', 1],
      ['Lone Star Kindergarten', 2],
    ],
  );
});

test('one hostile rating barely moves a well-reviewed school', () => {
  const google = { googleReviewScore: 4.5, googleReviewCount: 100 };
  const before = rankingScore(noReviews, google)!;
  const after = rankingScore({ count: 1, sum: 1 }, google)!;
  assert.ok(before - after < 0.15, `dropped by ${before - after}`);
});

test('a parent rating on this site counts more than a Google rating', () => {
  const site = rankingScore({ count: 10, sum: 50 }, { googleReviewScore: null, googleReviewCount: null })!;
  const google = rankingScore(noReviews, { googleReviewScore: 5, googleReviewCount: 10 })!;
  assert.ok(site > google);
});

test('schools without any rating are unranked and listed last', () => {
  const unrated = school({ name: 'AAA Unrated Kindergarten' });
  const rated = school({ name: 'Rated Kindergarten', googleReviewScore: 2.5, googleReviewCount: 5 });

  const { schools } = rankSchools([unrated, rated], new Map());

  assert.equal(schools[0].name, 'Rated Kindergarten');
  assert.equal(schools[1].weightedScore, null);
  assert.equal(schools[1].areaRank, null);
  assert.equal(schools[1].areaTotal, 2);
});

test('ranks restart in each area and areas are sorted', () => {
  const rows = [
    school({ name: 'A Kindergarten', googleReviewScore: 4, googleReviewCount: 10 }),
    school({ name: 'B Kindergarten', area: { name: 'shatin' }, district: 'Sha Tin', googleReviewScore: 4, googleReviewCount: 10 }),
  ];
  const { schools } = rankSchools(rows, new Map());
  assert.deepEqual(
    schools.map((s) => [s.area.name, s.areaRank]),
    [
      ['shatin', 1],
      ['tuenmun', 1],
    ],
  );
});

test('duplicate listings are merged and their ratings combined', () => {
  const a = school({ name: "St. Mary's Kindergarten", chineseName: '聖瑪利幼稚園', googleReviewScore: 4.6, googleReviewCount: 120 });
  const b = school({ name: "St Mary's Kindergarten", chineseName: '聖瑪利 幼稚園' });
  const totals = new Map([
    [a.id, { count: 1, sum: 5 }],
    [b.id, { count: 2, sum: 8 }],
  ]);

  const { schools, byId, membersById } = rankSchools([a, b], totals);

  assert.equal(schools.length, 1);
  assert.equal(schools[0].reviewCount, 3);
  assert.equal(schools[0].avgRating, 4.3);
  assert.equal(schools[0].googleReviewCount, 120);
  assert.equal(byId.get(a.id), byId.get(b.id));
  assert.deepEqual(new Set(membersById.get(schools[0].id)), new Set([a.id, b.id]));
});

test('different campuses, sections and districts are kept apart', () => {
  const rows = [
    school({ name: 'ABC Kindergarten (Tai Po)' }),
    school({ name: 'ABC Kindergarten (Sha Tin)' }),
    school({ name: 'XYZ Kindergarten', chineseName: 'XYZ幼稚園（本地）' }),
    school({ name: 'XYZ Kindergarten', chineseName: 'XYZ幼稚園（非本地）' }),
    school({ name: 'Same Name Kindergarten' }),
    school({ name: 'Same Name Kindergarten', district: 'Yuen Long', area: { name: 'yuenlong' } }),
  ];
  assert.equal(new Set(rows.map(dedupeKey)).size, rows.length);
});
