// Imported first by every test file: gives the file its own empty SQLite database and a
// predictable environment. Empty strings (not deletes) stop a developer's .env from filling them in.
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkkg-test-'));

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: `file:${path.join(dir, 'test.db')}`,
  JWT_SECRET: 'test-secret',
  EMAIL_OTP_SECRET: 'test-otp-secret',
  REQUIRE_EMAIL_VERIFIED: 'true',
  REVIEW_RATE_LIMIT_MAX: '8',
  CAPTCHA_SECRET_KEY: '',
  CAPTCHA_SITE_KEY: '',
  SMTP_HOST: '',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
  BASE_URL: '',
  FRONTEND_URL: '',
});

execSync('npx prisma db push --skip-generate', {
  cwd: path.resolve(__dirname, '..'),
  env: process.env,
  stdio: 'pipe',
});

process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
