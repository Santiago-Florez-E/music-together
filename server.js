const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();

// Configuración HTTPS
const httpsOptions = {
  key: fs.readFileSync(path.join(__dirname, 'certs', 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'certs', 'cert.pem'))
};

const httpsServer = https.createServer(httpsOptions, app);
const httpServer = http.createServer(app);

const io = socketIo(httpsServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Redirección HTTP a HTTPS
httpServer.on('request', (req, res) => {
  const host = req.headers.host;
  const httpsUrl = `https://${host.replace(':3000', ':3443')}${req.url}`;
  res.writeHead(301, { Location: httpsUrl });
  res.end();
});

// Estado global de la aplicación
let playlist = [];
let currentSong = null;
let isPlaying = false;
let currentTime = 0;
let playStartTime = null;

// Función para extraer ID de video de YouTube
function extractYouTubeId(url) {
  const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

// Función para obtener información del video (simulada)
function getVideoInfo(videoId) {
  return {
    id: videoId,
    title: `Video ${videoId}`,
    thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
    addedAt: new Date().toISOString()
  };
}

// Rutas API
app.get('/api/playlist', (req, res) => {
  res.json({
    playlist,
    currentSong,
    isPlaying,
    currentTime: isPlaying ? currentTime + (Date.now() - playStartTime) / 1000 : currentTime
  });
});

app.post('/api/add-song', (req, res) => {
  const { url, userName } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL es requerida' });
  }
  
  const videoId = extractYouTubeId(url);
  if (!videoId) {
    return res.status(400).json({ error: 'URL de YouTube inválida' });
  }
  
  const videoInfo = getVideoInfo(videoId);
  const song = {
    ...videoInfo,
    userName: userName || 'Anónimo',
    addedAt: new Date().toISOString()
  };
  
  playlist.push(song);
  
  // Si no hay canción actual, empezar a reproducir
  if (!currentSong && playlist.length === 1) {
    playNextSong();
  }
  
  // Notificar a todos los clientes
  io.emit('playlist-updated', {
    playlist,
    currentSong,
    isPlaying,
    currentTime: isPlaying ? currentTime + (Date.now() - playStartTime) / 1000 : currentTime
  });
  
  res.json({ success: true, song });
});

app.post('/api/next-song', (req, res) => {
  playNextSong();
  res.json({ success: true });
});

function playNextSong() {
  if (playlist.length === 0) {
    currentSong = null;
    isPlaying = false;
    currentTime = 0;
    playStartTime = null;
  } else {
    currentSong = playlist.shift();
    isPlaying = true;
    currentTime = 0;
    playStartTime = Date.now();
  }
  
  io.emit('song-changed', {
    currentSong,
    isPlaying,
    currentTime,
    playlist
  });
}

// Socket.io eventos
io.on('connection', (socket) => {
  console.log('Usuario conectado:', socket.id);
  
  // Enviar estado actual al nuevo usuario
  socket.emit('initial-state', {
    playlist,
    currentSong,
    isPlaying,
    currentTime: isPlaying ? currentTime + (Date.now() - playStartTime) / 1000 : currentTime
  });
  
  socket.on('song-ended', () => {
    playNextSong();
  });
  
  socket.on('disconnect', () => {
    console.log('Usuario desconectado:', socket.id);
  });
});

// Obtener IP local
function getLocalIP() {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

const HTTP_PORT = 3000;
const HTTPS_PORT = 3443;
const localIP = getLocalIP();

// Iniciar servidores
httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`🔄 Servidor HTTP (redirección) en puerto ${HTTP_PORT}`);
});

httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
  console.log(`🎵 Servidor HTTPS ejecutándose en:`);
  console.log(`   Local: https://localhost:${HTTPS_PORT}`);
  console.log(`   Red:   https://${localIP}:${HTTPS_PORT}`);
  console.log(`\n📱 Otros dispositivos pueden conectarse usando: https://${localIP}:${HTTPS_PORT}`);
  console.log(`\n⚠️  Acepta el certificado de seguridad en cada dispositivo`);
});