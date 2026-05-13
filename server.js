const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const YouTube = require('youtube-sr').default;

const app = express();
const PORT = process.env.PORT || 3000;

// Crear servidor HTTP (Vercel maneja HTTPS automáticamente)
const server = http.createServer(app);

// Configurar Socket.io
const io = socketIo(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' 
      ? ["https://*.railway.app", "https://*.up.railway.app"]
      : "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ["https://*.railway.app", "https://*.up.railway.app"]
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

// Función para obtener información real del video
async function getVideoInfo(videoId) {
  try {
    const video = await YouTube.getVideo(`https://www.youtube.com/watch?v=${videoId}`);
    return {
      id: videoId,
      title: video.title || `Video ${videoId}`,
      thumbnail: video.thumbnail.url || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
      addedAt: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error fetching video info:', error);
    return {
      id: videoId,
      title: `Video ${videoId}`,
      thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
      addedAt: new Date().toISOString()
    };
  }
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

app.get('/api/suggestions', async (req, res) => {
  try {
    const count = parseInt(req.query.count) || 6;
    let results = [];

    if (currentSong && !currentSong.id.startsWith('auto-')) {
      // Si hay una canción sonando, buscar relacionadas
      results = await YouTube.getSuggestions(currentSong.title); 
      // Nota: getSuggestions es para autocompletado de texto. 
      // Para videos relacionados reales usaremos search con el título.
      const searchResults = await YouTube.search(currentSong.title, { limit: count + 2, type: 'video' });
      results = searchResults
        .filter(v => v.id !== currentSong.id)
        .slice(0, count)
        .map(v => ({
          id: v.id,
          title: v.title,
          channel: v.channel?.name || 'YouTube',
          thumbnail: v.thumbnail?.url
        }));
    } else {
      // Si no hay nada, buscar tendencias de música
      const searchResults = await YouTube.search('tendencias musica 2024', { limit: count, type: 'video' });
      results = searchResults.map(v => ({
        id: v.id,
        title: v.title,
        channel: v.channel?.name || 'YouTube',
        thumbnail: v.thumbnail?.url
      }));
    }
    res.json(results);
  } catch (error) {
    console.error('Error fetching suggestions:', error);
    res.json([]); // Fallback a lista vacía o podrías usar el pool anterior
  }
});

app.post('/api/add-song', async (req, res) => {
  const { url, userName } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL es requerida' });
  }
  
  const videoId = extractYouTubeId(url);
  if (!videoId) {
    return res.status(400).json({ error: 'URL de YouTube inválida' });
  }
  
  const videoInfo = await getVideoInfo(videoId);
  const song = {
    ...videoInfo,
    id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, // ID único
    userName: userName || 'Anónimo',
    addedAt: new Date().toISOString()
  };
  
  playlist.push(song);
  
  // Si no hay canción actual, empezar a reproducir
  if (!currentSong || currentSong.id.startsWith('auto-')) {
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

app.post('/api/remove-song', (req, res) => {
  const { id } = req.body;
  const index = playlist.findIndex(s => s.id === id);
  
  if (index !== -1) {
    playlist.splice(index, 1);
    
    // Notificar a todos
    io.emit('playlist-updated', {
      playlist,
      currentSong,
      isPlaying,
      currentTime: isPlaying ? currentTime + (Date.now() - playStartTime) / 1000 : currentTime
    });
    
    return res.json({ success: true });
  }
  
  res.status(404).json({ error: 'Canción no encontrada' });
});

async function playNextSong() {
  if (playlist.length === 0) {
    try {
      // Buscar algo relacionado a la última canción para el autoplay
      const searchTerm = currentSong ? currentSong.title : 'musica popular mix';
      const searchResults = await YouTube.search(searchTerm, { limit: 5, type: 'video' });
      const nextAuto = searchResults[Math.floor(Math.random() * searchResults.length)];

      currentSong = {
        id: nextAuto.id,
        title: nextAuto.title,
        thumbnail: nextAuto.thumbnail.url,
        userName: 'Autoplay',
        addedAt: new Date().toISOString()
      };
    } catch (error) {
      currentSong = null; // Fallback
    }
    isPlaying = !!currentSong;
    currentTime = 0;
    playStartTime = Date.now();
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

// Iniciar servidor (Railway necesita esto en producción)
server.listen(PORT, () => {
  console.log(`🎵 Servidor ejecutándose en puerto ${PORT}`);
  // Iniciar con una sugerencia aleatoria si no hay nada
  if (!currentSong) {
    playNextSong();
  }
});

// Exportar para compatibilidad con Vercel (opcional)
module.exports = app;