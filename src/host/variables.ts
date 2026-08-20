/**
 * coreengine/scriptvariables.h — a small key/value store the scripts use to
 * stash per-unit, per-building or per-map state between turns.
 */
export class ScriptVariable {
  readonly id: string;
  private value: unknown = null;
  constructor(id: string) { this.id = id; }
  readValue(): unknown { return this.value; }
  writeValue(next: unknown): void { this.value = next; }
  readDataInt32(): number { return Number(this.value ?? 0); }
  writeDataInt32(next: number): void { this.value = next; }
  readDataString(): string { return String(this.value ?? ''); }
  writeDataString(next: string): void { this.value = next; }
  readDataBool(): boolean { return Boolean(this.value); }
  writeDataBool(next: boolean): void { this.value = next; }
}

export class ScriptVariables {
  private readonly variables = new Map<string, ScriptVariable>();

  createVariable(id: string): ScriptVariable {
    let variable = this.variables.get(id);
    if (!variable) {
      variable = new ScriptVariable(id);
      this.variables.set(id, variable);
    }
    return variable;
  }

  getVariable(id: string): ScriptVariable | null {
    return this.variables.get(id) ?? null;
  }

  removeVariable(id: string): void { this.variables.delete(id); }
  clear(): void { this.variables.clear(); }

  /** For snapshotting. */
  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [id, variable] of this.variables) out[id] = variable.readValue();
    return out;
  }

  fromJSON(data: Record<string, unknown>): void {
    this.clear();
    for (const [id, value] of Object.entries(data)) this.createVariable(id).writeValue(value);
  }
}
