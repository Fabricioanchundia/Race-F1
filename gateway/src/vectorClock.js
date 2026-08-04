class VectorClock {
  constructor(nodeId, size = 4) {
    this.nodeId = nodeId;
    this.clock  = new Array(size).fill(0);
  }
  tick() {
    this.clock[this.nodeId]++;
    return [...this.clock];
  }
  merge(received) {
    for (let i = 0; i < this.clock.length; i++) {
      this.clock[i] = Math.max(this.clock[i], received[i] || 0);
    }
    this.clock[this.nodeId]++;
    return [...this.clock];
  }
  get() { return [...this.clock]; }
}
module.exports = VectorClock;