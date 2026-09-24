import 'dotenv/config';
import * as cheerio from 'cheerio';
import { prisma } from '../models/prismaClient';

const BASE = 'https://kgp2025.azurewebsites.net/edb';

type SchoolType = 'PUBLIC' | 'PRIVATE' | 'INTERNATIONAL';

type Row = {
  externalId: string;
  name: string;
  chineseName: string;
  districtSlug: string;
  districtName: string;
  area: string;
  type: SchoolType;
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

export type ImportOptions = {
  fetchHtml?: (url: string) => Promise<string>;
};

function normalizeName(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function classifyType(name: string, schemeParticipating: boolean): SchoolType {
  const upper = name.toUpperCase();
  if (upper.includes('INTERNATIONAL') || upper.includes('國際')) {
    return 'INTERNATIONAL';
  }
  return schemeParticipating ? 'PUBLIC' : 'PRIVATE';
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; HKKindergartenImporter/1.0)',
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url} (${response.status})`);
  }

  return response.text();
}

export function extractDistrictSlugs(indexHtml: string): string[] {
  const matches = Array.from(indexHtml.matchAll(/school\.php\?district=([a-z]+)/g));
  return [...new Set(matches.map((m) => m[1]))];
}

export function extractSchoolCells(html: string): SchoolCell[] {
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

    // The first column lists kindergartens joining the Kindergarten Education Scheme.
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

async function scrapeDistrict(districtSlug: string, getHtml: (url: string) => Promise<string>): Promise<Row[]> {
  const enUrl = `${BASE}/school.php?district=${districtSlug}&lang=en`;
  const tcUrl = `${BASE}/school.php?district=${districtSlug}&lang=tc`;
  const [enHtml, tcHtml] = await Promise.all([getHtml(enUrl), getHtml(tcUrl)]);

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

async function fetchWikipediaKindergartenText(getHtml: (url: string) => Promise<string>): Promise<string> {
  try {
    const html = await getHtml('https://zh.wikipedia.org/wiki/%E9%A6%99%E6%B8%AF%E5%B9%BC%E7%A8%9A%E5%9C%92%E5%88%97%E8%A1%A8');
    const $ = cheerio.load(html);
    return normalizeName($('#mw-content-text').text());
  } catch {
    return '';
  }
}

/**
 * Adds new kindergartens and refreshes names/types of existing ones, matched by EDB school id.
 * Never deletes anything: school ids, parent reviews and synced Google ratings are all kept, so it
 * is safe to re-run whenever the EDB list changes.
 */
export async function runGovImport(options: ImportOptions = {}) {
  const getHtml = options.fetchHtml ?? fetchHtml;
  const indexHtml = await getHtml(`${BASE}/?lang=en`);
  const districtSlugs = extractDistrictSlugs(indexHtml);

  if (!districtSlugs.length) {
    throw new Error('No district links found on KGP page');
  }

  const collected: Row[] = [];
  for (const districtSlug of districtSlugs) {
    try {
      const rows = await scrapeDistrict(districtSlug, getHtml);
      collected.push(...rows);
      console.log(`Scraped ${rows.length} entries from ${districtSlug}`);
    } catch (error) {
      console.warn(`Skipped district ${districtSlug}:`, error);
    }
  }

  const rowsById = new Map<string, Row>();
  for (const row of collected) {
    if (!rowsById.has(row.externalId)) {
      rowsById.set(row.externalId, row);
    }
  }
  const rows = [...rowsById.values()];

  const wikiText = await fetchWikipediaKindergartenText(getHtml);
  let wikiMatched = 0;
  let created = 0;
  const areaIds = new Map<string, string>();

  for (const row of rows) {
    let areaId = areaIds.get(row.area);
    if (!areaId) {
      const area = await prisma.area.upsert({
        where: { name: row.area },
        update: {},
        create: { name: row.area },
      });
      areaId = area.id;
      areaIds.set(row.area, areaId);
    }

    const fields = {
      areaId,
      district: row.districtName,
      type: row.type,
      name: row.name,
      chineseName: row.chineseName,
      address: row.address,
    };
    const existing = await prisma.kindergarten.findUnique({
      where: { externalId: row.externalId },
      select: { id: true },
    });

    if (existing) {
      await prisma.kindergarten.update({ where: { id: existing.id }, data: fields });
    } else {
      await prisma.kindergarten.create({ data: { externalId: row.externalId, ...fields } });
      created += 1;
    }

    if (row.chineseName && wikiText && wikiText.includes(row.chineseName)) {
      wikiMatched += 1;
    }
  }

  const importedIds = new Set(rows.map((row) => row.externalId));
  const stored = await prisma.kindergarten.findMany({
    where: { externalId: { startsWith: 'kgp-' } },
    select: { externalId: true },
  });
  const notInSource = stored.filter((school) => !importedIds.has(school.externalId!)).length;

  console.log(`Imported ${rows.length} kindergarten rows from ${BASE} (${created} new, ${rows.length - created} updated)`);
  if (notInSource) {
    console.log(`${notInSource} kindergartens in the database were not in this import (closed or skipped?). They were left unchanged.`);
  }
  if (wikiText) {
    console.log(`Wikipedia Chinese-name reference matches: ${wikiMatched}/${rows.length}`);
  }

  return { imported: rows.length, created, notInSource };
}

if (require.main === module) {
  runGovImport()
    .catch((error) => {
      console.error('Government import failed:', error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
