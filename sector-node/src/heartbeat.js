const INTERVAL = 500;
const TIMEOUT  = 1500;

class HeartbeatMonitor {
  constructor(sectorId, redis, onNodeDown) {
    this.id         = parseInt(sectorId);
    this.redis      = redis;
    this.onNodeDown = onNodeDown;
    this.lastState  = {};
  }
  start() {
    setInterval(async () => {
      await this.redis.set(`hb:sector:${this.id}`, Date.now(), 'EX', 3);
    }, INTERVAL);

    setInterval(async () => {
      for (const id of [1, 2, 3]) {
        if (id === this.id) continue;
        const val     = await this.redis.get(`hb:sector:${id}`);
        const elapsed = Date.now() - (val ? parseInt(val) : 0);
        if (elapsed > TIMEOUT) {
          if (this.lastState[id] !== 'down') {
            this.lastState[id] = 'down';
            console.log(`[Sector ${this.id}] ALERTA: Sector ${id} caido (${elapsed}ms)`);
            this.onNodeDown(id);
          }
        } else {
          if (this.lastState[id] === 'down')
            console.log(`[Sector ${this.id}] Sector ${id} recuperado`);
          this.lastState[id] = 'alive';
        }
      }
    }, INTERVAL);

    console.log(`[Sector ${this.id}] Heartbeat monitor iniciado`);
  }
}
module.exports = HeartbeatMonitor;