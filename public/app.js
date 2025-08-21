class MusicTogether {
    constructor() {
        this.socket = io();
        this.player = null;
        this.isPlayerReady = false;
        this.currentSong = null;
        this.playlist = [];
        this.isPlaying = false;
        
        this.initializeElements();
        this.setupEventListeners();
        this.setupSocketListeners();
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
    }
    
    setupEventListeners() {
        this.addSongBtn.addEventListener('click', () => this.addSong());
        this.urlInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.addSong();
        });
        this.nextSongBtn.addEventListener('click', () => this.nextSong());
    }
    
    setupSocketListeners() {
        this.socket.on('connect', () => {
            this.connectionStatus.textContent = '🟢 Conectado';
        });
        
        this.socket.on('disconnect', () => {
            this.connectionStatus.textContent = '🔴 Desconectado';
        });
        
        this.socket.on('initial-state', (data) => {
            this.updateState(data);
        });
        
        this.socket.on('playlist-updated', (data) => {
            this.updateState(data);
        });
        
        this.socket.on('song-changed', (data) => {
            this.updateState(data);
            if (data.currentSong && this.isPlayerReady) {
                this.loadVideo(data.currentSong.id);
            }
        });
    }
    
    updateState(data) {
        this.currentSong = data.currentSong;
        this.playlist = data.playlist || [];
        this.isPlaying = data.isPlaying;
        
        this.updatePlaylist();
        this.updateCurrentSongInfo();
    }
    
    updatePlaylist() {
        this.queueCount.textContent = this.playlist.length;
        
        if (this.playlist.length === 0) {
            this.playlistDiv.innerHTML = '<p class="empty-playlist">La lista está vacía. ¡Añade la primera canción!</p>';
            return;
        }
        
        this.playlistDiv.innerHTML = this.playlist.map((song, index) => `
            <div class="song-item">
                <img src="${song.thumbnail}" alt="Thumbnail" class="song-thumbnail">
                <div class="song-info">
                    <div class="song-title">${song.title}</div>
                    <div class="song-meta">
                        Añadida por: ${song.userName} • ${new Date(song.addedAt).toLocaleTimeString()}
                    </div>
                </div>
            </div>
        `).join('');
    }
    
    updateCurrentSongInfo() {
        if (this.currentSong) {
            this.currentSongInfo.innerHTML = `
                <strong>Reproduciendo:</strong> ${this.currentSong.title}<br>
                <small>Añadida por: ${this.currentSong.userName}</small>
            `;
            this.nextSongBtn.style.display = 'inline-block';
        } else {
            this.currentSongInfo.innerHTML = '<span id="no-song">No hay canciones en reproducción</span>';
            this.nextSongBtn.style.display = 'none';
        }
    }
    
    async addSong() {
        const url = this.urlInput.value.trim();
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
                this.urlInput.value = '';
                this.showMessage('¡Canción añadida exitosamente!', 'success');
            } else {
                this.showMessage(result.error || 'Error al añadir la canción', 'error');
            }
        } catch (error) {
            this.showMessage('Error de conexión', 'error');
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
        messageDiv.className = type;
        messageDiv.textContent = message;
        
        const container = document.querySelector('.add-song-section');
        container.appendChild(messageDiv);
        
        setTimeout(() => {
            messageDiv.remove();
        }, 3000);
    }
    
    // YouTube Player API
    onYouTubeIframeAPIReady() {
        this.player = new YT.Player('youtube-player', {
            height: '315',
            width: '560',
            playerVars: {
                'playsinline': 1,
                'autoplay': 1,
                'controls': 1,
                'origin': window.location.origin
            },
            events: {
                'onReady': () => {
                    this.isPlayerReady = true;
                    if (this.currentSong) {
                        this.loadVideo(this.currentSong.id);
                    }
                },
                'onStateChange': (event) => {
                    if (event.data === YT.PlayerState.ENDED) {
                        this.socket.emit('song-ended');
                    }
                },
                'onError': (event) => {
                    console.error('Error del reproductor de YouTube:', event.data);
                    this.showMessage('Error al cargar el video. Intentando siguiente...', 'error');
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
                this.showMessage('Error al cargar el video', 'error');
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