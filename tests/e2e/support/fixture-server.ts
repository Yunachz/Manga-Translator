import { createReadStream, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import { fixturesDir } from './paths';

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

export interface FixtureServer {
  /** `http://127.0.0.1:<port>`. Loopback only. */
  origin: string;
  port: number;
  /** Request paths (with query) in arrival order. Cleared by `reset()`. */
  requests: string[];
  reset(): void;
  close(): Promise<void>;
}

/**
 * Serves tests/fixtures on an ephemeral loopback port. Read-only, no directory listing,
 * no access outside the fixture directory. Replaces the `python3 -m http.server` step in QA-PLAN.md.
 */
export async function startFixtureServer(root = fixturesDir, host = '127.0.0.1'): Promise<FixtureServer> {
  const base = resolve(root);
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push(url.pathname + url.search);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (pathname === '/') pathname = '/reader.html';
    if (pathname === '/protected.png') {
      if (request.headers['sec-fetch-dest'] !== 'image') {
        response.writeHead(403, { 'Cache-Control': 'no-store' }).end();
        return;
      }
      pathname = '/page-a.png';
    }
    const file = resolve(base, `.${pathname}`);
    if (pathname.includes('\0') || (file !== base && !file.startsWith(base + sep))) {
      response.writeHead(403).end();
      return;
    }
    let size: number;
    try {
      const stat = statSync(file);
      if (!stat.isFile()) throw new Error('not a file');
      size = stat.size;
    } catch {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': types[extname(file)] ?? 'application/octet-stream',
      'Content-Length': size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file).pipe(response);
  });
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, host, done);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://${host}:${port}`,
    port,
    requests,
    reset: () => { requests.length = 0; },
    close: () => new Promise<void>((done, fail) => {
      server.closeAllConnections();
      server.close(error => (error ? fail(error) : done()));
    }),
  };
}
