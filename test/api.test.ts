import './setup';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'events';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import { prisma } from '../src/models/prismaClient';
import { createApp } from '../src/app';
import { upsertGoogleUser } from '../src/routes/auth';

let base = '';
let server: Server;
const ids: Record<string, string> = {};

async function createUser(email: string, verified: boolean) {
  const user = await prisma.user.create({
    data: { email, name: `Real Name of ${email}`, emailVerifiedAt: verified ? new Date() : null },
  });
  return user.id;
}

const cookieFor = (userId: string, secret = 'test-secret') => `token=${jwt.sign({ sub: userId }, secret)}`;

type ApiOptions = { cookie?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> };

async function api(path: string, { cookie, body, rawBody, headers = {} }: ApiOptions = {}) {
  const hasBody = body !== undefined || rawBody !== undefined;
  const response = await fetch(base + path, {
    method: hasBody ? 'POST' : 'GET',
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, headers: response.headers };
}

before(async () => {
  const area = await prisma.area.create({ data: { name: 'tuenmun' } });
  const makeSchool = async (externalId: string, name: string, chineseName: string, extra = {}) =>
    (
      await prisma.kindergarten.create({
        data: { externalId, name, chineseName, district: 'Tuen Mun', address: '', areaId: area.id, type: 'PUBLIC', ...extra },
      })
    ).id;

  ids.popular = await makeSchool('kgp-1', 'Popular Kindergarten', '人氣幼稚園', { googleReviewScore: 4.6, googleReviewCount: 120 });
  ids.lone = await makeSchool('kgp-2', 'Lone Star Kindergarten', '孤星幼稚園', { googleReviewScore: 5, googleReviewCount: 1 });
  // A second EDB listing of the popular school, differing only in punctuation.
  ids.duplicate = await makeSchool('kgp-3', 'Popular Kindergarten.', '人氣．幼稚園');

  ids.alice = await createUser('alice@example.com', true);
  ids.bob = await createUser('bob@example.com', false);
  ids.carol = await createUser('carol@example.com', true);
  ids.dave = await createUser('dave@example.com', true);
  ids.validator = await createUser('validator@example.com', true);
  await prisma.review.create({ data: { userId: ids.dave, kindergartenId: ids.popular, rating: 4, comment: 'private' } });

  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await prisma.$disconnect();
});

describe('reading rankings', () => {
  test('lists merged, ranked schools without any reviewer details', async () => {
    const { status, json } = await api('/api/kindergartens');

    assert.equal(status, 200);
    assert.deepEqual(
      json.map((s: { name: string; areaRank: number }) => [s.name, s.areaRank]),
      [
        ['Popular Kindergarten', 1],
        ['Lone Star Kindergarten', 2],
      ],
    );
    assert.equal(json[0].reviewCount, 1);
    const payload = JSON.stringify(json);
    assert.ok(!payload.includes('Real Name'), 'no reviewer names');
    assert.ok(!payload.includes('userId') && !payload.includes('"reviews"'), 'no per-review data');
    assert.ok(!payload.includes('private'), 'no comments');
  });

  test('filters by area and type', async () => {
    assert.equal((await api('/api/kindergartens?area=tuenmun&type=public')).json.length, 2);
    assert.equal((await api('/api/kindergartens?type=INTERNATIONAL')).json.length, 0);
    assert.equal((await api('/api/kindergartens?area=shatin')).json.length, 0);
  });

  test('school detail includes only the signed-in parent’s own rating', async () => {
    assert.equal((await api(`/api/kindergartens/${ids.popular}`)).json.myReview, null);
    const mine = await api(`/api/kindergartens/${ids.popular}`, { cookie: cookieFor(ids.dave) });
    assert.equal(mine.json.myReview.rating, 4);
    assert.equal((await api('/api/kindergartens/does-not-exist')).status, 404);
  });
});

describe('POST /api/reviews', () => {
  test('requires a valid session', async () => {
    const body = { kindergartenId: ids.lone, rating: 5 };
    assert.equal((await api('/api/reviews', { body })).status, 401);
    // Signed with the old hard-coded fallback secret.
    assert.equal((await api('/api/reviews', { body, cookie: cookieFor(ids.alice, 'secret') })).status, 401);
  });

  test('rejects invalid input with 400', async () => {
    const cookie = cookieFor(ids.validator);
    const invalid = [
      { kindergartenId: ids.lone, rating: 3.5 },
      { kindergartenId: ids.lone, rating: '5' },
      { kindergartenId: ids.lone, rating: 6 },
      { kindergartenId: ids.lone, rating: 5, comment: { text: 'not a string' } },
      { kindergartenId: ids.lone, rating: 5, comment: 'x'.repeat(1001) },
    ];
    for (const body of invalid) {
      assert.equal((await api('/api/reviews', { body, cookie })).status, 400, JSON.stringify(body).slice(0, 80));
    }
  });

  test('returns 404 for an unknown school and 403 before email verification', async () => {
    assert.equal((await api('/api/reviews', { body: { kindergartenId: 'nope', rating: 5 }, cookie: cookieFor(ids.alice) })).status, 404);
    assert.equal((await api('/api/reviews', { body: { kindergartenId: ids.lone, rating: 5 }, cookie: cookieFor(ids.bob) })).status, 403);
  });

  test('rating again updates the parent’s existing rating', async () => {
    const cookie = cookieFor(ids.alice);
    const created = await api('/api/reviews', { body: { kindergartenId: ids.lone, rating: 5, comment: '  Great  ' }, cookie });
    assert.equal(created.status, 201);
    assert.equal(created.json.comment, 'Great');

    const updated = await api('/api/reviews', { body: { kindergartenId: ids.lone, rating: 2 }, cookie });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.updated, true);

    const school = await api(`/api/kindergartens/${ids.lone}`, { cookie });
    assert.equal(school.json.reviewCount, 1);
    assert.equal(school.json.avgRating, 2);
    assert.equal(school.json.myReview.rating, 2);
  });

  test('a rating on a hidden duplicate listing counts for the shown school', async () => {
    const created = await api('/api/reviews', { body: { kindergartenId: ids.duplicate, rating: 5 }, cookie: cookieFor(ids.alice) });
    assert.equal(created.status, 201);

    const shown = await api(`/api/kindergartens/${ids.duplicate}`);
    assert.equal(shown.json.id, ids.popular);
    assert.equal(shown.json.reviewCount, 2);
  });

  test('rate limits each account separately', async () => {
    const limit = Number(process.env.REVIEW_RATE_LIMIT_MAX);
    const cookie = cookieFor(ids.carol);
    for (let i = 0; i < limit; i += 1) {
      await api('/api/reviews', { body: {}, cookie });
    }
    assert.equal((await api('/api/reviews', { body: {}, cookie })).status, 429);
    assert.equal((await api('/api/reviews', { body: {}, cookie: cookieFor(ids.dave) })).status, 400, 'other parents unaffected');
  });
});

describe('email verification', () => {
  test('a parent can verify with the emailed code', async () => {
    const cookie = cookieFor(ids.bob);
    const sent = await api('/api/auth/email/send-code', { body: {}, cookie });
    assert.equal(sent.status, 200);
    const code: string = sent.json.devCode;
    assert.match(code, /^\d{6}$/);

    const wrong = code === '000000' ? '111111' : '000000';
    assert.equal((await api('/api/auth/email/verify', { body: { code: wrong }, cookie })).status, 400);
    assert.equal((await api('/api/auth/email/verify', { body: { code }, cookie })).status, 200);
    assert.equal((await api('/api/auth/me', { cookie })).json.canReview, true);
  });

  test('a code stops working after 5 wrong guesses', async () => {
    const cookie = cookieFor(await createUser('eve@example.com', false));
    const { json } = await api('/api/auth/email/send-code', { body: {}, cookie });
    const wrong = json.devCode === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) {
      await api('/api/auth/email/verify', { body: { code: wrong }, cookie });
    }
    const late = await api('/api/auth/email/verify', { body: { code: json.devCode }, cookie });
    assert.equal(late.status, 400);
    assert.match(late.json.error, /No active verification code/);
  });
});

describe('Google sign-in', () => {
  test('an email Google has verified needs no code', async () => {
    const user = await upsertGoogleUser({
      id: 'google-new',
      displayName: 'New Parent',
      emails: [{ value: 'new.parent@example.com', verified: true }],
      photos: [{ value: 'https://example.com/me.png' }],
    });
    assert.ok(user.emailVerifiedAt);
    assert.equal(user.image, 'https://example.com/me.png');
  });

  test('links to an existing account only when Google has verified the email', async () => {
    await createUser('existing@example.com', false);
    const profile = { id: 'google-existing', displayName: 'Existing', emails: [{ value: 'existing@example.com', verified: false }] };

    await assert.rejects(upsertGoogleUser(profile));
    const linked = await upsertGoogleUser({ ...profile, emails: [{ value: 'existing@example.com', verified: true }] });
    assert.equal(linked.googleId, 'google-existing');
    assert.ok(linked.emailVerifiedAt);
  });

  test('explains when Google sign-in is not configured', async () => {
    assert.equal((await api('/api/auth/google')).status, 503);
    assert.equal((await api('/api/auth/captcha-config')).json.googleLoginEnabled, false);
  });
});

describe('HTTP hardening', () => {
  test('sets security headers and hides the framework', async () => {
    const { headers } = await api('/health');
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
    assert.equal(headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(headers.get('x-powered-by'), null);
  });

  test('does not grant other websites CORS access', async () => {
    const { headers } = await api('/api/kindergartens', { headers: { Origin: 'https://evil.example' } });
    assert.equal(headers.get('access-control-allow-origin'), null);
  });

  test('answers malformed JSON and unknown API routes with JSON errors', async () => {
    const malformed = await api('/api/reviews', { rawBody: '{bad json', cookie: cookieFor(ids.alice) });
    assert.equal(malformed.status, 400);
    const missing = await api('/api/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, 'Not found');
  });

  test('logout clears the session cookie', async () => {
    const response = await fetch(`${base}/api/auth/logout`, { method: 'POST' });
    assert.equal(response.status, 204);
    assert.match(response.headers.get('set-cookie') ?? '', /token=;.*Expires=Thu, 01 Jan 1970/);
  });
});
