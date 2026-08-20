/** Stand-in for coreengine/qmlvector.h — scripts use size()/at()/randomize(). */
export class QmlVector<T> {
  private items: T[];
  constructor(items: T[] = []) { this.items = items; }
  size(): number { return this.items.length; }
  at(index: number): T { return this.items[index]; }
  append(value: T): void { this.items.push(value); }
  remove(index: number): void { this.items.splice(index, 1); }
  clear(): void { this.items.length = 0; }
  toArray(): T[] { return [...this.items]; }
  randomize(shuffle: (items: T[]) => void): void { shuffle(this.items); }
}
