import type { Game } from '../game/game.ts';
import type { Unit } from '../host/unit.ts';
import type { SpriteStore } from '../render/sprites.ts';

type Tile = { x: number; y: number };
const nameOf = (id: string) => id.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const number = (value: number) => Number(value.toFixed(1)).toString();

/** Damage previews use percentage points; units store health on a 0–10 scale. */
export function forecastHealth(hp: number, damagePercent: number): number {
  return Math.max(0, Math.min(10, hp - Math.max(0, damagePercent) / 10));
}

/** Buildings and destructible terrain store raw durability, not unit HP. */
export function forecastDurability(hp: number, damage: number): number {
  return Math.max(0, hp - Math.max(0, damage));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Caller controls visibility: only pass units/targets already revealed to the viewer. */
export class TacticalPanel {
  readonly element: HTMLElement;
  colorTableForPlayer: (index: number) => string | undefined = () => undefined;
  private generation = 0;
  private readonly sprites: SpriteStore;

  constructor(parent: HTMLElement, sprites: SpriteStore) {
    this.sprites = sprites;
    this.element = el('section', 'tactical-panel');
    this.element.setAttribute('aria-label', 'Unit information');
    this.element.hidden = true;
    parent.append(this.element);
  }

  hide(): void {
    this.generation++;
    this.element.hidden = true;
    this.element.replaceChildren();
  }

  private reset(battle: boolean): void {
    this.generation++;
    this.element.replaceChildren();
    this.element.hidden = false;
    this.element.classList.toggle('tactical-panel--battle', battle);
    this.element.setAttribute('aria-label', battle ? 'Combat preview' : 'Unit information');
  }

  private portrait(unit: Unit): HTMLCanvasElement {
    const canvas = el('canvas', 'tactical-portrait');
    canvas.width = 64;
    canvas.height = 64;
    canvas.setAttribute('aria-hidden', 'true');
    const generation = this.generation;
    const table = this.colorTableForPlayer(unit.getOwner().getPlayerID());
    void Promise.all(unit.sprites.map(layer =>
      (table && layer.id.endsWith('+mask') ? this.sprites.getRecolored(layer.id, table) : this.sprites.get(layer.id))
        .catch(() => null),
    )).then(layers => {
      if (generation !== this.generation) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      for (const sprite of layers) {
        if (!sprite) continue;
        const scale = Math.min(56 / sprite.frameWidth, 60 / sprite.frameHeight);
        const w = sprite.frameWidth * scale, h = sprite.frameHeight * scale;
        ctx.drawImage(sprite.image, 0, 0, sprite.frameWidth, sprite.frameHeight, (64 - w) / 2, 62 - h, w, h);
      }
    });
    return canvas;
  }

  private unitHeading(unit: Unit, caption: string): HTMLElement {
    const header = el('div', 'tactical-unit');
    const titles = el('div', 'tactical-unit-titles');
    titles.append(el('div', 'tactical-eyebrow', caption), el('h2', 'tactical-name', unit.customName || nameOf(unit.getUnitID())),
      el('div', 'tactical-owner', `P${unit.getOwner().getPlayerID() + 1}${unit.getOwner().getArmy() ? ` · ${nameOf(unit.getOwner().getArmy())}` : ""}`));
    header.append(this.portrait(unit), titles);
    return header;
  }

  private stat(parent: HTMLElement, label: string, value: string, low = false): void {
    const stat = el('div', `tactical-stat${low ? ' tactical-stat--low' : ''}`);
    stat.append(el('dt', 'tactical-stat-label', label), el('dd', 'tactical-stat-value', value));
    parent.append(stat);
  }

  showUnit(game: Game, unit: Unit, tile: Tile = unit): void {
    this.reset(false);
    this.element.append(this.unitHeading(unit, unit.hasMoved ? 'Orders complete' : 'Unit details'));
    const stats = el('dl', 'tactical-stats');
    this.stat(stats, 'HP', `${number(Math.max(0, unit.getHp()))} / 10`, unit.getHp() <= 3);
    this.stat(stats, 'Fuel', unit.maxFuel > 0 ? `${number(unit.fuel)} / ${unit.maxFuel}` : '—', unit.maxFuel > 0 && unit.fuel <= unit.maxFuel / 3);
    const ammo = [
      unit.weapon1ID ? (unit.maxAmmo1 > 0 ? `${unit.ammo1}/${unit.maxAmmo1}` : '∞') : '',
      unit.weapon2ID ? (unit.maxAmmo2 > 0 ? `${unit.ammo2}/${unit.maxAmmo2}` : '∞') : '',
    ].filter(Boolean);
    this.stat(stats, 'Ammo', ammo.join(' · ') || '—', unit.maxAmmo1 > 0 && unit.ammo1 === 0);
    this.element.append(stats);
    const terrain = game.map.getTerrain(tile.x, tile.y);
    const terrainName = nameOf(terrain.getBuilding()?.getBuildingID() ?? terrain.terrainID);
    const details = el('div', 'tactical-details');
    details.append(el('span', '', `${terrainName} · ${unit.getTerrainDefense(tile.x, tile.y)}★ defence`));
    const capacity = unit.getLoadingPlace();
    if (capacity > 0) {
      const names = unit.getOwner() === game.currentPlayer && unit.loaded.length > 0
        ? ` · ${unit.loaded.map(cargo => cargo.customName || nameOf(cargo.getUnitID())).join(', ')}` : '';
      details.append(el('span', '', `Cargo ${unit.getLoadedUnitCount()} / ${capacity}${names}`));
    }
    if (unit.getCapturePoints() > 0) details.append(el('span', '', `Capture ${unit.getCapturePoints()} / 20`));
    this.element.append(details);
  }

  showBattle(game: Game, attacker: Unit, from: Tile, target: Tile, onConfirm: () => void, onCancel: () => void): void {
    this.reset(true);
    const preview = game.previewBattle(attacker, from, target);
    const defender = game.unitAt(target.x, target.y);
    this.element.append(el('div', 'tactical-eyebrow', 'Combat forecast'));
    const exchange = el('div', 'tactical-exchange');
    exchange.append(this.unitHeading(attacker, 'Attacker'));
    if (defender) exchange.append(this.unitHeading(defender, 'Target'));
    else {
      const terrain = game.map.getTerrain(target.x, target.y);
      exchange.append(el('div', 'tactical-environment', nameOf(terrain.getBuilding()?.getBuildingID() ?? terrain.terrainID)));
    }
    this.element.append(exchange);
    if (preview) {
      const stats = el('dl', 'tactical-forecast');
      this.stat(stats, 'Strike', defender ? `${number(preview.attacker / 10)} HP` : `${number(preview.attacker)} damage`);
      this.stat(stats, 'Counterattack', `${number(preview.defender / 10)} HP`);
      this.stat(stats, 'Your HP after', `${number(forecastHealth(attacker.getHp(), preview.defender))} / 10`);
      if (defender) this.stat(stats, 'Target HP after', `${number(forecastHealth(defender.getHp(), preview.attacker))} / 10`);
      else {
        const terrain = game.map.getTerrain(target.x, target.y);
        const building = terrain.getBuilding();
        const hp = building && building.getHp() > 0 ? building.getHp() : terrain.getHp();
        if (hp > 0) this.stat(stats, 'Target durability after', number(forecastDurability(hp, preview.attacker)));
      }
      this.element.append(stats);
    }
    this.element.append(el('p', 'tactical-note', preview ? 'Average damage shown. Actual results vary.' : 'No damage forecast available.'));
    const controls = el('div', 'tactical-controls');
    const back = el('button', 'tactical-button', 'Back');
    const fire = el('button', 'tactical-button tactical-button--fire', 'Fire');
    back.type = fire.type = 'button';
    fire.disabled = !preview;
    const generation = this.generation;
    let submitted = false;
    back.addEventListener('click', () => {
      if (submitted || generation !== this.generation) return;
      submitted = true;
      onCancel();
    });
    fire.addEventListener('click', () => {
      if (submitted || !preview || generation !== this.generation) return;
      submitted = true;
      fire.disabled = back.disabled = true;
      onConfirm();
    });
    controls.append(back, fire);
    this.element.append(controls);
  }
}
