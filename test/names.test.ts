import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distinctiveName, nameSimilarity, normalizeText, schoolNameMatch } from '../src/utils/names';

test('normalizeText ignores case, full-width characters and punctuation', () => {
  assert.equal(normalizeText("St. Mary's  Kindergarten"), 'stmaryskindergarten');
  assert.equal(normalizeText('ＡＢＣ（屯門）'), 'abc屯門');
});

test('nameSimilarity is 1 for the same name and 0 for unrelated names', () => {
  assert.equal(nameSimilarity('明星幼稚園', '明星 幼稚園'), 1);
  assert.equal(nameSimilarity('abc', 'xyz'), 0);
});

test('distinctiveName drops the words every kindergarten shares', () => {
  assert.equal(distinctiveName('ABC International Kindergarten'), 'abc');
  assert.equal(distinctiveName('明星幼稚園暨幼兒中心'), '明星');
});

test('schoolNameMatch accepts the same school listed with extra detail', () => {
  const names = ['明星幼稚園', 'Bright Star Kindergarten'];
  assert.equal(schoolNameMatch('明星幼稚園 (屯門)', names), 1);
  assert.equal(schoolNameMatch('Bright Star Kindergarten', names), 1);
  assert.ok(schoolNameMatch('聖公會聖基道幼稚園 SKH St Christopher Kindergarten', ['聖公會聖基道幼稚園']) >= 0.95);
});

test('schoolNameMatch rejects places that are not the kindergarten', () => {
  assert.equal(schoolNameMatch('明星商場', ['明星幼稚園']), 0, 'shopping mall');
  assert.equal(schoolNameMatch('明星小學', ['明星幼稚園']), 0, 'primary school');
  assert.ok(schoolNameMatch('XYZ Kindergarten', ['ABC Kindergarten']) < 0.6, 'only "Kindergarten" in common');
  assert.ok(schoolNameMatch('明星天地幼稚園', ['明星幼稚園']) < 0.6, 'a different school containing the name');
});

test('schoolNameMatch requires the campus to match when the school names one', () => {
  const names = ['Victoria (Harbour Green) International Kindergarten'];
  assert.equal(schoolNameMatch('Victoria (Harbour Green) International Kindergarten', names), 1);
  assert.ok(schoolNameMatch('Victoria (Belcher) International Kindergarten', names) < 0.6);
});
