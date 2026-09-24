import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import path from 'path';

// config.ts reads the environment once, so each case runs in a fresh process.
function jwtSecretIn(env: Record<string, string>) {
  const { JWT_SECRET: _unused, ...inherited } = process.env;
  return spawnSync(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', '-e', "console.log(require('./src/config').getJwtSecret())"],
    { cwd: path.resolve(__dirname, '..'), env: { ...inherited, ...env }, encoding: 'utf8' },
  );
}

test('production refuses to run without JWT_SECRET', () => {
  const result = jwtSecretIn({ NODE_ENV: 'production' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /JWT_SECRET must be set/);
});

test('without JWT_SECRET, development uses a random secret instead of a guessable default', () => {
  const first = jwtSecretIn({ NODE_ENV: 'development' });
  const second = jwtSecretIn({ NODE_ENV: 'development' });
  assert.equal(first.status, 0);
  assert.match(first.stdout.trim(), /^[0-9a-f]{64}$/);
  assert.notEqual(first.stdout, second.stdout);
});

test('JWT_SECRET is used when set', () => {
  const result = jwtSecretIn({ NODE_ENV: 'production', JWT_SECRET: 'configured-secret' });
  assert.equal(result.stdout.trim(), 'configured-secret');
});
