/**
 * Loads Commander Wars sprites and applies colour-table recolouring.
 *
 * This mirrors system/frac_matrix_shader.glsl exactly:
 *
 *     gl_FragColor = texture2D(colorTable, vec2(color.r, color.g));
 *     gl_FragColor.a = color.a;
 *
 * A pixel's red and green channels are texture coordinates into a colour table;
 * alpha passes through. Note the coordinates are normalised, so the table's own
 * size matters: player tables are 256x256 (a 1:1 mapping) but terrain biome
 * palettes are 64x64, where each axis divides by four.
 *
 * Both terrain and player recolouring go through here — terrain masks are keyed
 * by a biome palette such as "palette_clear", units and buildings by a player
 * table such as "orange_star".
 */

export interface LoadedSprite {
  image: CanvasImageSource;
  /** Full sheet size. */
  width: number;
  height: number;
  /** One frame's size; sheets are cols x rows frames (res.xml). */
  frameWidth: number;
  frameHeight: number;
  cols: number;
  rows: number;
}

/** sprite id -> [cols, rows], from data/sprites/index.json. */
export type SpriteManifest = Record<string, [number, number]>;

export class SpriteStore {
  private readonly base = new Map<string, Promise<LoadedSprite>>();
  private readonly recolored = new Map<string, Promise<LoadedSprite>>();
  private readonly tables = new Map<string, Promise<ImageData>>();

  constructor(
    private readonly spriteUrl: (id: string) => string,
    private readonly tableUrl: (name: string) => string,
    private manifest: SpriteManifest = {},
  ) {}

  setManifest(manifest: SpriteManifest): void { this.manifest = manifest; }

  /** A sprite with no recolouring applied. */
  get(id: string): Promise<LoadedSprite> {
    let entry = this.base.get(id);
    if (!entry) {
      entry = loadImage(this.spriteUrl(id)).then(image => {
        const [cols, rows] = this.manifest[id] ?? [1, 1];
        return {
          image,
          width: image.naturalWidth,
          height: image.naturalHeight,
          frameWidth: image.naturalWidth / cols,
          frameHeight: image.naturalHeight / rows,
          cols, rows,
        };
      });
      this.base.set(id, entry);
    }
    return entry;
  }

  /** A sprite recoloured through the named colour table. */
  getRecolored(id: string, table: string): Promise<LoadedSprite> {
    const key = `${id}|${table}`;
    let entry = this.recolored.get(key);
    if (!entry) {
      entry = Promise.all([this.get(id), this.colorTable(table)])
        .then(([sprite, lut]) => applyColorTable(sprite, lut));
      this.recolored.set(key, entry);
    }
    return entry;
  }

  private colorTable(name: string): Promise<ImageData> {
    let entry = this.tables.get(name);
    if (!entry) {
      entry = loadImage(this.tableUrl(name)).then(image => {
        const canvas = createCanvas(image.naturalWidth, image.naturalHeight);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(image, 0, 0);
        return ctx.getImageData(0, 0, canvas.width, canvas.height);
      });
      this.tables.set(name, entry);
    }
    return entry;
  }

  /** Resolves once every requested sprite is decoded. */
  async preload(ids: Iterable<string>): Promise<void> {
    await Promise.all([...ids].map(id => this.get(id).catch(() => null)));
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`failed to load ${url}`));
    image.src = url;
  });
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function applyColorTable(sprite: LoadedSprite, lut: ImageData): LoadedSprite {
  const canvas = createCanvas(sprite.width, sprite.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(sprite.image, 0, 0);

  const pixels = ctx.getImageData(0, 0, sprite.width, sprite.height);
  const data = pixels.data;
  const table = lut.data;
  const tableWidth = lut.width;

  // The shader samples with normalised coordinates, so a channel addresses the
  // table at channel/255 * size. That resolves differently per table and both
  // forms show up in the assets:
  //   player tables  256x256 -> index (r, g); unit masks use the full range
  //   biome palettes  64x64  -> index (r/4, g/4); terrain index colours are
  //                             authored as multiples of four with blue at 0
  const tableHeight = lut.height;
  const maxX = tableWidth - 1;
  const maxY = tableHeight - 1;

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const tx = Math.min((data[i] * tableWidth) >> 8, maxX);
    const ty = Math.min((data[i + 1] * tableHeight) >> 8, maxY);
    const offset = (ty * tableWidth + tx) * 4;
    data[i] = table[offset];
    data[i + 1] = table[offset + 1];
    data[i + 2] = table[offset + 2];
    // alpha is preserved from the source sprite
  }
  ctx.putImageData(pixels, 0, 0);
  return { ...sprite, image: canvas };
}
