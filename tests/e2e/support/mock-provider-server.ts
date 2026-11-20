import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMockState, handleMockRequest, providerHosts, type MockProviderId, type MockState, type RecordedRequest, type Scenario,
} from './mock-providers';

export interface MockProviderServer {
  port: number;
  requests: RecordedRequest[];
  /** `*` applies to every provider without its own scenario. */
  setScenario(provider: MockProviderId | '*', scenario: Scenario): void;
  reset(): void;
  /** Chromium switches that route provider hostnames to this server and block every other external host. */
  chromiumArgs(): string[];
  close(): Promise<void>;
}

function selfSignedCertificate(): { key: Buffer; cert: Buffer } {
  const directory = mkdtempSync(join(tmpdir(), 'manga-mock-tls-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=manga-mock',
      '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' });
    return { key: readFileSync(join(directory, 'key.pem')), cert: readFileSync(join(directory, 'cert.pem')) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Expose-Headers': 'Retry-After',
};

/**
 * HTTPS server that plays every provider host. The throwaway certificate is generated per run and
 * only trusted because the launcher passes --ignore-certificate-errors. Requires the `openssl` binary.
 */
export async function startMockProviderServer(): Promise<MockProviderServer> {
  const state: MockState = createMockState();
  const pending = new Set<NodeJS.Timeout>();
  const server: Server = createServer(selfSignedCertificate(), (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(request.headers)) headers[name] = Array.isArray(value) ? value.join(',') : value;
      const mock = handleMockRequest({
        method: request.method ?? 'GET', host: request.headers.host ?? '', path: request.url ?? '/',
        headers, body: Buffer.concat(chunks).toString('utf8'),
      }, state);
      const send = () => response.writeHead(mock.status, { ...cors, ...mock.headers }).end(mock.body);
      if (mock.delayMs > 0) {
        const timer = setTimeout(() => { pending.delete(timer); send(); }, mock.delayMs);
        pending.add(timer);
        response.on('close', () => { clearTimeout(timer); pending.delete(timer); });
      } else {
        send();
      }
    });
  });
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const { port } = server.address() as AddressInfo;
  return {
    port,
    requests: state.requests,
    setScenario: (provider, scenario) => { state.scenarios.set(provider, scenario); },
    reset: () => { state.requests.length = 0; state.scenarios.clear(); },
    chromiumArgs: () => [
      // First matching rule wins. Provider hosts go to the mock, every other host except loopback fails to resolve.
      `--host-resolver-rules=${[...Object.keys(providerHosts).map(host => `MAP ${host} 127.0.0.1:${port}`),
        'MAP * ~NOTFOUND', 'EXCLUDE 127.0.0.1', 'EXCLUDE localhost'].join(', ')}`,
      '--ignore-certificate-errors',
    ],
    close: () => new Promise<void>((done, fail) => {
      for (const timer of pending) clearTimeout(timer);
      server.closeAllConnections();
      server.close(error => (error ? fail(error) : done()));
    }),
  };
}
