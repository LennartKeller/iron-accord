/**
 * Compares this engine with the real Commander Wars, turn by turn.
 *
 *   node tools/upstream-diff.ts <record.rec|.rec.gz> [--fog n] [--turns n]
 *   node tools/upstream-diff.ts --trim <in.rec> <out.rec.gz> [--fog n] [--key value ...]
 *
 * The first form replays every player-turn of a Commander Wars record and
 * reports where the result departs from what the real game produced. The
 * second strips a raw record down to a fixture, stamping the recording
 * settings into it. `tools/upstream/record.sh` produces records; see
 * docs/upstream-differential.md.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { bootstrap } from '../src/game/bootstrap.node.ts';
import { readRecord, trimRecord } from '../src/maps/recreader.ts';
import { diffRecord, describeReport } from '../src/game/upstream.node.ts';

export function loadRecordFile(file: string): Uint8Array {
  const bytes = fs.readFileSync(file);
  return file.endsWith('.gz') ? zlib.gunzipSync(bytes) : bytes;
}

const args = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--trim') positional.unshift('--trim');
  else if (args[i].startsWith('--')) flags.set(args[i].slice(2), args[++i] ?? '');
  else positional.push(args[i]);
}

if (positional[0] === '--trim') {
  const [, input, output] = positional;
  if (!input || !output) throw new Error('usage: --trim <in.rec> <out.rec.gz> [--fog n] [--key value ...]');
  const settings: Record<string, unknown> = {};
  for (const [key, value] of flags) settings[key] = /^-?\d+$/.test(value) ? Number(value) : value === 'true' ? true : value === 'false' ? false : value;
  const trimmed = trimRecord(loadRecordFile(input), { ironAccord: settings });
  fs.writeFileSync(output, zlib.gzipSync(trimmed, { level: 9 }));
  const record = readRecord(trimmed);
  console.log(`wrote ${output}: ${record.actions.length} actions, ${record.snapshots.length} snapshots, ` +
    `${(fs.statSync(output).size / 1024).toFixed(0)} KB${record.truncated ? ' (record was cut off; unfinished tail dropped)' : ''}`);
} else if (positional[0]) {
  const record = readRecord(loadRecordFile(positional[0]));
  const stamped = (record.info.ironAccord ?? {}) as { fog?: number };
  const fog = flags.has('fog') ? Number(flags.get('fog')) : stamped.fog ?? 0;
  const warnings = new Map<string, number>();
  console.warn = (...parts: unknown[]) => {
    const key = parts.map(p => (p instanceof Error ? p.message : String(p))).join(' ').split('\n')[0].slice(0, 160);
    warnings.set(key, (warnings.get(key) ?? 0) + 1);
  };
  const report = diffRecord(bootstrap(), record, { fog });
  console.log(`${positional[0]} (${String(record.info.mapName ?? '?')}, fog ${fog})`);
  console.log(describeReport(report, record, Number(flags.get('turns') ?? 5)));
  if (warnings.size > 0) {
    console.log('engine warnings:\n  ' + [...warnings].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${n}x ${k}`).join('\n  '));
  }
} else {
  console.log('usage: node tools/upstream-diff.ts <record> | --trim <in.rec> <out.rec.gz>');
  process.exitCode = 1;
}
