/** Collapses whitespace and case so OCR line wrapping does not matter. */
export const normalize = (text: string) => text.replace(/\s+/g, '').toUpperCase();

/** Character error rate: Levenshtein distance over the length of the reference. */
export function characterErrorRate(reference: string, hypothesis: string): number {
  const a = [...normalize(reference)];
  const b = [...normalize(hypothesis)];
  if (!a.length) return b.length ? 1 : 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length] / a.length;
}
