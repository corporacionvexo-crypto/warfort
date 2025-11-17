// server.js
// Uso: node server.js [PUERTO]
// ejemplo: node server.js 3000
const express = require('express');
const http = require('http');
const path = require('path');
const app = express();
const port = parseInt(process.argv[2]) || 3000;
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server);

// Serve static (index.html in same folder)
app.use('/', express.static(path.join(__dirname, '.')));

// simple in-memory world snapshot (shared across players on this server)
let mapState = null;
function generateStartingMap(){
  // For simplicity we keep a minimal structure matching client expectations.
  return { trees:[], bushes:[], stones:[], animals:[], wheels:[], forts:[] };
}
mapState = generateStartingMap();

const players = {}; // players by socket id

io.on('connection', (socket)=>{
  console.log('conn', socket.id);
  // send init (map snapshot + other players)
  socket.emit('init', { map: mapState, players });

  socket.on('join', data=>{
    players[socket.id] = { id: socket.id, name: data.name, x: data.x, y: data.y };
    io.emit('state', { players: { [socket.id]: players[socket.id] } });
  });

  socket.on('update', data => {
    players[socket.id] = { ...players[socket.id], ...data };
    // broadcast to others (throttle on client)
    socket.broadcast.emit('state', { players: { [socket.id]: players[socket.id] } });
  });

  socket.on('harvest', d => {
    // could update mapState to mark resource harvested; simplified: broadcast
    socket.broadcast.emit('state', { map: mapState });
  });

  socket.on('placeWheel', w => {
    mapState.wheels = mapState.wheels || [];
    mapState.wheels.push(w);
    io.emit('state', { map: mapState });
  });

  socket.on('killAnimal', d => {
    mapState.animals = (mapState.animals||[]).filter(a=>a.id!==d.id);
    io.emit('state', { map: mapState });
  });

  socket.on('craft', ()=>{ /* optionally log */ });

  socket.on('buyHelmet', ()=>{ /* optionally log */ });

  socket.on('joinFort', d=>{
    // could modify player record
    if(players[socket.id]) players[socket.id].fort = d.fort;
    io.emit('state', { players: { [socket.id]: players[socket.id] } });
  });

  socket.on('disconnect', ()=>{
    delete players[socket.id];
    io.emit('state', { players: { [socket.id]: null } });
  });
});

server.listen(port, ()=> console.log('Servidor escuchando en', port));
