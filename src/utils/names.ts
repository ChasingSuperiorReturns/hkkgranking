/** Lower-cased, width-normalised text with spaces and punctuation removed ("St. Mary's" -> "stmarys"). */
export function normalizeText(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Text inside the first pair of brackets, e.g. the campus in "ABC Kindergarten (Tai Po)". */
export function extractBracketContent(value: string | null | undefined): string {
  const match = String(value ?? '').match(/[（(]([^）)]+)[）)]/);
  return match ? normalizeText(match[1]) : '';
}

function bigrams(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i += 1) {
    const gram = text.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

const GENERIC_NAME_PARTS =
  /kindergarten|nursery|preschool|international|school|childcarecentre|childcarecenter|幼稚園|幼兒園|幼兒學校|幼兒中心|國際|學校|暨/g;
const KINDERGARTEN_MARKER = /kindergarten|nursery|preschool|montessori|幼稚園|幼兒/;

/** Name without the words every kindergarten shares, so "ABC Kindergarten" doesn't match "XYZ Kindergarten". */
export function distinctiveName(value: string | null | undefined): string {
  return normalizeText(value).replace(GENERIC_NAME_PARTS, '');
}

/** Dice coefficient over character bigrams: 1 for identical names, 0 for nothing in common. */
export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;

  const leftGrams = bigrams(left);
  const rightGrams = bigrams(right);
  let overlap = 0;
  for (const [gram, count] of leftGrams) {
    overlap += Math.min(count, rightGrams.get(gram) ?? 0);
  }
  return (2 * overlap) / (left.length - 1 + (right.length - 1));
}

/**
 * How confidently a Google place name refers to a school with the given names (0 to 1).
 * Only places that look like kindergartens can match, so a shopping mall or primary school
 * sharing the school's name is never picked up.
 */
export function schoolNameMatch(placeName: string | null | undefined, schoolNames: Array<string | null | undefined>): number {
  if (!KINDERGARTEN_MARKER.test(normalizeText(placeName))) return 0;

  let best = 0;
  for (const schoolName of schoolNames) {
    const school = distinctiveName(schoolName);
    if (school.length < 2) continue;

    // "明星幼稚園 (屯門)" is 明星幼稚園 with a location label, unless the school's own name names a
    // campus in brackets, in which case the campus has to match too.
    const hasCampus = /[（(]/.test(String(schoolName));
    const place = distinctiveName(hasCampus ? placeName : String(placeName).replace(/[（(][^）)]*[）)]/g, ''));
    if (place.length < 2) continue;
    if (school === place) return 1;

    // "聖公會聖基道" inside "聖公會聖基道 SKH St Christopher's": long enough to be distinctive.
    const [shorter, longer] = school.length <= place.length ? [school, place] : [place, school];
    if (longer.includes(shorter) && (shorter.length >= 4 || shorter.length / longer.length >= 0.6)) {
      best = Math.max(best, 0.95);
    } else {
      best = Math.max(best, nameSimilarity(school, place));
    }
  }
  return best;
}
