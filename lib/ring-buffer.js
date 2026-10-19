// Drop AI — fixed-capacity in-memory log ring buffer.
// Copyright by Dork Industry.

/** Fixed-capacity FIFO of strings. `push` drops the oldest entries on overflow. */
export class RingBuffer {
  constructor(capacity = 500) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new TypeError('capacity must be a positive integer');
    }
    this.capacity = capacity;
    this.items = [];
  }

  /** Push one or more lines (multi-line strings are split). */
  push(...lines) {
    for (const line of lines) {
      for (const part of String(line).split('\n')) {
        this.items.push(part);
        if (this.items.length > this.capacity) {
          this.items.splice(0, this.items.length - this.capacity);
        }
      }
    }
  }

  /** Return the last `n` lines (default: everything). */
  tail(n = this.capacity) {
    const count = Math.max(0, Math.min(Number.isInteger(n) ? n : 0, this.items.length));
    return this.items.slice(this.items.length - count);
  }

  clear() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }
}
