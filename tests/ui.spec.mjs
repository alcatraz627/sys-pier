/**
 * Playwright UI tests for pm2-manage dashboard
 * Tests visual rendering of cron and launchd cards, modals, and status badges.
 *
 * Run: npx playwright test tests/ui.spec.mjs
 * (Server must be running at localhost:5042)
 */
import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:5042';

// ── Dashboard loads ─────────────────────────────────────────────────────────

test('dashboard loads and shows title', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('.card', { timeout: 5000 });
  const title = await page.title();
  expect(title.toLowerCase()).toContain('pm2');
});

// ── Card types visible ──────────────────────────────────────────────────────

test('cron cards are present', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('[data-type="cron"]', { timeout: 5000 });
  const cards = await page.locator('[data-type="cron"]').count();
  expect(cards).toBeGreaterThanOrEqual(1);
});

test('launchd cards are present', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('[data-type="launchd"]', { timeout: 5000 });
  const cards = await page.locator('[data-type="launchd"]').count();
  expect(cards).toBeGreaterThanOrEqual(1);
});

// ── Status badges ───────────────────────────────────────────────────────────

test('redis launchd card shows online badge', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('[data-type="launchd"]', { timeout: 5000 });

  // Find the card with redis in the name
  const redisCard = page.locator('[data-type="launchd"]').filter({ hasText: 'redis' });
  await expect(redisCard).toBeVisible();

  // .badge has the text content; .status-dot is a CSS-only colored dot (no text)
  const badge = redisCard.locator('.badge');
  await expect(badge).toBeVisible();
  const badgeText = await badge.textContent();
  expect(badgeText.toLowerCase()).toContain('online');
});

test('cron cards show scheduled or stopped badge', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('[data-type="cron"]', { timeout: 5000 });

  const cronCards = page.locator('[data-type="cron"]');
  const count = await cronCards.count();
  expect(count).toBeGreaterThan(0);

  for (let i = 0; i < count; i++) {
    const badge = cronCards.nth(i).locator('.badge');
    await expect(badge).toBeVisible();
    const text = (await badge.textContent()).toLowerCase();
    expect(['scheduled', 'stopped']).toContain(text);
  }
});

// ── Cron detail modal ───────────────────────────────────────────────────────

test('cron detail modal opens and shows schedule info', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('[data-type="cron"]', { timeout: 5000 });

  // Click the info button on the first cron card
  const firstCronCard = page.locator('[data-type="cron"]').first();
  const infoBtn = firstCronCard.locator('button').filter({ hasText: 'ℹ' });
  await infoBtn.click();

  // Modal should appear
  const modal = page.locator('#cron-detail-modal');
  await expect(modal).toBeVisible({ timeout: 2000 });

  // Modal body should contain schedule-related text
  const body = page.locator('#cron-detail-body');
  const bodyText = await body.textContent();
  expect(bodyText.length).toBeGreaterThan(10);
});

// ── LaunchD detail modal ────────────────────────────────────────────────────

test('launchd detail modal opens with service info', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('[data-type="launchd"]', { timeout: 5000 });

  // Click info on first launchd card
  const firstCard = page.locator('[data-type="launchd"]').first();
  const infoBtn = firstCard.locator('button').filter({ hasText: 'ℹ' });
  await infoBtn.click();

  const modal = page.locator('#launchd-detail-modal');
  // launchd API calls take ~1.5s (launchctl subprocess); allow sufficient time
  await expect(modal).toBeVisible({ timeout: 6000 });

  // Modal name header should be populated
  const name = page.locator('#launchd-detail-name');
  const nameText = await name.textContent();
  expect(nameText.length).toBeGreaterThan(0);
});

// ── Screenshots ─────────────────────────────────────────────────────────────

test('screenshot: full dashboard', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('[data-type="launchd"]', { timeout: 5000 });
  await page.waitForTimeout(500); // let status dots settle
  await page.screenshot({
    path: 'tests/screenshots/dashboard-full.png',
    fullPage: true,
  });
});

test('screenshot: cron detail modal', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('[data-type="cron"]', { timeout: 5000 });
  const firstCronCard = page.locator('[data-type="cron"]').first();
  await firstCronCard.locator('button').filter({ hasText: 'ℹ' }).click();
  await page.locator('#cron-detail-modal').waitFor({ state: 'visible' });
  await page.screenshot({ path: 'tests/screenshots/cron-detail-modal.png' });
});

test('screenshot: launchd detail modal', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForSelector('[data-type="launchd"]', { timeout: 5000 });
  const redisCard = page.locator('[data-type="launchd"]').filter({ hasText: 'redis' });
  await redisCard.locator('button').filter({ hasText: 'ℹ' }).click();
  await page.locator('#launchd-detail-modal').waitFor({ state: 'visible' });
  await page.screenshot({ path: 'tests/screenshots/launchd-detail-modal.png' });
});
