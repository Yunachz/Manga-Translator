export type Measure = (text: string) => number;

function lineBreakUnits(text: string, segmenter: Intl.Segmenter): string[] {
  const parts = Array.from(segmenter.segment(text));
  const units: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (/^[-‐‑]$/u.test(part.segment) && parts[index - 1]?.isWordLike && parts[index + 1]?.isWordLike) {
      units[units.length - 1] += part.segment + parts[++index].segment;
    } else if (/^[\p{Pe}\p{Pf}.,!?;:…。、！？：；%％]+$/u.test(part.segment) && index && !/\s$/u.test(parts[index - 1].segment)) {
      units[units.length - 1] += part.segment;
    } else {
      units.push(part.segment);
    }
  }
  return units;
}

export function prepareText(text: string, language = 'id') {
  const words = new Intl.Segmenter(language, { granularity: 'word' });
  const graphemes = new Intl.Segmenter(language, { granularity: 'grapheme' });
  const paragraphs = text.split(/\r?\n/).map(paragraph => lineBreakUnits(paragraph, words));
  const characters = new Map<string, string[]>();
  return (width: number, measure: Measure, breakLongWords = true): string[] => {
    const lines: string[] = [];
    for (const paragraph of paragraphs) {
      let line = '';
      for (const segment of paragraph) {
        const candidate = line ? line + segment : segment.trimStart();
        if (measure(candidate.trimEnd()) <= width) {
          line = candidate;
          continue;
        }
        if (line.trim()) lines.push(line.trim());
        line = '';
        const word = segment.trim();
        if (measure(word) <= width) {
          line = word;
          continue;
        }
        if (!breakLongWords) return [];
        let units = characters.get(word);
        if (!units) {
          units = Array.from(graphemes.segment(word), item => item.segment);
          characters.set(word, units);
        }
        for (const character of units) {
          if (line && measure(line + character) > width) {
            lines.push(line);
            line = '';
          }
          line += character;
        }
      }
      if (line.trim()) lines.push(line.trim());
    }
    return lines;
  };
}

export function wrapText(text: string, width: number, measure: Measure, language = 'id'): string[] {
  return prepareText(text, language)(width, measure);
}
