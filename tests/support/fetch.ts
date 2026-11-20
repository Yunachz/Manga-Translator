import { vi } from 'vitest';

export interface RecordedFetch {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  init: RequestInit;
}

export type Reply = Response | Error | ((call: RecordedFetch) => Response | Promise<Response>);

export const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/**
 * Replaces `fetch` with a recorder that answers each call from the queue (the last reply repeats).
 * Nothing leaves the process: an unqueued call throws.
 */
export function stubFetch(...replies: Reply[]) {
  const calls: RecordedFetch[] = [];
  const stub = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value]));
    let body: unknown = init.body;
    if (typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    const call: RecordedFetch = { url: String(input), method: init.method ?? 'GET', headers, body, init };
    calls.push(call);
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (!reply) throw new Error('unexpected fetch: no reply queued');
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply(call) : reply.clone();
  });
  vi.stubGlobal('fetch', stub);
  return { calls, stub };
}

/** Minimal `chrome.permissions` for adapters that gate on host permission. */
export function stubChromePermissions(granted: boolean | ((origins: string[]) => boolean) = true) {
  const contains = vi.fn(async ({ origins = [] }: { origins?: string[] }) =>
    typeof granted === 'function' ? granted(origins) : granted);
  vi.stubGlobal('chrome', { permissions: { contains } });
  return contains;
}
