import { expect, test, type Page } from '@playwright/test';
import { connect, JSONCodec, type NatsConnection } from 'nats';

const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4230';
const NATS_BROWSER_URL = process.env.NATS_BROWSER_URL ?? NATS_URL; // what the backend dials
const MON_URL = process.env.NATS_MON_URL ?? 'http://localhost:8230';
const jc = JSONCodec();

let nc: NatsConnection;
const run = Date.now().toString(36);
const subjectRoot = `e2e.${run}`;
const streamName = `E2E_${run}`;
const bucketName = `e2e_${run}`;

test.beforeAll(async () => {
  // The suite assumes a backend without active connections (e.g. left over from a manual session).
  await fetch(`${process.env.NE_URL ?? 'http://localhost:3002'}/api/disconnect-all`, { method: 'POST' }).catch(() => undefined);
  nc = await connect({ servers: NATS_URL });
  const jsm = await nc.jetstreamManager();
  await jsm.streams.add({ name: streamName, subjects: [`${subjectRoot}.orders.>`] });
  const js = nc.jetstream();
  for (let i = 1; i <= 5; i++) await js.publish(`${subjectRoot}.orders.${i}`, jc.encode({ id: i, total: i * 10.5 }));
  const kv = await js.views.kv(bucketName, { history: 3 });
  await kv.put('config.mode', jc.encode({ mode: 'auto' }));
});

test.afterAll(async () => {
  const jsm = await nc.jetstreamManager();
  await jsm.streams.delete(streamName).catch(() => undefined);
  await jsm.streams.delete(`KV_${bucketName}`).catch(() => undefined);
  await nc.drain();
});

async function openApp(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    // Network-level "Failed to load resource" lines are expected for API calls that legitimately
    // answer 4xx/5xx (request timeouts, unreachable monitoring); real app errors are pageerrors.
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
  });
  await page.addInitScript(
    ({ url, mon }) => {
      localStorage.setItem('ne.theme', 'dark');
      localStorage.setItem(
        'ne.connections.v2',
        JSON.stringify([{ id: 'e2e-conn', name: 'E2E', servers: [url], authMethod: 'none', subscriptions: ['>'], sysTopics: {}, monitoringUrl: mon }]),
      );
    },
    { url: NATS_BROWSER_URL, mon: MON_URL },
  );
  await page.goto('/');
  return errors;
}

async function ensureConnected(page: Page) {
  // The UI renders nothing until the backend reported its connection list; wait for either state.
  const connectBtn = page.getByRole('button', { name: /Connect to E2E/ });
  const switcher = page.getByRole('button', { name: 'Switch connection' });
  await expect(connectBtn.or(switcher.filter({ hasText: 'E2E' }))).toBeVisible({ timeout: 15_000 });
  if (await connectBtn.isVisible()) await connectBtn.click();
  await expect(switcher).toContainText('E2E', { timeout: 15_000 });
}

test('subjects: live tree, detail, chart, branch view', async ({ page }) => {
  const errors = await openApp(page);
  await ensureConnected(page);

  // Publish live traffic and expect it in the tree.
  for (let i = 0; i < 3; i++) {
    nc.publish(`${subjectRoot}.live.temp`, jc.encode({ value: 20 + i, unit: 'C' }));
    await page.waitForTimeout(300);
  }
  await page.getByPlaceholder('Filter subjects…').fill(`${subjectRoot}.live`);
  const leaf = page.getByRole('treeitem').filter({ hasText: 'temp' }).first();
  await expect(leaf).toBeVisible({ timeout: 15_000 });
  await leaf.click();

  await expect(page.locator('.jv')).toContainText('"unit"');
  await expect(page.locator('.jv')).toContainText('"C"');

  // Chart a number: at least two points exist.
  await page.locator('.jv-chartable').first().click();
  await expect(page.getByRole('button', { name: /Chart: value/ })).toBeVisible();
  await expect(page.locator('.card svg path[stroke-width="1.6"]')).toBeVisible();

  // Branch view: selecting a parent shows what flows below it.
  await page.getByRole('treeitem').filter({ hasText: 'live' }).first().click();
  await expect(page.getByText('recent messages below this subject')).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('jetstream: stream overview, newest page, consumers', async ({ page }) => {
  const errors = await openApp(page);
  await ensureConnected(page);

  await page.getByRole('button', { name: 'JetStream' }).click();
  await page.getByPlaceholder('Filter streams…').fill(streamName);
  await page.locator('.list-row').filter({ has: page.getByText(streamName, { exact: true }) }).click();

  await expect(page.getByText('Overview')).toBeVisible();
  await expect(page.locator('[data-stat]').filter({ hasText: 'Messages' }).first()).toContainText('5');

  await page.getByRole('tab', { name: /Messages/ }).click();
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toContainText(`${subjectRoot}.orders.5`); // newest first
  await rows.first().click();
  await expect(page.locator('.jv')).toContainText('"total"');

  // Live tail appends a new message.
  await page.getByRole('button', { name: /Live/ }).click();
  await nc.jetstream().publish(`${subjectRoot}.orders.6`, jc.encode({ id: 6 }));
  await expect(page.locator('tbody tr').filter({ hasText: `${subjectRoot}.orders.6` })).toBeVisible({ timeout: 10_000 });

  await page.getByRole('tab', { name: /Consumers/ }).click();
  await expect(page.getByText('No consumers')).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('kv: browse, edit, live update', async ({ page }) => {
  const errors = await openApp(page);
  await ensureConnected(page);

  await page.getByRole('button', { name: 'Key-Value' }).click();
  await page.getByPlaceholder('Filter buckets…').fill(bucketName);
  await page.locator('.list-row').filter({ has: page.getByText(bucketName, { exact: true }) }).click();
  await page.locator('.list-row').filter({ hasText: 'config.mode' }).click();
  await expect(page.locator('.jv')).toContainText('"auto"');

  // Edit through the UI (PUT path).
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.locator('textarea').fill('{"mode":"manual"}');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.jv')).toContainText('"manual"');
  await expect(page.getByText('rev 2')).toBeVisible();

  // External write arrives through the KV watch without a refresh.
  const kv = await nc.jetstream().views.kv(bucketName);
  await kv.put('config.mode', jc.encode({ mode: 'external' }));
  await expect(page.locator('.jv')).toContainText('"external"', { timeout: 10_000 });
  await kv.put('new.key', jc.encode(1));
  await expect(page.locator('.list-row').filter({ hasText: 'new.key' })).toBeVisible({ timeout: 10_000 });

  expect(errors, errors.join('\n')).toEqual([]);
});

test('server and monitoring modules render', async ({ page }) => {
  const errors = await openApp(page);
  await ensureConnected(page);

  await page.getByRole('button', { name: 'Cluster' }).click();
  // Without system-account credentials the overview shows the connected node only and says so.
  await expect(page.getByText('single server view')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('table').first()).toContainText('2.');
  await page.getByRole('tab', { name: /Connections/ }).click();
  await expect(page.getByText('JetStream account')).toBeVisible();

  await page.getByRole('button', { name: 'Monitoring' }).click();
  // Either data or the actionable error must render; never a blank pane.
  await expect(page.getByText(/Client connections|Monitoring endpoint not reachable/).first()).toBeVisible({ timeout: 10_000 });

  expect(errors, errors.join('\n')).toEqual([]);
});
