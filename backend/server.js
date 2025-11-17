// ==============================================
//  WARFORT Backend - Persistencia, Clanes y Misiones
//  Lista para copiar/pegar (SQLite + Socket.IO)
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

const run = (sql, params=[]) => new Promise((res, rej) =>
  db.run(sql, params, function(err){ if (err) rej(err); else res(this); })
);
const get = (sql, params=[]) => new Promise((res, rej) =>
  db.get(sql, params, (err, row) => { if (err) rej(err); else res(row); })
);
const all = (sql, params=[]) => new Promise((res, rej) =>
  db.all(sql, params, (err, rows) => { if (err) rej(err); else res(rows); })
);

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

  // Guardar estado de mapa por primera vez si no existe
  const mapRow = await get(`SELECT json FROM map_state WHERE key = ?`, ['global']);
  if (!mapRow) {
    const initial = JSON.stringify({ trees:[], bushes:[], stones:[], animals:[], wheels:[], forts:[], loot:[] });
    await run(`INSERT INTO map_state (key, json) VALUES (?, ?)`, ['global', initial]);
  }

  // Insertar misiones base si no existen
  const missionsExist = await get(`SELECT COUNT(1) as c FROM missions`);
  if (!missionsExist || missionsExist.c === 0) {
    const now = Date.now();
    await run(`INSERT INTO missions (id, title, description, reward_json, active, created_at, reset_every)
      VALUES (?, ?, ?, ?, 1, ?, ?)`, [
        'm_daily_1',
        'Caza 3 animales',
        'Elimina 3 animales para completar la misión diaria.',
        JSON.stringify({ xp:50, gold:10 }),
        now,
        86400
      ]);
    await run(`INSERT INTO missions (id, title, description, reward_json, active, created_at, reset_every)
      VALUES (?, ?, ?, ?, 1, ?, ?)`, [
        'm_daily_2',
        'Recolecta madera',
        'Recoge 10 unidades de madera (loot).',
        JSON.stringify({ xp:30, wood:10 }),
        now,
        86400
      ]);
  }

})().catch(e => console.error("Init DB Error:", e));

// ============== ESTADO EN MEMORIA ===========
let mapState = { trees:[], bushes:[], stones:[], animals:[], wheels:[], forts:[], loot:[] };
let players = {}; // sincronizado con DB cuando se conectan

// Cargar mapState desde DB al arrancar
(async () => {
  try {
    const row = await get(`SELECT json FROM map_state WHERE key = ?`, ['global']);
    if (row && row.json) mapState = JSON.parse(row.json);
    console.log("✅ mapState cargado desde DB");
  } catch (err) { console.error("Error cargando mapState:", err); }
})();

// ============== UTILIDADES =================
const safe = (obj, keys) => keys.every(k => obj && obj[k] !== undefined);
const rand = (min, max) => Math.random() * (max - min) + min;

const persistMapState = async () => {
  try {
    await run(`UPDATE map_state SET json = ? WHERE key = ?`, [JSON.stringify(mapState), 'global']);
  } catch (e) { console.error("Persist map error:", e); }
};

const upsertPlayerDB = async (p) => {
  try {
    await run(
      `INSERT INTO players (id, name, role, x, y, hp, kills, fort, last_login)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, role=excluded.role, x=excluded.x, y=excluded.y, hp=excluded.hp, kills=excluded.kills, fort=excluded.fort, last_login=excluded.last_login`,
      [p.id, p.name, p.role, p.x, p.y, p.hp, p.kills, p.fort, Date.now()]
    );
  } catch (e) { console.error("upsertPlayerDB error:", e); }
};

// Respawn helper
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
  console.log("🟢 Conexión:", socket.id);

  socket.emit("init", { map: mapState, players });

  // JOIN -> si existe en DB lo carga, si no lo crea
  socket.on("join", async (data) => {
    if (!data || !data.name) return;
    try {
      // Evitar multi-login con mismo id (si ya existe)
      const existing = await get(`SELECT * FROM players WHERE id = ?`, [socket.id]);
      if (existing) {
        players[socket.id] = {
          id: existing.id,
          name: existing.name,
          role: existing.role || 'player',
          x: existing.x || rand(100,900),
          y: existing.y || rand(100,900),
          hp: existing.hp !== null ? existing.hp : 100,
          kills: existing.kills || 0,
          fort: existing.fort || null
        };
      } else {
        players[socket.id] = {
          id: socket.id,
          name: String(data.name).slice(0,20),
          role: ['player','mod','admin'].includes(data.role) ? data.role : 'player',
          x: data.x || rand(100,900),
          y: data.y || rand(100,900),
          hp: 100,
          kills: 0,
          fort: null
        };
      }

      await upsertPlayerDB(players[socket.id]);
      socket.emit("init", { map: mapState, players }); // reenviar init con estado actualizado
      io.emit("state", { players: { [socket.id]: players[socket.id] } });

    } catch (err) { console.error("join error:", err); }
  });

  // Movimiento y actualizaciones parciales
  socket.on("update", async (data) => {
    if (!players[socket.id]) return;
    players[socket.id] = { ...players[socket.id], ...data };
    await upsertPlayerDB(players[socket.id]);
    socket.broadcast.emit("state", { players: { [socket.id]: players[socket.id] } });
  });

  // Chat
  socket.on("chat", (msg) => {
    if (!players[socket.id]) return;
    io.emit("chat", { id: socket.id, name: players[socket.id].name, role: players[socket.id].role, msg: String(msg).slice(0,300) });
  });

  // Place wheel / item
  socket.on("placeWheel", async (wheel) => {
    if (!safe(wheel, ["x","y","id"])) return;
    mapState.wheels.push(wheel);
    await persistMapState();
    io.emit("state", { map: mapState });
  });

  // Loot pickup
  socket.on("pickupLoot", async (data) => {
    if (!safe(data, ["id"])) return;
    mapState.loot = mapState.loot.filter(l => l.id !== data.id);
    await persistMapState();

    // emitir evento de recolección
    io.emit("state", { map: mapState });
  });

  // Kill animal
  socket.on("killAnimal", async (data) => {
    if (!safe(data, ["id"])) return;
    mapState.animals = mapState.animals.filter(a => a.id !== data.id);
    await persistMapState();
    io.emit("state", { map: mapState });
  });

  // Hit (daño entre jugadores)
  socket.on("hit", async (data) => {
    if (!safe(data, ["target","dmg"])) return;
    const target = players[data.target];
    const killer = players[socket.id];
    if (!target || !killer) return;

    target.hp -= Number(data.dmg) || 0;
    if (target.hp <= 0) {
      killer.kills = (killer.kills || 0) + 1;
      await upsertPlayerDB(killer);
      await respawnPlayer(data.target);

      io.emit("killfeed", { killer: killer.name, victim: target.name });
    } else {
      await upsertPlayerDB(target);
      io.emit("state", { players: { [data.target]: target } });
    }
  });

  // Join fort
  socket.on("joinFort", async (data) => {
    if (!safe(data, ["fort"])) return;
    if (!players[socket.id]) return;
    players[socket.id].fort = data.fort;
    await upsertPlayerDB(players[socket.id]);
    io.emit("state", { players: { [socket.id]: players[socket.id] } });
  });

  // Disconnect
  socket.on("disconnect", async () => {
    try {
      // Persistir último estado del jugador en DB
      if (players[socket.id]) await upsertPlayerDB(players[socket.id]);
    } catch (e) { console.error("disconnect persist error:", e); }
    delete players[socket.id];
    io.emit("state", { players: { [socket.id]: null } });
    console.log("🔴 Desconexión:", socket.id);
  });
});

// ============== RUTAS: CLANES ==================

// Crear clan
app.post("/clans", async (req, res) => {
  try {
    const { id, name, owner } = req.body;
    if (!id || !name || !owner) return res.status(400).json({ ok:false, error: "id,name,owner required" });

    const exists = await get(`SELECT * FROM clans WHERE id = ?`, [id]);
    if (exists) return res.status(409).json({ ok:false, error: "clan exists" });

    await run(`INSERT INTO clans (id, name, owner, created_at) VALUES (?, ?, ?, ?)`, [id, name, owner, Date.now()]);
    await run(`INSERT INTO clan_members (clan_id, player_id, role) VALUES (?, ?, ?)`, [id, owner, 'owner']);

    return res.json({ ok:true, clan: { id, name, owner } });
  } catch (e) { console.error(e); return res.status(500).json({ ok:false, error: e.message }); }
});

// Unirse a clan
app.post("/clans/:id/join", async (req, res) => {
  try {
    const { id } = req.params;
    const { player_id } = req.body;
    if (!player_id) return res.status(400).json({ ok:false, error: "player_id required" });

    const clan = await get(`SELECT * FROM clans WHERE id = ?`, [id]);
    if (!clan) return res.status(404).json({ ok:false, error: "clan not found" });

    const member = await get(`SELECT * FROM clan_members WHERE clan_id = ? AND player_id = ?`, [id, player_id]);
    if (member) return res.status(409).json({ ok:false, error: "already member" });

    await run(`INSERT INTO clan_members (clan_id, player_id, role) VALUES (?, ?, ?)`, [id, player_id, 'member']);
    return res.json({ ok:true });
  } catch (e) { console.error(e); return res.status(500).json({ ok:false, error: e.message }); }
});

// Obtener clan con miembros
app.get("/clans/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const clan = await get(`SELECT * FROM clans WHERE id = ?`, [id]);
    if (!clan) return res.status(404).json({ ok:false, error: "clan not found" });
    const members = await all(`SELECT player_id, role FROM clan_members WHERE clan_id = ?`, [id]);
    return res.json({ ok:true, clan, members });
  } catch (e) { console.error(e); return res.status(500).json({ ok:false, error: e.message }); }
});

// ============== RUTAS: MISIONES ==================

// Listar misiones activas
app.get("/missions", async (req, res) => {
  try {
    const missions = await all(`SELECT id, title, description, reward_json, active, created_at, reset_every FROM missions WHERE active = 1`);
    const parsed = missions.map(m => ({ ...m, reward: JSON.parse(m.reward_json) }));
    res.json({ ok:true, missions: parsed });
  } catch (e) { console.error(e); res.status(500).json({ ok:false, error: e.message }); }
});

// Reclamar misión
app.post("/missions/:id/claim", async (req, res) => {
  try {
    const { id } = req.params;
    const { player_id } = req.body;
    if (!player_id) return res.status(400).json({ ok:false, error: "player_id required" });

    const mission = await get(`SELECT * FROM missions WHERE id = ? AND active = 1`, [id]);
    if (!mission) return res.status(404).json({ ok:false, error: "mission not found" });

    const already = await get(`SELECT * FROM mission_claims WHERE mission_id = ? AND player_id = ?`, [id, player_id]);
    if (already) return res.status(409).json({ ok:false, error: "already claimed" });

    await run(`INSERT INTO mission_claims (mission_id, player_id, claimed_at) VALUES (?, ?, ?)`, [id, player_id, Date.now()]);

    // aquí se podría otorgar la recompensa (ej: incrementar xp, items, etc) — dejamos hook simple
    io.to(player_id).emit("missionClaimed", { missionId: id, reward: JSON.parse(mission.reward_json) });

    res.json({ ok:true, mission: { id, reward: JSON.parse(mission.reward_json) } });
  } catch (e) { console.error(e); res.status(500).json({ ok:false, error: e.message }); }
});

// Reset automático de misiones (simple: elimina claims más viejos que reset_every)
setInterval(async () => {
  try {
    const missions = await all(`SELECT id, reset_every FROM missions WHERE active = 1`);
    const now = Date.now();
    for (const m of missions) {
      const cutoff = now - (m.reset_every * 1000);
      await run(`DELETE FROM mission_claims WHERE mission_id = ? AND claimed_at < ?`, [m.id, cutoff]);
    }
    // opcional: recrear misiones diarias o rotarlas aquí
  } catch (e) { console.error("mission reset error:", e); }
}, 60 * 1000); // cada minuto verifica

// ============== API UTILITARIAS ================

// Estado / status
app.get("/status", async (req, res) => {
  try {
    const playersCount = Object.keys(players).length;
    res.json({
      ok: true,
      players: playersCount,
      mapElements: {
        trees: mapState.trees.length,
        bushes: mapState.bushes.length,
        stones: mapState.stones.length,
        animals: mapState.animals.length,
        wheels: mapState.wheels.length,
        forts: mapState.forts.length,
        loot: mapState.loot.length
      },
      uptime: process.uptime()
    });
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
});

// Guardar manual del mapState
app.post("/admin/save-map", async (req, res) => {
  try {
    await run(`UPDATE map_state SET json = ? WHERE key = ?`, [JSON.stringify(mapState), 'global']);
    res.json({ ok:true });
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
});

// Endpoint para crear loot manualmente
app.post("/admin/spawn-loot", async (req, res) => {
  try {
    const { id, x, y, type } = req.body;
    const loot = { id: id || `loot_${Date.now()}`, x: x || rand(50,900), y: y || rand(50,900), type: type || 'wood' };
    mapState.loot.push(loot);
    await persistMapState();
    io.emit("state", { map: mapState });
    res.json({ ok:true, loot });
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
});

// ============== SISTEMAS PERIODICOS ============

// Generar loot automático cada 15s (persistido)
setInterval(async () => {
  try {
    const loot = { id:`loot_${Date.now()}`, x: rand(50,900), y: rand(50,900), type: ['wood','stone','meat'][Math.floor(Math.random()*3)] };
    mapState.loot.push(loot);
    await persistMapState();
    io.emit("mapLoot", { loot });
  } catch (e) { console.error("auto loot error:", e); }
}, 15000);

// Evento global de clima / tormenta cada 60s (ejemplo)
setInterval(() => {
  const intensity = Math.floor(rand(1,5));
  io.emit("storm", { intensity, ts: Date.now() });
}, 60000);

// ============== START SERVER ===================
server.listen(port, () => {
  console.log(`🚀 WARFORT backend con persistencia corriendo en puerto ${port}`);
});
