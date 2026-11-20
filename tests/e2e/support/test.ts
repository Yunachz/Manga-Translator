import { test as base } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from './fixture-server';
import { startMockProviderServer, type MockProviderServer } from './mock-provider-server';

interface WorkerFixtures {
  fixtureServer: FixtureServer;
  mockProviders: MockProviderServer;
}

export const test = base.extend<object, WorkerFixtures>({
  // Playwright requires an object destructuring pattern as the first fixture argument, even when empty.
  // eslint-disable-next-line no-empty-pattern
  fixtureServer: [async ({}, use) => {
    const server = await startFixtureServer();
    await use(server);
    await server.close();
  }, { scope: 'worker' }],
  // eslint-disable-next-line no-empty-pattern
  mockProviders: [async ({}, use) => {
    const server = await startMockProviderServer();
    await use(server);
    await server.close();
  }, { scope: 'worker' }],
});

export { expect } from '@playwright/test';
