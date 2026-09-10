import { expect, test, type Page } from '@playwright/test';
import type { Scene } from '../../src/maps/scene.ts';
import { SAVE_KEY, type SavedGame } from '../../src/game/save.ts';

const mapId = 'pre-deployed-8-bridge-isles';

test.beforeEach(async ({ page }) => {
  // Keep real palettes and sprite assets while making tactics deterministic.
  await page.route(`**/scenes/${mapId}.json`, async route => {
    const response = await route.fetch();
    const original = await response.json() as Scene;
    const plains = original.terrainIds.indexOf('PLAINS');
    const layers = original.tileSprites[original.terrain.flat().indexOf(plains)];
    expect(layers?.length).toBeGreaterThan(0);
    const scene: Scene = {
      ...original, name: 'Browser regression battlefield', width: 9, height: 7,
      players: original.players.slice(0, 2), terrainIds: ['PLAINS'],
      terrain: Array.from({ length: 7 }, () => Array(9).fill(0)),
      tileSprites: Array.from({ length: 63 }, () => layers), buildings: [],
      units: [
        { x: 1, y: 3, id: 'INFANTRY', owner: 0, hp: 10, sprites: [] },
        { x: 3, y: 3, id: 'INFANTRY', owner: 0, hp: 10, sprites: [] },
        { x: 5, y: 3, id: 'INFANTRY', owner: 1, hp: 10, sprites: [] },
      ],
    };
    await route.fulfill({ response, json: scene });
  });
});

async function openGame(page: Page) {
  await page.goto(`?map=${mapId}`);
  await expect(page.locator('#title')).toContainText('Browser regression battlefield');
  await expect(page.locator('#endturn')).toBeEnabled();
}

async function startGame(page: Page) {
  await page.locator('#newgame').click();
  await expect(page.locator('#setup')).toBeVisible();
  await page.locator('#setupStart').click();
  await expect(page.locator('#setup')).not.toBeVisible();
  await expect(page.locator('#endturn')).toBeEnabled();
  await expect(page.locator('#saveIndicator')).toHaveText('Saved');
}

async function tapTile(page: Page, x: number, y: number) {
  const point = await page.locator('#stage').evaluate((canvas, tile) => {
    const rect = canvas.getBoundingClientRect();
    const scale = Math.max(2.5, Math.min((rect.width - 24) / 144, (rect.height - 24) / 112, 12));
    return { x: rect.left + rect.width / 2 + ((tile.x + 0.5) * 16 - 72) * scale,
      y: rect.top + rect.height / 2 + ((tile.y + 0.5) * 16 - 56) * scale };
  }, { x, y });
  if (test.info().project.name === 'mobile') await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
}

async function savedGame(page: Page): Promise<SavedGame> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
}

test('start, move, preview, fire, and resume the committed match', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openGame(page);
  await startGame(page);
  await expect(page.locator('#nextunit')).toHaveText('Next (2)');

  await tapTile(page, 1, 3);
  await expect(page.locator('.tactical-name')).toHaveText('Infantry');
  await tapTile(page, 2, 3);
  await page.locator('#menu').getByRole('button', { name: 'Wait', exact: true }).click();
  await expect(page.locator('#endturn')).toBeEnabled();
  await expect(page.locator('#nextunit')).toHaveText('Next (1)');
  const moved = await savedGame(page);
  expect(moved.state.units.find(u => u.owner === 0 && u.x === 2)?.hasMoved).toBe(true);

  await page.reload();
  await expect(page.locator('#endturn')).toBeEnabled();
  expect((await savedGame(page)).state).toEqual(moved.state);
  const resumed = await savedGame(page);
  await expect(page.locator('#nextunit')).toHaveText('Next (1)');
  await tapTile(page, 3, 3);
  await tapTile(page, 4, 3);
  await page.locator('#menu').getByRole('button', { name: 'Fire', exact: true }).click();
  await tapTile(page, 5, 3);
  const preview = page.getByRole('region', { name: 'Combat preview' });
  await expect(preview).toBeVisible();
  const bounds = await preview.boundingBox();
  const footer = await page.locator('footer').boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(footer!.y + 1);
  expect(await savedGame(page)).toEqual(resumed);

  await preview.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(preview).not.toBeVisible();
  await expect(page.locator('#nextunit')).toHaveText('Next (1)');
  expect(await savedGame(page)).toEqual(resumed);
  await tapTile(page, 5, 3);
  await preview.getByRole('button', { name: 'Fire', exact: true }).click();
  await expect(preview).not.toBeVisible();
  await expect(page.locator('#endturn')).toBeEnabled();
  await expect(page.locator('#nextunit')).toBeDisabled();
  const fired = await savedGame(page);
  expect(fired.state.units.find(u => u.owner === 0 && u.x === 4)?.hasMoved).toBe(true);
  expect(fired.state.units.find(u => u.owner === 1)!.hp).toBeLessThan(10);

  await page.reload();
  await expect(page.locator('#endturn')).toBeEnabled();
  expect((await savedGame(page)).state).toEqual(fired.state);
  await expect(page.locator('#nextunit')).toBeDisabled();
  await page.locator('#endturn').click();
  await expect(page.locator('#turn')).toContainText('P2');
  const ended = await savedGame(page);
  await page.reload();
  await expect(page.locator('#turn')).toContainText('P2');
  expect((await savedGame(page)).state).toEqual(ended.state);
  expect(errors).toEqual([]);
});

test('preserves a damaged save until a new match is started', async ({ page }) => {
  await page.addInitScript(key => localStorage.setItem(key, '{damaged'), SAVE_KEY);
  await openGame(page);
  await expect(page.locator('#saveIndicator')).toHaveText('Unsaved');
  expect(await page.evaluate(key => localStorage.getItem(key), SAVE_KEY)).toBe('{damaged');
  await startGame(page);
  expect((await savedGame(page)).version).toBe(1);
});

test('storage failures leave the match playable and report it', async ({ page }) => {
  await page.addInitScript(key => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Storage is full', 'QuotaExceededError');
      setItem.call(this, name, value);
    };
  }, SAVE_KEY);
  await openGame(page);
  await expect(page.locator('#saveIndicator')).toHaveText('Unsaved');
  await page.locator('#endturn').click();
  await expect(page.locator('#turn')).toContainText('P2');
  await page.locator('#settings').click();
  await expect(page.locator('#saveStatus')).toContainText(/save|storage/i);
});

test('one-time fog URL option does not restart a resumed match', async ({ page }) => {
  await page.goto(`?map=${mapId}&fog=1`);
  await expect(page.locator('#endturn')).toBeEnabled();
  await expect(page).not.toHaveURL(/fog=/);
  await page.locator('#endturn').click();
  await expect(page.locator('#turn')).toContainText('P2');
  const before = await savedGame(page);
  expect(before.config.fog).toBe('war');
  await page.reload();
  await expect(page.locator('#turn')).toContainText('P2');
  expect((await savedGame(page)).state).toEqual(before.state);
});
