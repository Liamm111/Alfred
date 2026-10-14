import { expect, test } from '@playwright/test';

test('home renders honest status, no demo route, security headers', async ({ page, request }, info) => {
  const res = await page.goto('/');
  expect(res?.headers()['x-content-type-options']).toBe('nosniff');
  await expect(page.getByRole('heading', { name: 'AI Course Assistant' })).toBeVisible();
  await expect(page.getByText("n'est pas livrée")).toBeVisible();
  expect((await request.get('/dev/demo/transcript')).status()).toBe(404);
  await page.screenshot({ path: `test-results/home-${info.project.name}.png`, fullPage: true });
});
