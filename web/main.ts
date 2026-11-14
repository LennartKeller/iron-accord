import { TacticalPanel } from '../src/ui/tactical-panel.ts';
import { createSave, readSave, writeSave, restoreSave, type SavedGame } from '../src/game/save.ts';
import { captureFeedback } from '../src/ui/action-feedback.ts';
import { SpriteStore } from '../src/render/sprites.ts';
import { SceneRenderer } from '../src/render/renderer.ts';
import { PointerControls } from '../src/input/pointer.ts';
import { unitVisibleToViewer } from '../src/render/visibility.ts';
import { terrainAt, type Scene } from '../src/maps/scene.ts';
import { drawOverview, overviewCell } from '../src/ui/minimap.ts';
import { SoundPlayer } from '../src/ui/sound.ts';
import { soundBus } from '../src/host/sound.ts';
import { snapshot, restore, type GameState } from '../src/game/snapshot.ts';
import { actionableTiles } from '../src/game/pathfinding.ts';
import { assetFileName } from '../src/cw/assetname.ts';
import { bootstrapBrowser } from '../src/game/bootstrap.browser.ts';
import { gameMapFromScene } from '../src/game/fromscene.ts';
import { resolveBuildingSprites, resolveUnitSprites } from '../src/maps/loadmap.ts';
import { Game, fogViewerIndex, nextObserverSeat, type ActionStep } from '../src/game/game.ts';
import { describeVictoryRules, type VictoryRuleInfo } from '../src/game/victory.ts';
import { threatenedTiles } from '../src/game/threat.ts';
import {
  GameEnvironment, HeuristicAgent, NormalAi, PlannerAgent, applyAction, enumerateActions,
  type Agent,
} from '../src/ai/index.ts';
import { ValueNetAgent } from '../src/ai/valuenet.web.ts';
import { CoordinatedAi } from '../src/ai/coordinated.ts';
import { defaultConfig, sanitizeConfig, LIMITS, type GameConfig, type SeatController } from '../src/game/config.ts';
import { GameEnums, Unit, type AnimationRunner, type Mulberry32, type Player } from '../src/host/index.ts';
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
const observerButton = $<HTMLButtonElement>('#observer');
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
const tacticalPanel = new TacticalPanel($('#tactical-panel'), sprites);
tacticalPanel.colorTableForPlayer = index => scene?.players[index]?.colorTable;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
renderer.reducedMotion = reducedMotion.matches;
reducedMotion.addEventListener('change', event => {
  renderer.reducedMotion = event.matches;
  renderer.clearAnimations();
  requestRender();
});
// Repaint once a sprite we needed mid-frame has decoded.
renderer.onSpriteReady = () => requestRender();

let registry: ScriptRegistry | null = null;
let animations: AnimationRunner | null = null;
/** The script RNG the whole battle draws luck from; set alongside `registry`. */
let rng: Mulberry32 | null = null;
let game: Game | null = null;
let scene: Scene | null = null;
let env: GameEnvironment | null = null;
/** Independent opponent choices; experimental coordination leaves NormalAi unchanged. */
const AGENTS: Record<string, () => Agent> = {
  heuristic: () => new HeuristicAgent(),
  // Seeded per battle rather than fixed, so repeat games are not identical.
  commanderwars: () => new NormalAi({
    name: 'commanderwars',
    // Seeded per battle rather than fixed, so repeat games are not identical.
    seed: (Math.random() * 0x7fffffff) >>> 0 || 1,
  }),
  coordinated: () => new CoordinatedAi({ seed: (Math.random() * 0x7fffffff) >>> 0 || 1 }),
  // A visible turn should not stall on a phone, so the search is kept short.
  planner: () => new PlannerAgent({ timeBudgetMs: 250 }),
  // Same search, learned position evaluation. The model loads on first use.
  valuenet: () => new ValueNetAgent(250),
};

const agents = new Map<number, { key: string; agent: Agent }>();

/**
 * The agent for a seat, built once and kept so its memory survives the turn.
 *
 * Keyed on the registry name rather than on `agent.name`. Those matched only by
 * convention, and when they did not the seat was rebuilt on every single call:
 * an agent that carries state across a turn then loses it constantly. NormalAi
 * showed it plainly -- its production system opens with six infantry, so a
 * per-call rebuild bought six infantry every turn and never reached the rest of
 * the build distribution.
 */
function agentFor(seat: number): Agent {
  const wanted = config?.seats[seat]?.agent ?? 'heuristic';
  let existing = agents.get(seat);
  if (!existing || existing.key !== wanted) {
    existing = { key: wanted, agent: (AGENTS[wanted] ?? AGENTS.heuristic)() };
    agents.set(seat, existing);
  }
  return existing.agent;
}
/** Set while the AI is playing, so taps do not fight it for control. */
let aiRunning = false;
let sceneLoading = false;
let sceneLoadVersion = 0;

const options = { dimSpent: true };
/** Config for the game currently being set up, then for the running game. */
let config: GameConfig | null = null;
const fogEnabled = () => (config?.fog ?? 'off') !== 'off';

let autosaveAllowed = true;

// Storage can itself throw (for example when cookies/storage are disabled).
function saveStatus(message: string, failed = false): void {
  $('#saveStatus').textContent = message;
  const indicator = $('#saveIndicator');
  indicator.textContent = failed ? 'Unsaved' : 'Saved';
  indicator.title = message;
  indicator.hidden = false;
}

/** Called only at committed boundaries, never while AI search or a picker is active. */
function autosave(): void {
  if (!autosaveAllowed || !game || !scene || !config || !rng || sceneLoading) return;
  try {
    const saved = createSave(game, scene, config, rng, currentMapId);
    saved.agentStates = Object.fromEntries([...agents].flatMap(([seat, entry]) =>
      entry.agent instanceof NormalAi || entry.agent instanceof CoordinatedAi
        ? [[seat, { key: entry.key, state: entry.agent.saveState() }]] : []));
    if (!writeSave(localStorage, saved)) throw new Error('Storage write failed');
    saveStatus(`Saved on this device at ${new Date(saved.savedAt).toLocaleTimeString()}. Reload to resume.`);
  } catch {
    saveStatus('Autosave unavailable. Keep this tab open to continue this match.', true);
  }
}

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

let battleAnchor: { x: number; y: number } | null = null;
function positionBattle(): void {
  if (!battleAnchor || tacticalPanel.element.hidden) return;
  const point = renderer.camera.worldToScreen(battleAnchor.x, battleAnchor.y);
  const canvasRect = canvas.getBoundingClientRect();
  tacticalPanel.positionBattle({ x: point.x + canvasRect.left, y: point.y + canvasRect.top }, {
    left: 8, right: window.innerWidth - 8,
    top: $('.bar--top').getBoundingClientRect().bottom + 8,
    bottom: $('.bar--bottom').getBoundingClientRect().top - 8,
  });
}

let frameQueued = false;
function requestRender(): void {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => {
    frameQueued = false;
    renderer.camera.clampTo(renderer.worldWidth, renderer.worldHeight);
    positionBattle();
    const wasAnimating = renderer.isAnimating;
    renderer.render();
    drawMinimap();
    if (renderer.isAnimating) requestRender();
    else if (wasAnimating) syncTurn();
  });
}

// --- sound --------------------------------------------------------------------

const SOUND_KEY = 'iron-accord.sound';
const sound = new SoundPlayer(file => asset(`sounds/${file}`));
try { sound.enabled = localStorage.getItem(SOUND_KEY) !== 'off'; } catch { /* storage unavailable */ }
// Audio may only start from a gesture; the first touch or key unlocks it.
for (const type of ['pointerdown', 'keydown'] as const) {
  window.addEventListener(type, () => sound.unlock(), { passive: true });
}

/**
 * A sound the rule scripts asked for. Engine noises are loops meant to run as
 * long as a walk animation does; ours is brief, so they are cut short.
 */
function scriptedSound(file: string): void {
  sound.play(file, { maxSeconds: file.startsWith('move') ? 0.7 : 1.6, gain: file.startsWith('move') ? 0.6 : 1 });
}

// --- undo ---------------------------------------------------------------------

interface Checkpoint {
  state: GameState;
  rng: number;
  /** Enemy units the player to move could see, by identity. */
  seen: Set<number>;
}

/** The position after the last completed action, or at the start of the turn. */
let checkpoint: Checkpoint | null = null;
/** Positions that can be gone back to, oldest first. Cleared whenever something irreversible happens. */
const undoStack: Checkpoint[] = [];
let undoTurn = '';
const undoButton = $<HTMLButtonElement>('#undo');

function takeCheckpoint(): Checkpoint | null {
  if (!game || !rng) return null;
  const mover = game.currentPlayer;
  const seen = new Set<number>();
  for (const unit of game.map.units) {
    if (mover.isEnemyUnit(unit) && unitVisibleToViewer(unit, mover)) seen.add(unit.uid);
  }
  return { state: snapshot(game), rng: rng.getState(), seen };
}

/**
 * Whether going from `before` to `after` may be taken back.
 *
 * Undo is for a slip of the finger, not for peeking. So an action stays
 * undoable only while it taught the player nothing: no dice were rolled (the
 * random stream did not move, which rules out every attack), no enemy came
 * into view, no ambush was sprung, and under shroud no new ground was
 * uncovered. Moving, waiting, loading, capturing and building all qualify.
 */
function reversible(before: Checkpoint, after: Checkpoint): boolean {
  if (after.state.over || before.rng !== after.rng) return false;
  for (const uid of after.seen) if (!before.seen.has(uid)) return false;
  const mover = before.state.currentPlayerIndex;
  if ((after.state.players[mover]?.visionFields.length ?? 0) > (before.state.players[mover]?.visionFields.length ?? 0)) {
    return false;
  }
  const was = before.state.visionMemory?.[mover], now = after.state.visionMemory?.[mover];
  if (was && now) {
    for (let i = 0; i < now.length; i++) if (was[i] === 0 && now[i] !== 0) return false;
  }
  return true;
}

/** Called when the turn changes hands or a match starts: nothing before this can be undone. */
function resetUndo(): void {
  undoStack.length = 0;
  checkpoint = takeCheckpoint();
  syncUndo();
}

/** Called after each of the player's own actions. */
function recordUndo(): void {
  const before = checkpoint;
  const after = takeCheckpoint();
  checkpoint = after;
  if (!before || !after) { undoStack.length = 0; syncUndo(); return; }
  // Cancelling a menu ends up here too; a position that did not change is not a step.
  if (JSON.stringify(before.state) === JSON.stringify(after.state)) return;
  if (reversible(before, after)) undoStack.push(before);
  else undoStack.length = 0;
  syncUndo();
}

function syncUndo(): void {
  const available = undoStack.length > 0 && !aiRunning && !currentSeatIsAI() && !game?.over;
  undoButton.hidden = !available;
}

function undo(): void {
  if (!game || !rng || aiRunning || sceneLoading || currentSeatIsAI() || game.over) return;
  const previous = undoStack.pop();
  if (!previous) return;
  renderer.clearAnimations();
  restore(game, previous.state);
  rng.setState(previous.rng);
  checkpoint = previous;
  resetInteraction();
  syncBuildings();
  syncUnits();
  syncTurn();
  autosave();
  statusEl.textContent = 'Move undone';
  sound.play('cancel.wav');
  syncUndo();
  requestRender();
}
undoButton.addEventListener('click', undo);

// --- overview ---------------------------------------------------------------

const minimapEl = $<HTMLCanvasElement>('#minimap');
let minimapBase: { scene: Scene; cell: number; image: HTMLCanvasElement } | null = null;

/**
 * A small overview in the corner, shown only when the board does not fit the
 * screen. It marks who holds what, the units the viewer can see, and the part
 * of the map on screen; tapping or dragging on it moves the camera there.
 */
function drawMinimap(): void {
  const camera = renderer.camera;
  const band = canvas.clientHeight - camera.insets.top - camera.insets.bottom;
  const fits = !scene || (renderer.worldWidth * camera.scale <= canvas.clientWidth + 1
    && renderer.worldHeight * camera.scale <= band + 1);
  minimapEl.hidden = fits;
  if (fits || !scene) return;

  if (minimapBase?.scene !== scene) {
    const cell = Math.max(2, Math.floor(overviewCell(scene, 132, 100)));
    const image = document.createElement('canvas');
    image.width = scene.width * cell;
    image.height = scene.height * cell;
    // Terrain only: buildings and units change, and are drawn fresh below.
    drawOverview(image.getContext('2d')!, scene, cell, { buildings: [], units: [] });
    minimapBase = { scene, cell, image };
    minimapEl.width = image.width;
    minimapEl.height = image.height;
  }
  const { cell, image } = minimapBase;
  const ctx = minimapEl.getContext('2d')!;
  ctx.drawImage(image, 0, 0);
  // The renderer's live lists are already filtered to what the viewer may see.
  const buildings = game ? [] as Array<{ x: number; y: number; owner: number }> : scene.buildings;
  if (game) {
    for (let y = 0; y < game.map.height; y++) {
      for (let x = 0; x < game.map.width; x++) {
        const building = game.map.getTerrain(x, y).getBuilding();
        if (building) buildings.push({ x, y, owner: building.getOwner()?.getPlayerID() ?? -1 });
      }
    }
  }
  const scratch = document.createElement('canvas');
  scratch.width = image.width; scratch.height = image.height;
  const marks = scratch.getContext('2d')!;
  drawOverview(marks, { ...scene, terrain: [], height: 0 }, cell, {
    buildings, units: (renderer.liveUnits ?? scene.units).map(unit => ({ x: unit.x, y: unit.y, owner: unit.owner })),
  });
  ctx.drawImage(scratch, 0, 0);

  // The part of the board between the bars.
  const topLeft = camera.screenToWorld(0, camera.insets.top);
  const bottomRight = camera.screenToWorld(canvas.clientWidth, canvas.clientHeight - camera.insets.bottom);
  const k = cell / 16;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(
    Math.max(0.75, topLeft.x * k), Math.max(0.75, topLeft.y * k),
    Math.min(image.width - 1.5, (bottomRight.x - topLeft.x) * k),
    Math.min(image.height - 1.5, (bottomRight.y - topLeft.y) * k));
}

function minimapJump(event: PointerEvent): void {
  if (!minimapBase) return;
  const rect = minimapEl.getBoundingClientRect();
  const k = 16 / minimapBase.cell * (minimapEl.width / rect.width);
  renderer.camera.x = (event.clientX - rect.left) * k;
  renderer.camera.y = (event.clientY - rect.top) * k;
  requestRender();
}
minimapEl.addEventListener('pointerdown', event => {
  minimapEl.setPointerCapture(event.pointerId);
  minimapJump(event);
  event.preventDefault();
});
minimapEl.addEventListener('pointermove', event => { if (event.buttons || event.pointerType === 'touch') minimapJump(event); });

// --- presentation ---------------------------------------------------------

const PLAYER_COLORS = ['#ff6b4a', '#58a6ff', '#3fb950', '#d29922', '#bc8cff', '#7ee787'];
const playerColor = (index: number) => PLAYER_COLORS[index % PLAYER_COLORS.length];

/**
 * Observer choice, only offered when every seat is an AI.
 *
 * `null` means omniscient — draw the board with no fog at all. A number locks
 * the view to that seat's knowledge. Watching an AI-vs-AI game under the
 * *current* seat's fog is the one thing that is never useful: the view flips
 * every turn, so nothing on screen is comparable to what was there a moment ago.
 * Omniscient is the default because it is what studying a game wants; locking to
 * a seat answers the different question of what that AI could actually see when
 * it made a choice.
 */
let observerSeat: number | null = null;

/** True when nobody is playing — the only case where an observer view applies. */
function isSpectating(): boolean {
  return !!config && config.seats.every(seat => seat.controller === 'ai');
}

/**
 * Whose fog the board is drawn under. Not simply the current player: while an
 * AI seat plays, its view would print everything the machine knows — its own
 * hidden units included — onto the watching human's screen (fogViewerIndex).
 */
function fogViewer() {
  if (!game) return null;
  if (isSpectating()) {
    if (observerSeat === null) return null;   // omniscient
    return game!.map.players[observerSeat] ?? null;
  }
  const seat = fogViewerIndex(
    game!.currentPlayerIndex,
    game!.map.players.length,
    index => config?.seats[index]?.controller !== 'ai',
    index => game!.map.players[index]?.isDefeated ?? true,
  );
  return game!.map.players[seat] ?? game!.currentPlayer;
}

/** Cycles omniscient -> seat 0 -> seat 1 -> ... -> omniscient. */
function cycleObserver(): void {
  renderer.clearAnimations();
  tacticalPanel.hide();
  if (!isSpectating() || !game) return;
  observerSeat = nextObserverSeat(
    observerSeat,
    game.map.players.length,
    seat => game!.map.players[seat]?.isDefeated ?? true,
  );
  syncUnits();
  syncBuildings();
  syncObserver();
  requestRender();
}

/**
 * The observer control, which is the only place this mode is visible.
 *
 * It lives on a button rather than in the status line because `describe()`
 * rewrites the status on every tile tap, so a hint there disappears the moment
 * you touch the board — and a keyboard shortcut alone is no use on a phone,
 * which is where this app mostly gets played.
 */
function syncObserver(): void {
  const spectating = isSpectating();
  observerButton.hidden = !spectating;
  if (!spectating) return;
  observerButton.textContent = observerSeat === null
    ? '👁 All'
    : `👁 P${observerSeat + 1}`;
  observerButton.style.color = observerSeat === null
    ? '' : playerColor(observerSeat);
}

/**
 * Re-resolves building sprites from the live game, so a captured building shows
 * its new owner's colours immediately.
 */
function syncBuildings(): void {
  if (!game || !registry || !scene) { renderer.liveBuildings = null; return; }
  resolveBuildingSprites(game.map, registry);

  const viewer = fogViewer();
  const buildings: NonNullable<typeof renderer.liveBuildings> = [];
  for (let y = 0; y < game.map.height; y++) {
    for (let x = 0; x < game.map.width; x++) {
      const building = game.map.getTerrain(x, y).getBuilding();
      if (!building) continue;
      // A shrouded tile shows nothing at all; fogged tiles still show terrain.
      // A null viewer is the omniscient observer, which is shrouded nowhere.
      if (fogEnabled() && viewer
          && viewer.getFieldVisibleType(x, y) === GameEnums.VisionType_Shrouded) continue;

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

  const viewer = fogViewer();
  renderer.liveUnits = game.map.units
    // Visibility includes status stealth even when map fog is switched off.
    .filter(unit => unitVisibleToViewer(unit, viewer))
    .map(unit => {
      const table = scene!.players[unit.getOwner().getPlayerID()]?.colorTable;
      return {
        uid: unit.uid, x: unit.x, y: unit.y, id: unit.getUnitID(),
        owner: unit.getOwner().getPlayerID(),
        hasMoved: options.dimSpent && unit.hasMoved,
        sprites: unit.sprites.map(sprite => ({
          id: sprite.id,
          table: sprite.id.endsWith('+mask') ? table : undefined,
        })),
        badges: badgesFor(unit),
      };
    });
  renderer.fog = fogEnabled() && viewer ? game.map.vision.gridFor(viewer) : null;
  // Omniscient observers see the whole board, so nothing indicates what the
  // agent that is currently moving can actually see. Shading its blind tiles
  // turns "why did it do that?" into a question the screen can answer.
  renderer.visionOverlay = fogEnabled() && !viewer && isSpectating()
    ? game.map.vision.gridFor(game.currentPlayer)
    : null;
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

/** The colour a seat is drawn in on the board, which is the map's, not a fixed palette. */
const seatColor = (index: number) => scene?.players[index]?.color ?? playerColor(index);

/**
 * Day, and every player's funds — whose turn it is at a glance, and whether
 * the opponent can afford that tank. The active seat also shows what it earns
 * per day; funds are public in Advance Wars, fog or not.
 */
function renderHud(): void {
  if (!game) return;
  const day = document.createElement('span');
  day.className = 'hud-day';
  day.textContent = `Day ${game.day}`;
  const seats = game.map.players.map((player, index) => {
    const seat = document.createElement('span');
    const active = index === game!.currentPlayerIndex;
    seat.className = `hud-seat${active ? ' hud-seat--active' : ''}${player.isDefeated ? ' hud-seat--out' : ''}`;
    seat.style.setProperty('--seat', seatColor(index));
    const dot = document.createElement('i');
    const name = document.createElement('b');
    name.textContent = `P${index + 1}`;
    const money = document.createElement('span');
    money.textContent = funds(player.funds);
    seat.append(dot, name, money);
    if (active && !player.isDefeated) {
      const income = document.createElement('small');
      income.textContent = `+${Math.round(game!.calcIncome(player)).toLocaleString('en-US')}`;
      income.title = 'Income per day';
      seat.append(income);
    }
    seat.title = `P${index + 1}: ${player.units.length} units`;
    return seat;
  });
  turnEl.replaceChildren(day, ...seats);
}

const turnToast = $('#turnToast');
let announcedTurn = '';

/**
 * Says whose turn it is when it changes. Without it a hand-over is a number
 * changing in the corner, and after an AI turn it is easy not to notice that
 * the board is yours again.
 */
function announceTurn(): void {
  if (!game || game.over) { turnToast.hidden = true; return; }
  const key = `${sceneLoadVersion}:${game.day}:${game.currentPlayerIndex}`;
  if (key === announcedTurn) return;
  const first = announcedTurn === '' || !announcedTurn.startsWith(`${sceneLoadVersion}:`);
  announcedTurn = key;
  // A freshly loaded or resumed match needs no fanfare.
  if (first) return;
  const index = game.currentPlayerIndex;
  const who = currentSeatIsAI() ? `P${index + 1} (computer)` : `P${index + 1} — your move`;
  turnToast.replaceChildren();
  const day = document.createElement('small');
  day.textContent = `Day ${game.day}`;
  const name = document.createElement('strong');
  name.textContent = who;
  turnToast.append(day, name);
  turnToast.style.setProperty('--seat', seatColor(index));
  turnToast.hidden = false;
  // Restart the CSS animation for back-to-back hand-overs.
  turnToast.classList.remove('turn-toast--show');
  void turnToast.offsetWidth;
  turnToast.classList.add('turn-toast--show');
}
turnToast.addEventListener('animationend', () => { turnToast.hidden = true; });

function syncTurn(): void {
  if (!game) {
    turnEl.textContent = '';
    endTurnButton.hidden = true;
    nextUnitButton.hidden = true;
    observerButton.hidden = true;
    return;
  }
  renderHud();
  announceTurn();
  const turnKey = `${sceneLoadVersion}:${game.day}:${game.currentPlayerIndex}`;
  if (turnKey !== undoTurn) {
    const started = undoTurn !== '' && undoTurn.startsWith(`${sceneLoadVersion}:`);
    undoTurn = turnKey;
    resetUndo();
    if (started && !currentSeatIsAI() && !game.over) sound.play('player_turn.wav');
  }
  syncUndo();
  endTurnButton.hidden = false;
  const pending = game.pendingUnits().length;
  endTurnButton.textContent = 'End turn';
  nextUnitButton.hidden = false;
  nextUnitButton.disabled = pending === 0 || aiRunning || renderer.isAnimating;
  endTurnButton.disabled = aiRunning || sceneLoading || renderer.isAnimating;
  nextUnitButton.textContent = pending > 0 ? `Next (${pending})` : 'Next';
  syncObserver();
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
  if (renderer.isAnimating) return;
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

/** Where the selected unit can go: a light wash with a crisp border, so the terrain stays readable. */
const RANGE_EDGE = '#f0f6fc';

function showRange(): void {
  if (!game?.range) { renderer.highlights = []; return; }
  renderer.highlights = actionableTiles(game.range).map(tile => ({
    x: tile.x, y: tile.y, color: '#ffffff', edge: RANGE_EDGE,
    // A tile the unit can act on but not stop at (an ally stands there) is fainter.
    alpha: tile.canStop ? 0.24 : 0.1,
  }));
}

function showTargets(targets: Array<{ x: number; y: number; kind?: string }>): void {
  // Structures are tinted differently from units so it is clear what is being
  // shot at — a pipe seam looks nothing like a target otherwise.
  renderer.highlights = targets.map(t => {
    const color = t.kind && t.kind !== 'unit' ? '#d29922' : '#f85149';
    return { x: t.x, y: t.y, color, alpha: 0.4, edge: color };
  });
}

/**
 * What Commander Wars itself calls a unit, building or terrain. The scripts
 * carry proper names ("APC", "Anti-Tank Cannon"); title-casing the id gives
 * "Apc" and "Antitankcannon".
 */
function displayName(id: string): string {
  let name: unknown;
  try { name = registry?.[id]?.getName?.(); } catch { /* fall through */ }
  if (typeof name === 'string' && name.trim() !== '') return name;
  return id.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

/** Thousands separators, so 16000 does not have to be counted. */
const funds = (value: number) => `${Math.round(value).toLocaleString('en-US')} G`;

function describe(tile: { x: number; y: number } | null): void {
  tacticalPanel.hide();
  if (!scene || !tile) { statusEl.textContent = '—'; return; }
  const viewer = fogViewer();
  if (fogEnabled() && viewer?.getFieldVisibleType(tile.x, tile.y) === GameEnums.VisionType_Shrouded) {
    statusEl.textContent = 'Unexplored';
    return;
  }
  // Most specific first: the unit, then what it stands on.
  const parts: string[] = [];
  const unit = game?.unitAt(tile.x, tile.y);
  if (unit && unitVisibleToViewer(unit, viewer)) {
    tacticalPanel.showUnit(game!, unit, tile);
    parts.push(`${displayName(unit.getUnitID())} (P${unit.getOwner().getPlayerID() + 1})`);
    parts.push(`${Math.ceil(unit.getHp())} HP`);
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
  const building = game?.map.getTerrain(tile.x, tile.y).getBuilding();
  if (building) {
    const owner = building.getOwner();
    parts.push(`${displayName(building.getBuildingID())} — ${owner ? `P${owner.getPlayerID() + 1}` : 'neutral'}`);
  } else {
    parts.push(displayName(terrainAt(scene, tile.x, tile.y)));
  }
  statusEl.textContent = parts.join(' · ');
  statusEl.title = `Tile ${tile.x}, ${tile.y}`;
}

// --- context menu ---------------------------------------------------------

interface MenuItem { label: string; detail?: string; disabled?: boolean; icon?: HTMLElement; run?(): void; }

/** Sprite layers a unit type would be drawn with for a player, without building one. */
const rosterSprites = new Map<string, Unit['sprites']>();
function spritesForUnitType(unitID: string, player: Player): Unit['sprites'] {
  if (!game) return [];
  const key = `${unitID}:${player.getPlayerID()}:${player.getArmy()}`;
  let layers = rosterSprites.get(key);
  if (!layers) {
    // A throwaway unit that never joins the board; the identity counter it
    // would otherwise consume is rules state, so it is put back.
    const counter = game.map.getUnitUidCounter();
    const probe = new Unit(game.map, unitID, player, -1, -1);
    try { registry?.[unitID]?.loadSprites?.(probe, game.map); } catch { /* no artwork */ }
    game.map.setUnitUidCounter(counter);
    game.map.markUnitsDirty();
    layers = probe.sprites;
    rosterSprites.set(key, layers);
  }
  return layers;
}

/** One of Commander Wars' own interface icons, by sprite id; blank if the artwork is not shipped. */
function spriteIcon(id: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.className = 'menu-icon menu-icon--action';
  canvas.width = 24;
  canvas.height = 24;
  canvas.setAttribute('aria-hidden', 'true');
  void sprites.get(id).then(sprite => {
    const ctx = canvas.getContext('2d');
    if (!ctx || !sprite) return;
    ctx.imageSmoothingEnabled = false;
    const scale = Math.min(24 / sprite.frameWidth, 24 / sprite.frameHeight);
    const w = sprite.frameWidth * scale, h = sprite.frameHeight * scale;
    ctx.drawImage(sprite.image, 0, 0, sprite.frameWidth, sprite.frameHeight, (24 - w) / 2, (24 - h) / 2, w, h);
  }).catch(() => { /* no artwork: the label stands alone */ });
  return canvas;
}

/** A small recoloured picture of a unit type, for menus. */
function unitIcon(unitID: string, player: Player): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.className = 'menu-icon';
  canvas.width = 32;
  canvas.height = 32;
  canvas.setAttribute('aria-hidden', 'true');
  const table = scene?.players[player.getPlayerID()]?.colorTable;
  void Promise.all(spritesForUnitType(unitID, player).map(layer =>
    (table && layer.id.endsWith('+mask') ? sprites.getRecolored(layer.id, table) : sprites.get(layer.id))
      .catch(() => null),
  )).then(layers => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    for (const sprite of layers) {
      if (!sprite) continue;
      const scale = Math.min(30 / sprite.frameWidth, 30 / sprite.frameHeight);
      const w = sprite.frameWidth * scale, h = sprite.frameHeight * scale;
      ctx.drawImage(sprite.image, 0, 0, sprite.frameWidth, sprite.frameHeight, (32 - w) / 2, 31 - h, w, h);
    }
  });
  return canvas;
}

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
    if (item.icon) button.append(item.icon);
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = item.label;
    button.append(label);
    if (item.detail) {
      const cost = document.createElement('span');
      cost.className = 'cost';
      cost.textContent = item.detail;
      button.append(cost);
    }
    if (item.disabled) button.disabled = true;
    else button.addEventListener('click', () => { sound.play('okay.wav', { gain: 0.7 }); closeMenu(); item.run?.(); });
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
  tacticalPanel.hide();
  mode = 'idle';
  inspected = null;
  actor = null;
  destination = null;
  unloadIndex = -1;
  pickFields = [];
  // A transport that moved for an unload that never happened goes back to its
  // origin — and must be redrawn there, or the sprite stays at the abandoned
  // destination until something else refreshes the board.
  if (game?.cancelUnloadMove()) syncUnits();
  game?.cancelAction();
  game?.clearSelection();
  renderer.highlights = [];
  renderer.path = [];
  renderer.selected = null;
  closeMenu();
}

/** Rules resolve synchronously; animation only interpolates their visible result. */
function presentAction<T>(unit: Unit | null, to: { x: number; y: number } | null, run: () => T): T {
  if (!game) return run();
  const finish = captureFeedback(game, renderer.liveUnits ?? [], unit, to);
  // The scripts' sounds are heard only for an action the person watching may
  // witness: their own, or one by a unit they can see. Anything else — and
  // every action an AI merely considers — runs with no listener.
  const watcher = fogViewer();
  const audible = !currentSeatIsAI() || !fogEnabled() || !watcher
    || (unit !== null && unitVisibleToViewer(unit, watcher));
  soundBus.sink = audible ? scriptedSound : null;
  let result: T;
  try { result = run(); } finally { soundBus.sink = null; }
  const feedback = finish();
  syncBuildings();
  syncUnits();
  const viewer = fogViewer();
  // Fog grids alone do not represent status/terrain stealth on clear tiles.
  // Omit an enemy's disappearing route rather than exposing its hidden endpoint.
  const motionVisible = feedback.movement && (!viewer
    || feedback.movement.unit.owner === viewer.getPlayerID()
    || renderer.liveUnits?.some(unit => unit.uid === feedback.movement!.uid));
  const duration = motionVisible && feedback.movement
    ? renderer.animateMove(feedback.movement.uid, feedback.movement.path, feedback.movement.unit) : 0;
  for (const effect of feedback.effects) {
    if (viewer && !viewer.getFieldVisible(effect.x, effect.y)) continue;
    const occupant = game.map.getUnitAt(effect.x, effect.y);
    if (occupant && !unitVisibleToViewer(occupant, viewer)) continue;
    renderer.addEffect(effect.x, effect.y, effect.text, effect.color, duration);
    // Cues for what the scripts leave to Commander Wars' battle and capture
    // screens, which this game does not have.
    if (effect.text === 'TRAP!') sound.play('trap.wav');
    else if (effect.text === 'CAPTURED') sound.play('capture_ally.wav');
    else if (effect.text.startsWith('CAPTURE')) sound.play('capture.wav', { maxSeconds: 1.2 });
    else if (effect.text.endsWith('HP')) sound.play('cannon_weapon_fire.wav', { gain: 0.8 });
  }
  requestRender();
  return result;
}

// --- interaction ----------------------------------------------------------

let unloadIndex = -1;

function openActionMenu(screen: { x: number; y: number }): void {
  if (!game || !actor || !destination) return;
  const items: MenuItem[] = game.availableActions(actor, destination).map(option => ({
    label: option.label,
    icon: option.icon ? spriteIcon(option.icon) : undefined,
    run: () => runAction(option.id),
  }));

  // Unload is driven here rather than through the script, because
  // ACTION_UNLOAD is a multi-step action with its own menu and field pickers.
  const cargo = game.cargoOf(actor);
  if (cargo.length > 0 && !actor.hasMoved) {
    for (const { index, unit } of cargo) {
      items.push({
        label: `Unload ${displayName(unit.getUnitID())}`,
        icon: unitIcon(unit.getUnitID(), unit.getOwner()),
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
  if (!presentAction(actor, destination, () => game!.moveForUnload(actor!, destination!.x, destination!.y))) {
    // A trap commits a shorter move and spends the transport, while cancelling
    // the planned unload. Refresh the board even though no drop can proceed.
    resetInteraction();
    syncBuildings();
    syncUnits();
    syncTurn();
    checkBanner();
    autosave();
    requestRender();
    return;
  }

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
  handleStep(presentAction(actor, destination, () => game!.beginAction(actionID, actor!, destination!)));
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
        run: () => handleStep(presentAction(actor, destination, () => game!.provideMenu(entry.actionID, entry.cost))),
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
  statusEl.textContent = 'Select a unit';
  syncBuildings();
  syncUnits();
  syncTurn();
  recordUndo();
  checkBanner();
  autosave();
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
/**
 * Brings what the computer is about to do into view. Only for things the
 * person watching may see: scrolling to a hidden unit would give away where it
 * is as surely as drawing it.
 */
function followAction(action: Parameters<typeof applyAction>[1]): void {
  if (!game || action.kind === 'endTurn') return;
  const viewer = fogViewer();
  let focus: { x: number; y: number };
  if (action.kind === 'unit') {
    const unit = game.map.getUnitByUid(action.uid);
    if (!unit || !unitVisibleToViewer(unit, viewer)) return;
    focus = action.target ?? action.to;
  } else {
    focus = action.at;
    if (fogEnabled() && viewer && !viewer.getFieldVisible(focus.x, focus.y)) return;
  }
  const camera = renderer.camera;
  const wx = focus.x * 16 + 8, wy = focus.y * 16 + 8;
  if (camera.shows(wx, wy, 48)) return;
  camera.x = wx;
  camera.y = wy;
  camera.clampTo(renderer.worldWidth, renderer.worldHeight);
  requestRender();
}

async function maybeRunAI(): Promise<void> {
  if (!game || !env || aiRunning || sceneLoading || game.over) return;
  if (!currentSeatIsAI()) return;

  aiRunning = true;
  const runningGame = game;
  const runningEnv = env;
  const version = sceneLoadVersion;
  const isCurrent = () => !sceneLoading && version === sceneLoadVersion && game === runningGame;
  endTurnButton.disabled = true;
  statusEl.textContent = `P${game.currentPlayerIndex + 1} is thinking…`;

  try {
    let guard = 0;
    let acting = -1;
    while (isCurrent() && game && !game.over && currentSeatIsAI() && guard++ < 500) {
      const legal = enumerateActions(game, { maxFieldChoices: 8 });
      const seat = agentFor(game.currentPlayerIndex);
      if (acting !== game.currentPlayerIndex) {
        acting = game.currentPlayerIndex;
        await seat.beginTurn?.(runningEnv);
        if (!isCurrent()) return;
      }
      const chosen = await seat.selectAction(runningEnv, legal) ?? { kind: 'endTurn' as const };
      if (!isCurrent()) return;

      if (chosen.kind === 'endTurn') {
        lastCycledAt = null;
        game.endTurn();
        resetInteraction();
        syncBuildings();
        syncUnits();
        syncTurn();
        checkBanner();
        autosave();
        requestRender();
        break;
      }

      followAction(chosen);

      // If the chosen action is no longer legal, selecting again would return
      // the same one forever and hold the board hostage for guard x 160ms.
      if (!presentAction(chosen.kind === 'unit' ? game.map.getUnitByUid(chosen.uid) : null,
        chosen.kind === 'unit' ? chosen.to : null, () => applyAction(game!, chosen))) {
        console.warn('AI proposed an action that could not be applied; ending its turn', chosen);
        game.endTurn();
        resetInteraction();
        syncBuildings();
        syncUnits();
        syncTurn();
        checkBanner();
        autosave();
        requestRender();
        break;
      }

      resetInteraction();
      syncBuildings();
      syncUnits();
      syncTurn();
      checkBanner();
      autosave();
      requestRender();
      do { await wait(40); } while (isCurrent() && renderer.isAnimating);
    }
  } finally {
    aiRunning = false;
    if (!sceneLoading) {
      endTurnButton.disabled = false;
      checkBanner();
      syncTurn();
      // Clear the "thinking" line; the AI leaves no selection behind.
      describe(renderer.selected);
      requestRender();
    }
    // Consecutive AI seats hand off to each other.
    if (!sceneLoading && currentSeatIsAI() && game && !game.over) void maybeRunAI();
  }
}

function openBuildMenu(screen: { x: number; y: number }, tile: { x: number; y: number }): void {
  if (!game) return;
  const building = game.map.getTerrain(tile.x, tile.y).getBuilding();
  if (!building) return;
  const owner = building.getOwner() ?? game.currentPlayer;
  const items: MenuItem[] = game.buildOptions(building).map(option => ({
    label: displayName(option.id),
    detail: funds(option.cost),
    icon: unitIcon(option.id, owner),
    disabled: !option.affordable,
    run: () => {
      const built = game!.buildUnit(tile.x, tile.y, option.id);
      if (built) renderer.addEffect(tile.x, tile.y, 'DEPLOYED', '#85e5ac');
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
  if (!unitVisibleToViewer(unit, fogViewer())) return false;

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
  if (aiRunning || sceneLoading || renderer.isAnimating) return;
  const tile = renderer.tileAt(screenX, screenY);
  if (!menuEl.hidden) { closeMenu(); if (mode === 'choosing') { resetInteraction(); requestRender(); } return; }
  if (!game || !tile) { renderer.selected = tile; describe(tile); requestRender(); return; }

  if (mode === 'targeting' && actor && destination) {
    const targets = game.attackTargets(actor, destination);
    const hit = targets.find(t => t.x === tile.x && t.y === tile.y);
    if (hit) {
      const attackingGame = game;
      const attackingUnit = actor;
      const from = { ...destination };
      renderer.selected = { x: hit.x, y: hit.y };
      battleAnchor = renderer.camera.screenToWorld(screenX, screenY);
      tacticalPanel.showBattle(game, actor, from, hit, () => {
        if (game !== attackingGame || !game.canControl(attackingUnit) || renderer.isAnimating) return;
        presentAction(attackingUnit, from, () => game!.attack(attackingUnit, from, hit));
        afterTurnAction();
      }, () => {
        tacticalPanel.hide();
        statusEl.textContent = 'Pick a target';
        requestRender();
      });
      positionBattle();
      tacticalPanel.element.querySelector<HTMLButtonElement>('.tactical-button--fire')?.focus({ preventScroll: true });
      requestRender();
      return;
    }
    resetInteraction();
    requestRender();
    return;
  }

  if (mode === 'picking') {
    if (pickFields.some(f => f.x === tile.x && f.y === tile.y)) {
      handleStep(presentAction(actor, destination, () => game!.provideField(tile.x, tile.y)));
    } else {
      game.cancelAction();
      resetInteraction();
      requestRender();
    }
    return;
  }

  if (mode === 'unloading' && actor && unloadIndex >= 0) {
    if (presentAction(actor, { x: actor.x, y: actor.y }, () => game!.unloadUnit(actor!, unloadIndex, tile.x, tile.y))) {
      renderer.addEffect(tile.x, tile.y, 'UNLOADED', '#85e5ac');
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
  onLongPress: () => {
    if (aiRunning || sceneLoading || renderer.isAnimating) return;
    resetInteraction();
    requestRender();
  },
  onHover: (screenX, screenY) => {
    if (mode !== 'moving' || !game?.selected) return;
    const tile = renderer.tileAt(screenX, screenY);
    renderer.path = tile ? game.previewPath(tile.x, tile.y) : [];
    requestRender();
  },
});

endTurnButton.addEventListener('click', () => {
  if (aiRunning || sceneLoading || renderer.isAnimating) return;
  lastCycledAt = null;
  // Before the turn changes hands, not after: a half-entered unload must put
  // its transport back first, so end-of-turn hooks see it where it really is.
  resetInteraction();
  game?.endTurn();
  afterTurnAction();
});

nextUnitButton.addEventListener('click', cycleToNextUnit);
observerButton.addEventListener('click', cycleObserver);

window.addEventListener('keydown', event => {
  const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;
  const dialogOpen = picker.open || setup.open || settingsDialog.open;
  if (!typing && !dialogOpen && !event.repeat && !event.altKey
      && (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z')
        || (!event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'u'))) {
    undo();
    event.preventDefault();
    return;
  }
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
  // Ignore keys typed into the map search box.
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  if (event.key === 'Escape' && !picker.open && !setup.open && !settingsDialog.open) {
    if (aiRunning || sceneLoading) return;
    renderer.clearAnimations();
    resetInteraction();
    syncTurn(); requestRender(); event.preventDefault(); return;
  }
  if (event.key === 'n' || event.key === 'N') { cycleToNextUnit(); event.preventDefault(); }
  if (event.key === 'v' || event.key === 'V') { cycleObserver(); event.preventDefault(); }
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
  if (bannerEl.hidden) sound.play('victory.wav');
  bannerEl.hidden = false;
}
/** Names the rule that ended it, using the script's own wording. */
function ruleNameFor(ruleID: string | null): string {
  const info = victoryRuleInfos.find(entry => entry.ruleID === ruleID);
  return info ? `${info.name}.` : 'The game is over.';
}
$('#banner-close').addEventListener('click', () => { bannerEl.hidden = true; });

// --- loading --------------------------------------------------------------

async function loadScene(id: string, saved?: SavedGame): Promise<void> {
  let loaded = false;
  const version = ++sceneLoadVersion;
  sceneLoading = true;
  resetInteraction();
  renderer.clearAnimations();
  agents.clear();
  game = null;
  env = null;
  syncTurn();
  titleEl.textContent = 'loading…';
  const url = new URL(location.href);
  url.searchParams.set('map', id);
  url.searchParams.delete('new');
  history.replaceState(null, '', url);

  try {
    const loadedScene: Scene = saved?.scene ?? await (await fetch(asset(`scenes/${id}.json`))).json();
    if (version !== sceneLoadVersion) return;
    scene = loadedScene;
    await renderer.load(loadedScene);
    if (version !== sceneLoadVersion) return;
    bannerEl.hidden = true;
    resetInteraction();

    if (registry) {
      config ??= defaultConfig(
        scene!.players.length, scene!.players.map(p => p.army), scene!.players[0]?.funds ?? 0);
      game = new Game(gameMapFromScene(scene!, registry, config), registry, animations,
        { victoryRules: config.victoryRules });
      if (saved && rng) {
        restoreSave(game, rng, saved);
        for (const [seat, value] of Object.entries(saved.agentStates ?? {})) {
          const entry = value as { key?: string; state?: unknown };
          if (!entry || entry.key !== config.seats[Number(seat)]?.agent) continue;
          const agent = agentFor(Number(seat));
          if (agent instanceof NormalAi || agent instanceof CoordinatedAi) agent.loadState(entry.state);
        }
      }
      // The script RNG must ride along: explore() rewinds it around simulated
      // battles, and without it the AI's deliberation would consume the luck
      // stream the real game draws from.
      env = new GameEnvironment(game.map, registry,
        { maxFieldChoices: 8, rng: rng ?? undefined }, game);
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
    if (game && select && !saved) {
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
    loaded = true;
  } finally {
    if (version === sceneLoadVersion) {
      sceneLoading = false;
      if (loaded && game) {
        checkBanner();
        if (saved) {
          saveStatus(`Resumed the match saved on this device at ${new Date(saved.savedAt).toLocaleString()}.`);
          statusEl.textContent = 'Match resumed';
        } else autosave();
      }
      endTurnButton.disabled = aiRunning;
      if (loaded) void maybeRunAI();
    }
  }
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

/** "2_player" -> "2 players", "advance_wars_1_campaign.camp" -> "Advance Wars 1 campaign". */
function categoryLabel(category: string): string {
  const players = /^(\d+)_player$/.exec(category);
  if (players) return `${players[1]} players`;
  const words = category.replace(/\.camp$/, '').replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Thumbnails are drawn when a row scrolls into view; 570 scenes are not fetched up front. */
const previewScenes = new Map<string, Promise<Scene>>();
const previewObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    previewObserver.unobserve(entry.target);
    const preview = entry.target as HTMLCanvasElement;
    const id = preview.dataset.map!;
    let pending = previewScenes.get(id);
    if (!pending) {
      pending = fetch(asset(`scenes/${id}.json`)).then(response => response.json() as Promise<Scene>);
      previewScenes.set(id, pending);
    }
    void pending.then(mapScene => {
      const cell = overviewCell(mapScene, preview.width, preview.height);
      const ctx = preview.getContext('2d')!;
      ctx.translate((preview.width - mapScene.width * cell) / 2, (preview.height - mapScene.height * cell) / 2);
      drawOverview(ctx, mapScene, cell);
      preview.classList.add('map-preview--ready');
    }).catch(() => { /* a missing preview is not worth a message */ });
  }
}, { root: $('#list'), rootMargin: '200px' });

function renderList(): void {
  const listEl = $<HTMLUListElement>('#list');
  const matches = index.filter(matchesFilters);
  $('#filterCount').textContent = `${matches.length} map${matches.length === 1 ? '' : 's'}`;
  previewObserver.disconnect();

  listEl.replaceChildren(...matches.slice(0, 300).map(entry => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    const preview = document.createElement('canvas');
    preview.className = 'map-preview';
    preview.width = 144;
    preview.height = 108;
    preview.dataset.map = entry.id;
    preview.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    const detail = `${entry.width}×${entry.height} · ${categoryLabel(entry.category)}`
      + (entry.author ? ` · by ${entry.author}` : '');
    text.innerHTML = `${escapeHtml(entry.name)}<small>${escapeHtml(detail)}</small>`;
    button.append(preview, text);
    button.addEventListener('click', () => { picker.close(); void openSetup(entry); });
    li.append(button);
    previewObserver.observe(preview);
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
      value => { seat.agent = value; }, {
        heuristic: 'Greedy (fast)', commanderwars: 'Commander Wars', coordinated: 'Coordinated (experimental)',
        planner: 'Planner', valuenet: 'Planner + value net',
      });
    opponent.hidden = seat.controller !== 'ai';
    controlCell.append(select(['human', 'ai'], seat.controller, value => {
      seat.controller = value as SeatController;
      opponent.hidden = seat.controller !== 'ai';
    }, { human: 'Human', ai: 'Computer' }), opponent);

    row.append(seatCell, armyCell, teamCell, controlCell);
    return row;
  }));
}

function select(values: string[], current: string, onChange: (value: string) => void,
  labels: Record<string, string> = {}): HTMLSelectElement {
  const element = document.createElement('select');
  element.replaceChildren(...values.map(value => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = labels[value] ?? value;
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
  autosaveAllowed = true;
  // A fresh game starts omniscient; the previous game's choice should not
  // silently carry over into one with different seats.
  observerSeat = null;
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
const soundToggle = $<HTMLInputElement>('#optSound');
soundToggle.checked = sound.enabled;
soundToggle.addEventListener('change', () => {
  sound.enabled = soundToggle.checked;
  try { localStorage.setItem(SOUND_KEY, sound.enabled ? 'on' : 'off'); } catch { /* storage unavailable */ }
  if (sound.enabled) { sound.unlock(); sound.play('okay.wav'); }
});

$<HTMLInputElement>('#optDim').addEventListener('change', e => {
  options.dimSpent = (e.target as HTMLInputElement).checked;
  syncUnits();
  requestRender();
});
/** The bars lie over the canvas; tell the camera how much of it they cover. */
function applyInsets(): void {
  renderer.camera.insets = {
    top: $('.bar--top').getBoundingClientRect().bottom,
    bottom: Math.max(0, window.innerHeight - $('.bar--bottom').getBoundingClientRect().top),
  };
}
applyInsets();
window.addEventListener('resize', () => { applyInsets(); renderer.resize(); requestRender(); });
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--tactical-bottom',
    `${window.innerHeight - $('.bar--bottom').getBoundingClientRect().top + 12}px`);
  applyInsets();
  positionBattle();
  requestRender();
}).observe($('.bar--bottom'));

// Idle animation: a few steps a second is all the sprite sheets have, and a
// hidden tab or a reduced-motion preference gets none.
setInterval(() => {
  if (document.hidden || reducedMotion.matches || !scene) return;
  renderer.animationTick++;
  requestRender();
}, 280);

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
    option.textContent = categoryLabel(category);
    return option;
  }));
  renderList();

  try {
    const boot = await bootstrapBrowser(asset('scripts.json'));
    registry = boot.registry;
    animations = boot.animations;
    rng = boot.rng;
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
  let saved: SavedGame | undefined;
  const explicitStart = ['new', 'select', 'to', 'build', 'do', 'repeat', 'tap', 'press', 'fog', 'ai']
    .some(key => initial.has(key));
  if (registry && !explicitStart) {
    try {
      const result = readSave(localStorage);
      if (result.status === 'ready' && (!requested || requested === result.save.mapId)) saved = result.save;
      else if (result.status === 'invalid') {
        autosaveAllowed = false;
        saveStatus('The previous save could not be read. Use New to replace it.', true);
      }
      else if (result.status === 'unavailable') saveStatus('Autosave unavailable in this browser.', true);
    } catch { saveStatus('Autosave unavailable in this browser.', true); }
  }
  if (saved) {
    currentMapId = saved.mapId;
    config = saved.config;
    try { await loadScene(saved.mapId, saved); }
    catch (error) {
      console.error('Could not resume saved match', error);
      game = null;
      env = null;
      sceneLoading = false;
      syncTurn();
      saveStatus('This save could not be resumed. Use New to start a match.', true);
      statusEl.textContent = 'Could not resume match';
    }
  } else if (startup) {
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

  // Startup commands are one-shot. Reloading a configured battle resumes it.
  const cleanUrl = new URL(location.href);
  for (const key of ['new', 'select', 'to', 'build', 'do', 'repeat', 'tap', 'press', 'fog', 'ai', 'ui']) {
    cleanUrl.searchParams.delete(key);
  }
  history.replaceState(null, '', cleanUrl);
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
