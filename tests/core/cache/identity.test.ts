import { describe, expect, it } from 'vitest';
import { cacheKey, sha256, stableJson } from '../../../src/core/cache/identity';

describe('sha256', () => {
  it('matches published test vectors', async () => {
    expect(await sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes strings as UTF-8', async () => {
    expect(await sha256('行こう！')).toBe(await sha256(new TextEncoder().encode('行こう！').buffer as ArrayBuffer));
  });

  it('hashes raw bytes and returns 64 lowercase hex characters', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]).buffer;
    const hash = await sha256(bytes);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256(new Uint8Array([0, 1, 2, 254]).buffer)).not.toBe(hash);
  });
});

describe('stableJson', () => {
  it('ignores object key order at every depth', () => {
    const a = { b: 1, a: { d: [1, { z: 1, y: 2 }], c: 'x' } };
    const b = { a: { c: 'x', d: [1, { y: 2, z: 1 }] }, b: 1 };
    expect(stableJson(a)).toBe(stableJson(b));
    expect(stableJson(a)).toBe('{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}');
  });

  it('keeps array order significant', () => {
    expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]));
    expect(stableJson({ segments: ['a', 'b'] })).not.toBe(stableJson({ segments: ['b', 'a'] }));
  });

  it('distinguishes values that look alike', () => {
    expect(stableJson({ a: 1 })).not.toBe(stableJson({ a: '1' }));
    expect(stableJson({ a: null })).not.toBe(stableJson({ a: false }));
    expect(stableJson({ a: [] })).not.toBe(stableJson({ a: {} }));
  });

  it('passes primitives and null through', () => {
    expect(stableJson(null)).toBe('null');
    expect(stableJson('x')).toBe('"x"');
    expect(stableJson(3)).toBe('3');
    expect(stableJson([])).toBe('[]');
  });

  it('drops undefined fields like JSON does, so absent and undefined keys collide intentionally', () => {
    expect(stableJson({ a: 1, b: undefined })).toBe(stableJson({ a: 1 }));
  });

  it('does not mutate its input', () => {
    const input = { z: 1, a: { y: 1, b: 2 } };
    stableJson(input);
    expect(Object.keys(input)).toEqual(['z', 'a']);
    expect(Object.keys(input.a)).toEqual(['y', 'b']);
  });
});

describe('cacheKey', () => {
  const identity = { image: 'abc', panel: { x: 0.52, y: 0.05, width: 0.42, height: 0.4 }, language: 'ja' };

  it('is "<version>:<64 hex>"', async () => {
    expect(await cacheKey('panel-v1', identity)).toMatch(/^panel-v1:[0-9a-f]{64}$/);
  });

  it('is stable across key order and repeated calls', async () => {
    const reordered = { language: 'ja', panel: { height: 0.4, width: 0.42, y: 0.05, x: 0.52 }, image: 'abc' };
    const first = await cacheKey('v1', identity);
    expect(await cacheKey('v1', reordered)).toBe(first);
    expect(await cacheKey('v1', identity)).toBe(first);
  });

  it('changes with the version, and with every relevant field', async () => {
    const base = await cacheKey('v1', identity);
    expect(await cacheKey('v2', identity)).not.toBe(base);
    expect(await cacheKey('v1', { ...identity, language: 'ko' })).not.toBe(base);
    expect(await cacheKey('v1', { ...identity, image: 'abd' })).not.toBe(base);
    expect(await cacheKey('v1', { ...identity, panel: { ...identity.panel, x: 0.53 } })).not.toBe(base);
  });
});
