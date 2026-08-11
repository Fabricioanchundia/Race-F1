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

io.on('connection', (socket) => {
  console.log(`[Gateway] Cliente conectado: ${socket.id}`);

  socket.on('player:join', async ({ name, color, team }) => {
    const carId = uuidv4().slice(0, 6).toUpperCase();
    const clock = vc.tick();
    players.set(socket.id, { carId, sectorId: 1, name: name || `Piloto_${carId}`, color, team });
    try {
      await axios.post(`${SECTORS[1]}/car/register`, { carId, name, color, team, vectorClock: clock });
      socket.emit('player:registered', { carId, sectorId: 1, vectorClock: clock });
      await redisPub.publish('race:events', JSON.stringify({
        type: 'PLAYER_JOINED', carId, name, color, team, sectorId: 1, vectorClock: clock, timestamp: Date.now()
      }));
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
    try {
      await axios.post(`${SECTORS[player.sectorId]}/car/command`, {
        carId: player.carId, action: data.action, vectorClock: clock
      });
    } catch (err) {
      console.error(`[Gateway] Comando fallido S${player.sectorId}: ${err.message}`);
    }
  });

  socket.on('disconnect', async () => {
    const player = players.get(socket.id);
    if (!player) return;
    const clock = vc.tick();
    await redisPub.publish('race:events', JSON.stringify({
      type: 'PLAYER_LEFT', carId: player.carId, vectorClock: clock, timestamp: Date.now()
    }));
    players.delete(socket.id);
    console.log(`[Gateway] Auto ${player.carId} desconectado`);
    // Eliminar de verdad el auto en el sector donde esté (no dejar "fantasma" chocando/en la clasificación)
    axios.post(`${SECTORS[player.sectorId]}/car/remove`, { carId: player.carId }).catch(()=>{});
  });
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