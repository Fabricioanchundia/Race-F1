const express = require('express');
const Redis   = require('ioredis');
const axios   = require('axios');
const cors    = require('cors');
const HeartbeatMonitor = require('./heartbeat');
const BullyElection    = require('./bully');

const app = express();
app.use(cors());
app.use(express.json());

const SECTOR_ID = parseInt(process.env.SECTOR_ID || '1');
const PORT      = parseInt(process.env.PORT || '3001');
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const GATEWAY   = process.env.GATEWAY_URL || 'http://gateway:3000';

const SECTOR_URLS = {
  1: process.env.SECTOR_1_URL || 'http://localhost:3001',
  2: process.env.SECTOR_2_URL || 'http://localhost:3002',
  3: process.env.SECTOR_3_URL || 'http://localhost:3003',
};

const RANGE = { 1:{min:0,max:33}, 2:{min:33,max:66}, 3:{min:66,max:100} };
const COLLISION_DIST = 2.0; // % de pista - zona de colision

const redis    = new Redis(REDIS_URL);
const redisPub = new Redis(REDIS_URL);
const cars     = new Map();

const bully = new BullyElection(SECTOR_ID, SECTOR_URLS);

const hb = new HeartbeatMonitor(SECTOR_ID, redis, async (downId) => {
  await redisPub.publish('race:events', JSON.stringify({
    type: 'NODE_DOWN', sectorId: downId, detectedBy: SECTOR_ID, timestamp: Date.now()
  }));
  if (SECTOR_ID > downId) await bully.startElection(redisPub);
});

// Loop principal: mover autos + detectar colisiones + broadcast
setInterval(async () => {
  if (cars.size === 0) return;

  // 1. Mover todos los autos
  for (const [carId, car] of cars) {
    car.position = parseFloat((car.position + car.speed * 0.1).toFixed(2));

    if (car.position >= RANGE[SECTOR_ID].max) {
      const next = SECTOR_ID < 3 ? SECTOR_ID + 1 : 1;
      await handoff(carId, car, next);
      cars.delete(carId);
      continue;
    }

    await redis.hset(`car:${carId}`, {
      position: car.position, speed: car.speed,
      sector: SECTOR_ID, name: car.name
    });
  }

  // 2. Deteccion de colisiones (exclusion mutua natural: cada sector maneja su propio Map)
  const carArr = [...cars.entries()];
  const collided = new Set();

  for (let i = 0; i < carArr.length; i++) {
    for (let j = i + 1; j < carArr.length; j++) {
      const [idA, carA] = carArr[i];
      const [idB, carB] = carArr[j];

      if (collided.has(idA) || collided.has(idB)) continue;

      const dist = Math.abs(carA.position - carB.position);
      if (dist < COLLISION_DIST) {
        // El auto mas rapido (el que choca por detras) pierde velocidad
        if (carA.speed >= carB.speed) {
          carA.speed = Math.max(carA.speed - 2.2, 0.3);
          cars.get(idA).speed = carA.speed;
        } else {
          carB.speed = Math.max(carB.speed - 2.2, 0.3);
          cars.get(idB).speed = carB.speed;
        }
        collided.add(idA);
        collided.add(idB);

        await redisPub.publish('race:events', JSON.stringify({
          type: 'COLLISION',
          carA: idA, carB: idB,
          sector: SECTOR_ID,
          timestamp: Date.now()
        }));

        console.log(`[Sector ${SECTOR_ID}] COLISION: ${idA} vs ${idB}`);
      }
    }
  }

  // 3. Broadcast del estado (Consistencia Estricta via Redis Pub/Sub)
  await redisPub.publish('race:state', JSON.stringify({
    sectorId: SECTOR_ID,
    cars: [...cars.entries()].map(([id, c]) => ({
      carId: id, name: c.name, position: c.position, speed: c.speed
    })),
    timestamp: Date.now()
  }));
}, 100);

// Handoff al siguiente sector (token de Exclusion Mutua)
async function handoff(carId, car, targetSector) {
  try {
    await axios.post(`${SECTOR_URLS[targetSector]}/car/receive`, {
      carId,
      car: { ...car, position: RANGE[targetSector].min },
      fromSector: SECTOR_ID,
      toSector: targetSector
    });
    await axios.post(`${GATEWAY}/handoff-notify`, {
      carId, fromSector: SECTOR_ID, toSector: targetSector
    }).catch(() => {});
    console.log(`[Sector ${SECTOR_ID}] Handoff Auto ${carId} -> Sector ${targetSector}`);
  } catch (err) {
    console.error(`[Sector ${SECTOR_ID}] Error handoff: ${err.message}`);
    car.position = RANGE[SECTOR_ID].max - 1;
    cars.set(carId, car);
  }
}

// Rutas REST
app.post('/car/register', (req, res) => {
  const { carId, name, vectorClock } = req.body;
  cars.set(carId, { name: name || carId, position: RANGE[SECTOR_ID].min, speed: 1.5, vectorClock });
  console.log(`[Sector ${SECTOR_ID}] Auto ${carId} registrado`);
  res.json({ ok: true });
});

app.post('/car/receive', (req, res) => {
  const { carId, car, fromSector } = req.body;
  cars.set(carId, car);
  console.log(`[Sector ${SECTOR_ID}] Auto ${carId} recibido desde S${fromSector}`);
  res.json({ ok: true });
});

app.post('/car/command', (req, res) => {
  const { carId, action } = req.body;
  const car = cars.get(carId);
  if (!car) return res.status(404).json({ error: 'Auto no en este sector' });
  if (action === 'accelerate') car.speed = Math.min(car.speed + 0.35, 5.0);
  if (action === 'brake')      car.speed = Math.max(car.speed - 0.4,  0.3);
  res.json({ ok: true, speed: car.speed });
});

// Bully
app.post('/election',    (req, res) => { res.json({ ok: true }); setTimeout(() => bully.startElection(redisPub), 100); });
app.post('/coordinator', (req, res) => { bully.setLeader(req.body.leader); res.json({ ok: true }); });
app.get('/health',       (req, res) => res.json({ status: 'ok', sectorId: SECTOR_ID, cars: cars.size, leader: bully.getLeader() }));

app.listen(PORT, () => {
  console.log(`[Sector ${SECTOR_ID}] Nodo corriendo en puerto ${PORT}`);
  hb.start();
});