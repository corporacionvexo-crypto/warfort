// server.js
// WARFORT+ Backend - COMPLETO & MEJORADO (ARMAS Y HABILIDADES)
// Dependencias: npm i express cors socket.io sqlite3 uuid

const express = require('express');
const http = require('http');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'warfort.db');

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cors());

const log = (...args) => console.log('[WARFORT]', ...args);

// =====================
// DATABASE
// =====================
const db = new sqlite3.Database(DB_FILE, err => { if(err) console.error(err); else log('SQLite conectado'); });
const run = (sql, params=[]) => new Promise((res, rej) => db.run(sql, params, function(err){ err?rej(err):res(this); }));
const get = (sql, params=[]) => new Promise((res, rej) => db.get(sql, params, (err,row)=>err?rej(err):res(row)));
const all = (sql, params=[]) => new Promise((res, rej) => db.all(sql, params, (err,rows)=>err?rej(err):res(rows)));

// =====================
// INIT DB
// =====================
(async()=>{
  try{
    await run(`CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY, name TEXT, role TEXT, x REAL, y REAL,
      hp INTEGER, kills INTEGER, fort TEXT, inventory_json TEXT, last_login INTEGER
    )`);

    await run(`CREATE TABLE IF NOT EXISTS map_state (
      key TEXT PRIMARY KEY, json TEXT
    )`);

    const mapRow = await get(`SELECT json FROM map_state WHERE key=?`, ['global']);
    if(!mapRow){
      const initial = JSON.stringify({ trees:[], bushes:[], stones:[], animals:[], wheels:[], forts:[], loot:[] });
      await run(`INSERT INTO map_state(key,json) VALUES(?,?)`, ['global', initial]);
      log('map_state inicial creado');
    }
  } catch(e){ console.error('DB init error:', e); }
})();

// =====================
// SOCKET.IO
// =====================
const { Server } = require('socket.io');
const io = new Server(server, { cors:{ origin:'*' } });

let mapState = { trees:[], bushes:[], stones:[], animals:[], wheels:[], forts:[], loot:[] };
const playersById = {};
const playerSocketMap = {};
const socketPlayerMap = {};

(async()=>{
  const row = await get(`SELECT json FROM map_state WHERE key=?`, ['global']);
  if(row && row.json) mapState = JSON.parse(row.json);
})();

const rand = (min,max)=>Math.floor(Math.random()*(max-min+1))+min;
const persistMapState = async()=>{ await run(`UPDATE map_state SET json=? WHERE key=?`, [JSON.stringify(mapState),'global']); };
const upsertPlayerDB = async(p)=>{ 
  if(!p || !p.id) return;
  await run(`INSERT INTO players(id,name,role,x,y,hp,kills,fort,inventory_json,last_login)
    VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, role=excluded.role, x=excluded.x, y=excluded.y, hp=excluded.hp, kills=excluded.kills,
      fort=excluded.fort, inventory_json=excluded.inventory_json, last_login=excluded.last_login`,
    [p.id,p.name,p.role,p.x,p.y,p.hp,p.kills,p.fort,JSON.stringify(p.inventory||{}),Date.now()]);
};

// =====================
// SOCKET HANDLERS
// =====================
io.on('connection', socket=>{
  log('Connect',socket.id);
  socket.emit('init',{ map: mapState, players: playersById });

  // JOIN PLAYER
  socket.on('join', async(data={})=>{
    let playerId = data.player_id || uuidv4();
    let existing = await get(`SELECT * FROM players WHERE id=?`, [playerId]);
    let player = existing ? {
      id:existing.id,
      name:data.name||existing.name,
      role:existing.role||'player',
      x:existing.x,
      y:existing.y,
      hp:existing.hp,
      kills:existing.kills,
      fort:existing.fort,
      inventory:existing.inventory_json?JSON.parse(existing.inventory_json):{},
    } : {
      id:playerId,
      name:data.name||`Player-${playerId.slice(0,4)}`,
      role:'player',
      x:rand(100,900),
      y:rand(100,900),
      hp:100,
      kills:0,
      fort:null,
      inventory:{ sword:1, shield:1, bow:1 }, // arma inicial
    };
    playersById[player.id] = player;
    playerSocketMap[player.id] = socket.id;
    socketPlayerMap[socket.id] = player.id;
    await upsertPlayerDB(player);
    socket.emit('init',{ map: mapState, players: playersById, you: player.id });
    socket.broadcast.emit('state',{ players:{ [player.id]:player } });
  });

  // UPDATE PLAYER
  socket.on('update', async(data={})=>{
    const playerId = socketPlayerMap[socket.id]; if(!playerId) return;
    const player = playersById[playerId]; if(!player) return;
    ['x','y','hp','kills','fort','name','inventory'].forEach(k=>{ if(data[k]!=null) player[k]=data[k]; });
    await upsertPlayerDB(player);
    socket.broadcast.emit('state',{ players:{ [playerId]:player } });
  });

  // HIT PLAYER CON ARMAS
  socket.on('hit', async(data)=>{
    try{
      const attackerId = socketPlayerMap[socket.id]; if(!attackerId||!data||!data.target) return;
      const targetId = String(data.target);
      const attacker = playersById[attackerId];
      const target = playersById[targetId];
      if(!attacker||!target) return;

      let dmg = 10;
      if(data.weapon==='sword') dmg = 25;
      else if(data.weapon==='bow') dmg = 20;
      else if(data.weapon==='shield'){ dmg=0; socket.emit('shieldBlock',{ targetId }); }

      target.hp = (target.hp||100)-dmg;
      if(target.hp<=0){
        target.hp=0;
        attacker.kills = (attacker.kills||0)+1;
        target.x = rand(100,900);
        target.y = rand(100,900);
        target.hp = 100;
      }
      await upsertPlayerDB(target);
      await upsertPlayerDB(attacker);
      io.emit('state',{ players:{ [targetId]:target, [attackerId]:attacker } });
    } catch(e){ console.error('hit',e); }
  });

  // DISCONNECT
  socket.on('disconnect', async()=>{
    const playerId = socketPlayerMap[socket.id];
    if(playerId){ await upsertPlayerDB(playersById[playerId]); delete playerSocketMap[playerId]; }
    delete socketPlayerMap[socket.id];
    if(playerId) io.emit('state',{ players:{ [playerId]:null } });
  });
});

// =====================
// AUTO-SPAWN ANIMALES
// =====================
const animalTypes = ['lobo','vaca'];
setInterval(async()=>{
  const a = { id:`a_${Date.now()}`, x:rand(50,2950), y:rand(50,2950), type:animalTypes[Math.floor(Math.random()*animalTypes.length)], hp:50 };
  mapState.animals.push(a);
  await persistMapState();
  io.emit('spawnAnimal',{ animal: a });
},15000);

// =====================
// START SERVER
// =====================
server.listen(PORT,()=>log(`WARFORT+ backend running on ${PORT}`));
