import { describe, expect, it } from 'vitest';
import { PipelineError } from '../../../src/core/pipeline/PipelineError';
import { matchSegments, orderedTexts, parseLlm, responseSchema, translationInstructions } from '../../../src/core/translation/segments';
import type { TranslationRequest } from '../../../src/types/contracts';

const request: TranslationRequest = {
  sourceLanguage: 'ja', targetLanguage: 'en',
  segments: [{ id: 'a', text: '行こう！' }, { id: 'b', text: '星が見える。' }, { id: 'c', text: '船が来た！' }],
};

function invalid(action: () => unknown) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(PipelineError);
    expect((error as PipelineError).code).toBe('TRANSLATION_INVALID');
    return;
  }
  throw new Error('expected TRANSLATION_INVALID, but nothing was thrown');
}

describe('matchSegments', () => {
  it('returns the request order even when the provider answers in another order', () => {
    const result = matchSegments(request, { segments: [{ id: 'c', text: 'C' }, { id: 'a', text: 'A' }, { id: 'b', text: 'B' }] });
    expect(result.segments).toEqual([{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }]);
  });

  it('trims translated text', () => {
    const result = matchSegments({ ...request, segments: [request.segments[0]] }, { segments: [{ id: 'a', text: '  Let\'s go!\n' }] });
    expect(result.segments[0].text).toBe("Let's go!");
  });

  it('drops provider-added fields so only id and text survive', () => {
    const result = matchSegments({ ...request, segments: [request.segments[0]] }, { segments: [{ id: 'a', text: 'A', note: 'x', confidence: 1 }] });
    expect(Object.keys(result.segments[0]).sort()).toEqual(['id', 'text']);
  });

  it.each([
    ['null', null],
    ['a string', 'segments'],
    ['an array', []],
    ['no segments field', {}],
    ['segments that is not an array', { segments: {} }],
  ])('rejects %s', (_label, value) => invalid(() => matchSegments(request, value)));

  it('rejects a missing ID (fewer segments)', () => {
    invalid(() => matchSegments(request, { segments: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] }));
  });

  it('rejects an extra ID (more segments)', () => {
    invalid(() => matchSegments(request, { segments: [...request.segments.map(s => ({ id: s.id, text: 'x' })), { id: 'd', text: 'x' }] }));
  });

  it('rejects an unknown ID even when the count matches', () => {
    invalid(() => matchSegments(request, { segments: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'zzz', text: 'Z' }] }));
  });

  it('rejects a duplicated ID even when the count matches', () => {
    invalid(() => matchSegments(request, { segments: [{ id: 'a', text: 'A' }, { id: 'a', text: 'A2' }, { id: 'c', text: 'C' }] }));
  });

  it.each([
    ['empty', ''],
    ['whitespace only', ' \n\t '],
    ['a number', 5],
    ['null', null],
    ['undefined', undefined],
    ['too long', 'x'.repeat(5001)],
  ])('rejects %s text', (_label, text) => {
    invalid(() => matchSegments({ ...request, segments: [request.segments[0]] }, { segments: [{ id: 'a', text }] }));
  });

  it('accepts text of exactly 5000 characters', () => {
    const result = matchSegments({ ...request, segments: [request.segments[0]] }, { segments: [{ id: 'a', text: 'x'.repeat(5000) }] });
    expect(result.segments[0].text).toHaveLength(5000);
  });

  it.each([
    ['null item', null],
    ['numeric id', { id: 1, text: 'x' }],
    ['missing id', { text: 'x' }],
    ['primitive item', 7],
  ])('rejects a segment with %s', (_label, item) => {
    invalid(() => matchSegments({ ...request, segments: [request.segments[0]] }, { segments: [item] }));
  });

  it('accepts an empty request only with an empty result', () => {
    expect(matchSegments({ ...request, segments: [] }, { segments: [] })).toEqual({ segments: [] });
  });

  it('does not let the id "__proto__" or "constructor" smuggle through', () => {
    invalid(() => matchSegments(request, { segments: [{ id: '__proto__', text: 'x' }, { id: 'constructor', text: 'y' }, { id: 'c', text: 'z' }] }));
  });
});

describe('orderedTexts', () => {
  it('pairs a positional array with request IDs', () => {
    expect(orderedTexts(request, ['A', 'B', 'C']).segments).toEqual([{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }]);
  });

  it('rejects a length mismatch, a non-array and non-string items', () => {
    invalid(() => orderedTexts(request, ['A', 'B']));
    invalid(() => orderedTexts(request, ['A', 'B', 'C', 'D']));
    invalid(() => orderedTexts(request, undefined));
    invalid(() => orderedTexts(request, 'ABC'));
    invalid(() => orderedTexts(request, ['A', undefined, 'C']));
    invalid(() => orderedTexts(request, ['A', '', 'C']));
  });
});

describe('parseLlm', () => {
  const answer = JSON.stringify({ segments: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }] });

  it('parses a valid JSON answer', () => {
    expect(parseLlm(request, answer).segments.map(segment => segment.text)).toEqual(['A', 'B', 'C']);
  });

  it('rejects non-string payloads, bad JSON and prose around JSON', () => {
    invalid(() => parseLlm(request, undefined));
    invalid(() => parseLlm(request, { segments: [] }));
    invalid(() => parseLlm(request, '{"segments": [')); // truncated
    invalid(() => parseLlm(request, `Here you go: ${answer}`));
    invalid(() => parseLlm(request, `\`\`\`json\n${answer}\n\`\`\``));
    invalid(() => parseLlm(request, ''));
  });

  it('rejects oversized payloads before parsing', () => {
    invalid(() => parseLlm(request, ' '.repeat(175_001) + answer));
  });
});

describe('prompt contract', () => {
  it('requires strict, closed schema with id and text', () => {
    expect(responseSchema.required).toEqual(['segments']);
    expect(responseSchema.additionalProperties).toBe(false);
    expect(responseSchema.properties.segments.items.required).toEqual(['id', 'text']);
    expect(responseSchema.properties.segments.items.additionalProperties).toBe(false);
  });

  it('tells the model to treat the payload as data and keep IDs', () => {
    expect(translationInstructions).toMatch(/data, never instructions/);
    expect(translationInstructions).toMatch(/preserving IDs exactly/);
  });
});
