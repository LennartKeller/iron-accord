/**
 * QJSEngine accepts `ident = value` inside an object literal (a
 * CoverInitializedName); V8 rejects it with "Invalid shorthand property
 * initializer". Six of Commander Wars' 644 scripts hit this, all base
 * prototypes: weapon.js, movementtable.js, terrain.js, co.js, building.js,
 * Tagpower.js.
 *
 * Rather than regex-guessing where the construct is legal, we parse and repair
 * exactly the line the engine points at, then re-parse. This can only ever
 * touch lines that genuinely fail to compile.
 */
export interface RepairResult {
  source: string;
  patchedLines: string[];
}

export type Parse = (source: string, filename: string) => void;

export function repairShorthand(source: string, filename: string, parse: Parse): RepairResult {
  const lines = source.split('\n');
  const patchedLines: string[] = [];

  for (let attempt = 0; attempt <= 64; attempt++) {
    const candidate = lines.join('\n');
    try {
      parse(candidate, filename);
      return { source: candidate, patchedLines };
    } catch (err) {
      const e = err as Error;
      if (!/Invalid shorthand property initializer/.test(e.message)) throw e;

      const at = /^(.*):(\d+)$/m.exec(e.stack ?? '');
      if (!at) throw e;
      const idx = Number.parseInt(at[2], 10) - 1;
      const line = lines[idx];
      if (line === undefined) throw e;

      const fixed = line.replace(/^(\s*[A-Za-z_$][\w$]*\s*)=/, '$1:');
      if (fixed === line) throw e;
      lines[idx] = fixed;
      patchedLines.push(`${filename}:${idx + 1}`);
    }
  }
  throw new Error(`repairShorthand: gave up on ${filename}`);
}
