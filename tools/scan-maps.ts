import fs from 'node:fs';
import path from 'node:path';
import { readMap } from '../src/maps/mapreader.ts';
import { cwRoot } from '../src/cw/resources.node.ts';

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.map')) acc.push(p);
  }
  return acc;
}

const root = path.join(cwRoot(), 'maps');
const files = walk(root);
const byVersion = new Map<number, number>();
const failures: Array<{ file: string; error: string }> = [];
const trailing: string[] = [];
let ok = 0;
let tiles = 0;
let units = 0;
let buildings = 0;

for (const file of files) {
  try {
    const map = readMap(fs.readFileSync(file));
    byVersion.set(map.header.version, (byVersion.get(map.header.version) ?? 0) + 1);
    if (map.unparsedTailBytes > 0) trailing.push(`${path.relative(root, file)} (+${map.unparsedTailBytes}b)`);
    for (const row of map.tiles) for (const t of row) {
      tiles++;
      if (t.unit) units++;
      if (t.building) buildings++;
    }
    ok++;
  } catch (err) {
    failures.push({ file: path.relative(root, file), error: (err as Error).message });
  }
}

console.log(`map files        : ${files.length}`);
console.log(`parsed OK        : ${ok}`);
console.log(`failed           : ${failures.length}`);
console.log(`tiles read       : ${tiles}`);
console.log(`units placed     : ${units}`);
console.log(`buildings placed : ${buildings}`);
console.log(`versions         : ${[...byVersion.entries()].sort((a,b)=>a[0]-b[0]).map(([v,c])=>`v${v}:${c}`).join(' ')}`);
console.log(`unparsed tail    : ${trailing.length}`);
trailing.slice(0, 5).forEach(t => console.log('   ' + t));
const grouped = new Map<string, number>();
for (const f of failures) {
  const key = f.error.replace(/\d+/g, 'N').slice(0, 90);
  grouped.set(key, (grouped.get(key) ?? 0) + 1);
}
[...grouped.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 10)
  .forEach(([msg, n]) => console.log(`   ${String(n).padStart(4)}x ${msg}`));
failures.slice(0, 3).forEach(f => console.log(`   e.g. ${f.file}: ${f.error}`));
