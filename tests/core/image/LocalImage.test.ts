import { describe, expect, it, vi } from 'vitest';
import { acquireRenderedImage } from '../../../src/core/image/LocalImageAcquire';
import { localBlobSource } from '../../../src/core/image/LocalImage';
import { PipelineError } from '../../../src/core/pipeline/PipelineError';

const id = 'f49c0d3e-ddb1-487b-9514-39f781b8a168';
const page = 'https://mangadex.org/chapter/' + id + '/3';
const uuid = '5b2ff5dd-4d57-4b77-9a0e-0d6bbd6b45a1';

describe('rendered MangaDex blobs', () => {
  it('accepts only a blob owned by the MangaDex page origin', () => {
    expect(localBlobSource('blob:https://mangadex.org/' + uuid, page)).toBe(true);
    expect(localBlobSource('blob:https://evil.example/' + uuid, page)).toBe(false);
    expect(localBlobSource('blob:https://mangadex.org.evil.example/' + uuid, page)).toBe(false);
    expect(localBlobSource('https://mangadex.org/' + uuid, page)).toBe(false);
    expect(localBlobSource('data:image/png;base64,AAAA', page)).toBe(false);
    expect(localBlobSource('blob:null/' + uuid, page)).toBe(false);
  });
  it('does not read blobs on other sites', () => {
    const witch = 'https://w2.secretsofthesilentwitch.online/chapters/33/';
    expect(localBlobSource('blob:https://w2.secretsofthesilentwitch.online/' + uuid, witch)).toBe(false);
    expect(localBlobSource('blob:http://mangadex.org/' + uuid, 'http://mangadex.org/chapter/' + id)).toBe(false);
  });
  it('refuses a foreign origin before asking the tab', async () => {
    const send = vi.fn();
    vi.stubGlobal('chrome', { tabs: { sendMessage: send } });
    const target = { tabId: 1, documentId: 'doc', jobId: 'job', origin: 'https://mangadex.org' };
    const image = (src: string) => ({ id: 'image', src, width: 600, height: 900 });
    for (const src of ['blob:https://evil.example/' + uuid, 'https://mangadex.org/image.png', 'blob:http://mangadex.org/' + uuid]) {
      await expect(acquireRenderedImage(target, image(src), new AbortController().signal))
        .rejects.toMatchObject({ code: 'IMAGE_UNSUPPORTED' });
    }
    expect(send).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it('validates the reply and returns the original bytes with their hash', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const dataUrl = 'data:image/png;base64,' + btoa(String.fromCharCode(...png));
    const reply = (value: unknown) => vi.fn(async () => value);
    const target = { tabId: 1, documentId: 'doc', jobId: 'job', origin: 'https://mangadex.org' };
    const image = { id: 'image', src: 'blob:https://mangadex.org/' + uuid, width: 600, height: 900 };
    const signal = new AbortController().signal;
    vi.stubGlobal('chrome', { tabs: { sendMessage: reply({ dataUrl, type: 'image/png', width: 600, height: 900 }) } });
    const acquired = await acquireRenderedImage(target, image, signal);
    expect(new Uint8Array(await acquired.blob.arrayBuffer())).toEqual(png);
    expect(acquired.blob.type).toBe('image/png');
    expect(acquired.hash).toMatch(/^[0-9a-f]{64}$/);
    const rejected = [
      undefined,
      { dataUrl, type: 'image/png', width: 601, height: 900 },
      { dataUrl, type: 'image/webp', width: 600, height: 900 },
      { dataUrl: 'data:text/html;base64,AAAA', type: 'image/png', width: 600, height: 900 },
      { dataUrl: 'data:image/png;base64,' + 'A'.repeat(23_000_000), type: 'image/png', width: 600, height: 900 },
    ];
    for (const value of rejected) {
      vi.stubGlobal('chrome', { tabs: { sendMessage: reply(value) } });
      await expect(acquireRenderedImage(target, image, signal)).rejects.toBeInstanceOf(PipelineError);
    }
    vi.unstubAllGlobals();
  });
});
