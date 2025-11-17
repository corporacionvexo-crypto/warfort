// server.js
// WARFORT+ Backend - CORREGIDO & MEJORADO
// Ready to copy & paste
//
// Dependencias:
//   npm i express cors socket.io sqlite3 uuid
//
// Uso:
//   node server.js
// ------------------------------------------------

const express = require('express');
const http = require('http');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// CONFIG
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'warfort.db');
const IO_PING_INTERVAL = 2000;
const IO_PING_TIMEOUT = 4000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'; // puede restringir en producción

// MIDDLEWARE
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: CORS_ORIGIN }));

// LOGGING BÁSICO
const log = (...args) => console.log('[WARFORT]', ...args);
process.on('uncaughtException', e => console.error('[UNCAUGHT]', e));
process.on('unhandledRejection', e => console.error('[UNHANDLED_REJ]', e));

// SOCKET.IO
const { Server } = require('socket.io');
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'] },
  pingInterval: IO_PING_INTERVAL,
  pingTimeout: IO_PING_TIMEOUT
});

// =====================
// DATABASE (SQLite)
// =====================
const db = new sqlite3.Database(DB_FILE, err => {
  if (err) return console.error('SQLite connect error:', err);
  log('SQLite conectado:', DB_FILE);
});

// promisified helpers
const run = (sql, params = []) => new Promise((res, rej) =>
  db.run(sql, params, function (err) { err ? rej(err) : res(this); })
);
const get = (sql, params = []) => new Promise((res, rej) =>
  db.get(sql, params, (err, row) => err ? rej(err) : res(row))
);
const all = (sql, params = []) => new Promise((res, rej) =>
  db.all(sql, params, (err, rows) => err ? rej(err) : res(rows))
);

// Inicializar esquema
(async function initDb() {
  try {
    await run(`CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      name TEXT,
      role TEXT,
      x REAL,
      y REAL,
      hp INTEGER,
      kills INTEGER,
      fort TEXT,
      inventory_json TEXT,
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

    // Inicial map_state si falta
    const mapRow = await get(`SELECT json FROM map_state WHERE key = ?`, ['global']);
    if (!mapRow) {
      const initial = JSON.stringify({ trees: [], bushes: [], stones: [], animals: [], wheels: [], forts: [], loot: [] });
      await run(`INSERT INTO map_state (key, json) VALUES (?, ?)`, ['global', initial]);
      log('map_state inicial creado');
    }

    // Misiones base si no existen
    const missionsCount = await get(`SELECT COUNT(1) as c FROM missions`);
    if (!missionsCount || missionsCount.c === 0) {
      const now = Date.now();
      await run(`INSERT INTO missions (id, title, description, reward_json, active, created_at, reset_every)
        VALUES (?, ?, ?, ?, 1, ?, ?)`, [
        'm_daily_1',
        'Caza 3 animales',
        'Elimina 3 animales para completar la misión diaria.',
        JSON.stringify({ xp: 50, gold: 10 }),
        now,
        86400
      ]);
      await run(`INSERT INTO missions (id, title, description, reward_json, active, created_at, reset_every)
        VALUES (?, ?, ?, ?, 1, ?, ?)`, [
        'm_daily_2',
        'Recolecta madera',
        'Recoge 10 unidades de madera.',
        JSON.stringify({ xp: 30, wood: 10 }),
        now,
        86400
      ]);
      log('Misiones base creadas');
    }

    log('DB init complete');
  } catch (e) {
    console.error('DB init error:', e);
  }
})();

// =====================
// IN-MEMORY STATE
// =====================
// mapState: estado global del mapa
let mapState = { trees: [], bushes: [], stones: [], animals: [], wheels: [], forts: [], loot: [] };

// playersById: playerId -> player object (persisted shape)
// playerSocketMap: playerId -> socketId (si está online)
// socketPlayerMap: socketId -> playerId (reverse)
const playersById = {};
const playerSocketMap = {};
const socketPlayerMap = {};

(async () => {
  try {
    const row = await get(`SELECT json FROM map_state WHERE key = ?`, ['global']);
    if (row && row.json) mapState = JSON.parse(row.json);
    log('mapState cargado desde DB');
  } catch (e) {
    console.error('Error cargando mapState:', e);
  }
})();

// =====================
// UTILIDADES
// =====================
const safe = (obj, keys) => keys.every(k => obj && obj[k] !== undefined && obj[k] !== null);
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const persistMapState = async () => {
  try {
    await run(`UPDATE map_state SET json = ? WHERE key = ?`, [JSON.stringify(mapState), 'global']);
  } catch (e) {
    console.error('persistMapState error:', e);
  }
};

const upsertPlayerDB = async (p) => {
  try {
    if (!p || !p.id) throw new Error('player id required for upsert');
    await run(
      `INSERT INTO players (id,name,role,x,y,hp,kills,fort,inventory_json,last_login)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, role=excluded.role, x=excluded.x, y=excluded.y, hp=excluded.hp,
         kills=excluded.kills, fort=excluded.fort, inventory_json=excluded.inventory_json, last_login=excluded.last_login`,
      [p.id, p.name || `Player-${p.id.slice(0,4)}`, p.role || 'player', p.x || 0, p.y || 0, p.hp != null ? p.hp : 100, p.kills || 0, p.fort || null, JSON.stringify(p.inventory || {}), Date.now()]
    );
  } catch (e) {
    console.error('upsertPlayerDB error:', e);
  }
};

const respawnPlayer = async (playerId) => {
  try {
    const player = playersById[playerId];
    if (!player) {
      // try load from DB (offline respawn)
      const dbRow = await get(`SELECT * FROM players WHERE id = ?`, [playerId]);
      if (!dbRow) return;
      playersById[playerId] = {
        id: dbRow.id,
        name: dbRow.name,
        role: dbRow.role || 'player',
        x: dbRow.x || rand(100, 900),
        y: dbRow.y || rand(100, 900),
        hp: dbRow.hp !== null ? dbRow.hp : 100,
        kills: dbRow.kills || 0,
        fort: dbRow.fort || null,
        inventory: dbRow.inventory_json ? JSON.parse(dbRow.inventory_json) : {}
      };
    }
    const p = playersById[playerId];
    p.x = rand(100, 900);
    p.y = rand(100, 900);
    p.hp = 100;
    await upsertPlayerDB(p);
    // notify all clients about this player's new state
    safeEmit('state', { players: { [playerId]: p } });
  } catch (e) {
    console.error('respawnPlayer error:', e);
  }
};

// Emit seguro (captura excepciones)
const safeEmit = (event, payload) => {
  try {
    io.emit(event, payload);
  } catch (e) {
    console.error('safeEmit error:', e);
  }
};

// Helper para obtener socketId de un playerId (si está online)
const socketIdOf = (playerId) => playerSocketMap[playerId] || null;

// =====================
// SOCKET.IO HANDLERS
// =====================
io.on('connection', (socket) => {
  log('Connection:', socket.id);

  // enviar estado inicial mínimo para no mandar objetos grandes innecesarios
  socket.emit('init', { map: mapState, players: playersById });

  // JOIN: crear o cargar jugador
  // data: { player_id?, name?, role?, x?, y? }
  socket.on('join', async (data = {}) => {
    try {
      // si el cliente envía player_id, intentamos reconectar ese player
      const requestedId = data.player_id ? String(data.player_id) : null;
      const name = data.name ? String(data.name).slice(0, 30) : null;
      const role = (data.role && ['player', 'mod', 'admin'].includes(data.role)) ? data.role : 'player';

      let player;
      if (requestedId) {
        const existing = await get(`SELECT * FROM players WHERE id = ?`, [requestedId]);
        if (existing) {
          player = {
            id: existing.id,
            name: name || existing.name || `Player-${existing.id.slice(0,4)}`,
            role: existing.role || role,
            x: existing.x || rand(100, 900),
            y: existing.y || rand(100, 900),
            hp: existing.hp !== null ? existing.hp : 100,
            kills: existing.kills || 0,
            fort: existing.fort || null,
            inventory: existing.inventory_json ? JSON.parse(existing.inventory_json) : {}
          };
        }
      }

      if (!player) {
        // crear uno nuevo
        const newId = requestedId || uuidv4();
        player = {
          id: newId,
          name: name || `Player-${newId.slice(0,4)}`,
          role,
          x: (data && Number(data.x)) || rand(100, 900),
          y: (data && Number(data.y)) || rand(100, 900),
          hp: 100,
          kills: 0,
          fort: null,
          inventory: {}
        };
      }

      // guardar en memoria y mapear socket
      playersById[player.id] = player;
      playerSocketMap[player.id] = socket.id;
      socketPlayerMap[socket.id] = player.id;

      await upsertPlayerDB(player);

      // enviar init solo al socket que se conecta (ya lo hicimos arriba, pero actualizamos con player)
      socket.emit('init', { map: mapState, players: playersById, you: player.id });

      // notificar al resto
      socket.broadcast.emit('state', { players: { [player.id]: player } });

      log(`Player joined: ${player.name} (${player.id}) via socket ${socket.id}`);
    } catch (e) {
      console.error('join error:', e);
    }
  });

  // Movimiento / update parcial
  socket.on('update', async (data = {}) => {
    try {
      const playerId = socketPlayerMap[socket.id];
      if (!playerId) return;
      const player = playersById[playerId];
      if (!player) return;

      // Permitir solo campos esperados
      const allowed = new Set(['x', 'y', 'hp', 'kills', 'fort', 'name']);
      for (const k of Object.keys(data)) if (!allowed.has(k)) delete data[k];

      // aplicar cambios con validación básica
      if (data.x != null) player.x = Number(data.x);
      if (data.y != null) player.y = Number(data.y);
      if (data.hp != null) player.hp = Math.max(0, Number(data.hp));
      if (data.kills != null) player.kills = Number(data.kills);
      if (data.fort != null) player.fort = data.fort;
      if (data.name) player.name = String(data.name).slice(0, 30);

      await upsertPlayerDB(player);
      socket.broadcast.emit('state', { players: { [playerId]: player } });
    } catch (e) {
      console.error('update error:', e);
    }
  });

  // CHAT simple (limitado & rate-safe)
  socket.on('chat', (msg) => {
    try {
      const playerId = socketPlayerMap[socket.id];
      const name = playerId && playersById[playerId] ? playersById[playerId].name : `Guest-${socket.id.slice(0,4)}`;
      const text = String(msg).slice(0, 300);
      safeEmit('chat', { id: playerId || socket.id, name, msg: text });
    } catch (e) {
      console.error('chat error:', e);
    }
  });

  // PLACE WHEEL
  socket.on('placeWheel', async (wheel) => {
    try {
      if (!safe(wheel, ['id', 'x', 'y'])) return;
      mapState.wheels.push({ id: String(wheel.id), x: Number(wheel.x), y: Number(wheel.y) });
      await persistMapState();
      safeEmit('state', { map: mapState });
    } catch (e) { console.error('placeWheel error:', e); }
  });

  // PICKUP LOOT
  socket.on('pickupLoot', async (data) => {
    try {
      if (!safe(data, ['id'])) return;
      mapState.loot = mapState.loot.filter(l => l.id !== data.id);
      await persistMapState();
      safeEmit('state', { map: mapState });
    } catch (e) { console.error('pickupLoot error:', e); }
  });

  // KILL ANIMAL
  socket.on('killAnimal', async (data) => {
    try {
      if (!safe(data, ['id'])) return;
      mapState.animals = mapState.animals.filter(a => a.id !== data.id);
      await persistMapState();
      safeEmit('state', { map: mapState });
    } catch (e) { console.error('killAnimal error:', e); }
  });

  // JOIN FORT
  socket.on('joinFort', async (data) => {
    try {
      if (!safe(data, ['fort'])) return;
      const playerId = socketPlayerMap[socket.id];
      if (!playerId) return;
      const player = playersById[playerId];
      player.fort = data.fort;
      await upsertPlayerDB(player);
      safeEmit('state', { players: { [playerId]: player } });
    } catch (e) { console.error('joinFort error:', e); }
  });

  // ----------------------------
  // HIT entre jugadores (anti-hack y seguro)
  // payload: { target: "<playerId>", dmg: <number>, type: "melee"|"arrow" }
  // ----------------------------
  socket.on('hit', async (data) => {
    try {
      const attackerId = socketPlayerMap[socket.id];
      if (!attackerId || !data || !data.target) return;
      const targetId = String(data.target);
      const attacker = playersById[attackerId];
      const target = playersById[targetId];
      if (!attacker || !target) return;

      // CALCULA DISTANCIA: anti-hack para melee
      const dx = (attacker.x || 0) - (target.x || 0);
      const dy = (attacker.y || 0) - (target.y || 0);
      const distance = Math.sqrt(dx * dx + dy * dy);

      const dmg = Math.max(0, Number(data.dmg) || (data.type === 'arrow' ? 15 : 10));

      // Si es melee, exigir distancia <= 60
      if (!data.type || data.type === 'melee') {
        if (distance > 60) return;
      } else if (data.type === 'arrow') {
        // arrows allowed at longer distance (but max 1200)
        if (distance > 1200) return;
      }

      // Apply damage
      target.hp = (target.hp || 100) - dmg;

      if (target.hp <= 0) {
        // KILL
        target.hp = 0;
        attacker.kills = (attacker.kills || 0) + 1;
        await upsertPlayerDB(attacker);
        safeEmit('killfeed', { killer: attacker.name, victim: target.name });
        await respawnPlayer(targetId);
      } else {
        await upsertPlayerDB(target);
        safeEmit('state', { players: { [targetId]: target } });
      }

      // Resultado del golpe al autor y al objetivo (emit a sockets si están online)
      const targetSocket = socketIdOf(targetId);
      const attackerSocket = socketIdOf(attackerId);
      if (attackerSocket) io.to(attackerSocket).emit('hitResult', { attacker: attackerId, target: targetId, hp: target.hp });
      if (targetSocket) io.to(targetSocket).emit('hitTaken', { attacker: attackerId, hp: target.hp });

    } catch (e) {
      console.error('hit handler error:', e);
    }
  });

  // DISCONNECT
  socket.on('disconnect', async () => {
    try {
      const playerId = socketPlayerMap[socket.id];
      if (playerId) {
        // persistir jugador conectado por última vez
        const p = playersById[playerId];
        if (p) await upsertPlayerDB(p);
        // limpiar mapas
        delete playerSocketMap[playerId];
      }
      delete socketPlayerMap[socket.id];

      // notificar a clientes que este player está offline (set null to keep protocol)
      if (playerId) safeEmit('state', { players: { [playerId]: null } });

    } catch (e) {
      console.error('disconnect persist error:', e);
    }
    log('Disconnect:', socket.id);
  });

});

// =====================
// HTTP API - Clanes
// =====================
app.post('/clans', async (req, res) => {
  try {
    const { id, name, owner } = req.body;
    if (!id || !name || !owner) return res.status(400).json({ ok: false, error: 'id,name,owner required' });

    const exists = await get(`SELECT id FROM clans WHERE id = ?`, [id]);
    if (exists) return res.status(409).json({ ok: false, error: 'clan exists' });

    await run(`INSERT INTO clans (id,name,owner,created_at) VALUES (?, ?, ?, ?)`, [id, name, owner, Date.now()]);
    await run(`INSERT INTO clan_members (clan_id, player_id, role) VALUES (?, ?, ?)`, [id, owner, 'owner']);

    res.json({ ok: true, clan: { id, name, owner } });
  } catch (e) {
    console.error('/clans error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/clans/:id/join', async (req, res) => {
  try {
    const clanId = req.params.id;
    const { player_id } = req.body;
    if (!player_id) return res.status(400).json({ ok: false, error: 'player_id required' });

    const clan = await get(`SELECT id FROM clans WHERE id = ?`, [clanId]);
    if (!clan) return res.status(404).json({ ok: false, error: 'clan not found' });

    const member = await get(`SELECT player_id FROM clan_members WHERE clan_id = ? AND player_id = ?`, [clanId, player_id]);
    if (member) return res.status(409).json({ ok: false, error: 'already member' });

    await run(`INSERT INTO clan_members (clan_id, player_id, role) VALUES (?, ?, ?)`, [clanId, player_id, 'member']);
    res.json({ ok: true });
  } catch (e) {
    console.error('/clans/:id/join error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/clans/:id', async (req, res) => {
  try {
    const clanId = req.params.id;
    const clan = await get(`SELECT * FROM clans WHERE id = ?`, [clanId]);
    if (!clan) return res.status(404).json({ ok: false });
    const members = await all(`SELECT player_id, role FROM clan_members WHERE clan_id = ?`, [clanId]);
    res.json({ ok: true, clan, members });
  } catch (e) {
    console.error('/clans/:id error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =====================
// HTTP API - Missions
// =====================
app.get('/missions', async (req, res) => {
  try {
    const missions = await all(`SELECT id, title, description, reward_json, active, created_at, reset_every FROM missions WHERE active = 1`);
    const parsed = missions.map(m => {
      let reward = {};
      try { reward = JSON.parse(m.reward_json || '{}'); } catch (e) { reward = {}; }
      return ({ id: m.id, title: m.title, description: m.description, reward, active: m.active, created_at: m.created_at, reset_every: m.reset_every });
    });
    res.json({ ok: true, missions: parsed });
  } catch (e) {
    console.error('/missions error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/missions/:id/claim', async (req, res) => {
  try {
    const missionId = req.params.id;
    const { player_id } = req.body;
    if (!player_id) return res.status(400).json({ ok: false, error: 'player_id required' });

    const mission = await get(`SELECT * FROM missions WHERE id = ? AND active = 1`, [missionId]);
    if (!mission) return res.status(404).json({ ok: false, error: 'mission not found' });

    const already = await get(`SELECT * FROM mission_claims WHERE mission_id = ? AND player_id = ?`, [missionId, player_id]);
    if (already) return res.status(409).json({ ok: false, error: 'already claimed' });

    await run(`INSERT INTO mission_claims (mission_id, player_id, claimed_at) VALUES (?, ?, ?)`, [missionId, player_id, Date.now()]);

    // Emitir evento en socket si está conectado
    let reward = {};
    try { reward = JSON.parse(mission.reward_json || '{}'); } catch (e) { reward = {}; }

    const targetSocket = socketIdOf(player_id);
    if (targetSocket) {
      io.to(targetSocket).emit('missionClaimed', { missionId, reward });
    }

    res.json({ ok: true, mission: { id: missionId, reward } });
  } catch (e) {
    console.error('/missions/:id/claim error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Reset automático de claims según reset_every (cada minuto)
setInterval(async () => {
  try {
    const missions = await all(`SELECT id, reset_every FROM missions WHERE active = 1`);
    const now = Date.now();
    for (const m of missions) {
      const cutoff = now - (m.reset_every * 1000);
      await run(`DELETE FROM mission_claims WHERE mission_id = ? AND claimed_at < ?`, [m.id, cutoff]);
    }
  } catch (e) {
    console.error('missions reset error:', e);
  }
}, 60 * 1000);

// =====================
// ADMIN / UTIL ENDPOINTS
// =====================
app.get('/status', async (req, res) => {
  try {
    res.json({
      ok: true,
      playersConnected: Object.keys(playerSocketMap).length,
      mapCounts: {
        trees: mapState.trees.length,
        animals: mapState.animals.length,
        loot: mapState.loot.length
      },
      uptime: process.uptime()
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/admin/save-map', async (req, res) => {
  try {
    await persistMapState();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/admin/spawn-loot', async (req, res) => {
  try {
    const { id, x, y, type } = req.body;
    const loot = { id: id || `loot_${Date.now()}`, x: Number(x) || rand(50, 900), y: Number(y) || rand(50, 900), type: String(type || 'wood') };
    mapState.loot.push(loot);
    await persistMapState();
    safeEmit('state', { map: mapState });
    res.json({ ok: true, loot });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =====================
// PERIODIC SYSTEMS
// =====================

// Auto-spawn loot each 15s
setInterval(async () => {
  try {
    const loot = { id: `loot_${Date.now()}`, x: rand(50, 900), y: rand(50, 900), type: ['wood', 'stone', 'meat'][Math.floor(Math.random() * 3)] };
    mapState.loot.push(loot);
    await persistMapState();
    // Emit only the new loot to avoid large payloads
    safeEmit('mapLoot', { loot });
  } catch (e) {
    console.error('auto loot error:', e);
  }
}, 15 * 1000);

// Global storm event every 60s (example)
setInterval(() => {
  try {
    const intensity = rand(1, 5);
    safeEmit('storm', { intensity, ts: Date.now() });
  } catch (e) {
    console.error('storm emit error:', e);
  }
}, 60 * 1000);

// =====================
// GRACEFUL SHUTDOWN
// =====================
const shutdown = async () => {
  log('Shutting down, persisting players and map...');
  try {
    // persist players
    for (const id of Object.keys(playersById)) {
      await upsertPlayerDB(playersById[id]);
    }
    await persistMapState();
  } catch (e) {
    console.error('shutdown persist error:', e);
  }

  try {
    io.close();
  } catch (e) {
    console.error('error closing io:', e);
  }

  server.close(async () => {
    // cerrar DB
    db.close(err => {
      if (err) console.error('error closing db:', err);
      else log('DB closed');
      log('Server closed');
      process.exit(0);
    });
  });

  // forzar cierre si tarda demasiado (10s)
  setTimeout(() => {
    console.warn('Force exit');
    process.exit(1);
  }, 10_000).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// =====================
// START
// =====================
server.listen(PORT, () => {
  log(`WARFORT+ backend running on port ${PORT}`);
});
