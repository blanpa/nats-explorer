import { expect, type Page, test } from '@playwright/test';
import { connect, JSONCodec, type NatsConnection } from 'nats';

export const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4230';
const NATS_BROWSER_URL = process.env.NATS_BROWSER_URL ?? NATS_URL; // what the backend dials
const MON_URL = process.env.NATS_MON_URL ?? 'http://localhost:8230';
export const jc = JSONCodec();

/** Names unique to one test file run, so files never see each other's data. */
export interface Suite {
  nc: NatsConnection;
  subjectRoot: string;
  streamName: string;
  bucketName: string;
}

/**
 * Connects to NATS before the file's tests and seeds what they ask for: a
 * stream with five orders and a KV bucket with one key. The backend is
 * disconnected first because the suite assumes no leftover connections.
 */
export function useSuite(opts: { stream?: boolean; kv?: boolean } = {}): Suite {
  const run = Date.now().toString(36);
  const suite = { subjectRoot: `e2e.${run}`, streamName: `E2E_${run}`, bucketName: `e2e_${run}` } as Suite;

  test.beforeAll(async () => {
    await fetch(`${process.env.NE_URL ?? 'http://localhost:3002'}/api/disconnect-all`, { method: 'POST' }).catch(() => undefined);
    suite.nc = await connect({ servers: NATS_URL });
    const js = suite.nc.jetstream();
    if (opts.stream) {
      const jsm = await suite.nc.jetstreamManager();
      await jsm.streams.add({ name: suite.streamName, subjects: [`${suite.subjectRoot}.orders.>`] });
      for (let i = 1; i <= 5; i++) await js.publish(`${suite.subjectRoot}.orders.${i}`, jc.encode({ id: i, total: i * 10.5 }));
    }
    if (opts.kv) {
      const kv = await js.views.kv(suite.bucketName, { history: 3 });
      await kv.put('config.mode', jc.encode({ mode: 'auto' }));
    }
  });

  test.afterAll(async () => {
    const jsm = await suite.nc.jetstreamManager();
    if (opts.stream) await jsm.streams.delete(suite.streamName).catch(() => undefined);
    if (opts.kv) await jsm.streams.delete(`KV_${suite.bucketName}`).catch(() => undefined);
    await suite.nc.drain();
  });

  return suite;
}

/** Opens the app with one saved connection and collects page errors. */
export async function openApp(page: Page): Promise<string[]> {
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

/**
 * Clicks a leaf of the subject tree and waits until the detail pane shows
 * it. The tree keeps growing while messages arrive, so a row can move
 * between the lookup and the click; retrying is the reliable way.
 */
export async function selectLeaf(page: Page, text: string): Promise<void> {
  const row = page.getByRole('treeitem').filter({ hasText: text });
  await expect(row.first()).toBeVisible({ timeout: 15_000 });
  await expect(async () => {
    await row.last().click({ timeout: 2000 });
    // The detail pane, not the tree's own header.
    await expect(page.locator('main .pane-header').first()).toContainText(text, { timeout: 1500 });
  }).toPass({ timeout: 20_000 });
}

/** Connects the saved E2E connection if it is not connected yet. */
export async function ensureConnected(page: Page): Promise<void> {
  // The UI renders nothing until the backend reported its connection list; wait for either state.
  const connectBtn = page.getByRole('button', { name: /Connect to E2E/ });
  const switcher = page.getByRole('button', { name: 'Switch connection' });
  await expect(connectBtn.or(switcher.filter({ hasText: 'E2E' }))).toBeVisible({ timeout: 15_000 });
  if (await connectBtn.isVisible()) await connectBtn.click();
  await expect(switcher).toContainText('E2E', { timeout: 15_000 });
}
