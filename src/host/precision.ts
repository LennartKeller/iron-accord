/**
 * coreengine/precisiongrid.h — snapping a value onto a fixed-point grid.
 *
 * Commander Wars keeps unit HP on a 0.01 grid: every write goes through
 * `PrecisionGrid::floor(value, 100)`. That is not cosmetic. Damage is computed
 * in floating point, so a unit reduced to "zero" can be left holding 1e-16 HP,
 * which is greater than zero, so it is alive, so it keeps its tile and blocks
 * whoever was sent to take it. The grid is what turns that residue into 0.
 *
 * A plain floor would have the opposite fault — 8.4 computed as
 * 8.399999999999999 would drop to 8.39 — so a value within a few ULPs of a
 * grid point is taken to BE that grid point before flooring.
 */
const BOUNDARY_ULPS = 32;

const scratch = new DataView(new ArrayBuffer(8));

/** std::nextafter(value, ±infinity) for a finite double. */
function nextAfter(value: number, up: boolean): number {
  if (value === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
  scratch.setFloat64(0, value);
  const bits = scratch.getBigInt64(0);
  // Away from zero increments the bit pattern, towards zero decrements it.
  scratch.setBigInt64(0, (value > 0) === up ? bits + 1n : bits - 1n);
  return scratch.getFloat64(0);
}

/** std::round: halves go away from zero, which Math.round does not do for negatives. */
function roundHalfAway(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

function normalizeBoundary(value: number, precision: number): number {
  const scaled = value * precision;
  const nearest = roundHalfAway(scaled);
  const adjacent = nextAfter(nearest, scaled >= nearest);
  const tolerance = Math.abs(nearest - adjacent) * BOUNDARY_ULPS;
  return Math.abs(scaled - nearest) <= tolerance ? nearest : scaled;
}

/** PrecisionGrid::floor — the largest grid point not above `value`. */
export function gridFloor(value: number, precision: number): number {
  if (!Number.isFinite(value)) return value;
  return Math.floor(normalizeBoundary(value, precision)) / precision;
}

/** game/unit.cpp: FLOAT_PRECISION — unit HP lives on a 0.01 grid. */
export const HP_PRECISION = 100;
