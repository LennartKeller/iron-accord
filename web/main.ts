import { SpriteStore } from '../src/render/sprites.ts';
import { SceneRenderer } from '../src/render/renderer.ts';
import { PointerControls } from '../src/input/pointer.ts';
import { terrainAt, type Scene } from '../src/maps/scene.ts';
import { actionableTiles } from '../src/game/pathfinding.ts';
import { assetFileName } from '../src/cw/assetname.ts';
import { bootstrapBrowser } from '../src/game/bootstrap.browser.ts';
import { gameMapFromScene } from '../src/game/fromscene.ts';
import { resolveBuildingSprites, resolveUnitSprites } from '../src/maps/loadmap.ts';
import { Game, type ActionStep } from '../src/game/game.ts';
import { describeVictoryRules, type VictoryRuleInfo } from '../src/game/victory.ts';
import { threatenedTiles } from '../src/game/threat.ts';
import {
  GameEnvironment, HeuristicAgent, PlannerAgent, applyAction, enumerateActions,
  type Agent,
} from '../src/ai/index.ts';
import { defaultConfig, sanitizeConfig, LIMITS, type GameConfig, type SeatController } from '../src/game/config.ts';
import { GameEnums, type AnimationRunner, type Unit } from '../src/host/index.ts';
import type { ScriptRegistry } from '../src/scripts/types.ts';

interface IndexEntry {
  id: string; name: string; author: string;
  width: number; height: number; playerCount: number; category: string;
}

const $ = <T extends HTMLElement>(selector: string): T =>
  document.querySelector<T>(selector)!;

const canvas = $<HTMLCanvasElement>('#stage');
const titleEl = $('#title');
const statusEl = $('#status');
const turnEl = $('#turn');
const menuEl = $('#menu');
const bannerEl = $('#banner');
const endTurnButton = $<HTMLButtonElement>('#endturn');
const nextUnitButton = $<HTMLButtonElement>('#nextunit');
const picker = $<HTMLDialogElement>('#picker');
const settingsDialog = $<HTMLDialogElement>('#settingsDialog');
const setup = $<HTMLDialogElement>('#setup');

/**
 * Everything is fetched relative to the deployment root. GitHub Pages serves a
 * project site from a subpath, so absolute "/sprites/..." URLs would 404 there
 * while working perfectly in local development.
 */
const BASE = import.meta.env.BASE_URL;
const asset = (relativePath: string) => `${BASE}${relativePath}`.replace(/([^:])\/{2,}/g, '$1/');

const sprites = new SpriteStore(
  id => asset(`sprites/${assetFileName(id)}.png`),
  name => asset(`colortables/${assetFileName(name)}.png`),
);
const renderer = new SceneRenderer(canvas, sprites);
// Repaint once a sprite we needed mid-frame has decoded.
renderer.onSpriteReady = () => requestRender();

let registry: ScriptRegistry | null = null;
let animations: AnimationRunner | null = null;
let game: Game | null = null;
let scene: Scene | null = null;
let env: GameEnvironment | null = null;
/**
 * The opponents on offer. The planner searches whole turns and reasons from
 * what its side can actually see, so it is the one to play under fog; the
 * heuristic is faster and remains the default.
 */
const AGENTS: Record<string, () => Agent> = {
  heuristic: () => new HeuristicAgent(),
  // A visible turn should not stall on a phone, so the search is kept short.
  planner: () => new PlannerAgent({ timeBudgetMs: 250 }),
};

const agents = new Map<number, Agent>();

/** The agent for a seat, built once and kept so its memory survives the turn. */
function agentFor(seat: number): Agent {
  const wanted = config?.seats[seat]?.agent ?? 'heuristic';
  let existing = agents.get(seat);
  if (!existing || existing.name !== wanted) {
    existing = (AGENTS[wanted] ?? AGENTS.heuristic)();
    agents.set(seat, existing);
  }
  return existing;
}
/** Set while the AI is playing, so taps do not fight it for control. */
let aiRunning = false;
let aiCancelled = false;

const options = { dimSpent: true };
/** Config for the game currently being set up, then for the running game. */
let config: GameConfig | null = null;
const fogEnabled = () => (config?.fog ?? 'off') !== 'off';

/**
 * What the next tap means.
 *
 *   idle          nothing picked up
 *   moving        a unit is selected and its range is shown
 *   choosing      the unit has a destination and the action menu is open
 *   targeting     an attack is being aimed
 */
type Mode = 'idle' | 'moving' | 'choosing' | 'targeting' | 'unloading' | 'picking';
let mode: Mode = 'idle';
let actor: Unit | null = null;
let destination: { x: number; y: number } | null = null;

let frameQueued = false;
function requestRender(): void {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => {
    frameQueued = false;
    renderer.camera.clampTo(renderer.worldWidth, renderer.worldHeight);
    renderer.render();
  });
}

// --- presentation ---------------------------------------------------------

const PLAYER_COLORS = ['#ff6b4a', '#58a6ff', '#3fb950', '#d29922', '#bc8cff', '#7ee787'];
const playerColor = (index: number) => PLAYER_COLORS[index % PLAYER_COLORS.length];

/**
 * Re-resolves building sprites from the live game, so a captured building shows
 * its new owner's colours immediately.
 */
function syncBuildings(): void {
  if (!game || !registry || !scene) { renderer.liveBuildings = null; return; }
  resolveBuildingSprites(game.map, registry);

  const viewer = game.currentPlayer;
  const buildings: NonNullable<typeof renderer.liveBuildings> = [];
  for (let y = 0; y < game.map.height; y++) {
    for (let x = 0; x < game.map.width; x++) {
      const building = game.map.getTerrain(x, y).getBuilding();
      if (!building) continue;
      // A shrouded tile shows nothing at all; fogged tiles still show terrain.
      if (fogEnabled() && viewer.getFieldVisibleType(x, y) === GameEnums.VisionType_Shrouded) continue;

      const ownerId = building.getOwnerID();
      const table = ownerId >= 0 ? scene.players[ownerId]?.colorTable : undefined;
      buildings.push({
        x, y,
        sprites: building.sprites.map(sprite => ({
          id: sprite.id,
          table: sprite.id.endsWith('+mask') ? table : (sprite.palette || undefined),
        })),
      });
    }
  }
  renderer.liveBuildings = buildings;
}

function syncUnits(): void {
  if (!game || !registry || !scene) { renderer.liveUnits = null; return; }
  // Sprites come from the unit scripts, not the scene: a freshly built unit type
  // is not in the scene's palette and would otherwise render as nothing.
  resolveUnitSprites(game.map, registry);

  const viewer = game.currentPlayer;
  renderer.liveUnits = game.map.units
    // Under fog a unit is only drawn where its tile is actually visible.
    .filter(unit => !fogEnabled() || viewer.getFieldVisible(unit.x, unit.y))
    .map(unit => {
      const table = scene!.players[unit.getOwner().getPlayerID()]?.colorTable;
      return {
        x: unit.x, y: unit.y, id: unit.getUnitID(),
        owner: unit.getOwner().getPlayerID(),
        hasMoved: options.dimSpent && unit.hasMoved,
        sprites: unit.sprites.map(sprite => ({
          id: sprite.id,
          table: sprite.id.endsWith('+mask') ? table : undefined,
        })),
        badges: badgesFor(unit),
      };
    });
  renderer.fog = fogEnabled() ? game.map.vision.gridFor(viewer) : null;
}

/**
 * Status icons for a unit, matching what the desktop client shows: the HP digit
 * when damaged, and markers for the conditions that change what a unit can do.
 */
function badgesFor(unit: Unit): { hp?: number; icons: string[] } {
  const icons: string[] = [];
  const hp = Math.ceil(unit.getHp());

  // Thirds are the thresholds the player actually cares about — below a third
  // of capacity a unit is one or two turns from being useless.
  if (unit.maxFuel > 0 && unit.fuel <= unit.maxFuel / 3) icons.push('fuel');
  if (unit.maxAmmo1 > 0 && unit.ammo1 <= unit.maxAmmo1 / 3) icons.push('ammo');
  if (unit.getCapturePoints() > 0) icons.push('capture');
  if (unit.getLoadedUnitCount() > 0) icons.push('transport');

  return { hp: hp < 10 ? hp : undefined, icons };
}

function syncTurn(): void {
  if (!game) {
    turnEl.textContent = '';
    endTurnButton.hidden = true;
    nextUnitButton.hidden = true;
    return;
  }
  turnEl.textContent = `Day ${game.day} · P${game.currentPlayerIndex + 1} · ${game.currentPlayer.funds}G`;
  turnEl.style.color = playerColor(game.currentPlayerIndex);
  endTurnButton.hidden = false;
  const pending = game.pendingUnits().length;
  endTurnButton.textContent = 'End turn';
  nextUnitButton.hidden = false;
  nextUnitButton.disabled = pending === 0 || aiRunning;
  nextUnitButton.textContent = pending > 0 ? `Next (${pending})` : 'Next';
}

/**
 * Units still awaiting orders, in a stable reading order.
 *
 * Row-major rather than spawn order: cycling should feel like sweeping the
 * board, and unit order otherwise shifts as things are built and destroyed.
 */
let lastCycledAt: { x: number; y: number } | null = null;

function pendingInReadingOrder(): Unit[] {
  if (!game) return [];
  return game.pendingUnits().sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

/**
 * Selects the next unit with orders left, wrapping around, and brings it into
 * view. Picking one up this way behaves exactly as tapping it does.
 */
function cycleToNextUnit(): void {
  if (!game || aiRunning) return;
  const pending = pendingInReadingOrder();
  if (pending.length === 0) return;

  // Resume from where the sweep last stopped, tracked as a board position
  // rather than a unit: the unit we stopped on has usually taken its orders by
  // the next press, and looking it up by id would send us back to the top.
  const from = game.selected ?? lastCycledAt;
  const next = (from && pending.find(u => u.y > from.y || (u.y === from.y && u.x > from.x)))
    ?? pending[0];
  lastCycledAt = { x: next.x, y: next.y };

  resetInteraction();
  renderer.selected = { x: next.x, y: next.y };
  if (game.select(next.x, next.y)) {
    mode = 'moving';
    actor = game.selected;
    showRange();
  }

  // Centre on it: on a large map the next unit is usually off screen.
  renderer.camera.x = next.x * 16 + 8;
  renderer.camera.y = next.y * 16 + 8;
  describe({ x: next.x, y: next.y });
  requestRender();
}

function showRange(): void {
  if (!game?.range) { renderer.highlights = []; return; }
  const color = playerColor(game.currentPlayerIndex);
  renderer.highlights = actionableTiles(game.range).map(tile => ({
    x: tile.x, y: tile.y, color: tile.canStop ? color : '#ffffff',
  }));
}

function showTargets(targets: Array<{ x: number; y: number; kind?: string }>): void {
  // Structures are tinted differently from units so it is clear what is being
  // shot at — a pipe seam looks nothing like a target otherwise.
  renderer.highlights = targets.map(t => ({
    x: t.x, y: t.y, color: t.kind && t.kind !== 'unit' ? '#d29922' : '#f85149',
  }));
}

function describe(tile: { x: number; y: number } | null): void {
  if (!scene || !tile) { statusEl.textContent = '—'; return; }
  const parts = [`(${tile.x},${tile.y})`, terrainAt(scene, tile.x, tile.y)];
  const building = game?.map.getTerrain(tile.x, tile.y).getBuilding();
  if (building) {
    const owner = building.getOwner();
    parts.push(`${building.getBuildingID()}${owner ? ` P${owner.getPlayerID() + 1}` : ' neutral'}`);
  }
  const unit = game?.unitAt(tile.x, tile.y);
  if (unit && (!fogEnabled() || game!.currentPlayer.getFieldVisible(tile.x, tile.y))) {
    parts.push(`${unit.getUnitID()} P${unit.getOwner().getPlayerID() + 1}`);
    parts.push(`${Math.ceil(unit.getHp())}HP ${unit.fuel}F`);
    if (unit.getLoadedUnitCount() > 0) {
      parts.push(`carrying ${unit.getLoadedUnitCount()}/${unit.getLoadingPlace()}`);
    }
    // A capture takes two ticks at full health, and without this the first one
    // looks like nothing happened at all.
    if (unit.getCapturePoints() > 0) parts.push(`capturing ${unit.getCapturePoints()}/20`);
    if (unit.hasMoved) parts.push('done');
    if (unit === inspected) {
      parts.push(unit.canMoveAndFire() ? 'reach shown' : 'firing range shown');
    }
  }
  statusEl.textContent = parts.join(' · ');
}

// --- context menu ---------------------------------------------------------

interface MenuItem { label: string; detail?: string; disabled?: boolean; run?(): void; }

function openMenu(screen: { x: number; y: number }, items: MenuItem[]): void {
  if (items.length === 0) { closeMenu(); return; }
  menuEl.replaceChildren(...items.map(item => {
    if (item.label === '-') {
      const sep = document.createElement('div');
      sep.className = 'sep';
      return sep;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.label;
    if (item.detail) {
      const cost = document.createElement('span');
      cost.className = 'cost';
      cost.textContent = item.detail;
      button.append(cost);
    }
    if (item.disabled) button.disabled = true;
    else button.addEventListener('click', () => { closeMenu(); item.run?.(); });
    return button;
  }));
  menuEl.hidden = false;

  // Fit it to the band between the two bars before measuring, so a long build
  // list becomes a scrolling menu instead of one that runs off the screen. The
  // bars are measured rather than assumed: that picks up their real height and
  // the safe-area padding they already carry on a notched phone.
  const gap = 8;
  const top = $('.bar--top').getBoundingClientRect().bottom + gap;
  const bottom = $('.bar--bottom').getBoundingClientRect().top - gap;
  const left = gap + safeInset('--safe-left');
  const right = window.innerWidth - gap - safeInset('--safe-right');
  menuEl.style.maxHeight = `${Math.max(MIN_MENU_HEIGHT, bottom - top)}px`;

  // Clamp low-then-high: on a screen too short for the menu the upper bound
  // goes past the lower one, and the tap position must lose to the top edge.
  const rect = menuEl.getBoundingClientRect();
  const x = clamp(screen.x + 12, left, Math.max(left, right - rect.width));
  const y = clamp(screen.y + 12, top, Math.max(top, bottom - rect.height));
  menuEl.style.left = `${x}px`;
  menuEl.style.top = `${y}px`;
}

/** Enough for two or three rows; below this, scrolling beats vanishing. */
const MIN_MENU_HEIGHT = 120;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

/** Reads a safe-area inset, which env() only exposes to CSS. */
function safeInset(name: string): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  return Number.parseFloat(raw) || 0;
}

function closeMenu(): void {
  menuEl.hidden = true;
  menuEl.replaceChildren();
}

function resetInteraction(): void {
  mode = 'idle';
  inspected = null;
  actor = null;
  destination = null;
  unloadIndex = -1;
  pickFields = [];
  game?.cancelAction();
  game?.clearSelection();
  renderer.highlights = [];
  renderer.path = [];
  renderer.selected = null;
  closeMenu();
}

// --- interaction ----------------------------------------------------------

let unloadIndex = -1;

function openActionMenu(screen: { x: number; y: number }): void {
  if (!game || !actor || !destination) return;
  const items: MenuItem[] = game.availableActions(actor, destination).map(option => ({
    label: option.label,
    run: () => runAction(option.id),
  }));

  // Unload is driven here rather than through the script, because
  // ACTION_UNLOAD is a multi-step action with its own menu and field pickers.
  const cargo = game.cargoOf(actor);
  if (cargo.length > 0 && !actor.hasMoved) {
    for (const { index, unit } of cargo) {
      items.push({
        label: `Unload ${unit.getUnitID().replace(/_/g, ' ').toLowerCase()}`,
        run: () => beginUnload(index),
      });
    }
  }

  items.push({ label: '-' }, { label: 'Cancel', run: () => { resetInteraction(); requestRender(); } });
  mode = 'choosing';
  openMenu(screen, items);
}

function beginUnload(index: number): void {
  if (!game || !actor || !destination) return;
  if (!game.moveForUnload(actor, destination.x, destination.y)) { resetInteraction(); requestRender(); return; }

  const targets = game.unloadTargets(actor, index);
  if (targets.length === 0) { resetInteraction(); requestRender(); return; }

  unloadIndex = index;
  mode = 'unloading';
  renderer.highlights = targets.map(t => ({ x: t.x, y: t.y, color: '#3fb950' }));
  renderer.path = [];
  statusEl.textContent = 'Pick where to unload';
  syncUnits();
  requestRender();
}

function runAction(actionID: string): void {
  if (!game || !actor || !destination) return;

  if (actionID === 'ACTION_FIRE') {
    // Fire needs a target, so move first and then aim.
    const targets = game.attackTargets(actor, destination);
    if (targets.length === 0) { resetInteraction(); requestRender(); return; }
    mode = 'targeting';
    showTargets(targets);
    renderer.path = [];
    statusEl.textContent = 'Pick a target';
    requestRender();
    return;
  }

  // Everything else goes through the generic multi-step driver: single-step
  // actions finish immediately, the rest ask for a tile or a menu choice.
  handleStep(game.beginAction(actionID, actor, destination));
}

/** Presents whatever the action needs next, or finishes the turn action. */
function handleStep(step: ActionStep): void {
  if (!game) return;
  switch (step.kind) {
    case 'field':
      mode = 'picking';
      pickFields = step.fields;
      renderer.highlights = step.fields.map(f => ({ x: f.x, y: f.y, color: '#ffd23f' }));
      renderer.path = [];
      statusEl.textContent = 'Pick a target tile';
      requestRender();
      return;

    case 'menu': {
      mode = 'picking';
      const items: MenuItem[] = step.entries.map(entry => ({
        label: entry.text || entry.actionID,
        detail: entry.cost ? `${entry.cost}G` : undefined,
        run: () => handleStep(game!.provideMenu(entry.actionID, entry.cost)),
      }));
      items.push({ label: '-' }, { label: 'Cancel', run: () => { game!.cancelAction(); resetInteraction(); requestRender(); } });
      const anchor = destination
        ? renderer.camera.worldToScreen(destination.x * 16 + 8, destination.y * 16 + 8)
        : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      openMenu(anchor, items);
      return;
    }

    default:
      game.cancelAction();
      afterTurnAction();
  }
}

let pickFields: Array<{ x: number; y: number }> = [];

function afterTurnAction(): void {
  resetInteraction();
  syncBuildings();
  syncUnits();
  syncTurn();
  checkBanner();
  requestRender();
  void maybeRunAI();
}

/** Is the seat currently to move played by the computer? */
function currentSeatIsAI(): boolean {
  if (!game || !config) return false;
  return config.seats[game.currentPlayerIndex]?.controller === 'ai';
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Plays the AI's turn one action at a time, pausing between them so a human can
 * follow what happened. Yielding to the event loop also keeps the page
 * responsive on large maps.
 */
async function maybeRunAI(): Promise<void> {
  if (!game || !env || aiRunning || game.over) return;
  if (!currentSeatIsAI()) return;

  aiRunning = true;
  aiCancelled = false;
  endTurnButton.disabled = true;
  statusEl.textContent = `P${game.currentPlayerIndex + 1} is thinking…`;

  try {
    let guard = 0;
    let acting = -1;
    while (!aiCancelled && game && !game.over && currentSeatIsAI() && guard++ < 500) {
      const legal = enumerateActions(game, { maxFieldChoices: 8 });
      const seat = agentFor(game.currentPlayerIndex);
      if (acting !== game.currentPlayerIndex) {
        acting = game.currentPlayerIndex;
        await seat.beginTurn?.(env);
      }
      const chosen = await seat.selectAction(env, legal) ?? { kind: 'endTurn' as const };

      if (chosen.kind === 'endTurn') {
        lastCycledAt = null;
        game.endTurn();
        resetInteraction();
        syncBuildings();
        syncUnits();
        syncTurn();
        checkBanner();
        requestRender();
        break;
      }

      // If the chosen action is no longer legal, selecting again would return
      // the same one forever and hold the board hostage for guard x 160ms.
      if (!applyAction(game, chosen)) {
        console.warn('AI proposed an action that could not be applied; ending its turn', chosen);
        game.endTurn();
        resetInteraction();
        syncBuildings();
        syncUnits();
        syncTurn();
        checkBanner();
        requestRender();
        break;
      }

      resetInteraction();
      syncBuildings();
      syncUnits();
      syncTurn();
      requestRender();
      await wait(160);
    }
  } finally {
    aiRunning = false;
    endTurnButton.disabled = false;
    checkBanner();
    syncTurn();
    // Clear the "thinking" line; the AI leaves no selection behind.
    describe(renderer.selected);
    requestRender();
    // Consecutive AI seats hand off to each other.
    if (!aiCancelled && currentSeatIsAI() && game && !game.over) void maybeRunAI();
  }
}

function openBuildMenu(screen: { x: number; y: number }, tile: { x: number; y: number }): void {
  if (!game) return;
  const building = game.map.getTerrain(tile.x, tile.y).getBuilding();
  if (!building) return;
  const items: MenuItem[] = game.buildOptions(building).map(option => ({
    label: option.id.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()),
    detail: `${option.cost}G`,
    disabled: !option.affordable,
    run: () => {
      game!.buildUnit(tile.x, tile.y, option.id);
      afterTurnAction();
    },
  }));
  if (items.length === 0) return;
  openMenu(screen, items);
}

/**
 * The enemy whose reach is on display. Tapping one is a look, not a move: it
 * changes nothing about the turn, so it is kept apart from `actor`.
 */
let inspected: Unit | null = null;

/**
 * Tiles it can shoot from where it stands, and tiles it must move to first.
 * A danger zone covers a lot of board, so the reach is a light wash and only
 * what is already in range is stated at full strength.
 */
const THREAT_NOW = { color: '#f85149', alpha: 0.5 };
const THREAT_AFTER_MOVE = { color: '#f85149', alpha: 0.22 };

/**
 * Shows what a spotted enemy could hit next turn, if the tapped tile holds one.
 *
 * Only units the current player can actually see: under fog, tapping a tile
 * where an enemy happens to be standing must reveal nothing at all.
 */
function showThreatOf(tile: { x: number; y: number }): boolean {
  if (!game) return false;
  const unit = game.unitAt(tile.x, tile.y);
  if (!unit || !game.currentPlayer.isEnemy(unit.getOwner())) return false;
  if (fogEnabled() && !game.currentPlayer.getFieldVisible(unit.x, unit.y)) return false;

  const threatened = threatenedTiles(game.map, unit);
  if (threatened.length === 0) return false;      // a transport has no weapon

  inspected = unit;
  renderer.highlights = threatened.map(threat => ({
    x: threat.x, y: threat.y,
    ...(threat.fromHere ? THREAT_NOW : THREAT_AFTER_MOVE),
  }));
  return true;
}

function onTap(screenX: number, screenY: number): void {
  // The board is read-only while the AI is thinking.
  if (aiRunning) return;
  const tile = renderer.tileAt(screenX, screenY);
  if (!menuEl.hidden) { closeMenu(); if (mode === 'choosing') { resetInteraction(); requestRender(); } return; }
  if (!game || !tile) { renderer.selected = tile; describe(tile); requestRender(); return; }

  if (mode === 'targeting' && actor && destination) {
    const targets = game.attackTargets(actor, destination);
    const hit = targets.find(t => t.x === tile.x && t.y === tile.y);
    if (hit) {
      game.attack(actor, destination, { x: hit.x, y: hit.y });
      afterTurnAction();
      return;
    }
    resetInteraction();
    requestRender();
    return;
  }

  if (mode === 'picking') {
    if (pickFields.some(f => f.x === tile.x && f.y === tile.y)) {
      handleStep(game.provideField(tile.x, tile.y));
    } else {
      game.cancelAction();
      resetInteraction();
      requestRender();
    }
    return;
  }

  if (mode === 'unloading' && actor && unloadIndex >= 0) {
    if (game.unloadUnit(actor, unloadIndex, tile.x, tile.y)) {
      actor.hasMoved = true;
      afterTurnAction();
      return;
    }
    resetInteraction();
    requestRender();
    return;
  }

  if (mode === 'moving' && actor && game.range?.tiles.has(`${tile.x},${tile.y}`)) {
    const reachable = game.range.tiles.get(`${tile.x},${tile.y}`)!;
    // Allied-occupied tiles are action targets too — that is how loading and
    // joining work — so the menu opens on anything actionable.
    if (reachable.canAct) {
      destination = { x: tile.x, y: tile.y };
      renderer.path = game.previewPath(tile.x, tile.y);
      renderer.selected = tile;
      openActionMenu({ x: screenX, y: screenY });
      requestRender();
      return;
    }
  }

  // Fresh selection.
  resetInteraction();
  renderer.selected = tile;
  const range = game.select(tile.x, tile.y);
  if (range) {
    mode = 'moving';
    actor = game.selected;
    showRange();
  } else if (showThreatOf(tile)) {
    // Nothing else to do: the overlay is the whole interaction.
  } else if (game.canProduceAt(tile.x, tile.y)) {
    openBuildMenu({ x: screenX, y: screenY }, tile);
  }
  describe(tile);
  requestRender();
}

new PointerControls(canvas, renderer.camera, {
  onChange: () => { closeMenu(); requestRender(); },
  onTap,
  onLongPress: () => { resetInteraction(); requestRender(); },
  onHover: (screenX, screenY) => {
    if (mode !== 'moving' || !game?.selected) return;
    const tile = renderer.tileAt(screenX, screenY);
    renderer.path = tile ? game.previewPath(tile.x, tile.y) : [];
    requestRender();
  },
});

endTurnButton.addEventListener('click', () => {
  if (aiRunning) return;
  lastCycledAt = null;
  game?.endTurn();
  afterTurnAction();
});

nextUnitButton.addEventListener('click', cycleToNextUnit);

window.addEventListener('keydown', event => {
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
  // Ignore keys typed into the map search box.
  if (event.target instanceof HTMLInputElement) return;
  if (event.key === 'n' || event.key === 'N') { cycleToNextUnit(); event.preventDefault(); }
});

// --- game over ------------------------------------------------------------

function checkBanner(): void {
  const over = game?.checkGameOver();
  if (!over) return;
  // A turn limit with no nominated winner defeats everyone, so there may be
  // no survivor to name.
  $('#banner-title').textContent = over.winner < 0 ? 'Draw' : `Player ${over.winner + 1} wins`;
  $('#banner-text').textContent = over.reason === 'hq-captured' ? 'Enemy HQ captured.'
    : over.reason === 'no-units' ? 'All enemy forces eliminated.'
    : ruleNameFor(over.ruleID);
  bannerEl.hidden = false;
}
/** Names the rule that ended it, using the script's own wording. */
function ruleNameFor(ruleID: string | null): string {
  const info = victoryRuleInfos.find(entry => entry.ruleID === ruleID);
  return info ? `${info.name}.` : 'The game is over.';
}
$('#banner-close').addEventListener('click', () => { bannerEl.hidden = true; });

// --- loading --------------------------------------------------------------

async function loadScene(id: string): Promise<void> {
  titleEl.textContent = 'loading…';
  const url = new URL(location.href);
  url.searchParams.set('map', id);
  history.replaceState(null, '', url);

  scene = await (await fetch(asset(`scenes/${id}.json`))).json();
  await renderer.load(scene!);
  bannerEl.hidden = true;
  resetInteraction();

  aiCancelled = true;
  if (registry) {
    config ??= defaultConfig(
      scene!.players.length, scene!.players.map(p => p.army), scene!.players[0]?.funds ?? 0);
    game = new Game(gameMapFromScene(scene!, registry, config), registry, animations,
      { victoryRules: config.victoryRules });
    env = new GameEnvironment(game.map, registry, { maxFieldChoices: 8 }, game);
  } else {
    game = null;
    env = null;
    renderer.liveUnits = null;
  }
  syncBuildings();
  syncUnits();
  syncTurn();

  titleEl.textContent = `${scene!.name}${scene!.author ? ` — ${scene!.author}` : ''}`;
  statusEl.textContent = `${scene!.width}×${scene!.height} · ${scene!.players.length}P`;

  // Debug affordances: ?select=x,y picks a unit up and ?to=x,y walks it to a
  // destination and opens the action menu, so any board state is reproducible
  // from a URL (and screenshottable headlessly).
  const params = new URL(location.href).searchParams;
  const select = parsePoint(params.get('select'));
  if (game && select) {
    renderer.selected = select;
    const screenAt = (p: { x: number; y: number }) =>
      renderer.camera.worldToScreen(p.x * 16 + 8, p.y * 16 + 8);

    if (game.select(select.x, select.y)) {
      mode = 'moving';
      actor = game.selected;
      showRange();
    } else if (game.canProduceAt(select.x, select.y)) {
      openBuildMenu(screenAt(select), select);
    }
    describe(select);

    // ?build=UNIT_ID produces a unit at the selected building, for reproducing
    // a board state (and for checking that fresh artwork appears without an
    // extra interaction).
    const buildId = params.get('build');
    if (buildId && game.canProduceAt(select.x, select.y)) {
      game.buildUnit(select.x, select.y, buildId);
      closeMenu();
      syncBuildings();
      syncUnits();
      syncTurn();
    }

    const to = parsePoint(params.get('to'));
    if (to && actor) {
      destination = to;
      renderer.path = game.previewPath(to.x, to.y);
      renderer.selected = to;

      // ?do=ACTION_ID performs the action instead of opening the menu.
      const perform = params.get('do');
      if (perform) {
        // ?repeat=N performs the action N times, refreshing the unit between —
        // a capture needs two ticks before the building changes hands.
        const repeat = Math.max(1, Math.min(Number(params.get('repeat')) || 1, 10));
        for (let i = 0; i < repeat; i++) {
          if (i > 0) {
            actor.hasMoved = false;
            game.select(actor.x, actor.y);
            destination = { x: actor.x, y: actor.y };
          }
          game.performAction(perform, actor, destination ?? to);
        }
        closeMenu();
        syncBuildings();
        syncUnits();
        syncTurn();
        renderer.path = [];
      } else {
        openActionMenu(screenAt(to));
      }
    }
  }
  requestRender();
  void maybeRunAI();
}

let index: IndexEntry[] = [];
let currentMapId = '';

/** Current map-browser filters. */
const filters = { search: '', players: '', size: '', category: '' };

function matchesFilters(entry: IndexEntry): boolean {
  const needle = filters.search.trim().toLowerCase();
  if (needle && !entry.name.toLowerCase().includes(needle)
    && !entry.author.toLowerCase().includes(needle)
    && !entry.category.toLowerCase().includes(needle)) return false;

  if (filters.players && entry.playerCount !== Number(filters.players)) return false;
  if (filters.category && entry.category !== filters.category) return false;

  if (filters.size) {
    // Longest side is a better sense of "how big does this feel" than area.
    const extent = Math.max(entry.width, entry.height);
    if (filters.size === 'small' && extent > 20) return false;
    if (filters.size === 'medium' && (extent <= 20 || extent > 40)) return false;
    if (filters.size === 'large' && extent <= 40) return false;
  }
  return true;
}

function renderList(): void {
  const listEl = $<HTMLUListElement>('#list');
  const matches = index.filter(matchesFilters);
  $('#filterCount').textContent = `${matches.length} map${matches.length === 1 ? '' : 's'}`;

  listEl.replaceChildren(...matches.slice(0, 300).map(entry => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    const detail = `${entry.width}×${entry.height} · ${entry.playerCount}P · ${escapeHtml(entry.category)}`
      + (entry.author ? ` · ${escapeHtml(entry.author)}` : '');
    button.innerHTML = `${escapeHtml(entry.name)}<small>${detail}</small>`;
    button.addEventListener('click', () => { picker.close(); void openSetup(entry); });
    li.append(button);
    return li;
  }));
}

// --- game setup -----------------------------------------------------------

let pendingMap: IndexEntry | null = null;
let pendingScene: Scene | null = null;

/** Picking a map opens setup rather than starting immediately. */
async function openSetup(entry: IndexEntry): Promise<void> {
  pendingMap = entry;
  pendingScene = await (await fetch(asset(`scenes/${entry.id}.json`))).json();
  const scene = pendingScene!;

  $('#setupTitle').textContent = scene.name;
  $('#setupNote').textContent =
    `${scene.width}×${scene.height} · ${scene.players.length} players`
    + (scene.author ? ` · by ${scene.author}` : '');

  const draft = defaultConfig(
    scene.players.length,
    scene.players.map(p => p.army),
    scene.players[0]?.funds ?? 0,
  );
  // Carry the current rules across so a new map keeps your preferences.
  if (config) {
    draft.fog = config.fog;
    draft.startingFunds = config.startingFunds;
    draft.unitLimit = config.unitLimit;
    draft.victoryRules = { ...config.victoryRules };
  }

  ($('#cfgFog') as HTMLSelectElement).value = draft.fog;
  ($('#cfgFunds') as HTMLInputElement).value = String(draft.startingFunds);
  ($('#cfgUnitLimit') as HTMLInputElement).value = String(draft.unitLimit);
  ($('#cfgIncome') as HTMLSelectElement).value = String(draft.fundsModifier);
  updateRuleHints();
  renderSeats(draft, scene);
  renderVictoryRules(draft, scene);
  setupDraft = draft;
  setup.showModal();
}

let setupDraft: GameConfig | null = null;
let victoryRuleInfos: VictoryRuleInfo[] = [];

/**
 * Builds the victory-condition controls from the rule scripts themselves —
 * names, help text, input kinds, defaults and maxima all come from
 * gamerules/victory/*.js, so nothing here has to know what a rule does.
 */
function renderVictoryRules(draft: GameConfig, scene: Scene): void {
  const host = $('#victoryRules');
  host.replaceChildren();
  if (!registry) return;

  // The rules read the board to work out their defaults — the capture target
  // scales with the number of properties — so they need a real map.
  victoryRuleInfos = describeVictoryRules(gameMapFromScene(scene, registry, draft), registry);

  for (const info of victoryRuleInfos) {
    const values = draft.victoryRules[info.ruleID]
      ?? info.items.map(item => item.defaultValue);

    const block = document.createElement('div');
    block.className = 'rule';
    const head = document.createElement('div');
    head.className = 'rule__head';

    const [first] = info.items;
    if (first?.type === 'checkbox') {
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.id = `vr-${info.ruleID}-0`;
      toggle.checked = values[0] !== 0;
      head.append(toggle);
    }
    const title = document.createElement('strong');
    title.textContent = info.name;
    head.append(title);

    if (first?.type === 'spinbox') {
      const input = document.createElement('input');
      input.type = 'number';
      input.id = `vr-${info.ruleID}-0`;
      input.min = '0';
      input.max = String(first.maxValue);
      input.value = String(values[0] ?? first.defaultValue);
      head.append(input);
    }
    block.append(head);

    if (info.description) {
      const note = document.createElement('div');
      note.className = 'rule__desc';
      // Rule text carries the engine's own inline markup (<r>, <div c='#0f0'>),
      // which means nothing to a browser — strip it rather than inject it.
      note.textContent = info.description.replace(/<[^>]*>/g, '');
      block.append(note);
    }

    const extras = info.items.slice(1);
    if (extras.length > 0) {
      const row = document.createElement('div');
      row.className = 'rule__items';
      extras.forEach((item, offset) => {
        const index = offset + 1;
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.id = `vr-${info.ruleID}-${index}`;
        if (item.type === 'checkbox') {
          input.type = 'checkbox';
          input.checked = (values[index] ?? item.defaultValue) !== 0;
        } else {
          input.type = 'number';
          input.min = '0';
          input.max = String(item.maxValue);
          input.value = String(values[index] ?? item.defaultValue);
        }
        // Checkbox reads "[x] Team counter"; a number reads "Unit value [60]".
        if (item.type === 'checkbox') label.append(input, document.createTextNode(` ${item.name}`));
        else label.append(document.createTextNode(`${item.name} `), input);
        row.append(label);
      });
      block.append(row);
    }
    host.append(block);
  }
}

/** Reads the controls back into rule values. */
function readVictoryRules(): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const info of victoryRuleInfos) {
    out[info.ruleID] = info.items.map((item, index) => {
      const input = document.getElementById(`vr-${info.ruleID}-${index}`) as HTMLInputElement | null;
      if (!input) return item.defaultValue;
      if (item.type === 'checkbox') return input.checked ? 1 : 0;
      const value = Math.round(Number(input.value));
      return Number.isFinite(value) ? Math.min(Math.max(value, 0), item.maxValue) : 0;
    });
  }
  return out;
}

/** Reads a numeric field, clamping it into range so the form cannot go negative. */
function readClamped(id: string, bounds: { min: number; max: number }): number {
  const input = $<HTMLInputElement>(id);
  const value = Math.round(Number(input.value));
  const clamped = Number.isFinite(value)
    ? Math.min(Math.max(value, bounds.min), bounds.max)
    : bounds.min;
  // Write it back so the field always shows what will actually be used.
  if (String(clamped) !== input.value) input.value = String(clamped);
  return clamped;
}

/** Spells out what the zero values mean, since both read as "unset" otherwise. */
function updateRuleHints(): void {
  const funds = readClamped('#cfgFunds', LIMITS.startingFunds);
  const limit = readClamped('#cfgUnitLimit', LIMITS.unitLimit);
  $('#cfgFundsHint').textContent = funds === 0 ? 'day-1 income only' : '';
  $('#cfgUnitLimitHint').textContent = limit === 0 ? 'unlimited' : `max ${limit} per player`;
}

const ARMIES = ['OS', 'BM', 'GE', 'YC', 'BH', 'BG', 'MA', 'AC', 'BD', 'DM', 'GS', 'PF', 'TI'];

function renderSeats(draft: GameConfig, scene: Scene): void {
  const body = $<HTMLTableSectionElement>('#seatRows');
  body.replaceChildren(...draft.seats.map((seat, index) => {
    const row = document.createElement('tr');

    const seatCell = document.createElement('td');
    const dot = document.createElement('span');
    dot.className = 'seat-dot';
    dot.style.background = scene.players[index]?.color ?? playerColor(index);
    seatCell.append(dot, document.createTextNode(`P${index + 1}`));

    const armyCell = document.createElement('td');
    armyCell.append(select(ARMIES, seat.army, value => { seat.army = value; }));

    const teamCell = document.createElement('td');
    const teams = draft.seats.map((_, i) => String(i + 1));
    teamCell.append(select(teams, String(seat.team + 1), value => { seat.team = Number(value) - 1; }));

    // Controller and opponent share a cell: the opponent picker is meaningless
    // for a human seat, so it appears only when one is needed.
    const controlCell = document.createElement('td');
    const opponent = select(Object.keys(AGENTS), seat.agent ?? 'heuristic',
      value => { seat.agent = value; });
    opponent.hidden = seat.controller !== 'ai';
    controlCell.append(select(['human', 'ai'], seat.controller, value => {
      seat.controller = value as SeatController;
      opponent.hidden = seat.controller !== 'ai';
    }), opponent);

    row.append(seatCell, armyCell, teamCell, controlCell);
    return row;
  }));
}

function select(values: string[], current: string, onChange: (value: string) => void): HTMLSelectElement {
  const element = document.createElement('select');
  element.replaceChildren(...values.map(value => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    if (value === current) option.selected = true;
    return option;
  }));
  element.addEventListener('change', () => onChange(element.value));
  return element;
}

function parsePoint(value: string | null): { x: number; y: number } | null {
  if (!value) return null;
  const [x, y] = value.split(',').map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

$('#pick').addEventListener('click', () => { renderList(); picker.showModal(); });
$('#newgame').addEventListener('click', () => {
  const entry = index.find(e => e.id === currentMapId) ?? index[0];
  if (entry) void openSetup(entry);
});
$('#close').addEventListener('click', () => picker.close());
$<HTMLInputElement>('#search').addEventListener('input', e => {
  filters.search = (e.target as HTMLInputElement).value;
  renderList();
});
for (const [id, key] of [['#filterPlayers', 'players'], ['#filterSize', 'size'], ['#filterCategory', 'category']] as const) {
  $<HTMLSelectElement>(id).addEventListener('change', e => {
    (filters as Record<string, string>)[key] = (e.target as HTMLSelectElement).value;
    renderList();
  });
}

$('#setupCancel').addEventListener('click', () => setup.close());
for (const id of ['#cfgFunds', '#cfgUnitLimit']) {
  $<HTMLInputElement>(id).addEventListener('input', updateRuleHints);
  $<HTMLInputElement>(id).addEventListener('blur', updateRuleHints);
}
$('#setupStart').addEventListener('click', () => {
  if (!setupDraft || !pendingMap) return;
  setupDraft.fog = ($('#cfgFog') as HTMLSelectElement).value as GameConfig['fog'];
  setupDraft.startingFunds = readClamped('#cfgFunds', LIMITS.startingFunds);
  setupDraft.unitLimit = readClamped('#cfgUnitLimit', LIMITS.unitLimit);
  setupDraft.fundsModifier = Number(($('#cfgIncome') as HTMLSelectElement).value) || 1;
  setupDraft.victoryRules = readVictoryRules();
  // Clamp in the model too: the form is not the only way in.
  config = sanitizeConfig(setupDraft);
  currentMapId = pendingMap.id;
  setup.close();
  void loadScene(pendingMap.id);
});
$('#fit').addEventListener('click', () => {
  renderer.camera.fit(renderer.worldWidth, renderer.worldHeight);
  requestRender();
});

// --- settings -------------------------------------------------------------

$('#settings').addEventListener('click', () => settingsDialog.showModal());
$('#settingsClose').addEventListener('click', () => settingsDialog.close());
$<HTMLInputElement>('#optGrid').addEventListener('change', e => {
  renderer.showGrid = (e.target as HTMLInputElement).checked;
  requestRender();
});
$<HTMLInputElement>('#optDim').addEventListener('change', e => {
  options.dimSpent = (e.target as HTMLInputElement).checked;
  syncUnits();
  requestRender();
});
window.addEventListener('resize', () => { renderer.resize(); requestRender(); });

async function main(): Promise<void> {
  const initial = new URL(location.href).searchParams;
  // ?fog=1 starts a fogged game, for headless checks of the vision path.
  const startFogged = initial.get('fog') === '1';
  // ?ai=2 makes seat 2 computer-controlled; ?ai=all makes every seat AI.
  const aiSeats = initial.get('ai');
  sprites.setManifest(await (await fetch(asset('sprites/index.json'))).json());
  index = await (await fetch(asset('scenes/index.json'))).json();
  const categories = [...new Set(index.map(e => e.category))].sort();
  $<HTMLSelectElement>('#filterCategory').append(...categories.map(category => {
    const option = document.createElement('option');
    option.value = category;
    option.textContent = category;
    return option;
  }));
  renderList();

  try {
    const boot = await bootstrapBrowser(asset('scripts.json'));
    registry = boot.registry;
    animations = boot.animations;
    if (boot.report.failed.length) console.warn('scripts failed to load', boot.report.failed);
    console.info(`Commander Wars scripts: ${boot.report.loaded.length} loaded in the browser`);
  } catch (error) {
    console.error('rules engine unavailable, falling back to map viewer', error);
  }

  const requested = initial.get('map');
  const startup = index.find(e => e.id === requested)
    // Categories come from the map directory names, which use underscores.
    ?? index.find(e => e.category === 'pre_deployed')
    ?? index[0];
  if (startup) {
    currentMapId = startup.id;
    const scene: Scene = await (await fetch(asset(`scenes/${startup.id}.json`))).json();
    config = defaultConfig(
      scene.players.length, scene.players.map(p => p.army), scene.players[0]?.funds ?? 0);
    if (startFogged) config.fog = 'war';
    if (aiSeats) {
      const wanted = aiSeats === 'all'
        ? config.seats.map((_, i) => i)
        : aiSeats.split(',').map(n => Number(n) - 1);
      for (const index of wanted) {
        if (config.seats[index]) config.seats[index].controller = 'ai';
      }
    }
    await loadScene(startup.id);
  }

  // ?tap=x,y synthesises a real pointer gesture on a tile, so the whole input
  // path (PointerControls included) can be exercised without a human finger.
  const tapAt = parsePoint(initial.get('tap'));
  if (tapAt) {
    const screen = renderer.camera.worldToScreen(tapAt.x * 16 + 8, tapAt.y * 16 + 8);
    const rect = canvas.getBoundingClientRect();
    const shared = {
      pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
      clientX: rect.left + screen.x, clientY: rect.top + screen.y,
    };
    canvas.dispatchEvent(new PointerEvent('pointerdown', shared));
    canvas.dispatchEvent(new PointerEvent('pointerup', shared));
  }

  // ?press=<id> clicks a control (optionally N times: ?press=nextunit,3), so
  // button-driven flows can be exercised headlessly too.
  const press = initial.get('press');
  if (press) {
    const [id, times] = press.split(',');
    const button = document.getElementById(id);
    for (let i = 0; i < Math.max(1, Math.min(Number(times) || 1, 20)); i++) {
      (button as HTMLButtonElement | null)?.click();
    }
  }

  // ?ui=maps|setup|settings opens a dialog on load, so any screen can be
  // reproduced from a URL.
  const ui = initial.get('ui');
  if (ui === 'maps') { renderList(); picker.showModal(); }
  else if (ui === 'setup' && startup) await openSetup(startup);
  else if (ui === 'settings') settingsDialog.showModal();
}

void main();

// Register the worker after boot so it never delays first paint. Dev builds
// skip it: a cache-first worker in front of HMR is nothing but confusing.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(asset('sw.js'), { scope: BASE }).catch(error => {
      console.warn('service worker registration failed', error);
    });
  });
}
