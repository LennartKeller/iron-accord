import fs from 'node:fs';
import path from 'node:path';
import { cwRoot } from './resources.node.ts';
import type { SpriteIndex } from '../host/index.ts';

export interface SpriteEntry {
  /** Absolute path to the PNG. */
  file: string;
  /** Frame grid from res.xml; a sheet of cols x rows frames. */
  cols: number;
  rows: number;
}

function findResXml(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findResXml(full, acc);
    else if (entry.name === 'res.xml') acc.push(full);
  }
  return acc;
}

/**
 * Builds the sprite id -> entry map from Commander Wars' res.xml manifests.
 * A sprite's id is its filename without the .png extension.
 *
 * Many sprites are sheets: res.xml carries `cols` and `rows` attributes giving
 * the frame grid (sea+mask is cols="8", infantry+os+walk+mask is 4x4). Without
 * them a renderer draws the whole strip instead of one frame.
 */
export function buildSpriteIndex(): Map<string, SpriteEntry> {
  const index = new Map<string, SpriteEntry>();
  const imagesRoot = path.join(cwRoot(), 'resources/images');

  for (const xml of findResXml(imagesRoot)) {
    const dir = path.dirname(xml);
    const source = fs.readFileSync(xml, 'utf8');
    for (const match of source.matchAll(/<image\s+([^>]*?)\/?>/g)) {
      const attrs = match[1];
      const fileMatch = /file\s*=\s*"([^"]+)"/.exec(attrs);
      if (!fileMatch) continue;
      const rel = fileMatch[1];
      const id = path.basename(rel).replace(/\.png$/i, '');
      const file = path.join(dir, rel);
      if (!fs.existsSync(file)) continue;
      const cols = Number(/cols\s*=\s*"(\d+)"/.exec(attrs)?.[1] ?? 1);
      const rows = Number(/rows\s*=\s*"(\d+)"/.exec(attrs)?.[1] ?? 1);
      index.set(id, { file, cols, rows });
    }
  }
  return index;
}

export function asSpriteIndex(index: Map<string, SpriteEntry>): SpriteIndex {
  return { has: (id: string) => index.has(id) };
}
