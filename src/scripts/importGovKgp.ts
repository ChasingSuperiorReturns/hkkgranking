import dotenv from 'dotenv';
import * as cheerio from 'cheerio';
import { prisma } from '../models/prismaClient';

dotenv.config();

const BASE = 'https://kgp2025.azurewebsites.net/edb';

type Row = {
  externalId: string;
  name: string;
  chineseName: string;
  districtSlug: string;
  districtName: string;
  area: string;
  type: 'PUBLIC' | 'PRIVATE' | 'INTERNATIONAL';
  address: string;
};

const districtNameMap: Record<string, string> = {
  kwaichung: 'Kwai Chung & Tsing Yi',
  tsuenwan: 'Tsuen Wan',
  tuenmun: 'Tuen Mun',
  yuenlong: 'Yuen Long',
  north: 'North',
  shatin: 'Sha Tin',
  taipo: 'Tai Po',
  kowlooncity: 'Kowloon City',
  kwuntong: 'Kwun Tong',
  saikung: 'Sai Kung',
  shamshuipo: 'Sham Shui Po',
  wongtaisin: 'Wong Tai Sin',
  yautsimmongkok: 'Yau Tsim & Mong Kok',
  central: 'Central & Western',
  hkeast: 'HK East',
  islands: 'Islands',
  southern: 'Southern',
  wanchai: 'Wan Chai',
};

type SchoolCell = {
  schoolId: string;
  name: string;
  schemeParticipating: boolean;
};

function normalizeName(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function classifyType(name: string, schemeParticipating: boolean): 'PUBLIC' | 'PRIVATE' | 'INTERNATIONAL' {
  const upper = name.toUpperCase();
  if (upper.includes('INTERNATIONAL') || upper.includes('國際')) {
    return 'INTERNATIONAL';
  }
  return schemeParticipating ? 'PUBLIC' : 'PRIVATE';
}

function normalizeForWikiCheck(name: string): string {
  return name
    .replace(/\s+/g, '')
    .replace(/[()（）\-–—]/g, '')
    .replace(/[0-9０-９]/g, '')
    .trim();
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; HKKindergartenImporter/1.0)',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url} (${response.status})`);
  }

  return response.text();
}

function extractDistrictSlugs(indexHtml: string): string[] {
  const matches = Array.from(indexHtml.matchAll(/school\.php\?district=([a-z]+)/g));
  return [...new Set(matches.map((m) => m[1]))];
}

function extractSchoolCells(html: string): SchoolCell[] {
  const $ = cheerio.load(html);
  const deduped = new Map<string, SchoolCell>();

  $('td[onclick*="GoSchoolDetail"]').each((_idx, td) => {
    const onClick = $(td).attr('onclick') || '';
    const match = onClick.match(/GoSchoolDetail\('?(\d+)'?\)/);
    if (!match) {
      return;
    }

    const schoolId = match[1];
    if (deduped.has(schoolId)) {
      return;
    }

    const name = normalizeName($(td).text());
    if (!name) {
      return;
    }

    const columnIndex = $(td).index();
    const schemeParticipating = columnIndex === 0;

    deduped.set(schoolId, {
      schoolId,
      name,
      schemeParticipating,
    });
  });

  return [...deduped.values()];
}

async function scrapeDistrict(districtSlug: string): Promise<Row[]> {
  const enUrl = `${BASE}/school.php?district=${districtSlug}&lang=en`;
  const tcUrl = `${BASE}/school.php?district=${districtSlug}&lang=tc`;
  const [enHtml, tcHtml] = await Promise.all([fetchHtml(enUrl), fetchHtml(tcUrl)]);

  const englishCells = extractSchoolCells(enHtml);
  const chineseCells = extractSchoolCells(tcHtml);
  const chineseById = new Map(chineseCells.map((cell) => [cell.schoolId, cell.name]));

  const area = districtSlug;
  const districtName = districtNameMap[districtSlug] ?? districtSlug;

  return englishCells.map((entry) => ({
    externalId: `kgp-${entry.schoolId}`,
    name: entry.name,
    chineseName: chineseById.get(entry.schoolId) ?? '',
    districtSlug,
    districtName,
    area,
    type: classifyType(entry.name, entry.schemeParticipating),
    address: `${districtName}, Hong Kong (from EDB profile list)`,
  }));
}

async function fetchWikipediaKindergartenText(): Promise<string> {
  try {
    const html = await fetchHtml('https://zh.wikipedia.org/wiki/%E9%A6%99%E6%B8%AF%E5%B9%BC%E7%A8%9A%E5%9C%92%E5%88%97%E8%A1%A8');
    const $ = cheerio.load(html);
    return normalizeName($('#mw-content-text').text());
  } catch {
    return '';
  }
}

async function run() {
  const indexHtml = await fetchHtml(`${BASE}/?lang=en`);
  const districtSlugs = extractDistrictSlugs(indexHtml);

  if (!districtSlugs.length) {
    throw new Error('No district links found on KGP page');
  }

  const collected: Row[] = [];
  for (const districtSlug of districtSlugs) {
    try {
      const rows = await scrapeDistrict(districtSlug);
      collected.push(...rows);
      console.log(`Scraped ${rows.length} entries from ${districtSlug}`);
    } catch (error) {
      console.warn(`Skipped district ${districtSlug}:`, error);
    }
  }

  const dedupedByName = new Map<string, Row>();
  for (const row of collected) {
    const key = row.externalId;
    if (!dedupedByName.has(key)) {
      dedupedByName.set(key, row);
    }
  }

  const rows = [...dedupedByName.values()];

  await prisma.review.deleteMany({});
  await prisma.kindergarten.deleteMany({});
  await prisma.area.deleteMany({});

  const wikiText = await fetchWikipediaKindergartenText();
  let wikiMatched = 0;

  for (const row of rows) {
    const area = await prisma.area.upsert({
      where: { name: row.area },
      update: {},
      create: { name: row.area },
    });

    await prisma.kindergarten.upsert({
      where: {
        externalId: row.externalId,
      },
      update: {
        externalId: row.externalId,
        areaId: area.id,
        district: row.districtName,
        type: row.type as any,
        name: row.name,
        chineseName: row.chineseName,
        address: row.address,
      },
      create: {
        externalId: row.externalId,
        name: row.name,
        chineseName: row.chineseName,
        district: row.districtName,
        address: row.address,
        areaId: area.id,
        type: row.type as any,
      },
    });

    if (row.chineseName && wikiText && wikiText.includes(row.chineseName)) {
      wikiMatched += 1;
    }
  }

  console.log(`Imported/updated ${rows.length} kindergarten rows from ${BASE}`);
  if (wikiText) {
    console.log(`Wikipedia Chinese-name reference matches: ${wikiMatched}/${rows.length}`);
  }
}

run()
  .catch((error) => {
    console.error('Government import failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
