import { expect, test } from '@playwright/test';
import { ensureConnected, jc, openApp, selectLeaf, useSuite } from './support';

const suite = useSuite();

test('live tree, detail, chart and branch view', async ({ page }) => {
  const { nc, subjectRoot } = suite;
  const errors = await openApp(page);
  await ensureConnected(page);

  // Publish live traffic and expect it in the tree.
  for (let i = 0; i < 3; i++) {
    nc.publish(`${subjectRoot}.live.temp`, jc.encode({ value: 20 + i, unit: 'C' }));
    await page.waitForTimeout(300);
  }
  const filter = page.getByPlaceholder('Filter subjects…');
  await filter.fill(`${subjectRoot}.live`);
  const leaf = page.getByRole('treeitem').filter({ hasText: 'temp' }).first();
  await expect(leaf).toBeVisible({ timeout: 15_000 });
  await leaf.click();

  await expect(page.locator('.jv')).toContainText('"unit"');
  await expect(page.locator('.jv')).toContainText('"C"');

  // Chart a number: at least two points exist.
  await page.locator('.jv-chartable').first().click();
  await expect(page.getByRole('button', { name: /Chart: value/ })).toBeVisible();
  // The line comes in a piece per stretch of messages, so take the first.
  await expect(page.locator('.card svg path[stroke-width="1.6"]').first()).toBeVisible();

  // Branch view: selecting a parent shows what flows below it.
  await page.getByRole('treeitem').filter({ hasText: 'live' }).first().click();
  await expect(page.getByText(/messages below/).first()).toBeVisible();

  // With a persistent history the last hour can be loaded from the database.
  const app = (await (await fetch(`${process.env.NE_URL ?? 'http://localhost:3002'}/api/app`).catch(() => null))?.json()) as { historyDb?: boolean } | null;
  if (app?.historyDb) {
    await page.getByRole('button', { name: '1 h', exact: true }).click();
    await expect(page.getByText(/messages, 1 h/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/^[1-9]\d* messages, 1 h/)).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Live', exact: true }).click();
    await expect(page.getByText(/messages below/).first()).toBeVisible();
  }

  // Search over the recorded history of the branch: payload text and subject.
  const search = page.getByRole('textbox', { name: 'Search history' });
  await search.fill('"unit":"C"');
  await expect(page.getByText(/matching messages for/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/^[1-9]\d* matching messages/)).toBeVisible();
  await search.fill('nothing-like-this');
  await expect(page.getByText(/^0 matching messages/)).toBeVisible({ timeout: 10_000 });
  await search.press('Escape');
  await expect(page.getByText(/messages below/).first()).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('watch several subjects at once', async ({ page }) => {
  const { nc, subjectRoot } = suite;
  const errors = await openApp(page);
  await ensureConnected(page);
  nc.publish(`${subjectRoot}.live.temp`, jc.encode({ value: 1, unit: 'C' }));
  await nc.flush();

  const filter = page.getByPlaceholder('Filter subjects…');
  await filter.fill(`${subjectRoot}.live`);
  await page.getByRole('treeitem').filter({ hasText: 'live' }).first().click();
  // Ctrl-click watches a second subject alongside; both get live messages.
  await page
    .getByRole('treeitem')
    .filter({ hasText: 'temp' })
    .first()
    .click({ modifiers: ['ControlOrMeta'] });
  await expect(page.getByText('Watching 2 subjects')).toBeVisible();
  nc.publish(`${subjectRoot}.live.temp`, jc.encode({ value: 99, unit: 'C' }));
  await nc.flush();
  await expect(page.locator('[aria-label="Subject tree"] [aria-selected="true"]')).toHaveCount(2);
  await page.getByRole('button', { name: `Stop watching ${subjectRoot}.live`, exact: true }).click();
  await expect(page.getByText('Watching 2 subjects')).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('subscriptions change while connected', async ({ page }) => {
  const { nc, subjectRoot } = suite;
  const errors = await openApp(page);
  await ensureConnected(page);

  // The panel stays collapsed while everything is subscribed; open it.
  const header = page.getByRole('button', { name: /^Subscriptions/ });
  if ((await header.getAttribute('aria-expanded')) === 'false') await header.click();
  // Narrowing the patterns restarts the tree with the new ones.
  const add = page.getByRole('textbox', { name: 'Add subscription to E2E' });
  await add.fill(`${subjectRoot}.narrow.>`);
  await add.press('Enter');
  // Adding a concrete pattern replaces the catch-all.
  await expect(page.locator('[aria-label="Subscriptions"]')).toContainText(`${subjectRoot}.narrow.>`);
  await expect(page.locator('[aria-label="Subscriptions"]').getByText('>', { exact: true })).toHaveCount(0);
  nc.publish(`${subjectRoot}.narrow.yes`, jc.encode({ ok: true }));
  nc.publish(`${subjectRoot}.live.no`, jc.encode({ ok: false }));
  await nc.flush();
  const filter = page.getByPlaceholder('Filter subjects…');
  await filter.fill(subjectRoot); // filtering shows every level
  await expect(page.getByRole('treeitem').filter({ hasText: 'yes' }).first()).toBeVisible({ timeout: 10_000 });
  // The new pattern receives; the removed one does not. What it collected
  // before it was removed stays: the tree is what this connection has seen,
  // not what it is listening to at this instant. `live.temp` arrived in an
  // earlier test and is still there; `live.no` was published just now and
  // never reached us.
  await expect(
    page
      .locator('.tree-label')
      .filter({ hasText: /^temp$/ })
      .first(),
  ).toBeVisible();
  await expect(page.locator('.tree-label').filter({ hasText: /^no$/ })).toHaveCount(0);

  // Removing the last pattern leaves the connection with none: the catch-all
  // is the one subscription nobody can afford on a busy cluster, so it does
  // not come back by itself.
  await page.getByRole('button', { name: `Unsubscribe ${subjectRoot}.narrow.>`, exact: true }).click();
  await expect(page.getByRole('button', { name: /^Subscriptions no subscriptions/ })).toBeVisible();
  await expect(page.getByText(/this connection receives nothing/)).toBeVisible();

  // Back to everything for the tests that follow -- by asking for it.
  await add.fill('>');
  await add.press('Enter');
  await expect(page.getByRole('button', { name: 'Unsubscribe >', exact: true })).toBeVisible({ timeout: 10_000 });

  expect(errors, errors.join('\n')).toEqual([]);
});

test('binary payloads decode with a rule', async ({ page }) => {
  const { nc, subjectRoot } = suite;
  const errors = await openApp(page);
  await ensureConnected(page);

  // MessagePack for {"temp": 21}, written by hand so the suite needs no encoder.
  const packed = new Uint8Array([0x81, 0xa4, 0x74, 0x65, 0x6d, 0x70, 0x15]);
  for (let i = 0; i < 2; i++) {
    nc.publish(`${subjectRoot}.packed.sensor`, packed);
    await page.waitForTimeout(300);
  }
  await page.getByPlaceholder('Filter subjects…').fill(`${subjectRoot}.packed`);
  const leaf = page.getByRole('treeitem').filter({ hasText: 'sensor' }).first();
  await expect(leaf).toBeVisible({ timeout: 15_000 });
  await leaf.click();
  await expect(page.getByText('Binary payload')).toBeVisible();

  // A rule for the subject, MessagePack by default: the payload becomes a tree.
  await page.getByRole('button', { name: 'Decode with a schema (MessagePack, protobuf, Avro)' }).click();
  const dialog = page.getByRole('dialog', { name: 'Payload decoders' });
  await expect(dialog.getByLabel('Subject pattern')).toHaveValue(`${subjectRoot}.packed.sensor`);
  await dialog.getByRole('button', { name: 'Add rule' }).click();
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(page.locator('.jv')).toContainText('"temp"');
  await expect(page.locator('.jv')).toContainText('21');

  // Switching the rule to protobuf loads the parser; these bytes are not a valid message.
  await page.getByRole('button', { name: 'Edit payload decoders' }).click();
  await dialog.getByLabel('Format').selectOption('protobuf');
  await dialog.getByLabel('.proto source').fill('syntax = "proto3"; message Reading { string id = 1; double value = 2; }');
  await dialog.getByRole('button', { name: 'Save rule' }).click();
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(page.getByText(/Could not decode as protobuf/)).toBeVisible({ timeout: 10_000 });

  expect(errors, errors.join('\n')).toEqual([]);
});

test('a time range is shown like the live view', async ({ page }) => {
  const { nc, subjectRoot } = suite;
  const errors = await openApp(page);
  await ensureConnected(page);
  const app = (await (await fetch(`${process.env.NE_URL ?? 'http://localhost:3002'}/api/app`).catch(() => null))?.json()) as { historyDb?: boolean } | null;
  test.skip(!app?.historyDb, 'needs a persistent history');

  for (let i = 0; i < 4; i++) {
    nc.publish(`${subjectRoot}.ranged.temp`, jc.encode({ temp: 20 + i, unit: 'C' }));
    await page.waitForTimeout(250);
  }
  await page.getByPlaceholder('Filter subjects…').fill(`${subjectRoot}.ranged`);
  await selectLeaf(page, 'temp');
  await expect(page.locator('.jv')).toContainText('"unit"', { timeout: 10_000 });

  // The same detail view, with the messages of the range instead of the feed.
  await page.getByRole('button', { name: '1 h', exact: true }).click();
  await expect(page.getByText(/in 1 h/)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.jv')).toContainText('"unit"');
  await expect(page.getByRole('button', { name: /Schema/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'History', exact: true })).toBeVisible();

  // Picking an older message works as it does live.
  await page.locator('.list-row').nth(1).click();
  await expect(page.getByText(/pinned ·/)).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await expect(page.getByText(/in 1 h/)).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('payload filter narrows the tree and the history', async ({ page }) => {
  const { nc, subjectRoot } = suite;
  const errors = await openApp(page);
  await ensureConnected(page);

  // Two sensors, one over and one under the threshold.
  for (let i = 0; i < 3; i++) {
    nc.publish(`${subjectRoot}.hot.temp`, jc.encode({ temp: 80 + i, unit: 'C' }));
    nc.publish(`${subjectRoot}.cold.temp`, jc.encode({ temp: 10 + i, unit: 'C' }));
    await page.waitForTimeout(250);
  }
  await page.getByPlaceholder('Filter subjects…').fill(subjectRoot);
  await expect(page.getByRole('treeitem').filter({ hasText: 'cold' }).first()).toBeVisible({ timeout: 15_000 });

  // The expression keeps the hot sensor and drops the cold one.
  // The filter is its own collapsible panel, like subscriptions and bookmarks.
  await page.getByRole('button', { name: /^Payload filter/ }).click();
  const expr = page.getByLabel('Payload filter expression');
  await expr.fill('payload.temp > 50');
  await expect(page.getByRole('treeitem').filter({ hasText: 'cold' })).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole('treeitem').filter({ hasText: 'hot' }).first()).toBeVisible();

  // A broken expression says why instead of showing an empty tree.
  await expr.fill('payload.temp >');
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 10_000 });

  // Clearing brings both back.
  await expr.fill('');
  await expect(page.getByRole('treeitem').filter({ hasText: 'cold' }).first()).toBeVisible({ timeout: 15_000 });

  expect(errors, errors.join('\n')).toEqual([]);
});

test('search across all subjects', async ({ page }) => {
  const { nc, subjectRoot } = suite;
  const errors = await openApp(page);
  await ensureConnected(page);

  // A word that only one of two subjects carries.
  for (let i = 0; i < 3; i++) {
    nc.publish(`${subjectRoot}.pumps.p1`, jc.encode({ state: 'running', note: 'conveyor healthy' }));
    nc.publish(`${subjectRoot}.valves.v1`, jc.encode({ state: 'closed' }));
    await page.waitForTimeout(250);
  }
  await page.getByPlaceholder('Filter subjects…').fill(`${subjectRoot}.valves`);
  await selectLeaf(page, 'v1');

  // Scoped to the selected subject the word is not there.
  const search = page.getByRole('textbox', { name: 'Search history' });
  await search.fill('conveyor');
  await expect(page.getByText(/^0 matching messages/)).toBeVisible({ timeout: 10_000 });

  // Across all subjects it is found, and the row names the subject it came from.
  await page.getByRole('button', { name: 'All subjects', exact: true }).click();
  await expect(page.getByText(/matching messages .* across all subjects/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(`${subjectRoot}.pumps.p1`).first()).toBeVisible();

  await search.press('Escape');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('a chart point opens the message behind it', async ({ page }) => {
  const { nc, subjectRoot } = suite;
  const errors = await openApp(page);
  await ensureConnected(page);

  // One value stands out, so the point can be told apart from its neighbours.
  const values = [10, 11, 99, 12, 13];
  for (const v of values) {
    nc.publish(`${subjectRoot}.pick.temp`, jc.encode({ temp: v, marker: v === 99 ? 'spike' : 'normal' }));
    await page.waitForTimeout(300);
  }
  await page.getByPlaceholder('Filter subjects…').fill(`${subjectRoot}.pick`);
  await selectLeaf(page, 'temp');

  // Chart the field, then click the peak.
  await page.locator('.jv-chartable').first().click();
  const chart = page.getByRole('img', { name: /over time/ }).first();
  await expect(chart).toBeVisible({ timeout: 10_000 });
  const box = (await chart.boundingBox())!;
  await chart.click({ position: { x: box.width * 0.5, y: box.height * 0.2 } });

  // The payload of that message is shown, not the newest one.
  await expect(page.getByText(/pinned ·/)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.jv')).toContainText('spike');

  await page.getByText(/back to live/).click();
  await expect(page.getByText(/pinned ·/)).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('one message is enough for the history rail', async ({ page }) => {
  const { nc, subjectRoot } = suite;
  const errors = await openApp(page);
  await ensureConnected(page);

  // A subject that has sent once. The rail is also the way back into what
  // was recorded before this tab opened, so hiding it until a second
  // message arrives hides the way there.
  nc.publish(`${subjectRoot}.once.temp`, jc.encode({ temp: 21 }));
  await page.getByPlaceholder('Filter subjects…').fill(`${subjectRoot}.once`);
  await selectLeaf(page, 'temp');

  await expect(page.getByText('1 newest first')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/No older messages|Load older/)).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('dragging across a chart zooms into that stretch of time', async ({ page }) => {
  const { nc, subjectRoot } = suite;
  const errors = await openApp(page);
  await ensureConnected(page);

  for (let i = 0; i < 12; i++) {
    nc.publish(`${subjectRoot}.zoom.temp`, jc.encode({ temp: 20 + i }));
    await page.waitForTimeout(250);
  }
  await page.getByPlaceholder('Filter subjects…').fill(`${subjectRoot}.zoom`);
  await selectLeaf(page, 'temp');

  await page.locator('.jv-chartable').first().click();
  const chart = page.getByRole('img', { name: /over time/ }).first();
  await expect(chart).toBeVisible({ timeout: 10_000 });

  // Live, so there is no window yet and nothing to widen.
  const zoomOut = page.getByRole('button', { name: 'Zoom out' });
  await expect(zoomOut).toHaveCount(0);

  // How many the subject header says are on screen: "12 in history" live,
  // "5 in 16:07:46 – 16:08:04" once a window has been dragged.
  const shown = page.getByText(/^\d+ in /);
  const count = async () => Number((await shown.innerText()).match(/^(\d+) in/)![1]);
  await expect(shown).toContainText('in history');
  const live = await count();

  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();

  // The drag is the time range now: a window with a start and an end, fewer
  // messages than the whole history, and something to widen it with again.
  await expect(shown).toContainText(/in \d{2}:\d{2}:\d{2} – \d{2}:\d{2}:\d{2}/, { timeout: 10_000 });
  const zoomed = await count();
  expect(zoomed).toBeGreaterThan(0);
  expect(zoomed).toBeLessThan(live);

  await zoomOut.click();
  await expect(shown).toContainText(/in \d{2}:\d{2}:\d{2} – /, { timeout: 10_000 });
  expect(await count()).toBeGreaterThanOrEqual(zoomed);

  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await expect(shown).toContainText('in history', { timeout: 10_000 });

  expect(errors, errors.join('\n')).toEqual([]);
});

test('a search hit opens its payload', async ({ page }) => {
  const { nc, subjectRoot } = suite;
  const errors = await openApp(page);
  await ensureConnected(page);

  for (let i = 0; i < 3; i++) {
    nc.publish(`${subjectRoot}.hits.one`, jc.encode({ marker: 'findme', n: i }));
    nc.publish(`${subjectRoot}.hits.two`, jc.encode({ marker: 'other', n: i }));
    await page.waitForTimeout(250);
  }
  await page.getByPlaceholder('Filter subjects…').fill(`${subjectRoot}.hits`);
  await selectLeaf(page, 'one');

  // Search, then click a hit: its payload is shown, as in the live view.
  const search = page.getByRole('textbox', { name: 'Search history' });
  await search.fill('findme');
  await expect(page.getByText(/matching messages for/)).toBeVisible({ timeout: 10_000 });
  await page.locator('.grid.gap-3.px-3').filter({ hasText: 'findme' }).nth(1).click();
  await expect(page.locator('.jv')).toContainText('findme', { timeout: 10_000 });

  // Closing the panel leaves the results in place.
  await page.getByRole('button', { name: 'Close this message' }).click();
  await expect(page.locator('.jv')).toHaveCount(0);
  await expect(page.getByText(/matching messages for/)).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('opening a subject from a list unfolds the tree', async ({ page }) => {
  const { nc, subjectRoot } = suite;
  const errors = await openApp(page);
  await ensureConnected(page);

  for (let i = 0; i < 3; i++) {
    nc.publish(`${subjectRoot}.deep.a.b.leaf`, jc.encode({ n: i, marker: 'buried' }));
    await page.waitForTimeout(250);
  }
  // Select the branch above it, so the leaf is not on screen yet.
  await page.getByPlaceholder('Filter subjects…').fill(`${subjectRoot}.deep`);
  await selectLeaf(page, 'deep');
  await expect(page.getByText(/messages below/).first()).toBeVisible({ timeout: 15_000 });
  // A filter shows matches whatever their branch does, so clear it first.
  await page.getByPlaceholder('Filter subjects…').fill('');
  await page.getByRole('button', { name: 'Collapse all' }).click();
  await expect(page.getByRole('treeitem').filter({ hasText: 'leaf' })).toHaveCount(0);

  // A row of the branch list, then "Open subject": the tree unfolds to it.
  await page.locator('.grid.gap-3.px-3').filter({ hasText: 'buried' }).nth(1).click();
  await page.getByRole('button', { name: 'Open subject' }).click();
  await expect(page.getByRole('treeitem').filter({ hasText: 'leaf' }).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('main .pane-header').first()).toContainText('leaf');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('clearing the history of one subject leaves the others', async ({ page }) => {
  const { nc, subjectRoot } = suite;
  const errors = await openApp(page);
  await ensureConnected(page);

  for (let i = 0; i < 3; i++) {
    nc.publish(`${subjectRoot}.wipe.a`, jc.encode({ n: i }));
    nc.publish(`${subjectRoot}.wipe.b`, jc.encode({ n: i }));
    await page.waitForTimeout(250);
  }
  await page.getByPlaceholder('Filter subjects…').fill(`${subjectRoot}.wipe`);
  await selectLeaf(page, 'a');
  await expect(page.getByText(/3 in history/)).toBeVisible({ timeout: 15_000 });

  // Clear this one subject. The clear lives in the header's overflow menu:
  // it is the one irreversible action there and does not belong in a row
  // where every other click is harmless.
  await page.getByRole('button', { name: /^More for / }).click();
  await page.getByRole('menuitem', { name: /^Clear history/ }).click();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.getByText(/History cleared/)).toBeVisible({ timeout: 10_000 });

  // The other subject still has its messages.
  await selectLeaf(page, 'b');
  await expect(page.getByText(/3 in history/)).toBeVisible({ timeout: 10_000 });

  expect(errors, errors.join('\n')).toEqual([]);
});
