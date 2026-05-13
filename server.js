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

let autoplayHistory = [];
const AUTOPLAY_HISTORY_MAX = 30;

let lastSuggestionsSeed = null;
let lastSuggestions = [];
let lastSuggestionsAt = 0;

const SUGGESTIONS_TTL_MS = 20000;
const suggestionsCache = new Map();
const suggestionsInflight = new Map();

let playHistory = [];
const PLAY_HISTORY_MAX = 50;

function normalizeThumb(thumbnail, fallbackVideoId) {
  const url = thumbnail?.url || thumbnail?.toJSON?.().url;
  return url || `https://img.youtube.com/vi/${fallbackVideoId}/mqdefault.jpg`;
}

function rememberAutoplay(videoId) {
  if (!videoId) return;
  autoplayHistory = [videoId, ...autoplayHistory.filter((id) => id !== videoId)].slice(0, AUTOPLAY_HISTORY_MAX);
}

function getSongVideoId(song) {
  return song?.videoId || song?.id || null;
}

function addToPlayHistory(song) {
  const videoId = getSongVideoId(song);
  if (!videoId) return;

  const title = song?.title;
  if (!title) return;

  const entry = {
    videoId,
    title,
    channel: song?.channel || 'YouTube',
    thumbnail: song?.thumbnail || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
    userName: song?.userName || 'Anónimo',
    playedAt: new Date().toISOString()
  };

  playHistory = [entry, ...playHistory.filter((e) => e.videoId !== videoId)].slice(0, PLAY_HISTORY_MAX);
}

async function emitHistoryToSocket(socket) {
  socket.emit('history-updated', { items: playHistory });
}

async function broadcastHistory() {
  io.emit('history-updated', { items: playHistory });
}

function getBlockedVideoIds(seedVideoId) {
  const blocked = new Set(autoplayHistory);

  const currentVideoId = getSongVideoId(currentSong);
  if (currentVideoId) blocked.add(currentVideoId);

  for (const s of playlist) {
    const vid = getSongVideoId(s);
    if (vid) blocked.add(vid);
  }

  if (seedVideoId) blocked.add(seedVideoId);

  return blocked;
}

async function getYouTubeMixVideos(seedVideoId, limit) {
  if (!seedVideoId) return [];
  const mixUrl = `https://www.youtube.com/watch?v=${seedVideoId}&list=RD${seedVideoId}`;
  const mix = await YouTube.getPlaylist(mixUrl, { limit: Math.max(limit, 25) }).catch(() => null);
  const videos = mix?.videos;
  return Array.isArray(videos) ? videos : [];
}

async function getAutoplayCandidate(seedVideoId) {
  const blocked = getBlockedVideoIds(seedVideoId);

  if (seedVideoId) {
    const mixVideos = await getYouTubeMixVideos(seedVideoId, 25);
    const nextFromMix = mixVideos.find((v) => v?.id && !blocked.has(v.id));
    if (nextFromMix) return nextFromMix;
  }

  const trending = await YouTube.trending({ type: 'MUSIC' }).catch(() => []);
  if (Array.isArray(trending) && trending.length) {
    const unseen = trending.find((v) => v?.id && !blocked.has(v.id));
    return unseen || trending.find((v) => v?.id) || null;
  }

  const fallbackSearch = await YouTube.search('musica popular mix', { limit: 10, type: 'video' }).catch(() => []);
  if (Array.isArray(fallbackSearch) && fallbackSearch.length) {
    const unseen = fallbackSearch.find((v) => v?.id && !blocked.has(v.id));
    return unseen || fallbackSearch.find((v) => v?.id) || null;
  }

  return null;
}

function shuffleInPlace(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
  return items;
}

function getSuggestionsKey(seedVideoId, seedTitle) {
  if (seedVideoId) return `v:${seedVideoId}`;
  if (seedTitle) return `t:${seedTitle.toLowerCase().slice(0, 80)}`;
  return 'global';
}

function getSuggestionBlockedVideoIds(seedVideoId, includeHistory) {
  const blocked = new Set(includeHistory ? autoplayHistory : []);

  const currentVideoId = getSongVideoId(currentSong);
  if (currentVideoId) blocked.add(currentVideoId);

  for (const s of playlist) {
    const vid = getSongVideoId(s);
    if (vid) blocked.add(vid);
  }

  if (seedVideoId) blocked.add(seedVideoId);

  return blocked;
}

async function computeSuggestions(seedVideoId, seedTitle, count) {
  const strictBlocked = getSuggestionBlockedVideoIds(seedVideoId, true);
  const relaxedBlocked = getSuggestionBlockedVideoIds(seedVideoId, false);

  let candidates = [];

  if (seedVideoId) {
    const fromMix = await getYouTubeMixVideos(seedVideoId, Math.max(count * 12, 80)).catch(() => []);
    if (Array.isArray(fromMix) && fromMix.length) candidates = candidates.concat(fromMix);
  }

  if (seedTitle) {
    const fromSearch = await YouTube.search(seedTitle, { limit: Math.max(count * 8, 40), type: 'video' }).catch(() => []);
    if (Array.isArray(fromSearch) && fromSearch.length) candidates = candidates.concat(fromSearch);
  }

  const trending = await YouTube.trending({ type: 'MUSIC' }).catch(() => []);
  if (Array.isArray(trending) && trending.length) {
    candidates = candidates.concat(trending);
  }

  const collect = (blocked, out, used) => {
    for (const v of candidates) {
      if (!v?.id || !v?.title) continue;
      if (blocked.has(v.id)) continue;
      if (used.has(v.id)) continue;

      used.add(v.id);
      out.push({
        id: v.id,
        title: v.title,
        channel: v.channel?.name || 'YouTube',
        thumbnail: normalizeThumb(v.thumbnail, v.id)
      });

      if (out.length >= count) break;
    }
  };

  const results = [];
  const used = new Set();

  collect(strictBlocked, results, used);
  if (results.length < count) {
    collect(relaxedBlocked, results, used);
  }

  shuffleInPlace(results);
  return results.slice(0, count);
}

async function getSuggestions(seedVideoId, seedTitle, count, forceFresh = false) {
  const key = getSuggestionsKey(seedVideoId, seedTitle);
  const cached = suggestionsCache.get(key);

  if (!forceFresh && cached && Date.now() - cached.at < SUGGESTIONS_TTL_MS) {
    return cached.items.slice(0, count);
  }

  const inflight = suggestionsInflight.get(key);
  if (inflight) {
    const items = await inflight.catch(() => cached?.items || []);
    return (items || []).slice(0, count);
  }

  const promise = computeSuggestions(seedVideoId, seedTitle, Math.max(count, 6))
    .then((items) => {
      suggestionsCache.set(key, { items, at: Date.now() });
      suggestionsInflight.delete(key);
      return items;
    })
    .catch(() => {
      suggestionsInflight.delete(key);
      return cached?.items || [];
    });

  suggestionsInflight.set(key, promise);
  const items = await promise;
  return (items || []).slice(0, count);
}

async function emitSuggestionsToSocket(socket, count = 6) {
  const seedVideoId = getSongVideoId(currentSong);
  const seedTitle = currentSong?.title || null;
  const items = await getSuggestions(seedVideoId, seedTitle, count);

  lastSuggestionsSeed = seedVideoId;
  lastSuggestions = items;
  lastSuggestionsAt = Date.now();

  socket.emit('suggestions-updated', { seedVideoId, items });
}

async function broadcastSuggestions(count = 6, forceFresh = false) {
  const seedVideoId = getSongVideoId(currentSong);
  const seedTitle = currentSong?.title || null;
  const items = await getSuggestions(seedVideoId, seedTitle, count, forceFresh);

  lastSuggestionsSeed = seedVideoId;
  lastSuggestions = items;
  lastSuggestionsAt = Date.now();

  io.emit('suggestions-updated', { seedVideoId, items });
}

// Función para extraer ID de video de YouTube
function extractYouTubeId(url) {
  const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

function normalizeUrl(input) {
  const raw = (input || '').toString().trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function extractPlaylistId(input) {
  try {
    const u = new URL(normalizeUrl(input));
    return u.searchParams.get('list');
  } catch {
    return null;
  }
}

// Función para obtener información real del video
async function getVideoInfo(videoId) {
  try {
    const video = await YouTube.getVideo(`https://www.youtube.com/watch?v=${videoId}`);
    return {
      videoId,
      title: video.title || `Video ${videoId}`,
      thumbnail: normalizeThumb(video.thumbnail, videoId),
      addedAt: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error fetching video info:', error);
    return {
      videoId,
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
    const seedVideoId = getSongVideoId(currentSong);
    const seedTitle = currentSong?.title || null;
    const results = await getSuggestions(seedVideoId, seedTitle, count);
    res.json(results);
  } catch (error) {
    console.error('Error fetching suggestions:', error);
    res.json([]);
  }
});

app.get('/api/history', (req, res) => {
  const count = Math.min(50, Math.max(1, parseInt(req.query.count) || 50));
  res.json(playHistory.slice(0, count));
});

app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.json([]);

    const count = Math.min(25, Math.max(1, parseInt(req.query.count) || 12));
    const results = await YouTube.search(q, { limit: count, type: 'video' }).catch(() => []);

    const mapped = (Array.isArray(results) ? results : [])
      .filter((v) => v?.id && v?.title)
      .map((v) => ({
        id: v.id,
        title: v.title,
        channel: v.channel?.name || 'YouTube',
        thumbnail: normalizeThumb(v.thumbnail, v.id)
      }));

    res.json(mapped);
  } catch (error) {
    console.error('Error searching:', error);
    res.json([]);
  }
});

app.post('/api/add-song', async (req, res) => {
  const { url, userName } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL es requerida' });
  }

  const normalized = normalizeUrl(url);
  const playlistId = extractPlaylistId(normalized);

  if (playlistId) {
    const MAX_PLAYLIST_ADD = 100;

    const pl = await YouTube.getPlaylist(normalized, { fetchAll: true, limit: MAX_PLAYLIST_ADD }).catch(() => null);
    const videos = pl?.videos;

    if (!Array.isArray(videos) || videos.length === 0) {
      return res.status(400).json({ error: 'No se pudo leer la playlist' });
    }

    const now = Date.now();
    const addedAt = new Date().toISOString();
    const songs = videos
      .filter((v) => v?.id && v?.title)
      .slice(0, MAX_PLAYLIST_ADD)
      .map((v, idx) => ({
        id: `${now + idx}-${Math.random().toString(36).slice(2, 9)}`,
        videoId: v.id,
        title: v.title,
        thumbnail: normalizeThumb(v.thumbnail, v.id),
        userName: userName || 'Anónimo',
        addedAt
      }));

    if (songs.length === 0) {
      return res.status(400).json({ error: 'Playlist sin videos válidos' });
    }

    playlist.push(...songs);

    if (!currentSong) {
      await playNextSong();
    }

    io.emit('playlist-updated', {
      playlist,
      currentSong,
      isPlaying,
      currentTime: isPlaying ? currentTime + (Date.now() - playStartTime) / 1000 : currentTime
    });

    return res.json({ success: true, addedCount: songs.length, songs });
  }

  const videoId = extractYouTubeId(normalized);
  if (!videoId) {
    return res.status(400).json({ error: 'URL de YouTube inválida' });
  }

  const videoInfo = await getVideoInfo(videoId);
  const song = {
    ...videoInfo,
    id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    userName: userName || 'Anónimo',
    addedAt: new Date().toISOString()
  };

  playlist.push(song);

  if (!currentSong) {
    await playNextSong();
  }

  io.emit('playlist-updated', {
    playlist,
    currentSong,
    isPlaying,
    currentTime: isPlaying ? currentTime + (Date.now() - playStartTime) / 1000 : currentTime
  });

  res.json({ success: true, addedCount: 1, song });
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
  if (currentSong) {
    addToPlayHistory(currentSong);
    broadcastHistory().catch(() => {});
  }

  if (playlist.length === 0) {
    try {
      const seedVideoId = getSongVideoId(currentSong);

      let suggestionFirst = null;
      const cacheFresh = lastSuggestionsAt && Date.now() - lastSuggestionsAt < 60_000;
      if (cacheFresh && lastSuggestionsSeed === seedVideoId && Array.isArray(lastSuggestions) && lastSuggestions.length) {
        suggestionFirst = lastSuggestions[0];
      } else {
        const computed = await getSuggestions(seedVideoId, currentSong?.title || null, 6, true).catch(() => []);
        if (Array.isArray(computed) && computed.length) {
          suggestionFirst = computed[0];
          lastSuggestionsSeed = seedVideoId;
          lastSuggestions = computed;
          lastSuggestionsAt = Date.now();
        }
      }

      const nextAuto = suggestionFirst?.id
        ? { id: suggestionFirst.id, title: suggestionFirst.title, thumbnail: { url: suggestionFirst.thumbnail } }
        : await getAutoplayCandidate(seedVideoId);

      if (nextAuto?.id) {
        currentSong = {
          id: `auto-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          videoId: nextAuto.id,
          title: nextAuto.title,
          thumbnail: normalizeThumb(nextAuto.thumbnail, nextAuto.id),
          userName: 'Autoplay',
          addedAt: new Date().toISOString()
        };
        rememberAutoplay(nextAuto.id);
      } else {
        currentSong = null;
      }
    } catch (error) {
      currentSong = null;
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

  broadcastSuggestions(6, true).catch(() => {});
}

// Socket.io eventos
io.on('connection', (socket) => {
  console.log('Usuario conectado:', socket.id);
  
  // Enviar estado actual al nuevo usuario
  socket.emit('initial-state', {
    playlist,
    currentSong,
    isPlaying,
    currentTime: isPlaying ? currentTime + (Date.now() - playStartTime) / 1000 : currentTime,
    history: playHistory
  });

  emitSuggestionsToSocket(socket).catch(() => {});
  emitHistoryToSocket(socket).catch(() => {});
  
  socket.on('song-ended', () => {
    playNextSong();
  });

  socket.on('screen-message', (payload) => {
    const text = (payload?.text || '').toString().trim();
    const userName = (payload?.userName || 'Anónimo').toString().trim().slice(0, 20) || 'Anónimo';

    if (!text) return;
    if (text.length > 140) return;

    io.emit('screen-message', {
      text,
      userName,
      createdAt: Date.now()
    });
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