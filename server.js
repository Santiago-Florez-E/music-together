const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Crear servidor HTTP (Vercel maneja HTTPS automáticamente)
const server = http.createServer(app);

// Configurar Socket.io
const io = socketIo(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' 
      ? ["https://*.vercel.app", "https://*.vercel.com"]
      : "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ["https://*.vercel.app", "https://*.vercel.com"]
    : "*",
  credentials: true
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// Ruta principal para servir el frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Solo iniciar servidor en desarrollo local
if (process.env.NODE_ENV !== 'production') {
  server.listen(PORT, () => {
    console.log(`🎵 Servidor ejecutándose en http://localhost:${PORT}`);
  });
}

// Exportar para Vercel
module.exports = app;