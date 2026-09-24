import './setup';
import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/models/prismaClient';
import { classifyType, extractDistrictSlugs, extractSchoolCells, runGovImport } from '../src/scripts/importGovKgp';

type Listing = Record<string, Array<{ id: string; en: string; zh: string; scheme: boolean }>>;

/** Serves KGP-shaped pages: first table column = schools joining the Kindergarten Education Scheme. */
function fakeKgp(listing: Listing) {
  return async (url: string) => {
    if (url.includes('/edb/?lang=en')) {
      return Object.keys(listing)
        .map((slug) => `<a href="school.php?district=${slug}&lang=en">${slug}</a>`)
        .join('');
    }
    const match = url.match(/district=([a-z]+)&lang=(en|tc)/);
    if (match) {
      const rows = (listing[match[1]] ?? []).map(({ id, en, zh, scheme }) => {
        const cell = `<td onclick="GoSchoolDetail('${id}')">${match[2] === 'tc' ? zh : en}</td>`;
        return scheme ? `<tr>${cell}<td></td></tr>` : `<tr><td></td>${cell}</tr>`;
      });
      return `<table>${rows.join('')}</table>`;
    }
    throw new Error(`unexpected fetch ${url}`); // e.g. the optional Wikipedia cross-check
  };
}

after(() => prisma.$disconnect());

test('parses district links and school cells', () => {
  assert.deepEqual(extractDistrictSlugs('<a href="school.php?district=shatin&lang=en"></a><a href="school.php?district=taipo"></a>'), [
    'shatin',
    'taipo',
  ]);

  const cells = extractSchoolCells(
    `<table><tr><td onclick="GoSchoolDetail('1')"> Scheme  KG </td><td onclick="GoSchoolDetail(2)">Other KG</td></tr></table>`,
  );
  assert.deepEqual(cells, [
    { schoolId: '1', name: 'Scheme KG', schemeParticipating: true },
    { schoolId: '2', name: 'Other KG', schemeParticipating: false },
  ]);
});

test('classifies scheme, non-scheme and international kindergartens', () => {
  assert.equal(classifyType('ABC Kindergarten', true), 'PUBLIC');
  assert.equal(classifyType('ABC Kindergarten', false), 'PRIVATE');
  assert.equal(classifyType('ABC International Kindergarten', false), 'INTERNATIONAL');
});

test('re-running the import keeps school ids, reviews and Google ratings', async () => {
  mock.method(console, 'log', () => {});

  await runGovImport({
    fetchHtml: fakeKgp({
      tuenmun: [
        { id: '1', en: 'Bright Star Kindergarten', zh: '明星幼稚園', scheme: true },
        { id: '2', en: 'Closing Kindergarten', zh: '結束幼稚園', scheme: false },
      ],
    }),
  });

  const original = await prisma.kindergarten.findUniqueOrThrow({ where: { externalId: 'kgp-1' } });
  const user = await prisma.user.create({ data: { email: 'parent@example.com' } });
  await prisma.review.create({ data: { userId: user.id, kindergartenId: original.id, rating: 5 } });
  await prisma.kindergarten.update({
    where: { id: original.id },
    data: { googleReviewScore: 4.5, googleReviewCount: 10 },
  });

  const result = await runGovImport({
    fetchHtml: fakeKgp({
      tuenmun: [
        { id: '1', en: 'Bright Star Kindergarten (renamed)', zh: '明星幼稚園', scheme: true },
        { id: '3', en: 'New Kindergarten', zh: '新幼稚園', scheme: false },
      ],
    }),
  });

  const refreshed = await prisma.kindergarten.findUniqueOrThrow({ where: { externalId: 'kgp-1' } });
  assert.equal(refreshed.id, original.id, 'links to the school keep working');
  assert.equal(refreshed.name, 'Bright Star Kindergarten (renamed)');
  assert.equal(refreshed.googleReviewScore, 4.5);
  assert.equal(await prisma.review.count(), 1);
  assert.deepEqual(result, { imported: 2, created: 1, notInSource: 1 });
  assert.equal(await prisma.kindergarten.count(), 3, 'schools missing from the source are kept');
});
