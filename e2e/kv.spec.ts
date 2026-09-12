import { expect, test } from '@playwright/test';
import { ensureConnected, jc, openApp, useSuite } from './support';

const suite = useSuite({ kv: true });

test('browse, edit and live update', async ({ page }) => {
  const { nc, bucketName } = suite;
  const errors = await openApp(page);
  await ensureConnected(page);

  await page.getByRole('button', { name: 'Key-Value' }).click();
  await page.getByPlaceholder('Filter buckets…').fill(bucketName);
  await page
    .locator('.list-row')
    .filter({ has: page.getByText(bucketName, { exact: true }) })
    .click();
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
