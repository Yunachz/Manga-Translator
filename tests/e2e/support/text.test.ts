import { describe, expect, it } from 'vitest';
import { characterErrorRate, normalize } from './text';

describe('characterErrorRate', () => {
  it('is 0 for equal text ignoring case and wrapping', () => {
    expect(characterErrorRate('THE LIGHT IS ON.', 'the light\nis on.')).toBe(0);
  });

  it('counts substitutions, insertions and deletions against the reference length', () => {
    expect(characterErrorRate('abcd', 'abXd')).toBe(0.25);
    expect(characterErrorRate('abcd', 'abcde')).toBe(0.25);
    expect(characterErrorRate('abcd', 'abd')).toBe(0.25);
  });

  it('handles empty input and CJK', () => {
    expect(characterErrorRate('', '')).toBe(0);
    expect(characterErrorRate('', 'x')).toBe(1);
    expect(characterErrorRate('行こう！', '行こう！')).toBe(0);
    expect(characterErrorRate('行こう！', '行こう')).toBe(0.25);
    expect(normalize(' a b ')).toBe('A B'.replace(' ', ''));
  });
});
