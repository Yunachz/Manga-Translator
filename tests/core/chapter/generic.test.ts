import { describe, expect, it } from 'vitest';
import { genericSource, selectGenericPages, validateGenericPages, type PageCandidate } from '../../../src/core/chapter/genericPages';
import { chapterSite, namedChapterSite } from '../../../src/core/chapter/readerSites';

const origin = 'https://reader.example';
const page = (name: string, patch: Partial<PageCandidate> = {}): PageCandidate => ({
  src: `https://cdn.example/${name}.jpg`, naturalWidth: 800, naturalHeight: 1200, width: 600, height: 900,
  complete: true, visible: true, chrome: false, ...patch,
});

describe('generic chapter pages', () => {
  it('keeps the loaded page column in document order', () => {
    const pages = selectGenericPages([page('1'), page('2'), page('3')], origin);
    expect(pages).toEqual([1, 2, 3].map(index => ({ index, src: `https://cdn.example/${index}.jpg` })));
  });
  it('leaves out unrelated images', () => {
    const pages = selectGenericPages([
      page('logo', { naturalWidth: 200, naturalHeight: 60, width: 120, height: 36 }),
      page('avatar', { naturalWidth: 128, naturalHeight: 128, width: 48, height: 48 }),
      page('banner', { naturalWidth: 1456, naturalHeight: 180, width: 728, height: 90 }),
      page('1'),
      page('related', { naturalWidth: 600, naturalHeight: 900, width: 150, height: 225 }),
      page('sidebar-cover', { width: 320, height: 480 }),
      page('2'),
      page('menu', { chrome: true }),
      page('hidden', { visible: false }),
      page('loading', { complete: false }),
      page('2'),
      page('3'),
    ], origin);
    expect(pages.map(item => item.src.split('/').pop())).toEqual(['1.jpg', '2.jpg', '3.jpg']);
    expect(pages.map(item => item.index)).toEqual([1, 2, 3]);
  });
  it('takes no lone image without reader evidence, whatever its shape, and no empty page', () => {
    expect(selectGenericPages([page('photo', { naturalWidth: 1600, naturalHeight: 900, width: 800, height: 450 })], origin)).toEqual([]);
    expect(selectGenericPages([page('only')], origin)).toEqual([]);
    expect(selectGenericPages([], origin)).toEqual([]);
  });
  it('takes a repeated aligned column of pages and ignores a decorative cluster beside it', () => {
    const column = [1, 2, 3].map(index => page(String(index), { centre: { x: 400, y: index * 1000 } }));
    const grid = [1, 2, 3, 4].map(index => page(`related-${index}`, { width: 250, height: 375, naturalWidth: 500, naturalHeight: 750,
      centre: { x: 900 + (index % 2) * 260, y: 300 + Math.floor(index / 2) * 400 } }));
    expect(selectGenericPages([...grid, ...column], origin).map(item => item.src.split('/').pop())).toEqual(['1.jpg', '2.jpg', '3.jpg']);
  });
  it('takes a horizontal row of equal-height pages, such as a spread', () => {
    const row = [1, 2].map(index => page(String(index), { width: 560, height: 800, centre: { x: index * 600, y: 400 } }));
    expect(selectGenericPages(row, origin)).toHaveLength(2);
  });
  it('refuses pages inside explicit ad, cover or navigation markup', () => {
    const pages = [1, 2, 3].map(index => page(String(index)));
    const marked = (classes: string[]) => page('promo', { ancestry: [{ tag: 'DIV', classes }] });
    expect(selectGenericPages([...pages, marked(['js-page-ad']), marked(['series-cover']), marked(['sponsored-banner'])], origin)).toHaveLength(3);
    expect(selectGenericPages(pages.map(item => ({ ...item, ancestry: [{ tag: 'DIV', classes: ['page-ad'] }] })), origin)).toEqual([]);
    expect(selectGenericPages(pages.map(item => ({ ...item, outsideRoot: true })), origin)).toEqual([]);
  });
  it('accepts only fetchable web sources and refuses private hosts on other origins', () => {
    expect(genericSource('https://cdn.example/a.jpg#x', origin)).toBe('https://cdn.example/a.jpg');
    for (const src of ['blob:https://reader.example/1', 'data:image/png;base64,AAAA', 'ftp://cdn.example/a.jpg', 'http://cdn.example/a.jpg',
      'https://user:pw@cdn.example/a.jpg', 'https://localhost/a.jpg', 'https://127.0.0.1/a.jpg', 'https://192.168.1.4/a.jpg',
      'https://10.0.0.2/a.jpg', 'https://[::1]/a.jpg', 'https://nas.local/a.jpg', 'https://cdn.example/' + 'a'.repeat(4100), 42]) {
      expect(genericSource(src, origin), String(src)).toBeUndefined();
    }
    expect(genericSource('http://192.168.1.4/a.jpg', 'http://192.168.1.4')).toBe('http://192.168.1.4/a.jpg');
    expect(genericSource('https://127.0.0.1/a.jpg', 'https://127.0.0.1')).toBe('https://127.0.0.1/a.jpg');
  });
  it('caps a very long reader at the chapter limit', () => {
    const many = Array.from({ length: 260 }, (_value, index) => page(String(index + 1)));
    expect(selectGenericPages(many, origin)).toHaveLength(200);
  });
  it('rejects a malformed list from the page', () => {
    const one = 'https://cdn.example/1.jpg';
    expect(validateGenericPages(origin, [one, 'https://cdn.example/2.jpg'])).toEqual([
      { index: 1, src: one }, { index: 2, src: 'https://cdn.example/2.jpg' }]);
    expect(validateGenericPages(origin, undefined)).toEqual([]);
    expect(validateGenericPages(origin, [one, one])).toEqual([]);
    expect(validateGenericPages(origin, [one, 'https://localhost/2.jpg'])).toEqual([]);
    expect(validateGenericPages(origin, Array.from({ length: 201 }, (_value, index) => `https://cdn.example/${index}.jpg`))).toEqual([]);
  });
});

describe('generic chapter identity', () => {
  it('names any web page and keeps the two known sites exact', () => {
    const first = chapterSite('https://reader.example/read/ch-5?page=1#top');
    expect(first).toMatchObject({ site: 'generic', id: 'reader.example' });
    expect(first?.key).toMatch(/^generic-[0-9a-f]{16}$/);
    expect(first?.key).toMatch(/^[a-z0-9.-]{4,64}$/i);
    expect(chapterSite('https://reader.example/read/ch-5?page=1#bottom')?.key).toBe(first?.key);
    expect(chapterSite('https://reader.example/read/ch-6?page=1')?.key).not.toBe(first?.key);
    expect(chapterSite('https://reader.example/read/ch-5?page=2')?.key).not.toBe(first?.key);
    expect(chapterSite('https://other.example/read/ch-5?page=1')?.key).not.toBe(first?.key);
    expect(chapterSite('chrome://extensions')).toBeUndefined();
    expect(chapterSite('about:blank')).toBeUndefined();
    expect(namedChapterSite('https://reader.example/read/ch-5')).toBeUndefined();
    expect(namedChapterSite('https://w2.secretsofthesilentwitch.online/chapters/33/')).toMatchObject({ site: 'witch', key: 'witch-33' });
    expect(chapterSite('https://mangadex.org/chapter/f49c0d3e-ddb1-487b-9514-39f781b8a168/3')).toMatchObject({ site: 'dex', page: 3 });
  });
});
