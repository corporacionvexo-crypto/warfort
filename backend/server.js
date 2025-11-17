// server.js — Backend para WARFORT en Railway
const express = require('express');
const http = require('http');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

const server = http.createServer(app);
const { Server } = require('socket.io');

// WebSockets + CORS para Vercel
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// --- MAPA BASE ---
let mapState = {
  trees: [],
  bushes: [],
  stones: [],
  animals: [],
  wheels: [],
  forts: []
};

// --- JUGADORES ---
const players = {};

io.on("connection", (socket) => {
  console.log("Jugador conectado:", socket.id);

  // Enviar estado inicial
  socket.emit("init", { map: mapState, players });

  // Cuando un jugador entra
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

  // Actualización de movimiento
  socket.on("update", data => {
    if (!players[socket.id]) return;
    players[socket.id] = { ...players[socket.id], ...data };
    socket.broadcast.emit("state", { players: { [socket.id]: players[socket.id] } });
  });

  // Rueda giratoria
  socket.on("placeWheel", wheel => {
    mapState.wheels.push(wheel);
    io.emit("state", { map: mapState });
  });

  // Eliminar animal al matarlo
  socket.on("killAnimal", data => {
    mapState.animals = mapState.animals.filter(a => a.id !== data.id);
    io.emit("state", { map: mapState });
  });

  // Unirse a una fortaleza
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

server.listen(port, () => {
  console.log("🚀 WARFORT backend corriendo en Railway | Puerto:", port);
});
