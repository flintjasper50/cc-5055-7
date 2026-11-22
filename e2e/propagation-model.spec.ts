import { expect, test } from '@playwright/test';

/**
 * Propagation-model trade-off UI tests.
 *
 * These drive the real workbench (same kernel used by the benchmark): choose
 * joint vs independent propagation for an interval, switch a single contour
 * segment, recompute, and confirm the evidence table reports the model that
 * actually moved each point. A final test persists and reopens the shot and
 * checks the local constraint survives.
 */

async function setFrame(page: import('@playwright/test').Page, frame: number) {
  const readout = page.getByTestId('frame-readout');
  const slider = page.locator('input[aria-label="frame slider"]');
  await slider.fill(String(frame));
  await slider.dispatchEvent('input');
  try {
    await expect(readout).toContainText(`${frame} /`, { timeout: 3_000 });
    return;
  } catch {
    // Some headless builds swallow the range input's React onChange; advance
    // with the genuine next-frame button instead (real user clicks).
    const current = Number(((await readout.textContent()) ?? '0').trim().split(' ')[0]);
    for (let f = current; f < frame; f++) {
      await page.getByRole('button', { name: 'next frame' }).click();
    }
  }
  await expect(readout).toContainText(`${frame} /`);
}

/**
 * Select a control point by clicking its rendered marker. The workbench only
 * exposes the canvas (no per-point DOM nodes), so we read the live contour
 * geometry from React's fiber on the canvas and map it through the same
 * fit-view transform the renderer uses.
 */
async function selectFirstControlPoint(page: import('@playwright/test').Page) {
  const point = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.stage');
    if (!canvas) return null;
    const fiberKey = Object.keys(canvas).find((k) => k.startsWith('__reactFiber$'));
    type ContourLike = { points: { id: string; x: number; y: number }[] };
    type ClipLike = { width: number; height: number };
    type AnyFiber = { memoizedProps: Record<string, unknown>; return: AnyFiber | null } | null;
    let fiber = (fiberKey ? (canvas as unknown as Record<string, AnyFiber>)[fiberKey] : null) as AnyFiber;
    let contour: ContourLike | null = null;
    let clip: ClipLike | null = null;
    while (fiber) {
      const p = fiber.memoizedProps;
      const maybeContour = p.contour as ContourLike | undefined;
      const maybeClip = p.clip as ClipLike | undefined;
      if (maybeContour && Array.isArray(maybeContour.points) && maybeClip) {
        contour = maybeContour;
        clip = maybeClip;
        break;
      }
      fiber = fiber.return;
    }
    if (!contour || !clip) return null;
    const box = canvas.getBoundingClientRect();
    const scale = Math.min((box.width - 16) / clip.width, (box.height - 16) / clip.height);
    const offsetX = (box.width - clip.width * scale) / 2;
    const offsetY = (box.height - clip.height * scale) / 2;
    const target = contour.points[0];
    if (!target) return null;
    return {
      x: box.left + offsetX + target.x * scale,
      y: box.top + offsetY + target.y * scale,
    };
  });
  if (!point) throw new Error('could not read a control-point position from the canvas');
  await page.mouse.click(point.x, point.y);
  await expect(page.getByTestId('segment-switch')).toContainText('Selected segment (p');
}

async function seedAndPropagate(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: /Add truth keyframes/ }).click();
  await page.getByRole('button', { name: /Recompute all intervals/ }).click();
  await expect(page.getByTestId('progress')).toBeHidden({ timeout: 60_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.stage')).toBeVisible({ timeout: 30_000 });
});

test('switches the whole interval to independent propagation and reports the model', async ({ page }) => {
  await seedAndPropagate(page);
  await setFrame(page, 30);
  await expect(page.getByTestId('method-badge')).toContainText('Auto');

  // Default joint model is reported in the evidence table.
  await expect(page.locator('[data-testid^="model-"]').first()).toContainText('joint');

  // Uniform independent selection for this interval.
  await page.getByTestId('mode-independent').click();
  await page.getByRole('button', { name: /Recompute all intervals/ }).click();
  await expect(page.getByTestId('progress')).toBeHidden({ timeout: 60_000 });
  await setFrame(page, 30);

  // Every reported point now records the independent model (no segment-local
  // marker because the choice was uniform across the interval).
  const cells = page.locator('[data-testid^="model-"]');
  expect(await cells.count()).toBeGreaterThan(10);
  for (const cell of await cells.all()) await expect(cell).toContainText('independent');

  // Reopen-the-lens burden and frame-to-frame change are computed for auto frames.
  await expect(page.getByTestId('reopen-burden')).toBeVisible();
  await expect(page.getByTestId('burden-points')).toContainText('/');
  await expect(page.getByTestId('frame-delta')).toBeVisible();
  expect(await page.getByTestId('delta-mean').textContent()).toMatch(/px/);
});

test('switches a single contour segment independently and keeps the rest joint', async ({ page }) => {
  await seedAndPropagate(page);
  await setFrame(page, 30);

  // Select a control point directly on the canvas to address its segment.
  const firstId = (await page.locator('[data-testid^="model-"]').first().getAttribute('data-testid'))!.replace(
    'model-',
    '',
  );
  await selectFirstControlPoint(page);
  await page.getByTestId('segment-independent').click();

  // The segment card now reports a segment-local override.
  await expect(page.getByTestId('segment-switch')).toContainText('independent');
  await expect(page.getByTestId('segment-switch')).toContainText('segment-local override');

  // Recompute; the switched segment's start point runs independent, others joint.
  await page.getByRole('button', { name: /Recompute all intervals/ }).click();
  await expect(page.getByTestId('progress')).toBeHidden({ timeout: 60_000 });
  await setFrame(page, 30);

  await expect(page.getByTestId(`model-${firstId}`)).toContainText('independent');
  const jointCells = page.locator('[data-testid^="model-"]', { hasText: 'joint' });
  expect(await jointCells.count()).toBeGreaterThan(0);

  // Clearing the override returns the segment to the interval default.
  await page.getByTestId('segment-clear').click();
  await expect(page.getByTestId('segment-switch')).toContainText('joint');
});

test('persists the joint/independent decision across saving and reopening the shot', async ({ page }) => {
  await seedAndPropagate(page);
  await setFrame(page, 30);
  await page.getByTestId('mode-independent').click();

  // Save via the download produced by the workbench.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('save-shot').click(),
  ]);
  const path = await download.path();
  expect(path).toBeTruthy();

  // Reload the page and reopen the saved file.
  await page.reload();
  await expect(page.locator('.stage')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('reopen-shot').setInputFiles(path!);

  await setFrame(page, 30);
  // The stored constraint comes back: the interval model card reflects independent.
  await expect(page.getByTestId('mode-independent')).toHaveClass(/active/);
});
