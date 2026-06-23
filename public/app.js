'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const AVATAR_COLORS = ['#5865f2','#23a55a','#eb459e','#fee75c','#ed4245','#57f287','#9b59b6','#e67e22'];

// ── State ─────────────────────────────────────────────────────────────────────
let myId = null, myName = '', isHost = false;
let ws = null;
let localStream = null;      // microphone (processed — goes to WebRTC)
let rawMicStream = null;     // raw mic from getUserMedia (for stopping on switch)
let screenStream = null;     // screen share (outgoing)
let isMuted = false, isDeafened = false, isSharingScreen = false, isNoiseSuppression = true;
let noiseSuppressor = null;  // noise suppression processor
let isLeaving = false;       // true when user initiated leave

// peers: Map<peerId, { name, pc, audioEl, stream, muted, sharingScreen, card }>
const peers = new Map();
let selectedSourceId = null;
let viewingPeerId = null; // which peer's screen we're currently watching

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function initials(name) {
  return name.trim().slice(0, 2).toUpperCase() || '??';
}
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function setError(msg) {
  document.getElementById('connect-error').textContent = msg;
}
function cleanupRoom() {
  stopScreenShare().catch(() => {});
  peers.forEach((_, id) => closePeer(id));
  peers.clear();
  localStream?.getTracks().forEach(t => t.stop());
  rawMicStream?.getTracks().forEach(t => t.stop());
  localStream = null;
  rawMicStream = null;
  screenStream = null;
  isMuted = false;
  isDeafened = false;
  isSharingScreen = false;
  viewingPeerId = null;
  myId = null;
  isLeaving = false;
  if (noiseSuppressor) { noiseSuppressor.destroy(); noiseSuppressor = null; }
  audioCtxs.forEach((ctx) => { try { ctx.close(); } catch {} });
  audioCtxs.clear();
  document.getElementById('voice-grid').innerHTML = '';
  document.getElementById('peers-list').innerHTML = '';
  document.getElementById('share-viewer').style.display = 'none';
  document.getElementById('ctrl-back-voice').style.display = 'none';
  document.getElementById('ctrl-mute').classList.remove('danger');
  document.getElementById('ctrl-deafen').classList.remove('danger');
  document.getElementById('ctrl-screen').classList.remove('active');
  document.getElementById('share-video').srcObject = null;
  isConnecting = false;
}

// ── Connect screen UI ─────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
  });
});

// Show local IPs preview when on host tab
document.querySelector('[data-tab="host"]').addEventListener('click', async () => {
  const ips = await window.voxlink.getLocalIPs();
  const el = document.getElementById('host-ips-preview');
  if (ips.length) {
    el.innerHTML = ips.map(ip => `<div class="ip-line">${ip}:${document.getElementById('inp-port-host').value}</div>`).join('');
  } else {
    el.innerHTML = '<span class="hint">No network interfaces found</span>';
  }
});

let isConnecting = false;

function tryJoin() {
  if (isConnecting) return;
  isConnecting = true;
  const btn = document.getElementById('btn-join');
  btn.disabled = true;
  btn.textContent = 'Connecting...';
  doJoin().finally(() => {
    // only reset if we didn't actually enter the room
    if (!myId) {
      isConnecting = false;
      btn.disabled = false;
      btn.textContent = 'Connect →';
    }
  });
}

function tryHost() {
  if (isConnecting) return;
  isConnecting = true;
  const btn = document.getElementById('btn-host');
  btn.disabled = true;
  btn.textContent = 'Starting...';
  doHost().finally(() => {
    if (!myId) {
      isConnecting = false;
      btn.disabled = false;
      btn.textContent = 'Start & Host →';
    }
  });
}

document.getElementById('btn-join').addEventListener('click', tryJoin);
document.getElementById('btn-host').addEventListener('click', tryHost);
document.getElementById('inp-name').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('inp-ip').focus(); });
document.getElementById('inp-ip').addEventListener('keydown', e => { if (e.key === 'Enter') tryJoin(); });
document.getElementById('inp-port-join').addEventListener('keydown', e => { if (e.key === 'Enter') tryJoin(); });
document.getElementById('inp-port-host').addEventListener('keydown', e => { if (e.key === 'Enter') tryHost(); });

async function doJoin() {
  const name = document.getElementById('inp-name').value.trim();
  const ip   = document.getElementById('inp-ip').value.trim();
  const port = parseInt(document.getElementById('inp-port-join').value) || 7842;
  if (!name) { setError('Enter your name'); return; }
  if (!ip)   { setError('Enter host IP'); return; }
  setError('');
  await enterRoom(name, `ws://${ip}:${port}`, false);
}

async function doHost() {
  const name = document.getElementById('inp-name').value.trim();
  const port = parseInt(document.getElementById('inp-port-host').value) || 7842;
  if (!name) { setError('Enter your name'); return; }
  setError('Starting server...');

  console.log('[voxlink] starting host on port', port);
  const result = await window.voxlink.startHost(port);
  console.log('[voxlink] startHost result:', JSON.stringify(result));

  if (!result.ok) { setError('Could not start server: ' + result.error); return; }
  setError('');

  // Small delay to ensure server is fully ready
  await new Promise(r => setTimeout(r, 200));

  await enterRoom(name, `ws://127.0.0.1:${result.port}`, true);
}

// ── Enter Room ────────────────────────────────────────────────────────────────
async function enterRoom(name, wsUrl, hosting) {
  myName = name;
  isHost = hosting;

  console.log('[voxlink] enterRoom', wsUrl, 'hosting=', hosting);

  // Get mic — browser NS disabled, RNNoise handles it
  const audioConstraints = {
    echoCancellation: settings.echoCancellation,
    noiseSuppression: false,
    autoGainControl: true,
    sampleRate: 48000,
    channelCount: 1,
  };

  if (settings.micDeviceId) {
    audioConstraints.deviceId = { exact: settings.micDeviceId };
  }

  try {
    rawMicStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false
    });
    localStream = rawMicStream;
    console.log('[voxlink] mic ok, tracks:', localStream.getTracks().length);
  } catch (e) {
    console.error('[voxlink] mic error:', e);
    setError('Microphone access denied: ' + e.message);
    return;
  }

  // Initialize noise suppressor — process local mic BEFORE anything else
  if (!noiseSuppressor) {
    const nsCtx = new AudioContext();
    await nsCtx.resume();
    noiseSuppressor = new NoiseSuppressor();
    await noiseSuppressor.init(nsCtx);
    await noiseSuppressor.tryEnableRNNoise();
  }
  // Build RNNoise+Gain graph on local mic — result is the stream that goes to WebRTC
  if (noiseSuppressor && noiseSuppressor.initialized) {
    try {
      const processedLocal = noiseSuppressor.processStream('self', localStream);
      localStream = processedLocal;
      noiseSuppressor.setGain(settings.inputGain / 100);
      console.log('[voxlink] local mic processed through noise suppressor');
    } catch (e) {
      console.warn('[voxlink] local noise suppression failed, using raw mic:', e);
    }
  }

  // Connect WS — wait for open or error with timeout
  const connected = await new Promise((resolve) => {
    console.log('[voxlink] connecting to', wsUrl);
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      console.error('[voxlink] ws constructor error:', e);
      resolve(false);
      return;
    }

    const timeout = setTimeout(() => {
      console.error('[voxlink] ws connection timeout');
      resolve(false);
    }, 5000);

    ws.addEventListener('open', () => {
      clearTimeout(timeout);
      console.log('[voxlink] ws connected');
      resolve(true);
    });

    ws.addEventListener('error', (e) => {
      clearTimeout(timeout);
      console.error('[voxlink] ws error event');
      resolve(false);
    });
  });

  if (!connected) {
    setError('Cannot connect to server — check IP and port');
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    ws = null;
    return;
  }

  // Send join
  ws.send(JSON.stringify({ type: 'join', name: myName, room: 'main' }));

  ws.addEventListener('message', e => {
    try { handleSignal(JSON.parse(e.data)); }
    catch (err) { console.error('[voxlink] message parse error:', err); }
  });

  ws.addEventListener('close', (e) => {
    console.log('[voxlink] ws closed', e.code, e.reason);
    if (isLeaving) return; // user initiated leave, already cleaned up
    // Connection lost — host disconnected or network issue
    if (myId) {
      console.log('[voxlink] unexpected disconnect, cleaning up');
      notify('Host disconnected');
      cleanupRoom();
      setError('Host disconnected — session ended');
      showScreen('screen-connect');
    }
  });

  ws.addEventListener('error', (e) => {
    console.error('[voxlink] ws runtime error');
    // Close to trigger the 'close' handler which shows disconnected status
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  });
}

// ── Signaling ─────────────────────────────────────────────────────────────────
async function handleSignal(msg) {
  switch (msg.type) {
    case 'error': {
      // Server rejected connection
      ws?.close();
      localStream?.getTracks().forEach(t => t.stop());
      localStream = null;
      isConnecting = false;
      myId = null;
      setError(msg.message || 'Connection rejected by server');
      showScreen('screen-connect');
      break;
    }

    case 'joined': {
      myId = msg.id;
      showRoomUI();
      // Initiate connections to all existing peers
      for (const peer of msg.peers) {
        peers.set(peer.id, {
          name: peer.name,
          pc: null,
          audioEl: null,
          stream: null,
          muted: false,
          sharingScreen: peer.sharingScreen || false,
          screenAudioStreamId: peer.screenAudioStreamId || null,
          screenAudioTrackId: peer.screenAudioTrackId || null,
        });
        await initiateCall(peer.id);
      }
      renderPeers();
      break;
    }

    case 'peer_joined': {
      peers.set(msg.id, { name: msg.name, pc: null, audioEl: null, stream: null, muted: false, sharingScreen: false });
      renderPeers();
      addVoiceCard(msg.id, msg.name);
      notify(`${msg.name} joined`);
      break;
    }

    case 'peer_left': {
      closePeer(msg.id);
      peers.delete(msg.id);
      renderPeers();
      addVoiceCard(msg.id, null); // remove card
      notify(`${msg.name} left`);
      break;
    }

    case 'screen_start': {
      const peer = peers.get(msg.from);
      if (peer) {
        peer.screenAudioStreamId = msg.audioStreamId;
        peer.screenAudioTrackId = msg.audioTrackId;
        console.log('[voxlink] screen_start from', msg.from, 'streamId:', msg.audioStreamId, 'trackId:', msg.audioTrackId);
      }
      break;
    }

    case 'mute': {
      const peer = peers.get(msg.from);
      if (peer) {
        peer.muted = msg.muted;
        const card = document.getElementById('vc-' + msg.from);
        if (card) card.classList.toggle('muted-card', msg.muted);
        renderPeers();
      }
      break;
    }

    case 'screen_stop': {
      const peer = peers.get(msg.from);
      if (peer) {
        peer.sharingScreen = false;
        peer.screenStream = null;
        renderPeers();
        updateCardLabel(msg.from);
      }
      // Hide viewer if it was showing this peer's screen
      if (viewingPeerId === msg.from) {
        viewingPeerId = null;
        const video = document.getElementById('share-video');
        video.muted = true;
        video.srcObject = null;
        document.getElementById('share-viewer').style.display = 'none';
        document.getElementById('ctrl-back-voice').style.display = 'none';
        // Restore peer mic audio
        peers.forEach(p => { if (p.audioEl) p.audioEl.muted = isDeafened; });
      }
      break;
    }

    case 'offer':  await handleOffer(msg);  break;
    case 'answer': await handleAnswer(msg); break;
    case 'ice':    await handleIce(msg);    break;
  }
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

// ── WebRTC ────────────────────────────────────────────────────────────────────
function createPC(peerId) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const peer = peers.get(peerId);
  if (!peer) return null;
  peer.pc = pc;

  // Add local mic track
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  // Add screen share track if currently sharing
  if (screenStream) {
    screenStream.getTracks().forEach(t => pc.addTrack(t, screenStream));
  }

  pc.onicecandidate = e => {
    if (e.candidate) send({ type: 'ice', to: peerId, candidate: e.candidate });
  };

  pc.ontrack = e => {
    const stream = e.streams[0];
    if (!stream) return;
    const track = e.track;

    console.log('[voxlink] ontrack from', peerId, 'kind:', track.kind, 'streams:', e.streams.length);

    if (track.kind === 'video') {
      // Screen share video
      peer.sharingScreen = true;
      peer.screenStream = stream;
      renderPeers();
      updateCardLabel(peerId);
      showSharedScreen(stream, peer.name, peerId);

      // Apply any buffered audio tracks — reclassify using screenAudioTrackId
      if (peer.pendingScreenAudio) {
        const screenAudio = [];
        const micAudio = [];
        peer.pendingScreenAudio.forEach(audioTrack => {
          // Use track ID from screen_start signal (track.streams is unreliable in WebRTC)
          if (peer.screenAudioTrackId && audioTrack.id === peer.screenAudioTrackId) {
            screenAudio.push(audioTrack);
          } else {
            micAudio.push(audioTrack);
          }
        });
        // Add screen audio to the screen stream
        screenAudio.forEach(audioTrack => {
          console.log('[voxlink] late-join screen audio matched by track id');
          stream.addTrack(audioTrack);
        });
        // Treat remaining as mic audio — only set if we don't already have audio playing
        micAudio.forEach(audioTrack => {
          console.log('[voxlink] late-join mic audio (reclassified)');
          peer.stream = new MediaStream([audioTrack]);
          if (!peer.audioEl) {
            const audio = new Audio();
            audio.autoplay = true;
            peer.audioEl = audio;
          }
          peer.audioEl.srcObject = peer.stream;
          if (isDeafened) peer.audioEl.muted = true;
          startVolumeAnalyzer(peerId, peer.stream);
        });
        peer.pendingScreenAudio = null;
        // Reassign srcObject so video element picks up new audio track
        const video = document.getElementById('share-video');
        if (video && screenAudio.length > 0) {
          const wasMuted = video.muted;
          video.srcObject = stream;
          video.muted = wasMuted;
          video.play().catch(e => console.warn('[voxlink] video play failed:', e.message));
        }
      }
    } else {
      // Audio track — identify if it's screen audio or mic audio
      console.log('[voxlink] audio track stream id:', stream.id, 'screenAudioStreamId:', peer.screenAudioStreamId);

      // Detect screen audio by multiple methods:
      // 1. Stream identity: same stream as the screen video (works for late joiners too)
      // 2. Signal-based: track/stream ID from screen_start message
      const isScreenAudio = 
        (peer.screenStream && stream.id === peer.screenStream.id) ||
        (peer.screenAudioTrackId && track.id === peer.screenAudioTrackId) ||
        (peer.screenAudioStreamId && stream.id === peer.screenAudioStreamId);
      console.log('[voxlink] isScreenAudio:', isScreenAudio);

      // Late-join: if peer is sharing screen but video hasn't arrived yet,
      // buffer this audio — we'll reclassify when video arrives
      if (!isScreenAudio && peer.sharingScreen && !peer.screenStream && !peer.stream) {
        if (!peer.pendingScreenAudio) peer.pendingScreenAudio = [];
        peer.pendingScreenAudio.push(track);
        console.log('[voxlink] buffering audio for late-join screen share');
        return;
      }

      if (isScreenAudio) {
        if (peer.screenStream) {
          // Video already arrived — add audio track and reassign srcObject
          console.log('[voxlink] screen audio added after video');
          peer.screenStream.addTrack(track);
          const video = document.getElementById('share-video');
          if (video) {
            const wasMuted = video.muted;
            video.srcObject = peer.screenStream;
            video.muted = wasMuted;
            video.play().catch(e => console.warn('[voxlink] video play failed:', e.message));
            console.log('[voxlink] video srcObject reassigned');
          }
        } else {
          // Video not arrived yet — buffer
          if (!peer.pendingScreenAudio) peer.pendingScreenAudio = [];
          peer.pendingScreenAudio.push(track);
          console.log('[voxlink] screen audio buffered (waiting for video)');
        }
        return;
      }

      // Mic audio stream - apply noise suppression
      peer.stream = stream;
      if (!peer.audioEl) {
        const audio = new Audio();
        audio.autoplay = true;
        peer.audioEl = audio;
      }
      peer.audioEl.srcObject = stream;
      if (isDeafened) peer.audioEl.muted = true;
      startVolumeAnalyzer(peerId, stream);
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      console.warn('Connection failed for peer', peerId);
    }
  };

  return pc;
}

async function initiateCall(peerId) {
  const pc = createPC(peerId);
  if (!pc) return;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ type: 'offer', to: peerId, sdp: pc.localDescription });
}

async function handleOffer(msg) {
  const peerId = msg.from;
  const existingPeer = peers.get(peerId);

  // RENEGOTIATION: reuse existing PC (e.g. screen share added)
  if (existingPeer?.pc) {
    // Glary condition: we sent an offer AND received one simultaneously.
    // Rollback is destructive (loses local tracks). Instead, ignore the
    // remote offer — our offer is already in flight and the answer will arrive.
    if (existingPeer.pc.signalingState === 'have-local-offer') {
      console.log('[voxlink] ignoring remote offer (glary condition), our offer is pending');
      return;
    }
    try {
      await existingPeer.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const answer = await existingPeer.pc.createAnswer();
      await existingPeer.pc.setLocalDescription(answer);
      send({ type: 'answer', to: peerId, sdp: existingPeer.pc.localDescription });
      console.log('[voxlink] renegotiation answer sent to', peerId);
    } catch (e) {
      console.warn('[voxlink] renegotiation failed:', e.message);
    }
    return;
  }

  // FIRST CONNECTION: create new PC
  if (!existingPeer) {
    peers.set(peerId, { name: '?', pc: null, audioEl: null, stream: null, muted: false, sharingScreen: false });
  }
  const pc = createPC(peerId);
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  send({ type: 'answer', to: peerId, sdp: pc.localDescription });
  addVoiceCard(peerId, peers.get(peerId)?.name || '?');
  renderPeers();
}

async function handleAnswer(msg) {
  const peer = peers.get(msg.from);
  if (peer?.pc) await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
  addVoiceCard(msg.from, peer?.name || '?');
}

async function handleIce(msg) {
  const peer = peers.get(msg.from);
  if (peer?.pc) {
    try { await peer.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
  }
}

function closePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  peer.pc?.close();
  if (peer.audioEl) { peer.audioEl.pause(); peer.audioEl.srcObject = null; }
  document.getElementById('vc-' + id)?.remove();
  // Cleanup per-peer volume analyzer
  if (audioCtxs.has(id)) {
    const ctx = audioCtxs.get(id);
    try { ctx.close(); } catch {}
    audioCtxs.delete(id);
  }
}

// ── Volume Analyzer ───────────────────────────────────────────────────────────
const audioCtxs = new Map();

function startVolumeAnalyzer(id, stream) {
  if (audioCtxs.has(id)) return;
  try {
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    audioCtxs.set(id, ctx);
    const data = new Uint8Array(analyser.frequencyBinCount);

    function tick() {
      const card = document.getElementById('vc-' + id);
      if (!card) { ctx.close(); audioCtxs.delete(id); return; }
      analyser.getByteFrequencyData(data);
      const vol = data.reduce((a, b) => a + b, 0) / data.length / 255;
      const speaking = vol > settings.vadThreshold / 1000;
      card.classList.toggle('speaking', speaking);
      const bars = card.querySelectorAll('.vc-bar');
      bars.forEach(b => {
        const h = Math.max(2, Math.min(16, vol * 200 * (0.5 + Math.random())));
        b.style.height = h + 'px';
      });
      requestAnimationFrame(tick);
    }
    tick();
  } catch {}
}

// Also analyze local mic
function startLocalAnalyzer() {
  if (!localStream) return;
  if (audioCtxs.has('local')) return;
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(localStream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);
  audioCtxs.set('local', ctx);
  const data = new Uint8Array(analyser.frequencyBinCount);

  function tick() {
    const card = document.getElementById('vc-me');
    if (!card) { ctx.close(); audioCtxs.delete('local'); return; }
    analyser.getByteFrequencyData(data);
    const vol = data.reduce((a, b) => a + b, 0) / data.length / 255;
    const speaking = vol > settings.vadThreshold / 1000 && !isMuted;
    card.classList.toggle('speaking', speaking);
    const bars = card.querySelectorAll('.vc-bar');
    bars.forEach(b => {
      const h = Math.max(2, Math.min(16, vol * 200 * (0.5 + Math.random())));
      b.style.height = h + 'px';
    });
    requestAnimationFrame(tick);
  }
  tick();
}

// ── Voice Cards ───────────────────────────────────────────────────────────────
function addVoiceCard(id, name) {
  if (name === null) {
    document.getElementById('vc-' + id)?.remove();
    return;
  }
  if (document.getElementById('vc-' + id)) return;
  const color = avatarColor(name);
  const card = document.createElement('div');
  card.className = 'voice-card';
  card.id = 'vc-' + id;
  card.innerHTML = `
    <div class="vc-avatar" style="background:${color}">
      ${esc(initials(name))}
      <div class="vc-mute-badge">🔇</div>
    </div>
    <div class="vc-name">${esc(name)}</div>
    <div class="vc-label" id="vc-label-${id}">${id === myId ? 'you' : ''}</div>
    <div class="vc-bars">
      <div class="vc-bar" style="height:4px"></div>
      <div class="vc-bar" style="height:8px"></div>
      <div class="vc-bar" style="height:4px"></div>
      <div class="vc-bar" style="height:10px"></div>
      <div class="vc-bar" style="height:4px"></div>
    </div>
  `;
  // Click to view/hide this peer's screen
  card.addEventListener('click', () => switchToScreen(id));
  // Right-click context menu for volume (skip self)
  card.addEventListener('contextmenu', (e) => {
    if (id === myId) return;
    e.preventDefault();
    e.stopPropagation();
    showCtxMenu(e.clientX, e.clientY, id, name);
  });
  document.getElementById('voice-grid').appendChild(card);
}

function switchToScreen(peerId) {
  const peer = peers.get(peerId);
  if (!peer?.sharingScreen || !peer?.screenStream) return;

  // If already watching this peer — go back to grid
  if (viewingPeerId === peerId) {
    viewingPeerId = null;
    const video = document.getElementById('share-video');
    video.muted = true;
    video.srcObject = null;
    document.getElementById('share-viewer').style.display = 'none';
    document.getElementById('ctrl-back-voice').style.display = 'none';
    document.querySelectorAll('.voice-card').forEach(c => c.classList.remove('viewing-screen'));
    // Restore peer mic audio
    peers.forEach(p => { if (p.audioEl) p.audioEl.muted = isDeafened; });
    return;
  }

  // Remove old viewing highlight
  document.querySelectorAll('.voice-card').forEach(c => c.classList.remove('viewing-screen'));
  // Highlight the card we're switching to
  document.getElementById('vc-' + peerId)?.classList.add('viewing-screen');

  showSharedScreen(peer.screenStream, peer.name, peerId);
}

function updateCardLabel(id) {
  const label = document.getElementById('vc-label-' + id);
  const card = document.getElementById('vc-' + id);
  if (!label || !card) return;
  const peer = peers.get(id);
  if (peer?.sharingScreen) {
    label.innerHTML = '🖥 click to view';
    label.style.color = 'var(--accent)';
    label.style.fontSize = '10px';
    card.classList.add('has-screen');
  } else {
    label.textContent = id === myId ? 'you' : '';
    label.style.color = '';
    card.classList.remove('has-screen');
    card.classList.remove('viewing-screen');
  }
}

function addMyCard() {
  const color = avatarColor(myName);
  const card = document.createElement('div');
  card.className = 'voice-card';
  card.id = 'vc-me';
  card.innerHTML = `
    <div class="vc-avatar" style="background:${color}">
      ${esc(initials(myName))}
      <div class="vc-mute-badge">🔇</div>
    </div>
    <div class="vc-name">${esc(myName)}</div>
    <div class="vc-label">you</div>
    <div class="vc-bars">
      <div class="vc-bar" style="height:4px"></div>
      <div class="vc-bar" style="height:8px"></div>
      <div class="vc-bar" style="height:4px"></div>
      <div class="vc-bar" style="height:10px"></div>
      <div class="vc-bar" style="height:4px"></div>
    </div>
  `;
  document.getElementById('voice-grid').insertBefore(card, document.getElementById('voice-grid').firstChild);
  startLocalAnalyzer();
}

// ── Peers Sidebar ─────────────────────────────────────────────────────────────
function renderPeers() {
  const list = document.getElementById('peers-list');
  list.innerHTML = '';

  // Section: participants
  const label = document.createElement('div');
  label.className = 'peers-label';
  label.textContent = `Participants — ${peers.size + 1}`;
  list.appendChild(label);

  // Me
  const meRow = makePeerRow(myId, myName, { muted: isMuted, sharingScreen: isSharingScreen, isMe: true });
  list.appendChild(meRow);

  // Others
  peers.forEach((peer, id) => {
    list.appendChild(makePeerRow(id, peer.name, { muted: peer.muted, sharingScreen: peer.sharingScreen }));
  });

  // Update peer count badge
  const badge = document.getElementById('peer-count-badge');
  if (badge) badge.textContent = peers.size + 1;
}

function makePeerRow(id, name, { muted, sharingScreen, isMe } = {}) {
  const row = document.createElement('div');
  row.className = 'peer-row';
  row.id = 'pr-' + id;
  const color = avatarColor(name);
  row.innerHTML = `
    <div class="avatar ${muted ? 'muted' : ''}" style="background:${color}">${esc(initials(name))}</div>
    <span class="peer-name">${esc(name)}${isMe ? ' <span style="font-size:10px;color:var(--muted)">(you)</span>' : ''}</span>
    <span class="peer-icons">
      ${muted ? '<span class="peer-icon-mute" title="Muted">🔇</span>' : ''}
      ${sharingScreen ? '<span class="peer-icon-screen" title="Sharing screen">🖥</span>' : ''}
    </span>
  `;
  return row;
}

// ── Controls ──────────────────────────────────────────────────────────────────
document.getElementById('ctrl-mute').addEventListener('click', () => {
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  document.getElementById('ctrl-mute').classList.toggle('danger', isMuted);
  document.getElementById('vc-me')?.classList.toggle('muted-card', isMuted);
  // Notify all peers of mute state
  send({ type: 'mute', muted: isMuted });
  renderPeers();
});

// Noise suppression toggle
document.getElementById('ctrl-ns').addEventListener('click', () => {
  isNoiseSuppression = !isNoiseSuppression;
  settings.nsEnabled = isNoiseSuppression;
  saveSettings();
  const btn = document.getElementById('ctrl-ns');
  btn.classList.toggle('active', isNoiseSuppression);
  // Sync settings modal checkbox
  const nsChk = document.getElementById('set-ns-enabled');
  if (nsChk) nsChk.checked = isNoiseSuppression;
  // Toggle noise suppression bypass — graph stays active, only internal logic changes
  if (noiseSuppressor) {
    noiseSuppressor.setEnabled(isNoiseSuppression);
  }
});

// Initialize NS button state
document.getElementById('ctrl-ns').classList.add('active');

document.getElementById('ctrl-deafen').addEventListener('click', () => {
  isDeafened = !isDeafened;
  peers.forEach(peer => { if (peer.audioEl) peer.audioEl.muted = isDeafened; });
  document.getElementById('ctrl-deafen').classList.toggle('danger', isDeafened);
});

document.getElementById('ctrl-leave').addEventListener('click', async () => {
  isLeaving = true;
  await stopScreenShare();
  ws?.close();
  if (isHost) await window.voxlink.stopHost();
  cleanupRoom();
  showScreen('screen-connect');
});

// ── Screen Share ──────────────────────────────────────────────────────────────
document.getElementById('ctrl-screen').addEventListener('click', () => {
  if (isSharingScreen) {
    stopScreenShare();
  } else {
    openScreenPicker();
  }
});

async function openScreenPicker() {
  const sources = await window.voxlink.getScreenSources();
  const grid = document.getElementById('source-grid');
  grid.innerHTML = '';
  selectedSourceId = null;
  document.getElementById('modal-share').disabled = true;

  sources.forEach(src => {
    const item = document.createElement('div');
    item.className = 'source-item';
    item.dataset.id = src.id;
    item.innerHTML = `
      <img class="source-thumb" src="${src.thumbnail}" alt="${esc(src.name)}"/>
      <div class="source-name">${esc(src.name)}</div>
    `;
    item.addEventListener('click', () => {
      grid.querySelectorAll('.source-item').forEach(i => i.classList.remove('selected'));
      item.classList.add('selected');
      selectedSourceId = src.id;
      document.getElementById('modal-share').disabled = false;
    });
    grid.appendChild(item);
  });

  document.getElementById('modal-screen').style.display = 'flex';
}

document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-cancel').addEventListener('click', closeModal);
function closeModal() { document.getElementById('modal-screen').style.display = 'none'; }

document.getElementById('modal-share').addEventListener('click', async () => {
  if (!selectedSourceId) return;
  window._selectedSourceId = selectedSourceId;
  const shareAudio = document.getElementById('chk-share-audio').checked;
  closeModal();
  await startScreenShare(selectedSourceId, shareAudio);
});

function setContentHint(stream) {
  // Tell WebRTC this is screen content (text/detail) not camera (motion)
  // This makes the encoder prioritize sharpness over smoothness
  for (const track of stream.getVideoTracks()) {
    if ('contentHint' in track) {
      track.contentHint = 'detail';  // 'detail' = screen/text, 'motion' = camera
      console.log('[voxlink] contentHint set to detail');
    }
  }
}

async function startScreenShare(sourceId, shareAudio = false) {
  // Don't mute peers on the sharer's side - sharer should hear everyone

  try {
    const isLinux = navigator.userAgent.includes('Linux');
    let videoStream, audioStream = null;

    if (shareAudio && !isLinux && window.audioLoopback) {
      // Windows with audio: single getDisplayMedia for video + loopback audio
      // Two separate captures (getUserMedia + getDisplayMedia) conflict on Windows
      try {
        await window.audioLoopback.enable();
        await new Promise(r => setTimeout(r, 300));
        const combined = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48000,
            channelCount: 2,
          },
        });
        videoStream = new MediaStream(combined.getVideoTracks());
        audioStream = new MediaStream(combined.getAudioTracks());
        console.log('[voxlink] Windows combined capture, video tracks:', videoStream.getVideoTracks().length, 'audio tracks:', audioStream.getAudioTracks().length);
      } catch(e) {
        console.warn('[voxlink] Windows combined capture failed, falling back to video-only:', e.message);
        videoStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: getVideoConstraints(),
        });
      }
    } else {
      // Linux or no audio: get video via Electron desktopCapturer
      videoStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: getVideoConstraints(),
      });
    }

    if (shareAudio && isLinux && window.pipewire) {
      // Linux: use PipeWire virtual sink to capture system audio excluding our app
      try {
        const pw = await window.pipewire.start();
        if (pw.ok) {
          console.log('[voxlink] PipeWire sink ready:', pw.sinkName);

          await new Promise(r => setTimeout(r, 500));

          let micDevice = null;
          for (let attempt = 0; attempt < 5; attempt++) {
            const devices = await navigator.mediaDevices.enumerateDevices();
            micDevice = devices.find(d =>
              d.kind === 'audioinput' && d.label.toLowerCase().includes('voxlink')
            );
            if (micDevice) break;
            console.log(`[voxlink] voxlink_mic not found, retry ${attempt + 1}/5...`);
            await new Promise(r => setTimeout(r, 600));
          }
          console.log('[voxlink] voxlink_mic device:', micDevice?.label, micDevice?.deviceId);

          if (micDevice) {
            const pwStream = await navigator.mediaDevices.getUserMedia({
              audio: {
                deviceId: { exact: micDevice.deviceId },
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
              },
              video: false,
            }).catch(e => { console.warn('[voxlink] voxlink_mic capture failed:', e.message); return null; });

            if (pwStream) {
              audioStream = pwStream;
              console.log('[voxlink] voxlink_mic captured, tracks:', pwStream.getAudioTracks().length);
            }
          } else {
            console.warn('[voxlink] voxlink_mic not found in devices');
          }
        }
      } catch(e) {
        console.warn('[voxlink] PipeWire setup failed:', e.message);
      }
    }

    if (audioStream && audioStream.getAudioTracks().length > 0) {
      screenStream = new MediaStream([
        ...videoStream.getVideoTracks(),
        ...audioStream.getAudioTracks(),
      ]);
    } else {
      console.warn('[voxlink] no audio captured, video only');
      screenStream = videoStream;
    }

  } catch (e) {
    alert('Screen capture failed: ' + e.message);
    return;
  }
  if (screenStream.getAudioTracks().length > 0) {
    console.log('[voxlink] screen audio will be shared — peers kept audible (PipeWire/loopback isolates app audio)');
  }
    // Tell encoder this is screen content (sharp text), not motion video
    setContentHint(screenStream);

    // Apply quality constraints on the capture track
    const videoTrack = screenStream.getVideoTracks()[0];
    if (videoTrack) {
      const [w, h] = settings.videoRes.split('x').map(Number);
      const fps = parseInt(settings.videoFps) || 30;
      try {
        await videoTrack.applyConstraints({
          width: { ideal: w, max: w },
          height: { ideal: h, max: h },
          frameRate: { ideal: fps, min: Math.min(fps, 10) },
        });
        console.log('[voxlink] screen track settings:', JSON.stringify(videoTrack.getSettings()));
      } catch (e) {
        console.warn('[voxlink] applyConstraints failed (non-fatal):', e.message);
      }
    }


  isSharingScreen = true;
  document.getElementById('ctrl-screen').classList.add('active');
  renderPeers();

  // Show local preview — muted so sharer doesn't hear their own screen audio
  const shareViewer = document.getElementById('share-viewer');
  const shareVideo = document.getElementById('share-video');
  shareVideo.srcObject = screenStream;
  shareVideo.muted = true;  // prevent self-echo
  document.getElementById('share-bar-label').textContent = 'You are sharing your screen';
  shareViewer.style.display = 'flex';

  // Send screen_start BEFORE renegotiate so viewers store audioStreamId before ontrack fires
  const screenAudioTrack = screenStream.getAudioTracks()[0];
  console.log('[voxlink] screenStream.id:', screenStream.id, 'audio track id:', screenAudioTrack?.id);
  console.log('[voxlink] all stream tracks:', screenStream.getTracks().map(t => t.kind + ':' + t.id));
  send({ 
    type: 'screen_start', 
    hasAudio: !!screenAudioTrack,
    audioStreamId: screenAudioTrack ? screenStream.id : null,
    audioTrackId: screenAudioTrack ? screenAudioTrack.id : null,
  });

  // Small delay to let screen_start arrive before tracks
  await new Promise(r => setTimeout(r, 100));

  // Add all tracks (video + system audio) to peer connections
  const screenTracks = screenStream.getTracks();
  console.log('[voxlink] adding tracks to peers:', screenTracks.map(t => t.kind + ':' + t.label));
  peers.forEach(peer => {
    if (peer.pc) {
      screenTracks.forEach(track => peer.pc.addTrack(track, screenStream));
      renegotiate(peer.pc, peer);
    }
  });

  // Force high bitrate after renegotiation settles (try twice for reliability)
  setTimeout(() => forceHighBitrate(), 1000);
  setTimeout(() => forceHighBitrate(), 3000);

  // Stop sharing when stream ends (user closes via OS)
  screenStream.getVideoTracks()[0].addEventListener('ended', () => stopScreenShare());
}

async function stopScreenShare() {
  if (!isSharingScreen) return;
  isSharingScreen = false;

  // Remove screen video+audio senders from all PCs so we can addTrack again later
  const screenTracks = screenStream ? screenStream.getTracks() : [];
  peers.forEach(peer => {
    if (!peer.pc) return;
    peer.pc.getSenders().forEach(sender => {
      if (sender.track && screenTracks.includes(sender.track)) {
        try { peer.pc.removeTrack(sender); } catch (e) {}
      }
    });
    // Renegotiate so remote side detects track removal
    if (peer.pc.signalingState === 'stable') {
      peer.pc.createOffer().then(offer => {
        return peer.pc.setLocalDescription(offer);
      }).then(() => {
        for (const [id, p] of peers) {
          if (p === peer) { send({ type: 'offer', to: id, sdp: peer.pc.localDescription }); break; }
        }
      }).catch(e => console.warn('[voxlink] renegotiate after removeTrack failed:', e.message));
    }
  });

  screenStream?.getTracks().forEach(t => t.stop());
  screenStream = null;

  // Teardown PipeWire virtual sink on Linux
  if (window.pipewire) {
    await window.pipewire.stop().catch(e => console.warn('[voxlink] pipewire stop:', e.message));
  }

  // Cleanup audio loopback on Windows so audio routing is restored
  if (window.audioLoopback) {
    await window.audioLoopback.disable().catch(e => console.warn('[voxlink] loopback disable:', e.message));
  }

  // Restore peer audio in case deafen was on
  peers.forEach(peer => { if (peer.audioEl) peer.audioEl.muted = isDeafened; });

  document.getElementById('ctrl-screen').classList.remove('active');
  document.getElementById('share-viewer').style.display = 'none';
  document.getElementById('ctrl-back-voice').style.display = 'none';
  document.getElementById('share-video').srcObject = null;
  renderPeers();

  // Notify all peers that screen share stopped
  send({ type: 'screen_stop' });
}

async function forceHighBitrate() {
  for (const [id, peer] of peers) {
    if (!peer.pc) continue;
    for (const sender of peer.pc.getSenders()) {
      if (!sender.track || sender.track.kind !== 'video') continue;
      try {
        // ONE setParameters call — Chromium rejects if you call it twice in a row
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        // degradationPreference goes on the top-level params object, not encodings
        params.degradationPreference = 'maintain-resolution';
        params.encodings[0].maxBitrate = 10_000_000; // 10 Mbps
        params.encodings[0].scaleResolutionDownBy = 1.0;
        params.encodings[0].maxFramerate = parseInt(settings.videoFps) || 30;
        await sender.setParameters(params);
        console.log('[voxlink] quality params set for peer', id);
      } catch (e) {
        console.warn('[voxlink] setParameters failed:', e.message);
      }
    }
  }
}

function preferVideoCodec(sdp, codec) {
  // Move preferred codec to top of m=video section
  const lines = sdp.split('\r\n');
  const mVideoIdx = lines.findIndex(l => l.startsWith('m=video'));
  if (mVideoIdx === -1) return sdp;

  // Find payload types for codec
  const codecPts = [];
  lines.forEach(l => {
    const m = l.match(/^a=rtpmap:(\d+) (VP9|H264|VP8)/i);
    if (m && m[2].toUpperCase() === codec.toUpperCase()) codecPts.push(m[1]);
  });
  if (codecPts.length === 0) return sdp;

  // Reorder m=video payload types
  const mLine = lines[mVideoIdx].split(' ');
  const header = mLine.slice(0, 3);
  const pts = mLine.slice(3);
  const reordered = [
    ...codecPts.filter(p => pts.includes(p)),
    ...pts.filter(p => !codecPts.includes(p))
  ];
  lines[mVideoIdx] = [...header, ...reordered].join(' ');
  return lines.join('\r\n');
}

async function renegotiate(pc, peer) {
  try {
    const offer = await pc.createOffer();
    // Prefer VP9 for better screen share quality
    const mungedSdp = preferVideoCodec(offer.sdp, 'VP9');
    await pc.setLocalDescription({ type: offer.type, sdp: mungedSdp });
    for (const [id, p] of peers) {
      if (p === peer) { send({ type: 'offer', to: id, sdp: pc.localDescription }); break; }
    }
  } catch (e) {
    console.warn('[voxlink] renegotiate failed:', e.message);
  }
}

// Close shared screen view
document.getElementById('share-close').addEventListener('click', closeScreenViewer);
document.getElementById('ctrl-back-voice').addEventListener('click', closeScreenViewer);

// Right-click on shared screen for volume
document.getElementById('share-viewer').addEventListener('contextmenu', (e) => {
  if (!viewingPeerId) return;
  e.preventDefault();
  e.stopPropagation();
  const peer = peers.get(viewingPeerId);
  const name = peer?.name || '?';
  // Override ctx slider to control share-video volume
  ctxTargetPeerId = viewingPeerId;
  const menu = document.getElementById('ctx-menu');
  const title = document.getElementById('ctx-title');
  const slider = document.getElementById('ctx-volume');
  const valEl = document.getElementById('ctx-volume-val');

  title.textContent = name + ' (screen)';
  const video = document.getElementById('share-video');
  const vol = Math.round(video.volume * 100);
  slider.value = vol;
  valEl.textContent = vol + '%';

  menu.style.display = 'block';
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(e.clientX, window.innerWidth - rect.width - 8) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - rect.height - 8) + 'px';
});

function closeScreenViewer() {
  const video = document.getElementById('share-video');
  video.muted = true;
  video.srcObject = null;
  viewingPeerId = null;
  document.querySelectorAll('.voice-card').forEach(c => c.classList.remove('viewing-screen'));
  document.getElementById('share-viewer').style.display = 'none';
  document.getElementById('ctrl-back-voice').style.display = 'none';
  // Restore peer mic audio (unless user has deafen on)
  peers.forEach(peer => {
    if (peer.audioEl) peer.audioEl.muted = isDeafened;
  });
}

function showSharedScreen(stream, peerName, peerId) {
  viewingPeerId = peerId || null;
  const video = document.getElementById('share-video');
  video.srcObject = stream;
  video.muted = false;
  video.play().catch(e => console.warn('[voxlink] play failed:', e.message));
  document.getElementById('share-bar-label').textContent = `${peerName} is sharing their screen`;
  document.getElementById('share-viewer').style.display = 'flex';
  document.getElementById('ctrl-back-voice').style.display = 'flex';
}

// ── Room UI init ──────────────────────────────────────────────────────────────
function showRoomUI() {
  showScreen('screen-room');
  document.getElementById('my-name-sb').textContent = myName;
  document.getElementById('my-avatar-sb').textContent = initials(myName);
  document.getElementById('my-avatar-sb').style.background = avatarColor(myName);
  document.getElementById('my-role-sb').textContent = isHost ? 'host' : 'guest';
  addMyCard();
  renderPeers();
}

// ── Notifications ─────────────────────────────────────────────────────────────
function notify(body) {
  window.voxlink.showNotification({ title: 'VoxLink', body });
}

// ── Settings ──────────────────────────────────────────────────────────────────
const SETTINGS_KEY = 'voxlink_settings';
const defaultSettings = {
  micDeviceId: '',
  outputDeviceId: '',
  inputGain: 100,
  vadThreshold: 15,
  nsEnabled: true,
  echoCancellation: true,
  pttEnabled: false,
  pttKey: '',
  videoRes: '1920x1080',
  videoFps: '30',
  peerVolumes: {},
};

let settings = { ...defaultSettings };
let pttPressed = false;
let pttListening = false;

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) settings = { ...defaultSettings, ...JSON.parse(raw) };
  } catch {}
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}

function applySettings() {
  // Input gain
  applyInputGain();

  // NS
  if (noiseSuppressor) noiseSuppressor.setEnabled(settings.nsEnabled);
  document.getElementById('ctrl-ns').classList.toggle('active', settings.nsEnabled);
  isNoiseSuppression = settings.nsEnabled;

  // Update NS toggle in modal
  const nsChk = document.getElementById('set-ns-enabled');
  if (nsChk) nsChk.checked = settings.nsEnabled;

  // Echo cancellation — applies on reconnect
  const ecChk = document.getElementById('set-echo-cancellation');
  if (ecChk) ecChk.checked = settings.echoCancellation;

  // VAD threshold
  const vadChk = document.getElementById('set-vad-threshold');
  const vadVal = document.getElementById('set-vad-threshold-val');
  if (vadChk) vadChk.value = settings.vadThreshold;
  if (vadVal) vadVal.textContent = settings.vadThreshold;

  // Input gain slider
  const gainSlider = document.getElementById('set-input-gain');
  const gainVal = document.getElementById('set-input-gain-val');
  if (gainSlider) gainSlider.value = settings.inputGain;
  if (gainVal) gainVal.textContent = settings.inputGain + '%';

  // PTT
  const pttChk = document.getElementById('set-ptt-enabled');
  const pttKeyRow = document.getElementById('set-ptt-key-row');
  if (pttChk) pttChk.checked = settings.pttEnabled;
  if (pttKeyRow) pttKeyRow.style.display = settings.pttEnabled ? 'flex' : 'none';
  updatePTTKeyLabel();

  // Video
  const resSel = document.getElementById('set-video-res');
  const fpsSel = document.getElementById('set-video-fps');
  if (resSel) resSel.value = settings.videoRes;
  if (fpsSel) fpsSel.value = settings.videoFps;

  // Peer volumes
  applyPeerVolumes();
}

function applyPeerVolumes() {
  peers.forEach((peer, id) => {
    if (!peer.audioEl) return;
    const vol = settings.peerVolumes[id] ?? 100;
    peer.audioEl.volume = vol / 100;
  });
}

function renderPeerVolumeSliders() {
  const container = document.getElementById('set-peer-volumes');
  if (!container) return;
  container.innerHTML = '';

  peers.forEach((peer, id) => {
    const vol = settings.peerVolumes[id] ?? 100;
    const row = document.createElement('div');
    row.className = 'peer-vol-row';
    row.innerHTML = `
      <span class="peer-vol-name">${esc(peer.name)}</span>
      <input type="range" min="0" max="200" value="${vol}" class="settings-slider peer-vol-slider" data-peer-id="${id}"/>
      <span class="settings-value">${vol}%</span>
    `;
    const slider = row.querySelector('.settings-slider');
    const valEl = row.querySelector('.settings-value');
    slider.addEventListener('input', () => {
      const v = parseInt(slider.value);
      valEl.textContent = v + '%';
      settings.peerVolumes[id] = v;
      if (peer.audioEl) peer.audioEl.volume = v / 100;
      saveSettings();
    });
    container.appendChild(row);
  });
}

// ── Settings Modal ────────────────────────────────────────────────────────────
document.getElementById('ctrl-settings').addEventListener('click', async () => {
  document.getElementById('modal-settings').style.display = 'flex';
  await enumerateAudioDevices();
  renderPeerVolumeSliders();
  applySettings();
});

document.getElementById('settings-close').addEventListener('click', () => {
  document.getElementById('modal-settings').style.display = 'none';
});

// Close on backdrop click
document.getElementById('modal-settings').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal-settings')) {
    document.getElementById('modal-settings').style.display = 'none';
  }
});

// ── Device Enumeration ────────────────────────────────────────────────────────
async function enumerateAudioDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const micSelect = document.getElementById('set-mic-device');
    const outSelect = document.getElementById('set-output-device');

    const mics = devices.filter(d => d.kind === 'audioinput');
    const outputs = devices.filter(d => d.kind === 'audiooutput');

    micSelect.innerHTML = mics.length === 0
      ? '<option value="">No microphones found</option>'
      : mics.map(d => `<option value="${esc(d.deviceId)}" ${d.deviceId === settings.micDeviceId ? 'selected' : ''}>${esc(d.label || 'Microphone')}</option>`).join('');

    outSelect.innerHTML = outputs.length === 0
      ? '<option value="">No output devices found</option>'
      : outputs.map(d => `<option value="${esc(d.deviceId)}" ${d.deviceId === settings.outputDeviceId ? 'selected' : ''}>${esc(d.label || 'Speaker')}</option>`).join('');
  } catch (e) {
    console.warn('[settings] enumerateDevices failed:', e);
  }
}

// ── Settings Change Handlers ──────────────────────────────────────────────────
document.getElementById('set-mic-device').addEventListener('change', async (e) => {
  settings.micDeviceId = e.target.value;
  saveSettings();
  if (localStream) {
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: settings.micDeviceId ? { exact: settings.micDeviceId } : undefined,
          echoCancellation: settings.echoCancellation,
          noiseSuppression: false,
          autoGainControl: true,
          sampleRate: 48000,
          channelCount: 1,
        },
        video: false,
      });
      const newAudioTrack = newStream.getAudioTracks()[0];
      if (newAudioTrack) {
        // Stop OLD raw mic (not the processed destination stream!)
        if (rawMicStream) {
          rawMicStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
        }
        rawMicStream = newStream;
        let processedStream = newStream;
        if (noiseSuppressor && noiseSuppressor.initialized) {
          try {
            processedStream = noiseSuppressor.processStream('self', newStream);
            noiseSuppressor.setGain(settings.inputGain / 100);
          } catch (err) {
            console.warn('[voxlink] noise suppression failed for new mic:', err);
          }
        }
        localStream = processedStream;
        // Update all peer connections
        const finalTrack = localStream.getAudioTracks()[0];
        if (finalTrack) {
          peers.forEach(peer => {
            if (!peer.pc) return;
            const sender = peer.pc.getSenders().find(s => s.track?.kind === 'audio');
            if (sender) sender.replaceTrack(finalTrack);
          });
        }
      }
    } catch (err) {
      console.warn('[settings] mic switch failed:', err);
    }
  }
});

document.getElementById('set-output-device').addEventListener('change', async (e) => {
  settings.outputDeviceId = e.target.value;
  saveSettings();
  // Apply to all peer audio elements
  try {
    peers.forEach(peer => {
      if (peer.audioEl && typeof peer.audioEl.setSinkId === 'function') {
        peer.audioEl.setSinkId(settings.outputDeviceId).catch(() => {});
      }
    });
  } catch {}
});

document.getElementById('set-input-gain').addEventListener('input', (e) => {
  settings.inputGain = parseInt(e.target.value);
  document.getElementById('set-input-gain-val').textContent = settings.inputGain + '%';
  applyInputGain();
  saveSettings();
});

document.getElementById('set-vad-threshold').addEventListener('input', (e) => {
  settings.vadThreshold = parseInt(e.target.value);
  document.getElementById('set-vad-threshold-val').textContent = settings.vadThreshold;
  saveSettings();
});

document.getElementById('set-ns-enabled').addEventListener('change', (e) => {
  settings.nsEnabled = e.target.checked;
  saveSettings();
  applySettings();
  // Toggle bypass on the local mic graph — no stream re-processing needed
  if (noiseSuppressor) {
    noiseSuppressor.setEnabled(settings.nsEnabled);
  }
});

document.getElementById('set-echo-cancellation').addEventListener('change', (e) => {
  settings.echoCancellation = e.target.checked;
  saveSettings();
  // Will take effect on next mic acquisition
});

document.getElementById('set-ptt-enabled').addEventListener('change', (e) => {
  settings.pttEnabled = e.target.checked;
  document.getElementById('set-ptt-key-row').style.display = settings.pttEnabled ? 'flex' : 'none';
  saveSettings();
  if (!settings.pttEnabled) {
    // Unmute if PTT disabled while muted
    if (isMuted) {
      isMuted = false;
      localStream.getAudioTracks().forEach(t => t.enabled = true);
      document.getElementById('ctrl-mute').classList.remove('danger');
      document.getElementById('vc-me')?.classList.remove('muted-card');
      send({ type: 'mute', muted: false });
      renderPeers();
    }
  }
});

// PTT key capture
document.getElementById('set-ptt-key-btn').addEventListener('click', () => {
  const btn = document.getElementById('set-ptt-key-btn');
  if (pttListening) return;
  pttListening = true;
  btn.textContent = 'Press a key...';
  btn.classList.add('listening');

  function onKey(e) {
    e.preventDefault();
    e.stopPropagation();
    settings.pttKey = e.code;
    saveSettings();
    updatePTTKeyLabel();
    pttListening = false;
    btn.classList.remove('listening');
    document.removeEventListener('keydown', onKey, true);
  }
  document.addEventListener('keydown', onKey, true);
});

function updatePTTKeyLabel() {
  const btn = document.getElementById('set-ptt-key-btn');
  if (!btn) return;
  if (!settings.pttKey) {
    btn.textContent = 'Press a key...';
  } else {
    // Pretty print key name
    const key = settings.pttKey
      .replace('Key', '')
      .replace('Digit', '')
      .replace('Arrow', '↑↓←→'.includes(settings.pttKey.slice(-1)) ? settings.pttKey : 'Arrow ')
      .replace('Space', 'Space');
    btn.textContent = key || settings.pttKey;
  }
}

// PTT global key handlers
document.addEventListener('keydown', (e) => {
  if (!settings.pttEnabled || !settings.pttKey || pttListening) return;
  if (e.code === settings.pttKey && !e.repeat) {
    e.preventDefault();
    pttPressed = true;
    if (isMuted) {
      isMuted = false;
      localStream.getAudioTracks().forEach(t => t.enabled = true);
      document.getElementById('ctrl-mute').classList.remove('danger');
      document.getElementById('vc-me')?.classList.remove('muted-card');
      send({ type: 'mute', muted: false });
      renderPeers();
    }
  }
});

document.addEventListener('keyup', (e) => {
  if (!settings.pttEnabled || !settings.pttKey) return;
  if (e.code === settings.pttKey) {
    e.preventDefault();
    pttPressed = false;
    if (!isMuted) {
      isMuted = true;
      localStream.getAudioTracks().forEach(t => t.enabled = false);
      document.getElementById('ctrl-mute').classList.add('danger');
      document.getElementById('vc-me')?.classList.add('muted-card');
      send({ type: 'mute', muted: true });
      renderPeers();
    }
  }
});

// ── Input Gain ────────────────────────────────────────────────────────────────
function applyInputGain() {
  if (noiseSuppressor) {
    noiseSuppressor.setGain(settings.inputGain / 100);
  }
}

// ── Video Quality Helper ──────────────────────────────────────────────────────
function getVideoConstraints() {
  const [w, h] = settings.videoRes.split('x').map(Number);
  const fps = parseInt(settings.videoFps) || 30;
  return {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: window._selectedSourceId,
      minWidth: Math.min(w, 640),
      maxWidth: w,
      minHeight: Math.min(h, 360),
      maxHeight: h,
      minFrameRate: Math.min(fps, 10),
      maxFrameRate: fps,
    }
  };
}

// ── Context Menu (right-click volume) ────────────────────────────────────────
let ctxTargetPeerId = null;

function showCtxMenu(x, y, peerId, name) {
  ctxTargetPeerId = peerId;
  const menu = document.getElementById('ctx-menu');
  const title = document.getElementById('ctx-title');
  const slider = document.getElementById('ctx-volume');
  const valEl = document.getElementById('ctx-volume-val');

  title.textContent = name;
  const vol = settings.peerVolumes[peerId] ?? 100;
  slider.value = vol;
  valEl.textContent = vol + '%';

  // Position menu, keeping it on-screen
  menu.style.display = 'block';
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
}

function hideCtxMenu() {
  document.getElementById('ctx-menu').style.display = 'none';
  ctxTargetPeerId = null;
}

document.getElementById('ctx-volume').addEventListener('input', (e) => {
  if (!ctxTargetPeerId) return;
  const vol = parseInt(e.target.value);
  document.getElementById('ctx-volume-val').textContent = vol + '%';

  // Check if we're controlling screen share volume
  const menuTitle = document.getElementById('ctx-title').textContent;
  if (menuTitle.includes('(screen)')) {
    const video = document.getElementById('share-video');
    video.volume = vol / 100;
  } else {
    settings.peerVolumes[ctxTargetPeerId] = vol;
    const peer = peers.get(ctxTargetPeerId);
    if (peer?.audioEl) peer.audioEl.volume = vol / 100;
    saveSettings();
  }
});

// Close on click outside
document.addEventListener('click', (e) => {
  if (!document.getElementById('ctx-menu').contains(e.target)) {
    hideCtxMenu();
  }
});
document.addEventListener('contextmenu', (e) => {
  if (!document.getElementById('ctx-menu').contains(e.target)) {
    hideCtxMenu();
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
loadSettings();
applySettings();
document.getElementById('inp-name').focus();
