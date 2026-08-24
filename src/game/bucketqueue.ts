/**
 * A monotone bucket queue, for Dijkstra over integer costs.
 *
 * Both searches in this engine used to sort their whole frontier on every pop,
 * which is O(n^2 log n) and showed up as roughly a third of self-play runtime
 * once the AI started planning. Movement costs come from the scripts in
 * `resources/scripts/movementtables`, and every one of them returns a small
 * integer, so costs can index an array of buckets directly: push is O(1), and
 * because Dijkstra never pops a cost lower than the last one, the read cursor
 * only ever moves forward — the whole drain is O(maxCost + edges).
 *
 * Entries within a bucket come out in the order they went in. That is not an
 * incidental detail: `computeMovementRange` builds a `Map` whose iteration
 * order reaches action enumeration and therefore decides which move an agent
 * picks between equally-scored options. FIFO within a cost matches what the
 * stable sort it replaces did, so recorded games still replay bit-identically.
 */
export class BucketQueue {
  private readonly buckets: number[][] = [];
  private cursor = 0;
  private count = 0;

  /** `cost` must be a non-negative integer, and never below the last pop. */
  push(value: number, cost: number): void {
    let bucket = this.buckets[cost];
    if (!bucket) {
      bucket = [];
      this.buckets[cost] = bucket;
    }
    bucket.push(value);
    this.count++;
    if (cost < this.cursor) this.cursor = cost;
  }

  /** The lowest-cost entry, or -1 when empty. */
  pop(): number {
    while (this.count > 0) {
      const bucket = this.buckets[this.cursor];
      if (bucket && bucket.length > 0) {
        this.count--;
        return bucket.shift()!;
      }
      this.cursor++;
    }
    return -1;
  }

  get size(): number { return this.count; }
}

/**
 * Guards the integer assumption loudly.
 *
 * A fractional cost would not throw on its own — it would quietly index the
 * wrong bucket and return a route that is merely plausible. This engine's
 * expensive bugs have all been of that kind, so it fails instead.
 */
export function assertIntegerCost(step: number, x: number, y: number): void {
  if (!Number.isInteger(step)) {
    throw new Error(
      `movement cost ${step} at ${x},${y} is not an integer; ` +
      'BucketQueue indexes costs directly and cannot represent it');
  }
}
