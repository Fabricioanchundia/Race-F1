const axios = require('axios');

class BullyElection {
  constructor(sectorId, sectorUrls) {
    this.id      = Number.parseInt(sectorId);
    this.urls    = sectorUrls;
    this.leader  = null;
    this.running = false;
  }
  async startElection(redisPub) {
    if (this.running) return;
    this.running = true;
    console.log(`[Sector ${this.id}] Iniciando eleccion Bully...`);
    await redisPub.publish('race:events', JSON.stringify({
      type: 'ELECTION_STARTED', initiator: this.id, timestamp: Date.now()
    }));
    const higher = Object.entries(this.urls).filter(([id]) => Number.parseInt(id) > this.id);
    const alive  = (await Promise.all(higher.map(async ([id, url]) => {
      try {
        await axios.post(`${url}/election`, { from: this.id }, { timeout: 1500 });
        return Number.parseInt(id);
      } catch { return null; }
    }))).filter(Boolean);
    if (alive.length === 0) await this.becomeLeader(redisPub);
  }
  async becomeLeader(redisPub) {
    this.leader  = this.id;
    this.running = false;
    console.log(`[Sector ${this.id}] SOY EL NUEVO LIDER`);
    const lower = Object.entries(this.urls).filter(([id]) => Number.parseInt(id) < this.id);
    await Promise.allSettled(lower.map(([, url]) =>
      axios.post(`${url}/coordinator`, { leader: this.id }, { timeout: 1500 })
    ));
    await redisPub.publish('race:events', JSON.stringify({
      type: 'LEADER_ELECTED', leader: this.id, timestamp: Date.now()
    }));
  }
  setLeader(id) {
    this.leader  = id;
    this.running = false;
    console.log(`[Sector ${this.id}] Lider reconocido: Sector ${id}`);
  }
  getLeader() { return this.leader; }
}
module.exports = BullyElection;