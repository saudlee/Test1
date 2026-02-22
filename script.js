const CONFIG = {
    ICE_SERVERS: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
    // Change this to your Render/Railway URL after hosting (e.g., 'wss://your-app.onrender.com')
    SIGNAL_URL: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? 'ws://localhost:8080'
        : 'wss://' + window.location.hostname.replace('watch-pro', 'watch-server'),
};

// Global State
let localStream;
let peerConnection;
let socket;
let isLayoutLocked = false;

// Dynamic Room System from URL
const urlParams = new URLSearchParams(window.location.search);
let roomID = urlParams.get('room') || 'default-room';

let zoomLevels = { self: 1, peer: 1 };

// DOM Elements
const mainVideo = document.getElementById('main-video');
const selfCam = document.getElementById('self-cam');
const peerCam = document.getElementById('peer-cam');
const videoPlaceholder = document.getElementById('video-placeholder');
const connectionStatus = document.getElementById('connection-status');
const roomDisplay = document.getElementById('room-id-display');

/**
 * INITIALIZATION
 */
async function init() {
    setupWebSocket();
    await initMedia();
    loadLayout();
    setupEventListeners();
    setupDraggable();
}

/**
 * MEDIA & WEBRTC
 */
async function initMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });
        selfCam.srcObject = localStream;
    } catch (err) {
        console.error('Error accessing media:', err);
        alert('Could not access camera/microphone. Please check permissions.');
    }
}

function setupWebSocket() {
    socket = new WebSocket(CONFIG.SIGNAL_URL);

    socket.onopen = () => {
        console.log('Connected to signaling server');
        connectionStatus.textContent = 'Connecting...';
        connectionStatus.className = 'status-badge disconnected';

        socket.send(JSON.stringify({ type: 'join', room: roomID }));
    };

    socket.onmessage = async (event) => {
        const data = JSON.parse(event.data);

        switch (data.type) {
            case 'peer-joined':
                console.log('Peer joined, creating offer...');
                connectionStatus.textContent = 'Peer Found';
                connectionStatus.className = 'status-badge connected';
                createOffer();
                break;
            case 'offer':
                handleOffer(data.offer);
                break;
            case 'answer':
                handleAnswer(data.answer);
                break;
            case 'candidate':
                handleCandidate(data.candidate);
                break;
            case 'video-state':
                handleVideoSync(data);
                break;
            case 'peer-left':
                connectionStatus.textContent = 'Peer Left';
                connectionStatus.className = 'status-badge disconnected';
                if (peerConnection) peerConnection.close();
                peerCam.srcObject = null;
                break;
        }
    };

    socket.onclose = () => {
        connectionStatus.textContent = 'Server Down';
        connectionStatus.className = 'status-badge disconnected';
    };
}

async function createOffer() {
    createPeerConnection();
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.send(JSON.stringify({ type: 'offer', offer }));
}

async function handleOffer(offer) {
    createPeerConnection();
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.send(JSON.stringify({ type: 'answer', answer }));
}

async function handleAnswer(answer) {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
}

async function handleCandidate(candidate) {
    if (peerConnection) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
}

function createPeerConnection() {
    if (peerConnection) return;

    peerConnection = new RTCPeerConnection(CONFIG.ICE_SERVERS);

    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    peerConnection.ontrack = (event) => {
        console.log('Received remote track');
        peerCam.srcObject = event.streams[0];
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }));
        }
    };
}

/**
 * VIDEO SYNC LOGIC
 */
let lastSyncTime = 0;
const SYNC_THRESHOLD = 0.8; // Seconds

function syncVideo(action, time = 0, speed = 1) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        if (action === 'timeupdate' && Math.abs(time - lastSyncTime) < 2) return;

        lastSyncTime = time;
        socket.send(JSON.stringify({
            type: 'video-state',
            action,
            time,
            speed,
            sender: 'peer'
        }));
    }
}

function handleVideoSync(data) {
    // Play/Pause sync
    if (data.action === 'play') {
        if (mainVideo.paused) mainVideo.play().catch(() => { });
    } else if (data.action === 'pause') {
        if (!mainVideo.paused) mainVideo.pause();
    }

    // Speed sync
    if (data.speed && mainVideo.playbackRate !== data.speed) {
        mainVideo.playbackRate = data.speed;
    }

    // Position sync
    const timeDiff = Math.abs(mainVideo.currentTime - data.time);
    if (timeDiff > SYNC_THRESHOLD) {
        mainVideo.currentTime = data.time;
    }
}

/**
 * GESTURES & FEEDBACK
 */
function showFeedback(type, value) {
    const forward = document.querySelector('.feedback-icon.forward');
    const backward = document.querySelector('.feedback-icon.backward');
    const badge = document.querySelector('.speed-badge');

    // Remove existing active classes to trigger restart of animation
    forward.classList.remove('active');
    backward.classList.remove('active');
    // For badge, we handle it slightly differently as it stays while holding
    if (type !== 'speed') badge.classList.remove('active');

    if (type === 'forward') {
        void forward.offsetWidth; // Trigger reflow
        forward.classList.add('active');
        setTimeout(() => forward.classList.remove('active'), 700);
    } else if (type === 'backward') {
        void backward.offsetWidth; // Trigger reflow
        backward.classList.add('active');
        setTimeout(() => backward.classList.remove('active'), 700);
    } else if (type === 'speed') {
        badge.textContent = `${value}x`;
        badge.classList.add('active');
    } else if (type === 'speed-hide') {
        badge.classList.remove('active');
    }
}

/**
 * AUTO-HIDE CONTROLS
 */
let idleTimer;
function resetIdleTimer() {
    const overlay = document.querySelector('.ui-overlay');
    if (!overlay) return;

    overlay.classList.remove('idle');
    document.body.style.cursor = 'default';

    clearTimeout(idleTimer);

    // Auto-hide only if video is playing
    if (!mainVideo.paused) {
        idleTimer = setTimeout(() => {
            overlay.classList.add('idle');
            document.body.style.cursor = 'none';
        }, 2000);
    }
}

/**
 * INTERACTIVE UI (DRAG & RESIZE)
 */
function setupDraggable() {
    const containers = document.querySelectorAll('.cam-overlay');

    containers.forEach(container => {
        let isDragging = false;
        let isResizing = false;
        let startX, startY, startLeft, startTop, startWidth, startHeight;

        container.addEventListener('mousedown', (e) => {
            if (isLayoutLocked) return;

            // Check if clicking resize handle
            if (e.target.classList.contains('resize-handle')) {
                isResizing = true;
                container.style.transition = 'none';
            } else if (e.target.closest('.cam-header') || e.target.closest('.video-wrapper')) {
                // Ignore button clicks in header
                if (e.target.tagName === 'BUTTON') return;
                isDragging = true;
                container.style.transition = 'none';
            } else {
                return;
            }

            startX = e.clientX;
            startY = e.clientY;
            startLeft = container.offsetLeft;
            startTop = container.offsetTop;
            startWidth = container.offsetWidth;
            startHeight = container.offsetHeight;

            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (isDragging) {
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                container.style.left = `${startLeft + dx}px`;
                container.style.top = `${startTop + dy}px`;
            }

            if (isResizing) {
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                container.style.width = `${startWidth + dx}px`;
                container.style.height = `${startHeight + dy}px`;
            }
        });

        document.addEventListener('mouseup', () => {
            if (isDragging || isResizing) {
                isDragging = false;
                isResizing = false;
                container.style.transition = '';
                saveLayout();
            }
        });
    });
}

/**
 * ZOOM & CROP
 */
function updateZoom(id, delta) {
    const video = id === 'self' ? selfCam : peerCam;
    zoomLevels[id] = Math.max(1, Math.min(4, zoomLevels[id] + delta));
    video.style.transform = `scale(${zoomLevels[id]})`;
    saveLayout();
}

/**
 * PERSISTENCE
 */
function saveLayout() {
    const layout = {
        self: {
            left: document.getElementById('self-cam-container').style.left,
            top: document.getElementById('self-cam-container').style.top,
            width: document.getElementById('self-cam-container').style.width,
            height: document.getElementById('self-cam-container').style.height,
            zoom: zoomLevels.self
        },
        peer: {
            left: document.getElementById('peer-cam-container').style.left,
            top: document.getElementById('peer-cam-container').style.top,
            width: document.getElementById('peer-cam-container').style.width,
            height: document.getElementById('peer-cam-container').style.height,
            zoom: zoomLevels.peer
        },
        locked: isLayoutLocked
    };
    localStorage.setItem('watch_together_layout', JSON.stringify(layout));
}

function loadLayout() {
    const saved = localStorage.getItem('watch_together_layout');
    const selfContainer = document.getElementById('self-cam-container');
    const peerContainer = document.getElementById('peer-cam-container');

    if (!saved) {
        // Default positions using top/left for consistency
        selfContainer.style.left = '20px';
        selfContainer.style.top = (window.innerHeight - 250) + 'px';

        peerContainer.style.left = (window.innerWidth - 300) + 'px';
        peerContainer.style.top = (window.innerHeight - 250) + 'px';
        return;
    }

    const layout = JSON.parse(saved);
    const apply = (id, data) => {
        const el = document.getElementById(`${id}-cam-container`);
        if (data.left) el.style.left = data.left;
        if (data.top) el.style.top = data.top;
        if (data.width) el.style.width = data.width;
        if (data.height) el.style.height = data.height;
        zoomLevels[id] = data.zoom || 1;
        document.getElementById(`${id}-cam`).style.transform = `scale(${zoomLevels[id]})`;
    };

    apply('self', layout.self);
    apply('peer', layout.peer);

    isLayoutLocked = layout.locked || false;
    updateLockUI();
}

/**
 * UI EVENT LISTENERS
 */
function setupEventListeners() {
    const playBtn = document.getElementById('play-pause');
    const seekBar = document.getElementById('seek-bar');
    const seekProgress = document.getElementById('seek-progress');
    const seekBuffer = document.getElementById('seek-buffer');
    const volumeSlider = document.getElementById('volume-slider');
    const muteBtn = document.getElementById('mute-movie');
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    const gestureLeft = document.getElementById('gesture-left');
    const gestureRight = document.getElementById('gesture-right');

    const togglePlay = () => {
        if (mainVideo.paused) {
            mainVideo.play();
            syncVideo('play', mainVideo.currentTime);
        } else {
            mainVideo.pause();
            syncVideo('pause', mainVideo.currentTime);
        }
    };

    // Video Selection
    document.getElementById('local-file').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) loadMovie(URL.createObjectURL(file));
    });

    document.getElementById('load-url').addEventListener('click', () => {
        const url = document.getElementById('video-url').value;
        if (url) loadMovie(url);
    });

    // Playback Events
    playBtn.onclick = togglePlay;

    // Gesture Areas (Advanced Detection: Single vs Double vs Hold)
    let lastClickTime = 0;
    const GESTURE_TIMEOUT = 250; // Quicker response
    let holdTimer;
    let singleClickTimer;

    const handleSeekGesture = (direction) => {
        if (direction === 'forward') {
            mainVideo.currentTime += 4;
            showFeedback('forward');
        } else {
            mainVideo.currentTime -= 4;
            showFeedback('backward');
        }
        syncVideo('seek', mainVideo.currentTime);
    };

    const setupGestureArea = (el, direction) => {
        el.onmousedown = (e) => {
            const now = Date.now();
            clearTimeout(singleClickTimer); // Cancel any pending single click

            if (now - lastClickTime < GESTURE_TIMEOUT) {
                // DOUBLE CLICK
                handleSeekGesture(direction);
                lastClickTime = 0;
                clearTimeout(holdTimer);
            } else {
                lastClickTime = now;
                // Possible SINGLE CLICK or HOLD
                holdTimer = setTimeout(() => {
                    const speed = direction === 'forward' ? 2.0 : 0.75;
                    startSpeed(speed);
                    lastClickTime = 0; // Mark as "Handled by hold"
                }, 350);
            }
            resetIdleTimer();
        };

        el.onmouseup = () => {
            clearTimeout(holdTimer);

            if (mainVideo.playbackRate !== 1.0) {
                // Was HOLDING
                resetSpeed();
                showFeedback('speed-hide');
            } else if (lastClickTime !== 0) {
                // Possible SINGLE CLICK - wait to see if it becomes a double
                singleClickTimer = setTimeout(() => {
                    togglePlay();
                    lastClickTime = 0;
                }, GESTURE_TIMEOUT);
            }
        };

        el.onmouseleave = () => {
            clearTimeout(holdTimer);
            if (mainVideo.playbackRate !== 1.0) {
                resetSpeed();
                showFeedback('speed-hide');
            }
            lastClickTime = 0;
        };
    };

    setupGestureArea(gestureLeft, 'backward');
    setupGestureArea(gestureRight, 'forward');

    // Central video click (also needs the same smart delay)
    mainVideo.onclick = (e) => {
        // Prevent doubling up if clicking on gesture areas
        if (e.target !== mainVideo) return;

        const now = Date.now();
        clearTimeout(singleClickTimer);

        if (now - lastClickTime < GESTURE_TIMEOUT) {
            // Double click center -> Fullscreen toggle
            fullscreenBtn.click();
            lastClickTime = 0;
        } else {
            lastClickTime = now;
            singleClickTimer = setTimeout(() => {
                togglePlay();
                lastClickTime = 0;
            }, GESTURE_TIMEOUT);
        }
    };

    // Playback Speed Logic
    let speedTimer;
    const startSpeed = (val) => {
        mainVideo.playbackRate = val;
        showFeedback('speed', val);
        syncVideo('speed-change', mainVideo.currentTime, val);
    };

    const resetSpeed = () => {
        mainVideo.playbackRate = 1.0;
        syncVideo('speed-change', mainVideo.currentTime, 1.0);
    };

    // Listen for Speed Keys or gestures
    window.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT') return;

        switch (e.code) {
            case 'Space':
                e.preventDefault();
                togglePlay();
                break;
            case 'ArrowRight':
                if (e.repeat) { // Long press arrow
                    startSpeed(2.0);
                } else {
                    mainVideo.currentTime += 4;
                    showFeedback('forward');
                    syncVideo('seek', mainVideo.currentTime);
                }
                break;
            case 'ArrowLeft':
                if (e.repeat) {
                    startSpeed(0.75);
                } else {
                    mainVideo.currentTime -= 4;
                    showFeedback('backward');
                    syncVideo('seek', mainVideo.currentTime);
                }
                break;
            case 'KeyF':
                fullscreenBtn.click();
                break;
        }
        resetIdleTimer();
    });

    window.addEventListener('keyup', (e) => {
        if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
            resetSpeed();
        }
    });

    mainVideo.onplay = () => {
        playBtn.innerHTML = '<i data-lucide="pause"></i>';
        lucide.createIcons();
        resetIdleTimer();
    };
    mainVideo.onpause = () => {
        playBtn.innerHTML = '<i data-lucide="play"></i>';
        lucide.createIcons();
        resetIdleTimer();
    };

    // Seek Logic
    mainVideo.ontimeupdate = () => {
        const percent = (mainVideo.currentTime / mainVideo.duration) * 100 || 0;
        seekBar.value = percent;
        seekProgress.style.width = `${percent}%`;
        updateTimeDisplay();

        // Periodic sync to keep in step
        syncVideo('timeupdate', mainVideo.currentTime, mainVideo.playbackRate);
    };

    mainVideo.onprogress = () => {
        if (mainVideo.buffered.length > 0) {
            const bufferedEnd = mainVideo.buffered.end(mainVideo.buffered.length - 1);
            const duration = mainVideo.duration;
            if (duration > 0) {
                seekBuffer.style.width = `${(bufferedEnd / duration) * 100}%`;
            }
        }
    };

    seekBar.oninput = () => {
        const percent = seekBar.value;
        seekProgress.style.width = `${percent}%`;
        const time = (percent / 100) * mainVideo.duration;
        mainVideo.currentTime = time;
    };

    seekBar.onchange = () => {
        syncVideo('seek', mainVideo.currentTime);
    };

    // Volume
    volumeSlider.oninput = () => {
        mainVideo.volume = volumeSlider.value;
        muteBtn.innerHTML = mainVideo.volume === 0 ? '<i data-lucide="volume-x"></i>' : '<i data-lucide="volume-2"></i>';
        lucide.createIcons();
    };

    muteBtn.onclick = () => {
        mainVideo.muted = !mainVideo.muted;
        muteBtn.innerHTML = mainVideo.muted ? '<i data-lucide="volume-x"></i>' : '<i data-lucide="volume-2"></i>';
        lucide.createIcons();
    };

    // Fullscreen
    fullscreenBtn.onclick = () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen();
            fullscreenBtn.innerHTML = '<i data-lucide="minimize"></i>';
        } else {
            document.exitFullscreen();
            fullscreenBtn.innerHTML = '<i data-lucide="maximize"></i>';
        }
        lucide.createIcons();
    };

    // Zoom & Cam Controls
    document.querySelector('#self-cam-container .zoom-in').onclick = () => updateZoom('self', 0.2);
    document.querySelector('#self-cam-container .zoom-out').onclick = () => updateZoom('self', -0.2);
    document.querySelector('#peer-cam-container .zoom-in').onclick = () => updateZoom('peer', 0.2);
    document.querySelector('#peer-cam-container .zoom-out').onclick = () => updateZoom('peer', -0.2);

    document.getElementById('lock-layout').onclick = () => {
        isLayoutLocked = !isLayoutLocked;
        updateLockUI();
        saveLayout();
    };

    document.getElementById('toggle-self-cam').onclick = () => {
        const container = document.getElementById('self-cam-container');
        const isHidden = container.style.display === 'none';
        container.style.display = isHidden ? 'block' : 'none';
        document.getElementById('toggle-self-cam').innerHTML = isHidden ? '<i data-lucide="video"></i>' : '<i data-lucide="video-off"></i>';
        lucide.createIcons();
    };

    document.getElementById('mute-mic').onclick = () => {
        const audioTrack = localStream.getAudioTracks()[0];
        audioTrack.enabled = !audioTrack.enabled;
        document.querySelector('#mute-mic').innerHTML = audioTrack.enabled ? '<i data-lucide="mic"></i>' : '<i data-lucide="mic-off"></i>';
        lucide.createIcons();
    };

    // Keyboard Shortcuts
    // Idle detection
    // Copy Invite Link
    document.getElementById('copy-invite').onclick = () => {
        const url = new URL(window.location.href);
        url.searchParams.set('room', roomID);

        navigator.clipboard.writeText(url.toString()).then(() => {
            const btn = document.getElementById('copy-invite');
            const originalIcon = btn.innerHTML;
            btn.innerHTML = '<i data-lucide="check"></i>';
            lucide.createIcons();
            setTimeout(() => {
                btn.innerHTML = originalIcon;
                lucide.createIcons();
            }, 2000);
        });
    };

    window.addEventListener('mousemove', resetIdleTimer);
    window.addEventListener('mousedown', resetIdleTimer);

    // Settings Modal
    const modal = document.getElementById('settings-modal');
    document.getElementById('toggle-settings').onclick = () => modal.classList.add('active');
    document.getElementById('close-modal').onclick = () => modal.classList.remove('active');

    document.getElementById('reconnect-btn').onclick = () => {
        roomID = document.getElementById('room-id-input').value || 'default-room';
        roomDisplay.textContent = `Room: ${roomID}`;
        if (socket) socket.close();
        setupWebSocket();
        modal.classList.remove('active');
    };

    document.getElementById('reset-layout').onclick = () => {
        localStorage.removeItem('watch_together_layout');
        location.reload();
    };
}

function loadMovie(url) {
    mainVideo.src = url;
    videoPlaceholder.style.display = 'none';
    document.body.classList.add('playing');
    mainVideo.play().then(() => {
        resetIdleTimer();
    }).catch(e => console.log('Autoplay blocked:', e));
}

function updateTimeDisplay() {
    const format = (s) => new Date(s * 1000).toISOString().substr(11, 8);
    document.getElementById('time-display').textContent = `${format(mainVideo.currentTime)} / ${format(mainVideo.duration || 0)}`;
}

function updateLockUI() {
    const lockBtn = document.getElementById('lock-layout');
    lockBtn.innerHTML = isLayoutLocked ? '<i data-lucide="lock"></i>' : '<i data-lucide="unlock"></i>';
    lucide.createIcons();

    document.querySelectorAll('.cam-overlay').forEach(el => {
        el.classList.toggle('locked', isLayoutLocked);
    });
}

// Start the app
init();
