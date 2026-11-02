import { createServer } from 'node:http';
import { test, expect } from '@playwright/test';
import { createMockHealthServer, scopes } from '../../mock-google-health/server.mjs';

// Browser CSP checks every redirect after a consent form submission, including
// the final app callback. An HTTP-only OAuth test cannot detect that failure.
test('mock consent follows the provider, identity broker, and app redirect chain', async ({ page }) => {
  const running = [];
  async function listen(server) {
    running.push(server);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return `http://127.0.0.1:${server.address().port}`;
  }
  try {
    const app = await listen(createServer((_request, response) => response.end('Fixture consent complete')));
    let brokerReceivedCode = false;
    const broker = await listen(createServer((request, response) => {
      const query = new URL(request.url, 'http://broker.invalid').searchParams;
      brokerReceivedCode = Boolean(query.get('code')) && query.get('state') === 'browser-fixture-state';
      response.writeHead(303, { Location: app });response.end();
    }));
    const { server, stats } = createMockHealthServer({ clientId: 'browser-client', clientSecret: 'browser-secret', callback: `${broker}/callback` });
    const provider = await listen(server);
    const query = new URLSearchParams({ client_id: 'browser-client', redirect_uri: `${broker}/callback`, response_type: 'code', state: 'browser-fixture-state', scope: scopes.join(' ') });
    await page.goto(`${provider}/authorize?${query}`);
    await page.getByRole('button', { name: 'Allow fixture access' }).click();
    await expect(page).toHaveURL(`${app}/`);
    await expect(page.locator('body')).toHaveText('Fixture consent complete');
    expect(brokerReceivedCode).toBe(true);
    expect(stats.consentDecisions).toBe(1);
  } finally {
    for (const server of running.reverse()) { server.closeAllConnections();await new Promise((resolve) => server.close(resolve)); }
  }
});
