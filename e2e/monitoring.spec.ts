import { expect, test } from '@playwright/test';
import { ensureConnected, openApp, useSuite } from './support';

useSuite();

test('cluster and monitoring modules render', async ({ page }) => {
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
