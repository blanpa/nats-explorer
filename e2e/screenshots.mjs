/**
 * The screenshots on the README and the documentation site.
 *
 * They were made by hand until now, which is why they aged: the accent was
 * still teal and the monitoring page still a ribbon of strips long after
 * neither was true. This makes them from a known dataset, so the next one is
 * a command rather than an afternoon.
 *
 *   bun run nats:start                       # NATS on 4230 with JetStream
 *   PORT=3012 STORAGE_DIR=$(mktemp -d) NO_KEYRING=1 PUBLIC_PATH=client/dist ./dist/nats-explorer
 *   node e2e/screenshots.mjs                 # writes docs/screenshots/*.png
 *
 * NE_URL and NATS_URL override the two addresses.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { connect, JSONCodec } from 'nats';

const NE = process.env.NE_URL ?? 'http://localhost:3012';
const NATS = process.env.NATS_URL ?? 'nats://localhost:4230';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screenshots');
const jc = JSONCodec();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const api = async (method, path, body) => {
  const res = await fetch(`${NE}/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};

/** Everything the screenshots show, published before the browser opens. */
async function seed(nc) {
  const js = nc.jetstream();
  const jsm = await nc.jetstreamManager();

  for (const [name, subjects, description] of [
    ['ORDERS', ['orders.>'], 'Order events of the shop'],
    ['SENSORS', ['sensors.>'], 'Readings of every sensor in the building'],
  ]) {
    await jsm.streams.add({ name, subjects, description, storage: 'file', max_msgs: 100000 }).catch(() => {});
  }
  await jsm.consumers.add('ORDERS', { durable_name: 'billing', ack_policy: 'explicit', filter_subject: 'orders.paid' }).catch(() => {});

  const kv = await js.views.kv('app-config', { history: 5 }).catch(() => js.views.kv('app-config'));
  for (const v of ['0.9.0', '1.0.0', '1.1.0']) await kv.put('release.version', jc.encode({ version: v, rollout: v === '1.1.0' ? 'canary' : 'stable' }));
  await kv.put('feature.newCheckout', jc.encode({ enabled: true, percentage: 25 }));

  // Sensor readings: three rooms on two floors, a value that moves.
  const rooms = ['lobby', 'office', 'server-room'];
  for (let i = 0; i < 20; i++) {
    for (const floor of ['floor-1', 'floor-2']) {
      for (const room of rooms) {
        const base = room === 'server-room' ? 19 : 21;
        nc.publish(
          `sensors.${floor}.${room}.temperature`,
          jc.encode({
            celsius: Number((base + Math.sin(i / 2 + rooms.indexOf(room)) * 2.4 + Math.random() * 0.6).toFixed(2)),
            humidity: Math.round(40 + Math.random() * 14),
            battery: Math.round(60 + Math.random() * 37),
          }),
        );
      }
    }
    // The orders keep the stream and the trace interesting.
    if (i % 4 === 0) {
      const id = `ORD-${1000 + i}`;
      nc.publish('orders.created', jc.encode({ id, total: Number((80 + Math.random() * 500).toFixed(2)), items: 1 + (i % 5), currency: 'EUR' }));
      await sleep(60);
      nc.publish('orders.paid', jc.encode({ id, method: i % 8 === 0 ? 'card' : 'invoice' }));
      await sleep(90);
      nc.publish('orders.shipped', jc.encode({ id, carrier: 'dhl' }));
    }
    await sleep(280);
  }
  await nc.flush();
}

/** A service to send requests at, so a run has latencies to report. */
function responder(nc) {
  const sub = nc.subscribe('services.echo');
  (async () => {
    for await (const m of sub) {
      await sleep(3 + Math.random() * 18);
      m.respond(jc.encode({ ok: true, at: new Date().toISOString() }));
    }
  })();
  return sub;
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('wrote', name);
}

/** Waits for the pane to be quiet enough that a screenshot is not a blur. */
const settle = (page, ms = 1200) => page.waitForTimeout(ms);

async function main() {
  mkdirSync(OUT, { recursive: true });
  const nc = await connect({ servers: NATS });
  const sub = responder(nc);

  await api('POST', '/connect', {
    id: 'local',
    name: 'Local',
    servers: [NATS],
    authMethod: 'none',
    subscriptions: ['orders.>', 'sensors.>', 'services.>'],
    monitoringPort: 8230,
  });
  // A second one, so the switcher has something to switch between.
  await api('POST', '/connect', { id: 'staging', name: 'Staging', servers: [NATS], authMethod: 'none', subscriptions: ['orders.>'], color: '#f2607a' }).catch(
    () => {},
  );
  await seed(nc);

  // The endpoint takes the whole list: it replaces what is there.
  await api('PUT', '/alerts/rules', [
    {
      id: 'server-room-warm',
      name: 'Server room warm',
      pattern: 'sensors.*.server-room.temperature',
      expr: 'payload.celsius > 20',
      severity: 'warning',
      enabled: true,
    },
    {
      id: 'sensor-silent',
      name: 'Sensor stopped sending',
      pattern: 'sensors.>',
      staleAfter: 120,
      severity: 'critical',
      enabled: true,
    },
  ]);
  await sleep(1500);

  const browser = await chromium.launch({ executablePath: process.env.PW_CHROME });
  // The theme follows the operating system on a first visit, and the machine
  // taking these is not the subject: the file names say which one is meant,
  // so each page is opened with the one it is named after.
  const openPage = async theme => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
    await ctx.addInitScript(t => window.localStorage.setItem('ne.theme', `"${t}"`), theme);
    const p = await ctx.newPage();
    await p.goto(NE);
    await p.waitForSelector('text=Subjects', { timeout: 20000 });
    await settle(p, 2500);
    return p;
  };
  const page = await openPage('dark');

  // --- Subjects: the tree, the history, a chart and the payload ----------
  await page.getByPlaceholder('Filter subjects…').fill('temperature');
  await settle(page);
  const leaf = page.getByRole('treeitem').filter({ hasText: 'temperature' }).last();
  await leaf.click();
  await settle(page);
  // Chart the first number of the payload.
  await page.locator('.jv-chartable').first().click();
  await settle(page, 1500);
  // Open, not toggled: the panel remembers its state, and a click on an
  // open one closes it.
  const expand = async name => {
    const b = page.getByRole('button', { name }).first();
    if ((await b.getAttribute('aria-expanded').catch(() => null)) === 'false') await b.click();
  };
  await expand(/^Subscriptions/);
  await expand(/^Schema/);
  await settle(page);
  await shot(page, 'subjects-dark');

  // --- Monitoring: the health band, the overview, the curves ------------
  await page.getByRole('button', { name: 'Monitoring' }).click();
  // The curves need a second sample before they are curves.
  await settle(page, 12000);
  await shot(page, 'monitoring-dark');

  // --- Alerts -----------------------------------------------------------
  // One reading over the threshold just before the shot: a rule that is
  // firing says more about the module than a list of rules that are not.
  nc.publish('sensors.floor-2.server-room.temperature', jc.encode({ celsius: 24.8, humidity: 41, battery: 63 }));
  await nc.flush();
  await sleep(1200);
  await page.getByRole('button', { name: 'Alerts' }).click();
  await settle(page, 2500);
  await shot(page, 'alerts-dark');

  // --- Key-Value --------------------------------------------------------
  await page.getByRole('button', { name: 'Key-Value' }).click();
  await settle(page);
  await page
    .locator('.list-row')
    .filter({ hasText: 'app-config' })
    .first()
    .click()
    .catch(() => {});
  await settle(page);
  await page
    .locator('.list-row, tbody tr')
    .filter({ hasText: 'release.version' })
    .first()
    .click()
    .catch(() => {});
  await settle(page, 1500);
  await shot(page, 'kv-dark');

  // --- Requests: a template run several hundred times -------------------
  await page.getByRole('button', { name: 'Requests' }).click();
  await settle(page);
  await page.getByRole('button', { name: 'New request' }).first().click();
  await settle(page);
  await page.getByLabel('Request name').fill('Echo latency');
  await page.getByRole('textbox', { name: 'Subject' }).fill('services.echo');
  await page.getByRole('button', { name: 'Request / Reply' }).click();
  await page.getByLabel('Repeat count').fill('400');
  await settle(page);
  // The run is the point of this one: the percentiles and the histogram of
  // where the replies landed only exist afterwards.
  // With a repeat count the button says how many, not "send".
  await page.getByRole('button', { name: /^Run 400/ }).click();
  await page.waitForSelector('text=/p95/', { timeout: 60000 }).catch(() => {});
  await settle(page, 2000);
  await shot(page, 'requests-dark');

  // --- Connections ------------------------------------------------------
  // Over the subjects, where someone actually switches servers, rather than
  // over whatever pane happened to be open.
  await page.getByRole('button', { name: 'Subjects' }).click();
  await settle(page);
  await page
    .getByRole('button', { name: /Switch connection/ })
    .first()
    .click();
  await settle(page, 1200);
  await shot(page, 'connections-dark');
  await page.keyboard.press('Escape');

  // --- JetStream, in the light theme ------------------------------------
  const light = await openPage('light');
  await light.getByRole('button', { name: 'JetStream' }).click();
  await settle(light);
  await light.locator('.list-row').filter({ hasText: 'ORDERS' }).first().click();
  await settle(light, 1800);
  await shot(light, 'jetstream-light');

  await browser.close();
  sub.unsubscribe();
  await nc.drain();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
