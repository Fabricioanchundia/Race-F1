const express = require('express');
const Redis   = require('ioredis');
const axios   = require('axios');
const cors    = require('cors');
const HeartbeatMonitor = require('./heartbeat');
const BullyElection    = require('./bully');

const app = express();
app.use(cors()); app.use(express.json());

const SECTOR_ID   = parseInt(process.env.SECTOR_ID || '1');
const PORT        = parseInt(process.env.PORT || '3001');
const REDIS_URL   = process.env.REDIS_URL || 'redis://localhost:6379';
const GATEWAY     = process.env.GATEWAY_URL || 'http://gateway:3000';
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

// Bots solo en Sector 1, PARADOS hasta que llegue un jugador
const BOTS = [
  {id:'bot_hamilton', name:'Hamilton', color:'#00d2be', targetSpd:3.0},
  {id:'bot_norris',   name:'Norris',   color:'#ff8000', targetSpd:2.6},
  {id:'bot_leclerc',  name:'Leclerc',  color:'#e10600', targetSpd:3.3},
];
if (SECTOR_ID === 1) {
  BOTS.forEach((b,i) => {
    cars.set(b.id, {name:b.name,color:b.color,position:i*9,speed:0,lane:i*.2-.2,isBot:true,targetSpd:b.targetSpd,ready:false});
    console.log(`[Bots] ${b.name} listo en grilla`);
  });
}

function releaseBots() {
  for (const [,car] of cars) {
    if (car.isBot) car.ready = true;
  }
  redisPub.publish('race:events', JSON.stringify({type:'RACE_START',timestamp:Date.now()}));
  console.log('[Bots] ¡Arrancaron!');
}

// GAME LOOP
setInterval(async () => {
  if (cars.size === 0) return;
  for (const [carId, car] of cars) {
    if (car.isBot) {
      if (car.ready) {
        car.speed = Math.max(0, Math.min(4.8, car.speed + (car.targetSpd - car.speed)*.06 + (Math.random()-.5)*.08));
        car.lane  = (car.lane||0) * .92 + (Math.random()-.5)*.02;
      } else { car.speed = 0; }
    } else {
      car.lane = (car.lane||0) * .88;
    }
    car.position = parseFloat((car.position + car.speed * .1).toFixed(2));
    if (car.position >= RANGE[SECTOR_ID].max) {
      const next = SECTOR_ID < 3 ? SECTOR_ID+1 : 1;
      await handoff(carId, car, next); cars.delete(carId); continue;
    }
    await redis.hset(`car:${carId}`, {position:car.position,speed:car.speed,sector:SECTOR_ID,name:car.name,color:car.color||'#888',lane:car.lane||0});
  }
  // Colisiones
  const arr = [...cars.entries()]; const hit = new Set();
  for (let i=0;i<arr.length;i++) for (let j=i+1;j<arr.length;j++) {
    const [idA,cA]=arr[i],[idB,cB]=arr[j];
    if (hit.has(idA)||hit.has(idB)) continue;
    if (Math.abs(cA.position-cB.position)<2.0 && Math.abs((cA.lane||0)-(cB.lane||0))<0.55) {
      if(cA.speed>=cB.speed) cA.speed=Math.max(cA.speed-2,0); else cB.speed=Math.max(cB.speed-2,0);
      hit.add(idA);hit.add(idB);
      await redisPub.publish('race:events',JSON.stringify({type:'COLLISION',carA:idA,carB:idB,sector:SECTOR_ID,timestamp:Date.now()}));
      console.log(`[S${SECTOR_ID}] COLISIÓN: ${idA} vs ${idB}`);
    }
  }
  await redisPub.publish('race:state',JSON.stringify({sectorId:SECTOR_ID,cars:[...cars.entries()].map(([id,c])=>({carId:id,name:c.name,position:c.position,speed:c.speed,color:c.color||'#888',isBot:!!c.isBot,lane:c.lane||0})),timestamp:Date.now()}));
}, 100);

async function handoff(carId, car, target) {
  try {
    await axios.post(`${SECTOR_URLS[target]}/car/receive`,{carId,car:{...car,position:RANGE[target].min},fromSector:SECTOR_ID,toSector:target});
    await axios.post(`${GATEWAY}/handoff-notify`,{carId,fromSector:SECTOR_ID,toSector:target}).catch(()=>{});
    console.log(`[S${SECTOR_ID}] Handoff ${carId}→S${target}`);
  } catch(e) { console.error(`[S${SECTOR_ID}] Error handoff: ${e.message}`); car.position=RANGE[SECTOR_ID].max-1; cars.set(carId,car); }
}

app.post('/car/register', (req,res) => {
  const {carId,name,color,vectorClock}=req.body;
  cars.set(carId,{name:name||carId,color:color||'#888',position:RANGE[SECTOR_ID].min+1,speed:0,lane:0,vectorClock});
  console.log(`[S${SECTOR_ID}] Piloto ${name} en grilla — PARADO`);
  // Primera vez que llega un jugador real → contar 5s y soltar bots
  if (!playerJoined && SECTOR_ID===1) {
    playerJoined = true;
    console.log('[Bots] Jugador detectado, bots arrancan en 5s...');
    setTimeout(releaseBots, 5000);
  }
  res.json({ok:true});
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
app.post('/election',    (req,res)=>{res.json({ok:true});setTimeout(()=>bully.startElection(redisPub),100);});
app.post('/coordinator', (req,res)=>{bully.setLeader(req.body.leader);res.json({ok:true});});
app.get('/health',       (req,res)=>res.json({status:'ok',sectorId:SECTOR_ID,cars:cars.size,playerJoined}));
app.listen(PORT,()=>{console.log(`[Sector ${SECTOR_ID}] Puerto ${PORT}`);hb.start();});