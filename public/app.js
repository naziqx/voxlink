'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const AVATAR_COLORS = ['#5865f2','#23a55a','#eb459e','#fee75c','#ed4245','#57f287','#9b59b6','#e67e22'];

// ── State ─────────────────────────────────────────────────────────────────────
let myId = null, myName = '', isHost = false;
let ws = null;
let localStream = null;      // microphone
let screenStream = null;     // screen share (outgoing)
let isMuted = false, isDeafened = false, isSharingScreen = false;

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

  // Get mic
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false
    });
    console.log('[voxlink] mic ok, tracks:', localStream.getTracks().length);
  } catch (e) {
    console.error('[voxlink] mic error:', e);
    setError('Microphone access denied: ' + e.message);
    return;
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
    const el = document.getElementById('room-conn-status');
    if (el) { el.textContent = '● Disconnected'; el.style.color = 'var(--red)'; }
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
        peers.set(peer.id, { name: peer.name, pc: null, audioEl: null, stream: null, muted: false, sharingScreen: false });
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
        document.getElementById('voice-grid').style.display = 'flex';
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

      // Apply any buffered screen audio tracks that arrived before video
      if (peer.pendingScreenAudio) {
        peer.pendingScreenAudio.forEach(audioTrack => {
          console.log('[voxlink] applying buffered screen audio track');
          stream.addTrack(audioTrack);
        });
        peer.pendingScreenAudio = null;
        // Reassign srcObject so video element picks up new audio track
        const video = document.getElementById('share-video');
        if (video) {
          const wasMuted = video.muted;
          video.srcObject = stream;
          video.muted = wasMuted;
          video.play().catch(e => console.warn('[voxlink] video play failed:', e.message));
          console.log('[voxlink] video srcObject reassigned with audio');
        }
      }
    } else {
      // Audio track — check if it belongs to screen stream (same stream id)
      // or is a mic stream (different stream id)
      console.log('[voxlink] audio track stream id:', stream.id, 'screenAudioStreamId:', peer.screenAudioStreamId);

      // Identify screen audio: match by track id or stream id sent in screen_start signal.
      // Note: _isScreenAudio and label checks don't cross WebRTC (receiver gets different objects).
      const isScreenAudio = 
        (peer.screenAudioTrackId && track.id === peer.screenAudioTrackId) ||
        (peer.screenAudioStreamId && stream.id === peer.screenAudioStreamId);
      console.log('[voxlink] isScreenAudio:', isScreenAudio, 'track.id:', track.id, 'expected:', peer.screenAudioTrackId);

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

      // Mic audio stream
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
    try {
      // Handle glary condition: both sides sent offer simultaneously
      if (existingPeer.pc.signalingState === 'have-local-offer') {
        await existingPeer.pc.setLocalDescription({ type: 'rollback' });
      }
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
      const speaking = vol > 0.015;
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
    const speaking = vol > 0.015 && !isMuted;
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
    document.getElementById('voice-grid').style.display = 'flex';
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

document.getElementById('ctrl-deafen').addEventListener('click', () => {
  isDeafened = !isDeafened;
  peers.forEach(peer => { if (peer.audioEl) peer.audioEl.muted = isDeafened; });
  document.getElementById('ctrl-deafen').classList.toggle('danger', isDeafened);
});

document.getElementById('ctrl-leave').addEventListener('click', async () => {
  await stopScreenShare();
  ws?.close();
  if (isHost) await window.voxlink.stopHost();
  peers.forEach((_, id) => closePeer(id));
  peers.clear();
  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;
  // Cleanup all AudioContexts
  audioCtxs.forEach((ctx, id) => { try { ctx.close(); } catch {} });
  audioCtxs.clear();
  document.getElementById('voice-grid').innerHTML = '';
  document.getElementById('peers-list').innerHTML = '';
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
    // Step 1: get video via Electron desktopCapturer (our custom picker sourceId)
    const videoStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          minWidth: 1280,
          maxWidth: 1920,
          minHeight: 720,
          maxHeight: 1080,
          minFrameRate: 15,
          maxFrameRate: 30,
        }
      }
    });

    if (shareAudio) {
      const isLinux = navigator.userAgent.includes('Linux');
      let audioStream = null;

      if (isLinux && window.pipewire) {
        // Linux: use PipeWire virtual sink to capture system audio excluding our app
        try {
          const pw = await window.pipewire.start();
          if (pw.ok) {
            console.log('[voxlink] PipeWire sink ready:', pw.sinkName);

            // Wait for PipeWire to register the monitor as audio input device
            await new Promise(r => setTimeout(r, 500));

            // Find voxlink_mic virtual source in audio input devices
            const devices = await navigator.mediaDevices.enumerateDevices();
            const micDevice = devices.find(d =>
              d.kind === 'audioinput' && d.label.toLowerCase().includes('voxlink')
            );
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
      } else if (window.audioLoopback) {
        // Windows: use electron-audio-loopback
        try {
          await window.audioLoopback.enable();
          const loopbackStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true,
          });
          loopbackStream.getVideoTracks().forEach(t => { t.stop(); loopbackStream.removeTrack(t); });
          audioStream = loopbackStream;
          console.log('[voxlink] Windows loopback audio tracks:', loopbackStream.getAudioTracks().length);
        } catch(e) {
          console.warn('[voxlink] Windows loopback failed:', e.message);
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
    } else {
      screenStream = videoStream;
    }

  } catch (e) {
    alert('Screen capture failed: ' + e.message);
    return;
  }
  if (screenStream.getAudioTracks().length > 0) {
    console.log('[voxlink] system audio will be shared');
    // Keep peers muted - their voice comes through screen audio
  } else {
    // No screen audio - restore peer mic audio immediately
    console.log('[voxlink] no screen audio, restoring peer audio');
    peers.forEach(peer => { if (peer.audioEl) peer.audioEl.muted = isDeafened; });
  }
    // Tell encoder this is screen content (sharp text), not motion video
    setContentHint(screenStream);

    // Apply quality constraints on the capture track
    const videoTrack = screenStream.getVideoTracks()[0];
    if (videoTrack) {
      try {
        await videoTrack.applyConstraints({
          width: { ideal: 1920, max: 1920 },
          height: { ideal: 1080, max: 1080 },
          frameRate: { ideal: 30, min: 15 },
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
  document.getElementById('share-bar-label').textContent = '📺 You are sharing your screen';
  shareViewer.style.display = 'flex';
  document.getElementById('voice-grid').style.display = 'none';

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
  });

  screenStream?.getTracks().forEach(t => t.stop());
  screenStream = null;

  // Teardown PipeWire virtual sink on Linux
  if (window.pipewire) {
    await window.pipewire.stop().catch(e => console.warn('[voxlink] pipewire stop:', e.message));
  }

  // Restore peer audio in case deafen was on
  peers.forEach(peer => { if (peer.audioEl) peer.audioEl.muted = isDeafened; });

  document.getElementById('ctrl-screen').classList.remove('active');
  document.getElementById('share-viewer').style.display = 'none';
  document.getElementById('voice-grid').style.display = 'flex';
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
        params.encodings[0].maxFramerate = 30;
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
document.getElementById('share-close').addEventListener('click', () => {
  const video = document.getElementById('share-video');
  video.muted = true;
  video.srcObject = null;
  viewingPeerId = null;
  document.querySelectorAll('.voice-card').forEach(c => c.classList.remove('viewing-screen'));
  document.getElementById('share-viewer').style.display = 'none';
  document.getElementById('voice-grid').style.display = 'flex';
  // Restore peer mic audio (unless user has deafen on)
  peers.forEach(peer => {
    if (peer.audioEl) peer.audioEl.muted = isDeafened;
  });
});

function showSharedScreen(stream, peerName, peerId) {
  viewingPeerId = peerId || null;
  const video = document.getElementById('share-video');
  video.srcObject = stream;
  video.muted = false;
  video.play().catch(e => console.warn('[voxlink] play failed:', e.message));
  document.getElementById('share-bar-label').textContent = `🖥 ${peerName} is sharing their screen`;
  document.getElementById('share-viewer').style.display = 'flex';
  document.getElementById('voice-grid').style.display = 'none';
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

// ── Init ──────────────────────────────────────────────────────────────────────
document.getElementById('inp-name').focus();
