const express = require('express');
const Redis   = require('ioredis');
const axios   = require('axios');
const cors    = require('cors');
const HeartbeatMonitor = require('./heartbeat');
const BullyElection    = require('./bully');

const app = express();
app.disable('x-powered-by'); // no revelar la version del framework (pedido por SonarQube)
app.use(cors()); // NOSONAR: API interna entre nodos del mismo sistema, sin datos sensibles
app.use(express.json());

const SECTOR_ID   = Number.parseInt(process.env.SECTOR_ID || '1');
const PORT        = Number.parseInt(process.env.PORT || '3001');
const REDIS_URL   = process.env.REDIS_URL || 'redis://localhost:6379';
const GATEWAY     = process.env.GATEWAY_URL || 'http://gateway:3000'; // NOSONAR: URL interna de red privada (Docker/Railway), no expuesta a internet
const SECTOR_URLS = {
  1: process.env.SECTOR_1_URL || 'http://localhost:3001',
  2: process.env.SECTOR_2_URL || 'http://localhost:3002',
  3: process.env.SECTOR_3_URL || 'http://localhost:3003',
};
const RANGE = { 1:{min:0,max:33}, 2:{min:33,max:66}, 3:{min:66,max:100} };

const redis    = new Redis(REDIS_URL);
const redisPub = new Redis(REDIS_URL);
// Suscriptor dedicado (ioredis exige una conexión separada para modo subscribe).
// Se usa para coordinar el reseteo de bots entre los 3 procesos: antes, si un bot
// estaba físicamente de tránsito por sector2/3 justo cuando sector1 reseteaba la
// ronda, quedaba un bot "fantasma" ahí que sector1 no podía tocar desde su propio
// Map local. Ahora sector1 avisa por Redis a TODOS los sectores, y cada uno limpia
// cualquier bot que tenga en su propio Map local al recibir el aviso.
const redisSub = new Redis(REDIS_URL);
const cars     = new Map();
const MAX_LAPS = 5;

redisSub.subscribe('sector:reset-bots', (err) => {
  if (err) console.error(`[S${SECTOR_ID}] Error suscribiendo a sector:reset-bots: ${err.message}`);
});
redisSub.on('message', (channel, raw) => {
  if (channel !== 'sector:reset-bots') return;
  const data = JSON.parse(raw);
  if (data.sectorId === SECTOR_ID) return; // el que originó el aviso ya se encargó de los suyos
  let purged = 0;
  for (const id of [...cars.keys()]) {
    if (id.startsWith('bot_')) { cars.delete(id); purged++; }
  }
  if (purged > 0) console.log(`[S${SECTOR_ID}] ${purged} bot(s) fantasma descartados (estaban de tránsito al resetear la ronda)`);
});

let playerJoined = false;  // ← bots esperan al primer jugador

const bully = new BullyElection(SECTOR_ID, SECTOR_URLS);
const hb = new HeartbeatMonitor(SECTOR_ID, redis, async (downId) => {
  await redisPub.publish('race:events', JSON.stringify({type:'NODE_DOWN',sectorId:downId,detectedBy:SECTOR_ID,timestamp:Date.now()}));
  if (SECTOR_ID > downId) await bully.startElection(redisPub);
});

// Grilla de salida tipo "kart": 2 autos por fila, en zigzag, escalonados hacia atrás,
// bien pegados a la línea de meta (antes llegaba a 24 unidades de distancia, se veía
// como si arrancaran en cualquier parte en vez de justo detrás de la meta).
// Grilla de salida tipo "kart": 3 autos por fila, en zigzag, bien pegados a la línea
// de meta (antes eran 2 por fila y necesitaba hasta 15 unidades de posición para 10
// autos — en circuitos compactos eso ya era un tramo visible del trazado, así que los
// autos arrancaban dispersos lejos de la meta en vez de agrupados detrás, como en un
// arranque real de F1). Con 3 por fila el total baja a menos de la mitad.
// Grilla F1: dos autos por fila, en posiciones alternadas y con una distancia que
// evita que nazcan superpuestos. Tres autos lado a lado se veía como una fila de
// karts y dejaba al jugador visualmente muy separado de los bots.
const LANES = [-0.36, 0.36];
function gridSlot(i){
  const row = Math.floor(i/LANES.length);
  const lane = LANES[i%LANES.length];
  return { position: Math.max(0.8, 8 - row*2.25), lane };
}
const BOTS = [
  {id:'bot_hamilton', name:'Hamilton', color:'#00d2be', targetSpd:3.0},
  {id:'bot_norris',   name:'Norris',   color:'#ff8000', targetSpd:2.6},
  {id:'bot_leclerc',  name:'Leclerc',  color:'#e10600', targetSpd:3.3},
];
if (SECTOR_ID === 1) {
  BOTS.forEach((b,i) => {
    const slot = gridSlot(i);
    cars.set(b.id, {name:b.name,color:b.color,position:slot.position,speed:0,lane:slot.lane,isBot:true,targetSpd:b.targetSpd,ready:false});
    console.log(`[Bots] ${b.name} listo en grilla`);
  });
}

let raceStarted = false; // true desde que se sueltan los bots — se lo decimos a quien se una después
let waitingQueue = [];   // jugadores que llegaron con la carrera ya en marcha: esperan la próxima ronda
let queueSince = null;   // cuándo empezó a esperar el primero de la cola (para el límite de seguridad)

// Duración de la secuencia de luces en el cliente (ver runLights() en index.html):
// 300ms inicial + 5 luces x 600ms + 800ms "GO" + 600ms para ocultar la barra = 4700ms.
// Los bots deben arrancar EXACTAMENTE en ese instante, no antes.
const LIGHTS_DURATION_MS = 4700;

// BUG ARREGLADO: antes esta función soltaba los bots en el MISMO instante en que se
// avisaba RACE_START — pero el cliente todavía tarda ~4.7s en mostrar la secuencia de
// luces antes de dejar reaccionar al jugador. En ese hueco, los bots ya estaban en
// movimiento y podían chocar al jugador mientras seguía parado esperando el "GO!".