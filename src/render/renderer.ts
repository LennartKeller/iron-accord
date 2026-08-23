import { TILE_SIZE, tileSpritesAt, type Scene, type SceneSpriteRef } from '../maps/scene.ts';
import { Camera } from './camera.ts';
import { SpriteStore, type LoadedSprite } from './sprites.ts';

/**
 * Canvas2D renderer for a Commander Wars scene.
 *
 * Terrain and buildings are static, so they are baked once into an offscreen
 * canvas at 1:1 tile scale; each frame is then a single transformed blit plus
 * the dynamic layers. That keeps pan/zoom smooth on phones without a GPU path.
 */
/** Status icons shown on a unit. */
export interface UnitBadges {
  /** 1–9 when damaged; omitted at full health. */
  hp?: number;
  /** Sprite ids drawn along the bottom-left, e.g. "fuel", "ammo", "capture". */
  icons: string[];
}

export interface Highlight {
  x: number;
  y: number;
  /** CSS colour, drawn semi-transparent over the tile. */
  color: string;
  /** Overrides the default opacity, for overlays that cover a lot of board. */
  alpha?: number;
}

export class SceneRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private terrainLayer: HTMLCanvasElement | null = null;
  private dpr = 1;

  scene: Scene | null = null;
  readonly camera: Camera;
  /** Tile the user has selected, or null. */
  selected: { x: number; y: number } | null = null;
  /** Extra tinted tiles, e.g. a movement range. */
  highlights: Highlight[] = [];
  showGrid = false;

  // Written out rather than declared as constructor parameter properties:
  // plain `node` type stripping erases the annotations but cannot generate the
  // assignments they imply, so the fields would silently stay undefined.
  private readonly canvas: HTMLCanvasElement;
  private readonly sprites: SpriteStore;

  constructor(canvas: HTMLCanvasElement, sprites: SpriteStore) {
    this.canvas = canvas;
    this.sprites = sprites;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('SceneRenderer: 2d context unavailable');
    this.ctx = ctx;
    this.camera = new Camera({ width: canvas.clientWidth, height: canvas.clientHeight });
  }

  get worldWidth(): number { return (this.scene?.width ?? 0) * TILE_SIZE; }
  get worldHeight(): number { return (this.scene?.height ?? 0) * TILE_SIZE; }

  /** Sizes the backing store for the device pixel ratio. */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.camera.setViewport({ width: rect.width, height: rect.height });
  }

  async load(scene: Scene): Promise<void> {
    this.scene = scene;
    this.selected = null;
    this.highlights = [];
    this.path = [];
    this.fog = null;
    this.visionOverlay = null;
    this.liveBuildings = null;
    await this.sprites.preload(scene.spriteIds);
    await this.bakeTerrain(scene);
    this.resize();
    this.camera.fit(this.worldWidth, this.worldHeight);
  }

  /** Screen position (CSS px) -> tile coordinate, or null if off-map. */
  tileAt(screenX: number, screenY: number): { x: number; y: number } | null {
    if (!this.scene) return null;
    const world = this.camera.screenToWorld(screenX, screenY);
    const x = Math.floor(world.x / TILE_SIZE);
    const y = Math.floor(world.y / TILE_SIZE);
    if (x < 0 || y < 0 || x >= this.scene.width || y >= this.scene.height) return null;
    return { x, y };
  }

  /**
   * Draws one frame of a sprite sheet, anchored the way Commander Wars anchors
   * terrain: bottom-centre on the tile
   * (game/terrain.cpp: setPosition(-(w - imageSize) / 2, -(h - imageSize))).
   * That anchoring is what lets mountains, forests and units stand above their
   * own tile rather than being squashed into it.
   */
  private drawSprite(
    ctx: CanvasRenderingContext2D, sprite: LoadedSprite,
    tileX: number, tileY: number, frame = 0,
  ): void {
    const { frameWidth, frameHeight, cols } = sprite;
    const sx = (frame % cols) * frameWidth;
    const sy = Math.floor(frame / cols) * frameHeight;
    // game/unit.cpp: setScale(imageSize / anim->getWidth()) — a frame is scaled
    // so its WIDTH matches the tile. Height follows, so tall sprites still stand
    // above their tile instead of being squashed into it.
    const scale = TILE_SIZE / frameWidth;
    const drawWidth = frameWidth * scale;
    const drawHeight = frameHeight * scale;
    const dx = tileX * TILE_SIZE - (drawWidth - TILE_SIZE) / 2;
    const dy = tileY * TILE_SIZE - (drawHeight - TILE_SIZE);
    ctx.drawImage(sprite.image, sx, sy, frameWidth, frameHeight, dx, dy, drawWidth, drawHeight);
  }

  private async resolve(scene: Scene, ref: SceneSpriteRef): Promise<LoadedSprite | null> {
    const [index, tableIndex] = ref;
    const id = scene.spriteIds[index];
    if (!id) return null;
    const table = tableIndex >= 0 ? scene.tables[tableIndex] : undefined;
    try {
      return table
        ? await this.sprites.getRecolored(id, table)
        : await this.sprites.get(id);
    } catch {
      return null; // a sprite we could not decode should not kill the frame
    }
  }

  private async bakeTerrain(scene: Scene): Promise<void> {
    const layer = document.createElement('canvas');
    layer.width = scene.width * TILE_SIZE;
    layer.height = scene.height * TILE_SIZE;
    const ctx = layer.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;

    // Row by row so that tall sprites overlap the row above, as the desktop
    // client does with its per-row draw priorities.
    for (let y = 0; y < scene.height; y++) {
      for (let x = 0; x < scene.width; x++) {
        for (const ref of tileSpritesAt(scene, x, y)) {
          const sprite = await this.resolve(scene, ref);
          if (sprite) this.drawSprite(ctx, sprite, x, y);
        }
      }
    }
    // Buildings are NOT baked in: capturing one changes its sprites, and a
    // static layer would keep showing the previous owner's colours.
    this.terrainLayer = layer;
  }

  render(): void {
    const { ctx, canvas, scene } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!scene || !this.terrainLayer) return;

    const { camera } = this;
    const origin = camera.worldToScreen(0, 0);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.save();
    ctx.translate(origin.x, origin.y);
    ctx.scale(camera.scale, camera.scale);

    ctx.drawImage(this.terrainLayer, 0, 0);
    this.drawBuildings(ctx, scene);
    this.drawHighlights(ctx);
    this.drawUnits(ctx, scene);
    // Fog sits above the board but below the player's own overlays, so a
    // selection or path stays readable across unseen ground.
    this.drawFog(ctx, scene);
    // Same layer as fog: above the board, below selection and path.
    this.drawVisionOverlay(ctx, scene);
    this.drawPath(ctx);
    if (this.showGrid) this.drawGrid(ctx, scene);
    this.drawSelection(ctx);

    ctx.restore();
  }

  /**
   * Live buildings, supplied by the game. Each carries the sprite ids its script
   * resolved for its *current* owner.
   */
  liveBuildings: Array<{ x: number; y: number; sprites: Array<{ id: string; table?: string }> }> | null = null;

  private drawBuildings(ctx: CanvasRenderingContext2D, scene: Scene): void {
    if (this.liveBuildings) {
      for (const building of this.liveBuildings) {
        for (const layer of building.sprites) {
          const sprite = this.peek(layer.id, layer.table);
          if (sprite) this.drawSprite(ctx, sprite, building.x, building.y);
        }
      }
      return;
    }
    // Map-viewer fallback: the scene's baked sprites.
    for (const building of scene.buildings) {
      for (const ref of building.sprites) {
        const id = scene.spriteIds[ref[0]];
        const table = ref[1] >= 0 ? scene.tables[ref[1]] : undefined;
        const sprite = this.peek(id, table);
        if (sprite) this.drawSprite(ctx, sprite, building.x, building.y);
      }
    }
  }

  /**
   * Live units, supplied by the game each frame. Falls back to the scene's
   * starting units when no game is attached (map-viewer mode).
   *
   * Sprite ids travel with each unit rather than being looked up from the scene:
   * a newly built unit type is not in the scene's palette at all, and deriving
   * ids from it left anything not already on the map invisible.
   */
  liveUnits: Array<{
    x: number; y: number; owner: number; id: string; hasMoved: boolean;
    sprites: Array<{ id: string; table?: string }>;
    /** Status icons: HP digit, low fuel, low ammo, capture, cargo. */
    badges?: UnitBadges;
  }> | null = null;

  private drawUnits(ctx: CanvasRenderingContext2D, scene: Scene): void {
    if (this.liveUnits) { this.drawLiveUnits(ctx, scene); return; }
    for (const unit of scene.units) {
      for (const ref of unit.sprites) {
        const id = scene.spriteIds[ref[0]];
        const table = ref[1] >= 0 ? scene.tables[ref[1]] : undefined;
        // Only draw what is already decoded; the frame must not await.
        const cached = this.peek(id, table);
        if (cached) this.drawSprite(ctx, cached, unit.x, unit.y);
        else void this.resolve(scene, ref);
      }
    }
  }

  /**
   * Draws units from game state. Sprite ids are looked up per unit id and owner
   * so a unit that moved or was built still renders, even though it is not in
   * the baked scene.
   */
  private drawLiveUnits(ctx: CanvasRenderingContext2D, _scene: Scene): void {
    for (const unit of this.liveUnits ?? []) {
      for (const layer of unit.sprites) {
        const sprite = this.peek(layer.id, layer.table);
        if (!sprite) continue;
        ctx.save();
        // A spent unit is dimmed, as the desktop client does with its wait sprite.
        if (unit.hasMoved) ctx.globalAlpha = 0.55;
        this.drawSprite(ctx, sprite, unit.x, unit.y);
        ctx.restore();
      }
      if (unit.badges) this.drawBadges(ctx, unit.x, unit.y, unit.badges);
    }
  }

  /**
   * Status icons, drawn small in the tile's corners the way Advance Wars does:
   * the HP digit bottom-right, condition markers bottom-left. They are drawn at
   * a fixed pixel size rather than scaled to the tile, because the source icons
   * are 32 or 48 px and would otherwise swamp the unit.
   */
  private drawBadges(
    ctx: CanvasRenderingContext2D, tileX: number, tileY: number, badges: UnitBadges,
  ): void {
    const size = 8;
    const left = tileX * TILE_SIZE;
    const top = tileY * TILE_SIZE;

    if (badges.hp && badges.hp >= 1 && badges.hp <= 9) {
      const sprite = this.peek(String(badges.hp));
      if (sprite) {
        ctx.drawImage(sprite.image, 0, 0, sprite.frameWidth, sprite.frameHeight,
          left + TILE_SIZE - size, top + TILE_SIZE - size, size, size);
      }
    }

    // Condition markers stack leftwards along the bottom edge.
    let offset = 0;
    for (const icon of badges.icons) {
      const sprite = this.peek(icon);
      if (!sprite) continue;
      ctx.drawImage(sprite.image, 0, 0, sprite.frameWidth, sprite.frameHeight,
        left + offset, top + TILE_SIZE - size, size, size);
      offset += size - 2;
    }
  }

  /** A route to preview, drawn as a chain of dots. */
  path: Array<{ x: number; y: number }> = [];

  /**
   * Per-tile visibility for the viewing player, row-major. Null disables fog.
   * Shrouded tiles are painted over; the units on them simply are not supplied.
   */
  fog: Uint8Array | null = null;

  /**
   * What the ACTING player can see, drawn as a light wash instead of occlusion.
   *
   * For watching an AI play: the board stays fully visible, but the tiles the
   * agent is blind to are shaded, so a move that looks foolish can be read
   * against what the agent actually knew. Occluding fog (`fog`) answers "what
   * may I see"; this answers "what is it working with", and they are different
   * questions — which is why this is a separate field rather than a mode of
   * the same one.
   */
  visionOverlay: Uint8Array | null = null;

  private drawVisionOverlay(ctx: CanvasRenderingContext2D, scene: Scene): void {
    if (!this.visionOverlay) return;
    ctx.save();
    for (let y = 0; y < scene.height; y++) {
      for (let x = 0; x < scene.width; x++) {
        // Clear tiles are left alone, so the unshaded region IS the agent's
        // vision — the eye reads the negative space without a legend.
        if (this.visionOverlay[y * scene.width + x] === 2) continue;
        ctx.fillStyle = 'rgba(13, 17, 23, 0.34)';
        ctx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      }
    }
    ctx.restore();
  }

  private drawFog(ctx: CanvasRenderingContext2D, scene: Scene): void {
    if (!this.fog) return;
    ctx.save();
    for (let y = 0; y < scene.height; y++) {
      for (let x = 0; x < scene.width; x++) {
        const vision = this.fog[y * scene.width + x];
        if (vision === 2) continue;                       // VisionType_Clear
        // Fogged still shows the ground — Commander Wars tints it with
        // #64464646 (a ~39% grey). Shrouded hides the tile completely.
        ctx.fillStyle = vision === 0
          ? '#0d1117'                                     // VisionType_Shrouded
          : 'rgba(70, 70, 70, 0.39)';                     // VisionType_Fogged
        ctx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      }
    }
    ctx.restore();
  }

  private drawPath(ctx: CanvasRenderingContext2D): void {
    if (this.path.length < 2) return;
    ctx.save();
    ctx.strokeStyle = '#ffd23f';
    ctx.lineWidth = Math.max(2 / this.camera.scale, 0.9);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    this.path.forEach((tile, i) => {
      const cx = tile.x * TILE_SIZE + TILE_SIZE / 2;
      const cy = tile.y * TILE_SIZE + TILE_SIZE / 2;
      if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
    });
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Called when a sprite that was missing during a frame finishes decoding.
   * Without this the frame that first needs a sprite draws nothing and the
   * artwork only appears on whatever render happens next — a unit built this
   * turn stayed invisible until the following click.
   */
  onSpriteReady: (() => void) | null = null;

  /** Synchronous cache peek so render() stays non-blocking. */
  private readonly ready = new Map<string, LoadedSprite>();
  private readonly pending = new Set<string>();

  private peek(id: string, table?: string): LoadedSprite | null {
    const key = table ? `${id}|${table}` : id;
    const hit = this.ready.get(key);
    if (hit) return hit;
    // One request per sprite; render() runs often and must not pile up handlers.
    if (this.pending.has(key)) return null;
    this.pending.add(key);

    const promise = table ? this.sprites.getRecolored(id, table) : this.sprites.get(id);
    promise
      .then(sprite => {
        this.ready.set(key, sprite);
        this.pending.delete(key);
        this.onSpriteReady?.();
      })
      .catch(() => { this.pending.delete(key); });
    return null;
  }

  private drawHighlights(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    for (const highlight of this.highlights) {
      ctx.globalAlpha = highlight.alpha ?? 0.45;
      ctx.fillStyle = highlight.color;
      ctx.fillRect(highlight.x * TILE_SIZE, highlight.y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    }
    ctx.restore();
  }

  private drawSelection(ctx: CanvasRenderingContext2D): void {
    if (!this.selected) return;
    const { x, y } = this.selected;
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1 / this.camera.scale, 0.4);
    ctx.strokeRect(
      x * TILE_SIZE + ctx.lineWidth / 2,
      y * TILE_SIZE + ctx.lineWidth / 2,
      TILE_SIZE - ctx.lineWidth,
      TILE_SIZE - ctx.lineWidth,
    );
    ctx.restore();
  }

  private drawGrid(ctx: CanvasRenderingContext2D, scene: Scene): void {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1 / this.camera.scale;
    ctx.beginPath();
    for (let x = 0; x <= scene.width; x++) {
      ctx.moveTo(x * TILE_SIZE, 0);
      ctx.lineTo(x * TILE_SIZE, scene.height * TILE_SIZE);
    }
    for (let y = 0; y <= scene.height; y++) {
      ctx.moveTo(0, y * TILE_SIZE);
      ctx.lineTo(scene.width * TILE_SIZE, y * TILE_SIZE);
    }
    ctx.stroke();
    ctx.restore();
  }
}
