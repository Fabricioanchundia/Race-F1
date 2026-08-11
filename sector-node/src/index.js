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
const cars     = new Map();

let playerJoined = false;  // ← bots esperan al primer jugador

const bully = new BullyElection(SECTOR_ID, SECTOR_URLS);
const hb = new HeartbeatMonitor(SECTOR_ID, redis, async (downId) => {
  await redisPub.publish('race:events', JSON.stringify({type:'NODE_DOWN',sectorId:downId,detectedBy:SECTOR_ID,timestamp:Date.now()}));
  if (SECTOR_ID > downId) await bully.startElection(redisPub);
});

// Grilla de salida tipo "kart": 2 autos por fila, en zigzag, escalonados hacia atrás,
// bien pegados a la línea de meta (antes llegaba a 24 unidades de distancia, se veía
// como si arrancaran en cualquier parte en vez de justo detrás de la meta).
function gridSlot(i){
  const row = Math.floor(i/2);
  const lane = i%2===0 ? -0.32 : 0.32;
  return { position: Math.max(0, 15 - row*3), lane };
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
// Ahora se separa en dos pasos: se avisa YA (para que todos vean las luces juntos, al
// mismo tiempo real), pero los bots recién arrancan cuando ese mismo tiempo ya pasó.
function releaseBots() {
  redisPub.publish('race:events', JSON.stringify({type:'RACE_START',circuit:currentCircuit,timestamp:Date.now()}));
  console.log('[Bots] Luces arrancando para todos...');
  setTimeout(() => {
    raceStarted = true;
    for (const [,car] of cars) {
      if (car.isBot) car.ready = true;
    }
    console.log('[Bots] ¡Arrancaron de verdad!');
  }, LIGHTS_DURATION_MS);
}

// BUG ARREGLADO: antes cada jugador elegía su circuito solo del lado del cliente (puro
// cosmético) — dos jugadores en la misma carrera podían ver formas de pista totalmente
// distintas, aunque compartieran el mismo espacio físico. Ahora el circuito de la ronda
// lo decide quien la inicia, y todos los que se suman se sincronizan con ese mismo.
let currentCircuit = null; // null = todavía nadie decidió el de esta ronda

// Coloca un piloto en la grilla de salida (usado tanto para el registro normal como
// para cuando se libera la cola de espera al empezar una nueva ronda). Si todavía nadie
// decidió el circuito de esta ronda, lo fija con el que pidió este piloto.
function placeOnGrid(carId, name, color, vectorClock, circuit) {
  if (currentCircuit === null) {
    currentCircuit = (typeof circuit === 'number' && circuit >= 0 && circuit <= 2) ? circuit : 0;
  }
  const humanCount = [...cars.values()].filter(c=>!c.isBot).length;
  const slot = gridSlot(BOTS.length + humanCount);
  cars.set(carId,{name:name||carId,color:color||'#888',position:RANGE[SECTOR_ID].min+slot.position,speed:0,lane:slot.lane,vectorClock,spawnUntil:Date.now()+4000});
  console.log(`[S${SECTOR_ID}] Piloto ${name} en grilla — PARADO (carril ${slot.lane}, pos ${slot.position})`);
}

// Arranca una nueva ronda para todos los que estaban esperando en cola: resetea los
// bots a la grilla, saca cualquier auto humano que haya quedado (fantasmas de la ronda
// anterior) y ubica a los de la cola, todos juntos, como si fuera una carrera nueva.
// LIMITACIÓN CONOCIDA: si justo en este instante un bot está físicamente de tránsito
// por el sector 2 o 3 (procesos separados), esta función no lo puede tocar desde acá —
// puede causar un pequeño glitch visual en su próximo handoff de vuelta a este sector.
// Coordinar bots entre los 3 procesos vía Redis sería la solución completa, pero excede
// el alcance de este arreglo puntual.
function startNextWave() {
  cars.clear(); // limpia bots y cualquier humano que haya quedado (fantasma de la ronda anterior)
  currentCircuit = null; // el primero de la cola vuelve a decidir el circuito de esta ronda
  BOTS.forEach((b,i)=>{
    const slot=gridSlot(i);
    cars.set(b.id,{name:b.name,color:b.color,position:slot.position,speed:0,lane:slot.lane,isBot:true,targetSpd:b.targetSpd,ready:false});
  });
  raceStarted = false;
  const toRelease = waitingQueue; waitingQueue = []; queueSince = null;
  toRelease.forEach(p => placeOnGrid(p.carId, p.name, p.color, p.vectorClock, p.circuit));
  console.log(`[Bots] Nueva ronda: ${toRelease.length} piloto(s) en cola pasan a la grilla (circuito ${currentCircuit})`);
  setTimeout(releaseBots, 5000);
}

// Revisa cada 2s si ya se puede arrancar la próxima ronda para los que están en cola:
// se puede si no queda ningún humano corriendo la ronda actual, o si ya esperaron
// demasiado (límite de seguridad para no dejar a alguien esperando para siempre por
// un auto fantasma que nunca se desconectó bien).
if (SECTOR_ID === 1) {
  setInterval(() => {
    if (waitingQueue.length === 0) return;
    const humansActive = [...cars.values()].filter(c=>!c.isBot).length;
    const waitedTooLong = queueSince && (Date.now()-queueSince > 45000);
    if (humansActive === 0 || waitedTooLong) startNextWave();
  }, 2000);
}

const lastCollision = {}; // enfriamiento por par de autos, evita el spam infinito

// Actualiza física de UN auto (posición, velocidad, carril) y hace handoff si sale del sector
async function updateCarPhysics(carId, car) {
  if (car.isBot) {
    if (car.ready) {
      car.speed = Math.max(0, Math.min(4.8, car.speed + (car.targetSpd - car.speed)*.06 + (Math.random()-.5)*.08)); // NOSONAR: aleatoriedad de IA de bots, no criptografica
      car.lane  = (car.lane||0) * .92 + (Math.random()-.5)*.02; // NOSONAR: aleatoriedad de IA de bots, no criptografica
    } else { car.speed = 0; }
  } else {
    // El carril del jugador solo vuelve al centro MUY lentamente (antes era *.88 cada
    // 100ms, o sea se recentraba solo en ~1s) -- eso deshacía la separación lograda tras
    // chocar, y los autos volvían a juntarse y chocar en bucle infinito sin poder avanzar.
    car.lane = (car.lane||0) * .992;
    // BUG ARREGLADO: antes, una vez que acelerabas, la velocidad se quedaba pegada ahí
    // para siempre (nunca bajaba sola) hasta que frenaras a mano -- se sentía ilógico,
    // como si el auto siguiera "acelerando" solo. Ahora hay una fricción natural leve
    // (resistencia del aire/rodadura), como en un auto real.
    car.speed = Math.max(0, car.speed - 0.025);
  }
  car.position = Number.parseFloat((car.position + car.speed * .1).toFixed(2));
  if (car.position >= RANGE[SECTOR_ID].max) {
    const next = SECTOR_ID < 3 ? SECTOR_ID+1 : 1;
    await handoff(carId, car, next);
    cars.delete(carId);
    return;
  }
  await redis.hset(`car:${carId}`, {position:car.position,speed:car.speed,sector:SECTOR_ID,name:car.name,color:car.color||'#888',lane:car.lane||0});
}

function isColliding(cA, cB) {
  return Math.abs(cA.position-cB.position)<2.0 && Math.abs((cA.lane||0)-(cB.lane||0))<0.55;
}

// Siempre separa de carril a un par que choco (si no, quedan pegados chocando para siempre)
function separateLanes(cA, cB) {
  if ((cA.lane||0)<=(cB.lane||0)) { cA.lane=Math.max((cA.lane||0)-0.32,-0.88); cB.lane=Math.min((cB.lane||0)+0.32,0.88); }
  else { cB.lane=Math.max((cB.lane||0)-0.32,-0.88); cA.lane=Math.min((cA.lane||0)+0.32,0.88); }
}

// Baja velocidad y publica el evento — solo una vez cada 700ms por par, no cada 100ms
async function applyCollisionPenalty(idA, cA, idB, cB, key, now) {
  lastCollision[key] = now;
  // Impacto = qué tan distinta era la velocidad de los dos autos al chocar.
  // Un bot a toda velocidad contra un auto detenido = golpe fuerte (impact cerca de 1).
  // Dos autos a velocidad pareja = simple roce (impact cerca de 0.25). Se manda al
  // cliente para que anime la cámara más o menos fuerte según qué tan duro fue.
  const impact = Math.min(1, Math.abs(cA.speed - cB.speed) / 4.5 + 0.25);
  const penalty = 1 + impact * 2.5; // entre 1 y 3.5 según la fuerza del golpe
  if (cA.speed>=cB.speed) cA.speed=Math.max(cA.speed-penalty,0); else cB.speed=Math.max(cB.speed-penalty,0);
  // BUG ARREGLADO: el enfriamiento de arriba es por PAREJA, así que en un amontonamiento
  // de 3+ autos, uno distinto podía golpearte cada 100ms sin que ninguna pareja "repitiera"
  // dentro de los 700ms — quedabas trabado en 0 para siempre. Ahora, tras recibir un golpe,
  // ese auto queda medio segundo sin poder ser chocado por NADIE, dándole tiempo real de escapar.
  const recoverUntil = now + 500;
  cA.hitUntil = recoverUntil; cB.hitUntil = recoverUntil;
  console.log(`[S${SECTOR_ID}] COLISIÓN: ${idA} vs ${idB} (impacto ${impact.toFixed(2)})`);
  await redisPub.publish('race:events',JSON.stringify({type:'COLLISION',carA:idA,carB:idB,sector:SECTOR_ID,impact,timestamp:Date.now()}));
}

// Evalúa un solo par de autos: ¿deben chocar? si sí, los separa y aplica la penalización
async function handlePair(idA, cA, idB, cB, hit, now) {
  if (hit.has(idA)||hit.has(idB)) return;
  // Un bot que AÚN NO arrancó (esperando en la grilla) no debe chocar con nadie —
  // si no, el jugador nace pegado a él y queda atrapado sin poder acelerar nunca.
  if ((cA.isBot && !cA.ready) || (cB.isBot && !cB.ready)) return;
  // Auto recién registrado (jugador que entra a una carrera ya en marcha) —
  // inmunidad breve para que le dé tiempo a arrancar antes de que lo choquen
  if ((cA.spawnUntil && now < cA.spawnUntil) || (cB.spawnUntil && now < cB.spawnUntil)) return;
  // Enfriamiento por auto (no solo por pareja) — ver nota en applyCollisionPenalty
  if ((cA.hitUntil && now < cA.hitUntil) || (cB.hitUntil && now < cB.hitUntil)) return;
  if (!isColliding(cA,cB)) return;
  const key = idA<idB ? idA+'|'+idB : idB+'|'+idA;
  separateLanes(cA,cB);
  hit.add(idA);hit.add(idB);
  if (!lastCollision[key] || now-lastCollision[key]>700) {
    await applyCollisionPenalty(idA,cA,idB,cB,key,now);
  }
}

async function checkCollisions() {
  const arr = [...cars.entries()]; const hit = new Set();
  const now = Date.now();
  for (let i=0;i<arr.length;i++) {
    for (let j=i+1;j<arr.length;j++) {
      const [idA,cA]=arr[i],[idB,cB]=arr[j];
      await handlePair(idA,cA,idB,cB,hit,now);
    }
  }
}

// GAME LOOP — cada 100ms: mueve autos, revisa colisiones, publica el estado
setInterval(async () => {
  if (cars.size === 0) return;
  for (const [carId, car] of cars) {
    await updateCarPhysics(carId, car);
  }
  await checkCollisions();
  await redisPub.publish('race:state',JSON.stringify({sectorId:SECTOR_ID,cars:[...cars.entries()].map(([id,c])=>({carId:id,name:c.name,position:c.position,speed:c.speed,color:c.color||'#888',isBot:!!c.isBot,lane:c.lane||0})),timestamp:Date.now()}));
}, 100);


async function handoff(carId, car, target) {
  try {
    await axios.post(`${SECTOR_URLS[target]}/car/receive`,{carId,car:{...car,position:RANGE[target].min},fromSector:SECTOR_ID,toSector:target});
    await notifyGatewayHandoff(carId, target);
    console.log(`[S${SECTOR_ID}] Handoff ${carId}→S${target}`);
  } catch(e) { console.error(`[S${SECTOR_ID}] Error handoff: ${e.message}`); car.position=RANGE[SECTOR_ID].max-1; cars.set(carId,car); }
}

// Avisa al gateway que el auto cambió de sector, con 2 reintentos cortos.
// Antes era "fire and forget" (.catch(()=>{})): si este único intento fallaba,
// el gateway quedaba creyendo que el auto seguía en el sector viejo para siempre,
// y desde ahí todos los comandos del jugador se mandaban a un sector donde el auto
// ya no existe (404 silencioso) — el jugador se quedaba trabado sin ningún aviso.
async function notifyGatewayHandoff(carId, target, attempt=1) {
  try {
    await axios.post(`${GATEWAY}/handoff-notify`,{carId,fromSector:SECTOR_ID,toSector:target},{timeout:1500});
  } catch(e) {
    if (attempt < 3) {
      await new Promise(r=>setTimeout(r,150*attempt));
      return notifyGatewayHandoff(carId, target, attempt+1);
    }
    console.error(`[S${SECTOR_ID}] No se pudo avisar el handoff al gateway tras 3 intentos: ${e.message}`);
  }
}

app.post('/car/register', (req,res) => {
  const {carId,name,color,vectorClock,circuit}=req.body;
  // Si la carrera YA está en marcha, este piloto no entra al tráfico en vivo — espera
  // en cola a que termine la ronda actual (todos los humanos se vayan o terminen) para
  // arrancar sincronizado en la próxima, en vez de aparecer en medio de una carrera ajena.
  if (raceStarted && SECTOR_ID===1) {
    if (waitingQueue.length===0) queueSince = Date.now();
    waitingQueue.push({carId,name,color,vectorClock,circuit});
    console.log(`[S${SECTOR_ID}] Piloto ${name} en cola — esperando la próxima ronda (${waitingQueue.length} en cola)`);
    return res.json({ok:true, queued:true, circuit:currentCircuit});
  }
  placeOnGrid(carId, name, color, vectorClock, circuit);
  // Primera vez que llega un jugador real → contar 5s y soltar bots
  if (!playerJoined && SECTOR_ID===1) {
    playerJoined = true;
    console.log('[Bots] Jugador detectado, bots arrancan en 5s...');
    setTimeout(releaseBots, 5000);
  }
  res.json({ok:true, raceStarted, circuit:currentCircuit});
});

app.post('/car/receive', (req,res) => { const{carId,car,fromSector}=req.body; cars.set(carId,car); console.log(`[S${SECTOR_ID}] ${carId} desde S${fromSector}`); res.json({ok:true}); });
app.post('/car/command', (req,res) => {
  const{carId,action}=req.body; const car=cars.get(carId);
  if(!car) return res.status(404).json({error:'No en este sector'});
  if(car.isBot) return res.json({ok:true});
  if(action==='accelerate') car.speed=Math.min(car.speed+0.4,5.0);
  if(action==='brake')      car.speed=Math.max(car.speed-0.55,0.0);
  if(action==='steerLeft')  car.lane=Math.max((car.lane||0)-0.14,-0.88);
  if(action==='steerRight') car.lane=Math.min((car.lane||0)+0.14,0.88);
  res.json({ok:true,speed:car.speed,lane:car.lane});
});
// El jugador se desconectó (cerró/recargó la página) → sacarlo de verdad de la carrera,
// si no, su auto se queda "fantasma" para siempre (chocando, apareciendo en la clasificación).
app.post('/car/remove', (req,res) => {
  const {carId} = req.body;
  const existed = cars.delete(carId);
  const queuedBefore = waitingQueue.length;
  waitingQueue = waitingQueue.filter(p => p.carId !== carId); // por si se fue mientras esperaba en cola
  if (waitingQueue.length !== queuedBefore) console.log(`[S${SECTOR_ID}] ${carId} salió de la cola de espera`);
  Object.keys(lastCollision).forEach(k=>{if(k.includes(carId))delete lastCollision[k];});
  if(existed) console.log(`[S${SECTOR_ID}] ${carId} eliminado (desconectado)`);
  res.json({ok:true,existed});
});
app.post('/election',    (req,res)=>{res.json({ok:true});setTimeout(()=>bully.startElection(redisPub),100);});
app.post('/coordinator', (req,res)=>{bully.setLeader(req.body.leader);res.json({ok:true});});
app.get('/health',       (req,res)=>res.json({status:'ok',sectorId:SECTOR_ID,cars:cars.size,playerJoined}));
app.listen(PORT,()=>{console.log(`[Sector ${SECTOR_ID}] Puerto ${PORT}`);hb.start();});