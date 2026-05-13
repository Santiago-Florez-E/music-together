class MusicTogether {
    constructor() {
        this.socket = io();
        this.player = null;
        this.isPlayerReady = false;
        this.currentSong = null;
        this.playlist = [];
        this.isPlaying = false;
        
        this.isPlaying = false;
        this.recommendations = [];
        this.lastSuggestionsSeed = null;
        this.lastSuggestionsSeedFromServer = null;
        this.suggestionsRefreshTimer = null;

        this.activeTab = 'queue';
        this.searchResults = [];
        this.history = [];
        this.activeScreenMessages = [];

        this.initializeElements();
        this.setupEventListeners();
        this.setupSocketListeners();
        this.fetchRecommendations();
    }
    
    initializeElements() {
        this.userNameInput = document.getElementById('userName');
        this.urlInput = document.getElementById('youtubeUrl');
        this.addSongBtn = document.getElementById('addSongBtn');
        this.playlistDiv = document.getElementById('playlist');
        this.queueCount = document.getElementById('queue-count');
        this.connectionStatus = document.getElementById('connection-status');
        this.currentSongInfo = document.getElementById('current-song-info');
        this.nextSongBtn = document.getElementById('nextSongBtn');
        this.recommendationsDiv = document.getElementById('recommendations');
        this.refreshSuggestionsBtn = document.getElementById('refreshSuggestions');

        this.tabQueueBtn = document.getElementById('tabQueueBtn');
        this.tabSearchBtn = document.getElementById('tabSearchBtn');
        this.tabQueuePanel = document.getElementById('tab-queue');
        this.tabSearchPanel = document.getElementById('tab-search');
        this.tabHistoryBtn = document.getElementById('tabHistoryBtn');
        this.tabHistoryPanel = document.getElementById('tab-history');
        this.historyListDiv = document.getElementById('historyList');

        this.searchQueryInput = document.getElementById('searchQuery');
        this.searchBtn = document.getElementById('searchBtn');
        this.searchResultsDiv = document.getElementById('searchResults');

        this.screenMessageInput = document.getElementById('screenMessage');
        this.sendMessageBtn = document.getElementById('sendMessageBtn');
        this.playerContainer = document.getElementById('player-container');
    }
    
    setupEventListeners() {
        this.addSongBtn.addEventListener('click', () => this.addSong());
        this.urlInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.addSong();
        });
        this.nextSongBtn.addEventListener('click', () => this.nextSong());
        this.refreshSuggestionsBtn.addEventListener('click', () => this.fetchRecommendations());

        this.tabQueueBtn?.addEventListener('click', () => this.switchTab('queue'));
        this.tabSearchBtn?.addEventListener('click', () => this.switchTab('search'));
        this.tabHistoryBtn?.addEventListener('click', () => this.switchTab('history'));

        this.searchBtn?.addEventListener('click', () => this.searchYouTube());
        this.searchQueryInput?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.searchYouTube();
        });

        this.sendMessageBtn?.addEventListener('click', () => this.sendScreenMessage());
        this.screenMessageInput?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.sendScreenMessage();
        });
    }
    
    setupSocketListeners() {
        this.socket.on('connect', () => {
            this.connectionStatus.innerHTML = '🟢 Conectado';
            this.connectionStatus.style.color = '#10b981';
        });
        
        this.socket.on('disconnect', () => {
            this.connectionStatus.innerHTML = '🔴 Desconectado';
            this.connectionStatus.style.color = '#ef4444';
        });
        
        this.socket.on('initial-state', (data) => {
            this.updateState(data);
            if (Array.isArray(data?.history)) {
                this.history = data.history;
                this.renderHistory();
            }
        });
        
        this.socket.on('playlist-updated', (data) => {
            this.updateState(data);
        });
        
        this.socket.on('song-changed', (data) => {
            this.updateState(data);
            const vid = data.currentSong?.videoId || data.currentSong?.id;
            if (vid && this.isPlayerReady) {
                this.loadVideo(vid);
            }
        });

        this.socket.on('suggestions-updated', (data) => {
            if (this.suggestionsRefreshTimer) {
                clearTimeout(this.suggestionsRefreshTimer);
                this.suggestionsRefreshTimer = null;
            }

            const payload = Array.isArray(data) ? { seedVideoId: null, items: data } : data;
            const items = payload?.items || [];
            if (!Array.isArray(items)) return;

            this.lastSuggestionsSeedFromServer = payload?.seedVideoId || null;

            this.recommendations = items;
            this.renderRecommendations();
        });

        this.socket.on('history-updated', (data) => {
            const payload = Array.isArray(data) ? { items: data } : data;
            const items = payload?.items || [];
            if (!Array.isArray(items)) return;
            this.history = items;
            this.renderHistory();
        });

        this.socket.on('screen-message', (data) => {
            const text = (data?.text || '').toString();
            const userName = (data?.userName || 'Anónimo').toString();
            if (!text) return;
            this.renderScreenMessage({ text, userName });
        });
    }
    
    updateState(data) {
        const prevVid = this.getCurrentVideoId(this.currentSong);

        this.currentSong = data.currentSong;
        this.playlist = data.playlist || [];
        this.isPlaying = data.isPlaying;

        const nextVid = this.getCurrentVideoId(this.currentSong);
        if (nextVid && nextVid !== prevVid && nextVid !== this.lastSuggestionsSeed) {
            this.lastSuggestionsSeed = nextVid;
            this.scheduleRecommendationsRefresh();
        }
        
        this.updatePlaylist();
        this.updateCurrentSongInfo();
    }
    
    updatePlaylist() {
        this.queueCount.textContent = this.playlist.length;
        
        if (this.playlist.length === 0) {
            this.playlistDiv.innerHTML = '<p class="empty-playlist">La lista está vacía. ¡Añade la primera canción!</p>';
            return;
        }
        
        this.playlistDiv.innerHTML = this.playlist.map((song) => `
            <div class="song-item">
                <img src="${song.thumbnail}" alt="Thumbnail" class="song-thumbnail">
                <div class="song-info">
                    <div class="song-title" title="${song.title}">${song.title}</div>
                    <div class="song-meta">
                        Por: ${song.userName} • ${new Date(song.addedAt).toLocaleTimeString()}
                    </div>
                </div>
                <button class="remove-btn" onclick="app.removeSong('${song.id}')" title="Eliminar de la cola">
                    ✕
                </button>
            </div>
        `).join('');
    }
    
    updateCurrentSongInfo() {
        if (this.currentSong) {
            this.currentSongInfo.innerHTML = `
                <div style="color: var(--accent); font-size: 0.8rem; text-transform: uppercase; font-weight: 700; margin-bottom: 4px;">En vivo ahora</div>
                <div style="font-size: 1.1rem;">${this.currentSong.title}</div>
                <div style="color: var(--text-muted); font-size: 0.85rem;">Sugerida por: ${this.currentSong.userName}</div>
            `;
            this.nextSongBtn.style.display = 'inline-block';
        } else {
            this.currentSongInfo.innerHTML = '<span id="no-song">No hay canciones en reproducción</span>';
            this.nextSongBtn.style.display = 'none';
        }
    }

    getCurrentVideoId(song) {
        return song?.videoId || song?.id || null;
    }

    scheduleRecommendationsRefresh() {
        if (this.suggestionsRefreshTimer) clearTimeout(this.suggestionsRefreshTimer);
        const expectedSeed = this.lastSuggestionsSeed;

        this.suggestionsRefreshTimer = setTimeout(() => {
            this.suggestionsRefreshTimer = null;

            if (this.lastSuggestionsSeedFromServer === expectedSeed) {
                return;
            }

            this.fetchRecommendations();
        }, 2000);
    }

    async fetchRecommendations() {
        try {
            const response = await fetch('/api/suggestions?count=6');
            this.recommendations = await response.json();
            this.renderRecommendations();
        } catch (error) {
            console.error('Error al cargar sugerencias:', error);
        }
    }

    renderRecommendations() {
        this.recommendationsDiv.innerHTML = this.recommendations.map(rec => `
            <div class="rec-item" onclick="app.addFromRecommendation('${rec.id}')">
                <img src="${rec.thumbnail}" class="rec-thumbnail">
                <div class="rec-info">
                    <div class="rec-title">${rec.title}</div>
                    <div class="rec-channel">${rec.channel}</div>
                </div>
            </div>
        `).join('');
    }

    switchTab(tab) {
        this.activeTab = tab;

        if (this.tabQueueBtn) this.tabQueueBtn.classList.toggle('active', tab === 'queue');
        if (this.tabSearchBtn) this.tabSearchBtn.classList.toggle('active', tab === 'search');
        if (this.tabHistoryBtn) this.tabHistoryBtn.classList.toggle('active', tab === 'history');

        if (this.tabQueuePanel) this.tabQueuePanel.classList.toggle('hidden', tab !== 'queue');
        if (this.tabSearchPanel) this.tabSearchPanel.classList.toggle('hidden', tab !== 'search');
        if (this.tabHistoryPanel) this.tabHistoryPanel.classList.toggle('hidden', tab !== 'history');

        if (tab === 'search' && (!this.searchResults || this.searchResults.length === 0)) {
            this.searchResultsDiv.innerHTML = '<p class="empty-search">Escribe algo y pulsa Buscar</p>';
        }

        if (tab === 'history' && (!this.history || this.history.length === 0)) {
            this.fetchHistory();
        }
    }

    sendScreenMessage() {
        const text = this.screenMessageInput?.value?.trim() || '';
        if (!text) return;

        const userName = this.userNameInput?.value?.trim() || 'Anónimo';

        this.socket.emit('screen-message', {
            text: text.slice(0, 140),
            userName: userName.slice(0, 20)
        });

        if (this.screenMessageInput) this.screenMessageInput.value = '';
    }

    renderScreenMessage({ text, userName }) {
        if (!this.playerContainer) return;

        const el = document.createElement('div');
        el.className = 'screen-msg';
        el.textContent = `${userName}: ${text}`;

        const containerHeight = this.playerContainer.clientHeight || 0;
        const top = Math.max(8, Math.floor(Math.random() * Math.max(1, containerHeight - 40)));
        el.style.top = `${top}px`;
        el.style.animationDuration = '30s';

        this.playerContainer.appendChild(el);

        const remove = () => {
            el.removeEventListener('animationend', remove);
            if (el.parentNode) el.remove();
        };

        el.addEventListener('animationend', remove);
        setTimeout(remove, 30000);
    }

    async fetchHistory() {
        try {
            const response = await fetch('/api/history?count=50');
            const items = await response.json();
            this.history = Array.isArray(items) ? items : [];
            this.renderHistory();
        } catch (error) {
            this.renderHistory();
        }
    }

    renderHistory() {
        if (!this.historyListDiv) return;

        if (!this.history || this.history.length === 0) {
            this.historyListDiv.innerHTML = '<p class="empty-search">Aún no hay historial</p>';
            return;
        }

        this.historyListDiv.innerHTML = this.history.map((h) => `
            <div class="history-item">
                <img src="${h.thumbnail}" alt="Thumbnail" class="history-thumbnail">
                <div class="history-info">
                    <div class="history-title" title="${h.title}">${h.title}</div>
                    <div class="history-meta">${h.userName || 'Anónimo'} • ${new Date(h.playedAt).toLocaleString()}</div>
                </div>
                <button class="history-add-btn" onclick="app.addFromRecommendation('${h.videoId}')">Añadir</button>
            </div>
        `).join('');
    }

    async searchYouTube() {
        const q = this.searchQueryInput?.value?.trim() || '';
        if (!q) {
            this.showMessage('Escribe algo para buscar', 'error');
            return;
        }

        try {
            this.searchResultsDiv.innerHTML = '<p class="empty-search">Buscando...</p>';
            const response = await fetch(`/api/search?q=${encodeURIComponent(q)}&count=12`);
            const results = await response.json();
            this.searchResults = Array.isArray(results) ? results : [];
            this.renderSearchResults();
        } catch (error) {
            this.searchResultsDiv.innerHTML = '<p class="empty-search">No se pudo buscar. Intenta otra vez.</p>';
        }
    }

    renderSearchResults() {
        if (!this.searchResults || this.searchResults.length === 0) {
            this.searchResultsDiv.innerHTML = '<p class="empty-search">Sin resultados</p>';
            return;
        }

        this.searchResultsDiv.innerHTML = this.searchResults.map((v) => `
            <div class="search-item">
                <img src="${v.thumbnail}" alt="Thumbnail" class="search-thumbnail">
                <div class="search-info">
                    <div class="search-title" title="${v.title}">${v.title}</div>
                    <div class="search-meta">${v.channel || 'YouTube'}</div>
                </div>
                <button class="search-add-btn" onclick="app.addFromRecommendation('${v.id}')">Añadir</button>
            </div>
        `).join('');
    }
    
    async addSong(urlValue = null) {
        const url = urlValue || this.urlInput.value.trim();
        const userName = this.userNameInput.value.trim() || 'Anónimo';
        
        if (!url) {
            this.showMessage('Por favor, ingresa una URL de YouTube', 'error');
            return;
        }
        
        try {
            const response = await fetch('/api/add-song', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ url, userName })
            });
            
            const result = await response.json();
            
            if (result.success) {
                if (!urlValue) this.urlInput.value = '';
                const n = Number(result.addedCount || 0);
                if (n > 1) {
                    this.showMessage(`¡Playlist añadida! (${n} canciones)`, 'success');
                } else {
                    this.showMessage('¡Canción añadida!', 'success');
                }
            } else {
                this.showMessage(result.error || 'Error al añadir', 'error');
            }
        } catch (error) {
            this.showMessage('Error de conexión', 'error');
        }
    }

    addFromRecommendation(id) {
        const url = `https://www.youtube.com/watch?v=${id}`;
        this.addSong(url);
    }
    
    async removeSong(songId) {
        try {
            const response = await fetch('/api/remove-song', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ id: songId })
            });
            
            const result = await response.json();
            if (result.success) {
                this.showMessage('Canción eliminada', 'success');
            }
        } catch (error) {
            this.showMessage('Error al eliminar', 'error');
        }
    }
    
    async nextSong() {
        try {
            await fetch('/api/next-song', { method: 'POST' });
        } catch (error) {
            this.showMessage('Error al cambiar de canción', 'error');
        }
    }
    
    showMessage(message, type) {
        const messageDiv = document.createElement('div');
        messageDiv.style.position = 'fixed';
        messageDiv.style.top = '2rem';
        messageDiv.style.left = '50%';
        messageDiv.style.transform = 'translateX(-50%)';
        messageDiv.style.padding = '0.75rem 1.5rem';
        messageDiv.style.borderRadius = '2rem';
        messageDiv.style.background = type === 'success' ? '#10b981' : '#ef4444';
        messageDiv.style.color = 'white';
        messageDiv.style.fontWeight = '600';
        messageDiv.style.zIndex = '1000';
        messageDiv.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)';
        messageDiv.style.animation = 'fadeIn 0.3s ease';
        messageDiv.textContent = message;
        
        document.body.appendChild(messageDiv);
        
        setTimeout(() => {
            messageDiv.style.opacity = '0';
            messageDiv.style.transition = 'opacity 0.3s ease';
            setTimeout(() => messageDiv.remove(), 300);
        }, 2000);
    }
    
    onYouTubeIframeAPIReady() {
        this.player = new YT.Player('youtube-player', {
            height: '100%',
            width: '100%',
            playerVars: {
                'playsinline': 1,
                'autoplay': 1,
                'controls': 1,
                'origin': window.location.origin,
                'rel': 0
            },
            events: {
                'onReady': () => {
                    this.isPlayerReady = true;
                    const vid = this.currentSong?.videoId || this.currentSong?.id;
                    if (vid) {
                        this.loadVideo(vid);
                    }
                },
                'onStateChange': (event) => {
                    if (event.data === YT.PlayerState.ENDED) {
                        this.socket.emit('song-ended');
                    }
                },
                'onError': (event) => {
                    console.error('Error del reproductor de YouTube:', event.data);
                    this.showMessage('Error al cargar el video. Saltando...', 'error');
                    setTimeout(() => {
                        this.socket.emit('song-ended');
                    }, 2000);
                }
            }
        });
    }
    
    loadVideo(videoId) {
        if (this.player && this.isPlayerReady) {
            try {
                this.player.loadVideoById(videoId);
            } catch (error) {
                console.error('Error al cargar video:', error);
            }
        }
    }
}

// Inicializar la aplicación
const app = new MusicTogether();

// Función global requerida por YouTube API
function onYouTubeIframeAPIReady() {
    app.onYouTubeIframeAPIReady();
}