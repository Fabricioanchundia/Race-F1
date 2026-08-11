const express    = require('express');
const http       = require('node:http');
const { Server } = require('socket.io');
const Redis      = require('ioredis');
const axios      = require('axios');
const cors       = require('cors');
const path       = require('node:path');
const { v4: uuidv4 } = require('uuid');
const VectorClock = require('./vectorClock');

const app    = express();
app.disable('x-powered-by'); // no revelar la version del framework (pedido por SonarQube)
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

// CORS abierto a propósito: este proyecto expone una API publica de solo-lectura del estado
// de la carrera (sin datos sensibles ni autenticacion), pensada para ser consumida desde
// el cliente web servido por este mismo proceso. No hay riesgo de CSRF/robo de datos privados.
app.use(cors()); // NOSONAR: sin datos sensibles, API publica de solo lectura del estado de carrera
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const redisPub  = new Redis(REDIS_URL);
const redisSub  = new Redis(REDIS_URL);

const SECTORS = {
  1: process.env.SECTOR_1_URL || 'http://localhost:3001',
  2: process.env.SECTOR_2_URL || 'http://localhost:3002',
  3: process.env.SECTOR_3_URL || 'http://localhost:3003',
};

const vc      = new VectorClock(0);
const players = new Map();

redisSub.subscribe('race:state', 'race:events', (err) => {
  if (err) return console.error('[Gateway] Redis error:', err.message);
  console.log('[Gateway] Suscrito a race:state y race:events');
});

redisSub.on('message', (channel, raw) => {
  const data  = JSON.parse(raw);
  const clock = vc.tick();
  if (channel === 'race:state')  io.emit('race:state', { ...data, vectorClock: clock });
  if (channel === 'race:events') {
    io.emit('race:event', data);
    console.log(`[Gateway] Evento: ${data.type} | VC: [${clock}]`);
  }
});

// Saca al jugador del mundo compartido de verdad: avisa el evento, borra su registro
// local y le pide al sector que elimine su auto (no dejar "fantasma" chocando/en la clasificación).
async function removePlayer(socketId) {
  const player = players.get(socketId);
  if (!player) return;
  const clock = vc.tick();
  await redisPub.publish('race:events', JSON.stringify({
    type: 'PLAYER_LEFT', carId: player.carId, vectorClock: clock, timestamp: Date.now()
  }));
  players.delete(socketId);
  console.log(`[Gateway] Auto ${player.carId} desconectado`);
  axios.post(`${SECTORS[player.sectorId]}/car/remove`, { carId: player.carId }).catch(()=>{});
}

io.on('connection', (socket) => {
  console.log(`[Gateway] Cliente conectado: ${socket.id}`);

  socket.on('player:join', async ({ name, color, team, circuit }) => {
    const carId = uuidv4().slice(0, 6).toUpperCase();
    const clock = vc.tick();
    players.set(socket.id, { carId, sectorId: 1, name: name || `Piloto_${carId}`, color, team });
    try {
      const { data } = await axios.post(`${SECTORS[1]}/car/register`, { carId, name, color, team, circuit, vectorClock: clock });
      socket.emit('player:registered', { carId, sectorId: 1, vectorClock: clock, raceStarted: !!data.raceStarted, queued: !!data.queued, circuit: data.circuit });
      if (!data.queued) {
        await redisPub.publish('race:events', JSON.stringify({
          type: 'PLAYER_JOINED', carId, name, color, team, sectorId: 1, vectorClock: clock, timestamp: Date.now()
        }));
      }
      console.log(`[Gateway] Auto ${carId} registrado | VC: [${clock}]`);
    } catch (err) {
      console.error(`[Gateway] Error: ${err.message}`);
      socket.emit('error', { message: 'No se pudo registrar.' });
    }
  });

  socket.on('car:command', async (data) => {
    const player = players.get(socket.id);
    if (!player) return;
    const clock = vc.merge(data.vectorClock || []);
    const payload = { carId: player.carId, action: data.action, vectorClock: clock };
    try {
      await axios.post(`${SECTORS[player.sectorId]}/car/command`, payload);
    } catch (err) {
      // El sector esperado dice que el auto no está ahí (probablemente el aviso de handoff
      // se perdió y player.sectorId quedó desactualizado). Intentamos el siguiente sector,
      // que es adonde un handoff normal siempre avanza, en vez de dejar el comando en la nada.
      if (err.response && err.response.status === 404) {
        const nextSector = player.sectorId < 3 ? player.sectorId + 1 : 1;
        try {
          await axios.post(`${SECTORS[nextSector]}/car/command`, payload);
          player.sectorId = nextSector; // corregido: se auto-sincroniza
          console.log(`[Gateway] Auto-corregido: ${player.carId} en realidad estaba en S${nextSector}`);
        } catch (err2) {
          console.error(`[Gateway] Comando fallido (S${player.sectorId} y S${nextSector}): ${err2.message}`);
          socket.emit('error', { message: 'No se pudo aplicar el comando, reconectando...' });
        }
      } else {
        console.error(`[Gateway] Comando fallido S${player.sectorId}: ${err.message}`);
      }
    }
  });

  socket.on('disconnect', () => removePlayer(socket.id));
});

// BUG DEL AUTO FANTASMA: al recargar o cerrar la página, socket.io puede tardar hasta
// ~20s (su pingTimeout por defecto) en darse cuenta de que el cliente se fue. En ese
// tiempo, el jugador ya se re-registra con un auto NUEVO mientras el VIEJO sigue vivo
// en el servidor — dos autos tuyos al mismo tiempo, chocando y duplicados en la
// clasificación. Este endpoint lo llama el cliente con sendBeacon() justo antes de
// cerrarse, así el auto se elimina al instante en vez de esperar el timeout.
app.post('/player-leaving', express.text({ type: '*/*' }), (req, res) => {
  let carId;
  try { carId = JSON.parse(req.body).carId; } catch { return res.status(400).end(); }
  for (const [socketId, p] of players) {
    if (p.carId === carId) { removePlayer(socketId); break; }
  }
  res.status(204).end();
});

app.post('/handoff-notify', (req, res) => {
  const { carId, fromSector, toSector } = req.body;
  for (const p of players.values()) {
    if (p.carId === carId) { p.sectorId = toSector; break; }
  }
  io.emit('race:event', { type: 'HANDOFF', carId, fromSector, toSector, timestamp: Date.now() });
  res.json({ ok: true });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', players: players.size, vectorClock: vc.get() });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Gateway] Corriendo en puerto ${PORT}`);
});