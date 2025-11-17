// ==============================================
//  WARFORT Backend - Persistencia, Clanes, Misiones,
//  Golpes entre jugadores (anti-hack) y eventos globales
//  LISTO PARA COPIAR Y PEGAR
// ==============================================

/*
  Dependencias:
    npm i express cors socket.io sqlite3
*/

const express = require('express');
const http = require('http');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] }));

process.on("uncaughtException", err => console.error("❌ Error no capturado:", err));
process.on("unhandledRejection", err => console.error("❌ Promesa no manejada:", err));

// ============== HTTP + SOCKET.IO ============
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingInterval: 2000,
  pingTimeout: 4000
});

// ============== DB (SQLite) =================
const DB_FILE = path.join(__dirname, 'warfort.db');
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) return console.error("DB ERROR:", err);
  console.log("✅ SQLite conectado:", DB_FILE);
});

const run = (sql, params=[]) => new Promise((res, rej) => db.run(sql, params, function(err){ err ? rej(err) : res(this); }));
const get = (sql, params=[]) => new Promise((res, rej) => db.get(sql, params, (err,row)=> err?rej(err):res(row)));
const all = (sql, params=[]) => new Promise((res, rej) => db.all(sql, params, (err,rows)=> err?rej(err):res(rows)));

// Inicializar tablas
(async () => {
  await run(`CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    name TEXT,
    role TEXT,
    x REAL,
    y REAL,
    hp INTEGER,
    kills INTEGER,
    fort TEXT,
    last_login INTEGER
  )`);

  await run(`CREATE TABLE IF NOT EXISTS map_state (
    key TEXT PRIMARY KEY,
    json TEXT
  )`);

  await run(`CREATE TABLE IF NOT EXISTS clans (
    id TEXT PRIMARY KEY,
    name TEXT,
    owner TEXT,
    created_at INTEGER
  )`);

  await run(`CREATE TABLE IF NOT EXISTS clan_members (
    clan_id TEXT,
    player_id TEXT,
    role TEXT DEFAULT 'member',
    PRIMARY KEY (clan_id, player_id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS missions (
    id TEXT PRIMARY KEY,
    title TEXT,
    description TEXT,
    reward_json TEXT,
    active INTEGER DEFAULT 1,
    created_at INTEGER,
    reset_every INTEGER DEFAULT 86400
  )`);

  await run(`CREATE TABLE IF NOT EXISTS mission_claims (
    mission_id TEXT,
    player_id TEXT,
    claimed_at INTEGER,
    PRIMARY KEY (mission_id, player_id)
  )`);

  // Estado inicial del mapa
  const mapRow = await get(`SELECT json FROM map_state WHERE key = ?`, ['global']);
  if (!mapRow) {
    const initial = JSON.stringify({ trees:[], bushes:[], stones:[], animals:[], wheels:[], forts:[], loot:[] });
    await run(`INSERT INTO map_state (key, json) VALUES (?, ?)`, ['global', initial]);
  }

  // Misiones iniciales
  const missionsExist = await get(`SELECT COUNT(1) as c FROM missions`);
  if (!missionsExist || missionsExist.c === 0) {
    const now = Date.now();
    await run(`INSERT INTO missions VALUES (?, ?, ?, ?, 1, ?, ?)`, [
      'm_daily_1',
      'Caza 3 animales',
      'Elimina 3 animales para completar la misión diaria.',
      JSON.stringify({ xp:50, gold:10 }),
      now,
      86400
    ]);

    await run(`INSERT INTO missions VALUES (?, ?, ?, ?, 1, ?, ?)`, [
      'm_daily_2',
      'Recolecta madera',
      'Recoge 10 unidades de madera.',
      JSON.stringify({ xp:30, wood:10 }),
      now,
      86400
    ]);
  }

})().catch(e => console.error("Init DB Error:", e));

// ============== ESTADO EN MEMORIA ===========
let mapState = { trees:[], bushes:[], stones:[], animals:[], wheels:[], forts:[], loot:[] };
let players = {}; 

// Cargar mapState desde DB
(async () => {
  try {
    const row = await get(`SELECT json FROM map_state WHERE key = ?`, ['global']);
    if (row && row.json) mapState = JSON.parse(row.json);
    console.log("✅ mapState cargado");
  } catch (err) { console.error("Error al cargar mapState:", err); }
})();

// Helper
const safe = (obj, keys) => keys.every(k => obj && obj[k] !== undefined);
const rand = (min, max) => Math.random() * (max - min) + min;

const persistMapState = async () => {
  await run(`UPDATE map_state SET json = ? WHERE key = ?`, [JSON.stringify(mapState), 'global']);
};

const upsertPlayerDB = async (p) => {
  await run(
    `INSERT INTO players VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET 
       name=excluded.name, role=excluded.role, x=excluded.x, y=excluded.y,
       hp=excluded.hp, kills=excluded.kills, fort=excluded.fort, last_login=excluded.last_login`,
    [p.id, p.name, p.role, p.x, p.y, p.hp, p.kills, p.fort, Date.now()]
  );
};

// Respawn
const respawnPlayer = async (id) => {
  if (!players[id]) return;
  players[id].x = rand(100, 900);
  players[id].y = rand(100, 900);
  players[id].hp = 100;
  await upsertPlayerDB(players[id]);
  io.emit("state", { players: { [id]: players[id] } });
};

// ============== SOCKET.IO ==================
io.on("connection", (socket) => {

  socket.emit("init", { map: mapState, players });

  // Join
  socket.on("join", async (data) => {
    if (!data || !data.name) return;

    const existing = await get(`SELECT * FROM players WHERE id = ?`, [socket.id]);

    if (existing) {
      players[socket.id] = { ...existing };
    } else {
      players[socket.id] = {
        id: socket.id,
        name: data.name.slice(0,20),
        role: ['player','mod','admin'].includes(data.role) ? data.role : 'player',
        x: rand(100,900),
        y: rand(100,900),
        hp: 100,
        kills: 0,
        fort: null
      };
    }

    await upsertPlayerDB(players[socket.id]);
    io.emit("state", { players: { [socket.id]: players[socket.id] } });
  });

  // Movimiento
  socket.on("update", async (data) => {
    if (!players[socket.id]) return;
    players[socket.id] = { ...players[socket.id], ...data };
    await upsertPlayerDB(players[socket.id]);
    socket.broadcast.emit("state", { players: { [socket.id]: players[socket.id] } });
  });

  // Chat
  socket.on("chat", msg => {
    if (!players[socket.id]) return;
    io.emit("chat", { id: socket.id, name: players[socket.id].name, msg: msg.slice(0,300) });
  });

  // Colocar ruedas
  socket.on("placeWheel", async (wheel) => {
    if (!safe(wheel, ["x","y","id"])) return;
    mapState.wheels.push(wheel);
    await persistMapState();
    io.emit("state", { map: mapState });
  });

  // Loot
  socket.on("pickupLoot", async (d) => {
    mapState.loot = mapState.loot.filter(l => l.id !== d.id);
    await persistMapState();
    io.emit("state", { map: mapState });
  });

  // Matar animal
  socket.on("killAnimal", async (d) => {
    mapState.animals = mapState.animals.filter(a => a.id !== d.id);
    await persistMapState();
    io.emit("state", { map: mapState });
  });

  // ========== GOLPE ENTRE JUGADORES (ANTI-HACK) ==========
  socket.on("hit", data => {
    if (!players[socket.id]) return;
    if (!players[data.target]) return;

    const attacker = players[socket.id];
    const target = players[data.target];

    // Distancia máxima permitida
    const dx = attacker.x - target.x;
    const dy = attacker.y - target.y;
    const distance = Math.sqrt(dx*dx + dy*dy);

    if (distance > 50) return;  // Anti-hack

    target.hp -= 10;

    if (target.hp <= 0) {
      target.hp = 0;
      io.emit("playerDeath", { id: target.id, killer: attacker.id });
      respawnPlayer(target.id);
    }

    io.emit("hitResult", {
      attacker: attacker.id,
      target: target.id,
      hp: target.hp
    });
  });

  // Salida
  socket.on("disconnect", async () => {
    if (players[socket.id]) await upsertPlayerDB(players[socket.id]);
    delete players[socket.id];
    io.emit("state", { players: { [socket.id]: null } });
  });

});

// ============== RUTAS: CLANES ==================

app.post("/clans", async (req,res) => {
  try {
    const { id, name, owner } = req.body;
    if (!id || !name || !owner) return res.json({ ok:false });

    await run(`INSERT INTO clans VALUES (?, ?, ?, ?)`, [id,name,owner,Date.now()]);
    await run(`INSERT INTO clan_members VALUES (?, ?, ?)`, [id,owner,'owner']);
    res.json({ ok:true });
  } catch (e) { res.json({ ok:false }); }
});

app.post("/clans/:id/join", async (req,res) => {
  const { id } = req.params;
  const { player_id } = req.body;
  await run(`INSERT INTO clan_members VALUES (?, ?, ?)`, [id, player_id, 'member']);
  res.json({ ok:true });
});

app.get("/clans/:id", async (req,res) => {
  const clan = await get(`SELECT * FROM clans WHERE id = ?`, [req.params.id]);
  const members = await all(`SELECT * FROM clan_members WHERE clan_id = ?`, [req.params.id]);
  res.json({ ok:true, clan, members });
});

// ============== RUTAS: MISIONES ================

app.get("/missions", async (req,res) => {
  const missions = await all(`SELECT * FROM missions WHERE active = 1`);
  missions.forEach(m => m.reward = JSON.parse(m.reward_json));
  res.json({ ok:true, missions });
});

app.post("/missions/:id/claim", async (req,res) => {
  const { id } = req.params;
  const { player_id } = req.body;

  const already = await get(`SELECT * FROM mission_claims WHERE mission_id = ? AND player_id = ?`, [id, player_id]);
  if (already) return res.json({ ok:false, error:"already" });

  await run(`INSERT INTO mission_claims VALUES (?, ?, ?)`, [id, player_id, Date.now()]);
  res.json({ ok:true });
});

// Reset misiones cada minuto
setInterval(async () => {
  const missions = await all(`SELECT id, reset_every FROM missions`);
  const now = Date.now();
  for (const m of missions) {
    const cut = now - (m.reset_every * 1000);
    await run(`DELETE FROM mission_claims WHERE mission_id = ? AND claimed_at < ?`, [m.id, cut]);
  }
}, 60000);

// ============== SISTEMAS PERIODICOS ============

// Loot automático cada 15s
setInterval(async () => {
  const loot = { id:`loot_${Date.now()}`, x:rand(50,900), y:rand(50,900), type:["wood","stone","meat"][Math.floor(Math.random()*3)] };
  mapState.loot.push(loot);
  await persistMapState();
  io.emit("mapLoot", { loot });
}, 15000);

// Evento de clima
setInterval(() => {
  io.emit("storm", { intensity: Math.floor(rand(1,5)), ts: Date.now() });
}, 60000);

// ============== START SERVER ===================
server.listen(port, () => {
  console.log(`🚀 WARFORT backend funcionando en puerto ${port}`);
});
