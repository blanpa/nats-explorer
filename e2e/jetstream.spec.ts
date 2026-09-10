import { expect, test } from '@playwright/test';
import { ensureConnected, jc, openApp, useSuite } from './support';

const suite = useSuite({ stream: true });

test('stream overview, newest page, chart, live tail, consumers', async ({ page }) => {
  const { nc, subjectRoot, streamName } = suite;
  const errors = await openApp(page);
  await ensureConnected(page);

  await page.getByRole('button', { name: 'JetStream' }).click();
  await page.getByPlaceholder('Filter streams…').fill(streamName);
  await page
    .locator('.list-row')
    .filter({ has: page.getByText(streamName, { exact: true }) })
    .click();

  await expect(page.getByText('Overview')).toBeVisible();
  await expect(page.locator('[data-stat]').filter({ hasText: 'Messages' }).first()).toContainText('5');

  await page.getByRole('tab', { name: /Messages/ }).click();
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toContainText(`${subjectRoot}.orders.5`); // newest first

  // Every sequence once, and in order. A page used to be fetched in
  // batches that could replay after a restart, which put a copy of the
  // first message at the end and left the newest one out.
  const seqOf = () => rows.evaluateAll(trs => trs.map(tr => Number(tr.children[1]?.textContent)));
  const desc = await seqOf();
  expect(new Set(desc).size).toBe(desc.length);
  expect(desc).toEqual([...desc].sort((a, b) => b - a));

  // Seq sorts the other way round on a click, and back.
  await page.getByRole('button', { name: /^Seq/ }).click();
  await expect.poll(seqOf).toEqual([...desc].sort((a, b) => a - b));
  await page.getByRole('button', { name: /^Seq/ }).click();
  await expect.poll(seqOf).toEqual(desc);

  // The columns of the message table are dragged to width, like the ones of
  // the subject message list.
  const subjectHead = page.locator('thead th').filter({ hasText: 'Subject' });
  const width = async () => (await subjectHead.boundingBox())!.width;
  const before = await width();
  const grip = subjectHead.locator('span[title^="Drag to resize"]');
  const box = (await grip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(width).toBeGreaterThan(before + 50);
  // A double click puts it back where it started.
  await grip.dblclick();
  await expect.poll(width).toBeLessThan(before + 10);

  await rows.first().click();
  await expect(page.locator('.jv')).toContainText('"total"');
  // A number in the payload charts the field over the stream, for the row's subject.
  await page.locator('.jv .jv-chartable').first().click();
  await expect(page.getByText(/values in seq/)).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Close chart' }).click();

  // Live tail appends a new message.
  await page.getByRole('button', { name: /Live/ }).click();
  await nc.jetstream().publish(`${subjectRoot}.orders.6`, jc.encode({ id: 6 }));
  await expect(page.locator('tbody tr').filter({ hasText: `${subjectRoot}.orders.6` })).toBeVisible({ timeout: 10_000 });

  // Export the loaded page as a file. NDJSON sits beside JSON in the menu,
  // so the name has to be exact.
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  await page.getByRole('menuitem', { name: 'JSON', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.json$/);

  // And the line-delimited one, which is a different file.
  const ndjson = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  await page.getByRole('menuitem', { name: 'NDJSON' }).click();
  expect((await ndjson).suggestedFilename()).toMatch(/\.ndjson$/);

  // Consumers: create one, then edit what JetStream allows to change.
  await page.getByRole('tab', { name: /Consumers/ }).click();
  await expect(page.getByText('No consumers')).toBeVisible();
  await page.getByRole('button', { name: 'New consumer' }).click();
  await page.getByPlaceholder('order-processor').fill('e2e-worker');
  await page.getByRole('button', { name: 'Create consumer' }).click();
  await expect(page.locator('tbody tr').filter({ hasText: 'e2e-worker' })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Edit consumer' }).first().click();
  await expect(page.getByPlaceholder('order-processor')).toBeDisabled();
  await page.getByLabel('Description').fill('edited by e2e');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('tbody tr').filter({ hasText: 'e2e-worker' }).click();
  await expect(page.getByText('edited by e2e')).toBeVisible({ timeout: 10_000 });

  expect(errors, errors.join('\n')).toEqual([]);
});
