export const chapterPageLimit = 200;
const witchHost = /^(?:w\d+\.)?secretsofthesilentwitch\.online$/i;
const dexHost = /^(?:www\.)?mangadex\.org$/i;
const dexPath = /^\/chapter\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\/(\d{1,3}))?\/?$/i;

export type ChapterSite = { site: 'witch' | 'dex' | 'generic'; key: string; id: string; page?: number };
export interface ChapterPage { index: number; src: string }

function hash(text: string, seed: number): string {
  let value = seed >>> 0;
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 16777619) >>> 0;
  return value.toString(16).padStart(8, '0');
}

/** Sites with a known page list. Everything else uses what the reader has already loaded. */
export function namedChapterSite(href: string): ChapterSite | undefined {
  let url: URL;
  try { url = new URL(href); } catch { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  const witch = /^\/chapters\/([\d]+(?:[-.]\d+)?)\/?$/.exec(url.pathname);
  if (witchHost.test(url.hostname) && witch) return { site: 'witch', key: `witch-${witch[1]}`, id: witch[1] };
  const dex = dexPath.exec(url.pathname);
  if (dexHost.test(url.hostname) && dex) return { site: 'dex', key: `dex-${dex[1].toLowerCase()}`, id: dex[1].toLowerCase(),
    page: dex[2] ? Number(dex[2]) : undefined };
}

/** The page address without its fragment is the chapter identity for any other HTTP(S) reader. */
export function chapterSite(href: string): ChapterSite | undefined {
  const named = namedChapterSite(href);
  if (named) return named;
  let url: URL;
  try { url = new URL(href); } catch { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  const identity = url.origin + url.pathname + url.search;
  return { site: 'generic', key: `generic-${hash(identity, 2166136261)}${hash(identity, 40503)}`, id: url.hostname };
}


function witchPage(src: string, chapter: ChapterSite): ChapterPage | undefined {
  let url: URL;
  try { url = new URL(src); } catch { return; }
  const file = /^\/Secrets-of-the-Silent-Witch\/([\d.-]+)\/p(\d+)\.(?:webp|png|jpe?g|avif)$/i.exec(url.pathname);
  if (url.protocol !== 'https:' || url.hostname !== 'manga.xtdz.top' || !file || file[1].replace(/^0+(?=\d)/, '') !== chapter.id ||
      url.username || url.password || url.port || url.search || url.hash) return;
  const index = Number(file[2]);
  if (index < 1 || index > chapterPageLimit) return;
  return { index, src: url.href };
}

export function validateSilentWitchPages(chapter: ChapterSite, sources: unknown): ChapterPage[] {
  if (!Array.isArray(sources) || !sources.length || sources.length > chapterPageLimit) return [];
  const pages: ChapterPage[] = [];
  for (const [position, source] of sources.entries()) {
    const page = typeof source === 'string' ? witchPage(source, chapter) : undefined;
    if (!page || page.index !== position + 1) return [];
    pages.push(page);
  }
  return pages;
}

export function silentWitchPages(chapter: ChapterSite, metadata: Iterable<string>): ChapterPage[] {
  for (const content of metadata) {
    if (content.length > 2_000_000) continue;
    // Next.js may encode component props inside a serialized script string.
    const text = content.replace(/\\+"/g, '"');
    for (const entry of text.matchAll(/"images"\s*:\s*(\[[^\]]{1,100000}\])/g)) {
      let sources: unknown;
      try { sources = JSON.parse(entry[1]); } catch { continue; }
      const pages = validateSilentWitchPages(chapter, sources);
      if (pages.length) return pages;
    }
  }
  return [];
}

export function chapterPageKey(href: string): string {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.pathname : url.href;
  } catch { return ''; }
}
