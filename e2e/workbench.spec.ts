import { expect, test } from '@playwright/test';

/**
 * Golden-path UI test for the rotoscoping workbench.
 *
 * Exercises: clip generation → truth keyframes → two-sided propagation →
 * scrubbing to review sampled evidence and suspicious segments → a manual
 * correction → interval invalidation → interval recompute. Assertions are on
 * visible state (method badge, evidence table, stats) rather than internals.
 */

async function setFrame(page: import('@playwright/test').Page, frame: number) {
  const slider = page.locator('input[aria-label="frame slider"]');
  await slider.fill(String(frame));
  await expect(page.getByTestId('frame-readout')).toContainText(`${frame} /`);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.topbar h1')).toHaveText('Rotoscope Contour Tracker');
  // Clip generation takes ~1 s; wait for the stage to mount.
  await expect(page.locator('.stage')).toBeVisible({ timeout: 30_000 });
});

test('propagates an interval and shows sampled evidence and suspicious spans', async ({ page }) => {
  await page.getByTestId('tool-move').click();

  // Three ground-truth keyframes bracket two intervals.
  await page.getByRole('button', { name: /Add truth keyframes/ }).click();

  // Run two-sided propagation over both intervals.
  await page.getByRole('button', { name: /Recompute all intervals/ }).click();
  await expect(page.getByTestId('progress')).toBeVisible();
  await expect(page.getByTestId('progress')).toBeHidden({ timeout: 60_000 });
  await expect(page.getByText(/Applied \d+ automatic frames/)).toBeVisible();

  // A mid-occlusion frame must be an automatic result (not a keyframe).
  await setFrame(page, 40);
  await expect(page.getByTestId('method-badge')).toContainText('Auto');

  // The evidence table shows actual sampled correlation for the auto frame.
  const evidenceRows = page.locator('.evidence-table tbody tr');
  await expect(evidenceRows.first()).toBeVisible();
  expect(await evidenceRows.count()).toBeGreaterThan(10);

  // The occlusion scenario must surface suspicious (occluded/conflicting)
  // segments somewhere in the clip — these are reported, not hidden.
  await setFrame(page, 30);
  await expect(page.getByTestId('method-badge')).toContainText('Auto');
  const suspicious = page.getByTestId('stat-suspicious');
  const suspiciousCount = Number(await suspicious.textContent());
  expect(suspiciousCount).toBeGreaterThan(0);

  // Control-point identity is preserved: the contour still has the full set.
  const points = Number(await page.locator('.stat-grid dd').first().textContent());
  expect(points).toBe(clipPointCount());
});

test('manual correction invalidates the interval and recompute restores it', async ({ page }) => {
  await page.getByRole('button', { name: /Add truth keyframes/ }).click();
  await page.getByRole('button', { name: /Recompute all intervals/ }).click();
  await expect(page.getByTestId('progress')).toBeHidden({ timeout: 60_000 });

  await setFrame(page, 25);
  await expect(page.getByTestId('method-badge')).toContainText('Auto');

  // Add a control point on an interpolated frame: this becomes a manual
  // correction anchored at this frame.
  await page.getByTestId('tool-add').click();
  const box = await page.locator('.stage').boundingBox();
  if (!box) throw new Error('no canvas box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId('method-badge')).toContainText('Manual');

  // The automatic frames inside the touched interval are invalidated, so a
  // neighbouring interpolated frame no longer claims an auto result.
  await setFrame(page, 20);
  await expect(page.getByTestId('method-badge')).toContainText('No contour');

  // Recompute only the interval containing frame 20.
  await page.getByRole('button', { name: /Recompute interval at 20/ }).click();
  await expect(page.getByTestId('progress')).toBeHidden({ timeout: 60_000 });
  await expect(page.getByTestId('method-badge')).toContainText('Auto');

  // The manual correction is preserved through the recompute.
  await setFrame(page, 25);
  await expect(page.getByTestId('method-badge')).toContainText('Manual');
});

test('a stale background job cannot overwrite a manual correction', async ({ page }) => {
  await page.getByRole('button', { name: /Add truth keyframes/ }).click();
  await page.getByRole('button', { name: /Recompute all intervals/ }).click();
  await expect(page.getByTestId('progress')).toBeHidden({ timeout: 60_000 });

  await setFrame(page, 45);
  await expect(page.getByTestId('method-badge')).toContainText('Auto');

  // Start a long recompute, then immediately apply a manual correction while it
  // is still running. The revision guard must keep the correction.
  await page.getByRole('button', { name: /Recompute all intervals/ }).click();
  await expect(page.getByTestId('progress')).toBeVisible();

  await setFrame(page, 45);
  await page.getByTestId('tool-add').click();
  const box = await page.locator('.stage').boundingBox();
  if (!box) throw new Error('no canvas box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId('method-badge')).toContainText('Manual');

  // Let the background job finish (or cancel it); the manual frame must survive.
  await page.getByRole('button', { name: /Cancel job/ }).click();
  await expect(page.getByTestId('progress')).toBeHidden({ timeout: 60_000 });
  await setFrame(page, 45);
  await expect(page.getByTestId('method-badge')).toContainText('Manual');
});

test('draws a closed contour freehand as the first keyframe', async ({ page }) => {
  await page.getByTestId('tool-draw').click();
  const box = await page.locator('.stage').boundingBox();
  if (!box) throw new Error('no canvas box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Trace a closed ellipse with the pointer.
  await page.mouse.move(cx, cy - 90);
  await page.mouse.down();
  for (let i = 0; i <= 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    await page.mouse.move(cx + Math.cos(a) * 110, cy + Math.sin(a) * 70);
  }
  await page.mouse.up();

  // The first drawn contour is the track's first keyframe, with a usable number
  // of control points.
  await expect(page.getByTestId('method-badge')).toContainText('Keyframe');
  const points = Number(await page.locator('.stat-grid dd').first().textContent());
  expect(points).toBeGreaterThanOrEqual(4);
  expect(points).toBeLessThanOrEqual(40);
});

function clipPointCount(): number {
  // Ground-truth keyframes for the default (occlusion) scenario use 26 points.
  return 26;
}
