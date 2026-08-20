/**
 * game/player.cpp: Player::colorToTable maps a handful of well-known ARGB player
 * colours onto the prebuilt colour tables in resources/images/colortables.
 * Anything else gets a table generated from the colour at runtime; we fall back
 * to the nearest known table instead.
 */
const KNOWN: Array<[string, number[]]> = [
  ['orange_star', [0xff5a00, 0xf85800, 0xf00008]],
  ['blue_moon',   [0x0068e8, 0x0098f8]],
  ['green_earth', [0x00c010]],
  ['yellow_comet',[0xf8c000, 0xd08000]],
  ['black_hole',  [0x5f11b7, 0x6038a0]],
];

export function colorTableFor(rgb: number): string {
  const value = rgb & 0xffffff;
  for (const [name, colors] of KNOWN) {
    if (colors.includes(value)) return name;
  }
  // Nearest match in RGB space keeps unknown colours looking sensible.
  let best = KNOWN[0][0];
  let bestDistance = Number.POSITIVE_INFINITY;
  const r = (value >> 16) & 0xff, g = (value >> 8) & 0xff, b = value & 0xff;
  for (const [name, colors] of KNOWN) {
    for (const candidate of colors) {
      const dr = r - ((candidate >> 16) & 0xff);
      const dg = g - ((candidate >> 8) & 0xff);
      const db = b - (candidate & 0xff);
      const distance = dr * dr + dg * dg + db * db;
      if (distance < bestDistance) { bestDistance = distance; best = name; }
    }
  }
  return best;
}

export function toHex(argb: number): string {
  return `#${((argb & 0xffffff) >>> 0).toString(16).padStart(6, '0')}`;
}

export const KNOWN_TABLES = KNOWN.map(([name]) => name);
