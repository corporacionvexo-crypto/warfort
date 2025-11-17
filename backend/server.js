// ===============================
//  WARFORT Backend (Railway)
// ===============================
const express = require('express');
const http = require('http');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

// Seguridad básica
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --------- CORS CORRECTO PARA VERCEL ---------
const cors = require("cors");
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
  credentials: false
}));

// ------------------------------------------------------------
const server = http.createServer(app);
const { Server } = require('socket.io');

// SOCKET.IO configurado para producción
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ===============================
//  ESTADO GLOBAL DEL MAPA
// ===============================
let mapState = {
  trees: [],
  bushes: [],
  stones: [],
  animals: [],
  wheels: [],
  forts: []
};

// ===============================
//  JUGADORES
// ===============================
const players = {};

io.on("connection", (socket) => {
  console.log("Jugador conectado:", socket.id);

  // Enviar estado inicial
  socket.emit("init", { map: mapState, players });

  // Jugador entra
  socket.on("join", data => {
    players[socket.id] = {
      id: socket.id,
      name: data.name,
      x: data.x,
      y: data.y,
      fort: null
    };
    io.emit("state", { players: { [socket.id]: players[socket.id] } });
  });

  // Movimiento
  socket.on("update", data => {
    if (!players[socket.id]) return;
    players[socket.id] = { ...players[socket.id], ...data };
    socket.broadcast.emit("state", { players: { [socket.id]: players[socket.id] } });
  });

  // Colocar rueda
  socket.on("placeWheel", wheel => {
    mapState.wheels.push(wheel);
    io.emit("state", { map: mapState });
  });

  // Animal eliminado
  socket.on("killAnimal", data => {
    mapState.animals = mapState.animals.filter(a => a.id !== data.id);
    io.emit("state", { map: mapState });
  });

  // Unirse a fortaleza
  socket.on("joinFort", data => {
    if (players[socket.id]) players[socket.id].fort = data.fort;
    io.emit("state", { players: { [socket.id]: players[socket.id] } });
  });

  // Desconexión
  socket.on("disconnect", () => {
    delete players[socket.id];
    io.emit("state", { players: { [socket.id]: null } });
  });
});

// ===============================
//  RUTAS NECESARIAS PARA RAILWAY
// ===============================

// Ruta principal (evita "Cannot GET /")
app.get("/", (req, res) => {
  res.send("🔥 WARFORT Backend activo y funcionando correctamente");
});

// Ruta para comprobar estado
app.get("/status", (req, res) => {
  res.json({
    ok: true,
    players: Object.keys(players).length,
    mapElements: {
      trees: mapState.trees.length,
      bushes: mapState.bushes.length,
      stones: mapState.stones.length,
      animals: mapState.animals.length,
      wheels: mapState.wheels.length,
      forts: mapState.forts.length
    }
  });
});

// ===============================
//  INICIAR SERVIDOR
// ===============================
server.listen(port, () => {
  console.log("🚀 WARFORT backend corriendo en Railway | Puerto:", port);
});
