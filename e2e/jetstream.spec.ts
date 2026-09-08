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

  // Export the loaded page as a file.
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  await page.getByRole('menuitem', { name: /JSON/ }).click();
  expect((await download).suggestedFilename()).toMatch(/\.json$/);

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
