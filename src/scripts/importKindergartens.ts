import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { parse } from 'csv-parse/sync';
import { prisma } from '../models/prismaClient';

dotenv.config();

type CsvRow = {
  name: string;
  address: string;
  area: string;
  type: string;
};

function normalizeType(value: string): 'PUBLIC' | 'PRIVATE' | 'INTERNATIONAL' {
  const raw = value.trim().toUpperCase();
  if (raw === 'PUBLIC') return 'PUBLIC';
  if (raw === 'INTERNATIONAL') return 'INTERNATIONAL';
  return 'PRIVATE';
}

async function run() {
  const inputPath =
    process.argv[2] ?? path.resolve(process.cwd(), 'data/hk_kindergartens.csv');

  const csv = fs.readFileSync(inputPath, 'utf-8');
  const rows = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as CsvRow[];

  let imported = 0;

  for (const row of rows) {
    if (!row.name || !row.address || !row.area || !row.type) {
      continue;
    }

    const area = await prisma.area.upsert({
      where: { name: row.area },
      update: {},
      create: { name: row.area },
    });

    await (prisma.kindergarten as any).upsert({
      where: {
        externalId: `csv-${row.name}`,
      },
      update: {
        areaId: area.id,
        type: normalizeType(row.type) as any,
      },
      create: {
        externalId: `csv-${row.name}`,
        name: row.name,
        address: row.address,
        areaId: area.id,
        type: normalizeType(row.type) as any,
      },
    });

    imported += 1;
  }

  console.log(`Imported ${imported} kindergartens from ${inputPath}`);
}

run()
  .catch((error) => {
    console.error('Import failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
