import path from 'node:path';
import { expect, test } from '@playwright/test';

const OUT = process.env.CAPTURE_OUT;

test('the index and the article page render', async ({ page }) => {
  expect(OUT, 'CAPTURE_OUT names the directory the screenshots go to').toBeTruthy();

  await page.goto('/');
  const article = page.getByRole('link', { name: 'Capture article' });
  await expect(article).toBeVisible();
  await page.screenshot({ path: path.join(OUT!, '01-index.png') });

  await article.click();
  await expect(page.getByRole('navigation', { name: 'On this page' })).toBeVisible();
  await page.screenshot({ path: path.join(OUT!, '02-article.png'), fullPage: true });
});
