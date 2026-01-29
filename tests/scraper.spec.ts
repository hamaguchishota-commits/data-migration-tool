import { test, expect } from '@playwright/test';

test.describe('Web Scraper', () => {
  test('should launch browser and navigate to a page', async ({ page }) => {
    // Basic test to verify Playwright is working
    await page.goto('https://example.com');
    await expect(page).toHaveTitle(/Example Domain/);
  });

  test('should take a screenshot', async ({ page }) => {
    await page.goto('https://example.com');
    await page.screenshot({ path: 'data/test-screenshot.png' });
  });

  test('should extract text from page', async ({ page }) => {
    await page.goto('https://example.com');
    const heading = await page.textContent('h1');
    expect(heading).toBe('Example Domain');
  });
});
