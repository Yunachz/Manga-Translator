import { describe, expect, it } from 'vitest';
import { admitSurface, negativeMetadata, strongestCohort, words, type AncestorFacts, type CohortMember, type SurfaceFacts } from '../../../src/core/surface/admission';

const ancestor = (tag: string, ...classes: string[]): AncestorFacts => ({ tag, classes });
const surface = (patch: Partial<SurfaceFacts> = {}): SurfaceFacts => ({
  kind: 'img', natural: { width: 800, height: 1200 }, rendered: { width: 600, height: 900 }, complete: true, visible: true, ancestry: [], ...patch,
});
const member = (index: number, patch: Partial<SurfaceFacts> = {}): CohortMember => ({ index, facts: surface(patch) });
const column = (count: number, container = { key: 'reader', reader: true }, x = 400): CohortMember[] =>
  Array.from({ length: count }, (_, index) => member(index, { centre: { x, y: 500 + index * 1000 }, container }));

describe('surface admission', () => {
  it('accepts a plausible raster for a click and for automatic use', () => {
    expect(admitSurface(surface(), 'click')).toEqual({ ok: true });
    expect(admitSurface(surface(), 'automatic')).toEqual({ ok: true });
  });

  it('refuses unusable geometry whatever the intent', () => {
    for (const intent of ['click', 'automatic'] as const) {
      expect(admitSurface(surface({ complete: false }), intent)).toEqual({ ok: false, reason: 'unready' });
      expect(admitSurface(surface({ visible: false }), intent)).toEqual({ ok: false, reason: 'hidden' });
      expect(admitSurface(surface({ rendered: { width: 60, height: 60 } }), intent)).toEqual({ ok: false, reason: 'tiny' });
      expect(admitSurface(surface({ natural: { width: 9000, height: 9000 } }), intent)).toEqual({ ok: false, reason: 'huge' });
      expect(admitSurface(surface({ outsideRoot: true }), intent)).toEqual({ ok: false, reason: 'outside' });
    }
  });

  it('refuses explicit ads, promos, covers, dialogs and navigation for a click too', () => {
    const verdict = (...ancestry: AncestorFacts[]) => admitSurface(surface({ ancestry }), 'click');
    expect(verdict(ancestor('IMG'), ancestor('DIV', 'js-page', 'page-ad', 'js-page-ad'))).toEqual({ ok: false, reason: 'advert' });
    expect(verdict(ancestor('DIV', 'Sponsored'))).toEqual({ ok: false, reason: 'advert' });
    expect(verdict(ancestor('DIV', 'series-cover'))).toEqual({ ok: false, reason: 'cover' });
    expect(verdict(ancestor('IMG'), ancestor('DIV', 'thumbnails'))).toEqual({ ok: false, reason: 'cover' });
    expect(verdict(ancestor('DIV'), ancestor('DIALOG'))).toEqual({ ok: false, reason: 'dialog' });
    expect(verdict({ tag: 'DIV', classes: [], role: 'dialog' })).toEqual({ ok: false, reason: 'dialog' });
    expect(verdict(ancestor('NAV'))).toEqual({ ok: false, reason: 'navigation' });
    expect(verdict({ tag: 'DIV', classes: [], hidden: true })).toEqual({ ok: false, reason: 'hidden' });
  });

  it('keeps weaker hints for what the extension starts by itself, so an unusual but plausible click still works', () => {
    const header = surface({ ancestry: [ancestor('IMG'), ancestor('HEADER')] });
    const related = surface({ ancestry: [ancestor('DIV', 'related-posts')] });
    expect(admitSurface(header, 'click')).toEqual({ ok: true });
    expect(admitSurface(related, 'click')).toEqual({ ok: true });
    expect(admitSurface(header, 'automatic')).toEqual({ ok: false, reason: 'navigation' });
    expect(admitSurface(related, 'automatic')).toEqual({ ok: false, reason: 'cover' });
  });

  it('does not mistake painting utilities or words that merely contain a marker for cover or ad markup', () => {
    expect(negativeMetadata([ancestor('IMG', 'object-cover', 'bg-cover', 'w-full')], 'click')).toBeUndefined();
    expect(negativeMetadata([ancestor('DIV', 'discovery', 'loading', 'padding', 'readable')], 'automatic')).toBeUndefined();
    expect(negativeMetadata([ancestor('DIV', 'reader-page')], 'automatic')).toBeUndefined();
    expect(words('pageAd js-page-ad')).toEqual(['page', 'ad', 'js', 'page', 'ad']);
  });
});

describe('strongest cohort', () => {
  it('takes a repeated aligned column and drops a surface of another width', () => {
    const pages = column(4);
    const stray = member(9, { rendered: { width: 320, height: 480 }, centre: { x: 400, y: 5000 }, container: { key: 'reader', reader: true } });
    expect(strongestCohort([...pages, stray]).map(item => item.index)).toEqual([0, 1, 2, 3]);
  });

  it('takes a row of pages of one height, such as a horizontal spread', () => {
    const row = [0, 1].map(index => member(index, { rendered: { width: 560, height: 800 }, centre: { x: 300 + index * 580, y: 400 } }));
    expect(strongestCohort(row).map(item => item.index)).toEqual([0, 1]);
  });

  it('discards a giant unmarked singleton before scoring so it cannot beat a real column of pages', () => {
    const poster = member(10, { natural: { width: 4000, height: 6000 }, rendered: { width: 1800, height: 2700 },
      centre: { x: 1000, y: 200 }, container: { key: 'hero', reader: false } });
    expect(strongestCohort([poster, ...column(3)]).map(item => item.index)).toEqual([0, 1, 2]);
    expect(strongestCohort([poster])).toEqual([]);
  });

  it('trusts no lone image without reader evidence, even a plausible portrait, but keeps a lone scoped surface', () => {
    expect(strongestCohort([member(0)])).toEqual([]);
    expect(strongestCohort([member(0, { scoped: true })]).map(item => item.index)).toEqual([0]);
  });

  it('keeps pages of one reader container apart from a promo cluster of the same geometry elsewhere', () => {
    const promo = [20, 21, 22, 23, 24].map(index => member(index, { centre: { x: 400, y: 9000 + index * 1000 }, container: { key: 'promo', reader: false } }));
    expect(strongestCohort([...promo, ...column(3)]).map(item => item.index)).toEqual([0, 1, 2]);
  });

  it('prefers a repeated column to a grid of thumbnails by total area', () => {
    const grid = [30, 31, 32, 33].map(index => member(index, { rendered: { width: 200, height: 300 }, natural: { width: 500, height: 750 },
      centre: { x: 900 + (index % 2) * 230, y: 300 + Math.floor((index - 30) / 2) * 330 }, container: { key: 'reader', reader: true } }));
    expect(strongestCohort([...grid, ...column(3)]).map(item => item.index)).toEqual([0, 1, 2]);
  });

  it('is empty when nothing is plausible', () => {
    expect(strongestCohort([])).toEqual([]);
    expect(strongestCohort([member(0, { natural: { width: 200, height: 60 }, rendered: { width: 120, height: 36 } })])).toEqual([]);
  });
});
