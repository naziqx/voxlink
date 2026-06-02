const { app, BrowserWindow, ipcMain, desktopCapturer, Notification } = require('electron');
const { execSync, exec } = require('child_process');
let audioLoopback = null;
try {
  audioLoopback = require('electron-audio-loopback');
} catch(e) {
  console.warn('[main] electron-audio-loopback not available:', e.message);
}
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');
const os = require('os');
const http = require('http');

// Must be set BEFORE app ready
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  // Allow PipeWire monitor sinks to appear as audio input devices
  app.commandLine.appendSwitch('enable-webrtc-pipewire-capturer');
  app.commandLine.appendSwitch('auto-select-desktop-capture-source', 'voxlink_capture');
}

let mainWindow;
let signalingServer = null;
let httpServer = null;
const DEFAULT_PORT = 7842;

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0d0d11',
    frame: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../public/index.html'));

  // Open DevTools so you can see renderer errors
  mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Log renderer console to terminal
  mainWindow.webContents.on('console-message', (e, level, msg, line, src) => {
    const tag = ['LOG','WARN','ERR','DBG'][level] || '?';
    console.log(`[renderer][${tag}] ${msg}  (${src}:${line})`);
  });

  // Allow mic + screen capture permissions
  mainWindow.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    console.log('[main] permission requested:', permission);
    callback(true);
  });

  mainWindow.webContents.session.setPermissionCheckHandler(() => true);

  // Allow getDisplayMedia — Electron requires explicit handler
  // Renderer stores selected sourceId in window._selectedSourceId before calling getDisplayMedia
  mainWindow.webContents.session.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      // Get the sourceId that the user picked in our custom UI
      const selectedId = await mainWindow.webContents.executeJavaScript('window._selectedSourceId || null');
      const source = selectedId
        ? sources.find(s => s.id === selectedId) || sources[0]
        : sources[0];
      console.log('[main] displayMedia approved, source:', source?.name);
      // 'loopback' captures system audio on Windows; on Linux it may be ignored
      callback({ video: source, audio: 'loopback' });
    } catch (e) {
      console.error('[main] displayMedia handler error:', e.message);
      callback({});
    }
  });
}

app.whenReady().then(() => {
  // Init audio loopback plugin if available
  if (audioLoopback) {
    try {
      audioLoopback.initMain(app);
      console.log('[main] electron-audio-loopback initialized');
    } catch(e) {
      console.warn('[main] audioLoopback init failed:', e.message);
    }
  }
  createWindow();
});

app.on('window-all-closed', () => {
  stopSignalingServer();
  if (process.platform !== 'darwin') app.quit();
});

// ── Signaling Server ──────────────────────────────────────────────────────────
function getLocalIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

function startSignalingServer(port) {
  return new Promise((resolve, reject) => {
    if (signalingServer) {
      // Already hosting — return error so UI can show message
      reject(new Error(`Already hosting on port ${port}. Stop current session first.`));
      return;
    }

    httpServer = http.createServer();
    signalingServer = new WebSocketServer({ server: httpServer });

    // clients: Map<ws, { id, name, room }>
    const clients = new Map();
    let idCounter = 0;

    signalingServer.on('connection', (ws) => {
      const clientId = 'c' + (++idCounter);
      clients.set(ws, { id: clientId, name: 'Unknown', room: null });

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        const meta = clients.get(ws);
        if (!meta) return;

        switch (msg.type) {
          case 'join': {
            meta.name = (msg.name || 'User').slice(0, 32);
            meta.room = msg.room || 'default';

            // Check if same name already in room (double-connect guard)
            let duplicate = false;
            clients.forEach((m, pws) => {
              if (pws !== ws && m.room === meta.room && m.name === meta.name) {
                duplicate = true;
              }
            });
            if (duplicate) {
              ws.send(JSON.stringify({ type: 'error', message: `Name "${meta.name}" is already in this room` }));
              ws.close();
              break;
            }

            // Collect existing peers in same room
            const peers = [];
            clients.forEach((m, pws) => {
              if (pws !== ws && m.room === meta.room) {
                peers.push({ id: m.id, name: m.name });
              }
            });

            // Confirm join
            ws.send(JSON.stringify({ type: 'joined', id: clientId, peers }));

            // Notify others
            broadcast(meta.room, { type: 'peer_joined', id: clientId, name: meta.name }, ws, clients);
            console.log(`[+] ${meta.name} (${clientId}) joined. Room members: ${peers.length + 1}`);
            break;
          }

          case 'offer':
          case 'answer':
          case 'ice': {
            // Relay to specific peer
            const target = findById(msg.to, clients);
            if (target && target.readyState === WebSocket.OPEN) {
              target.send(JSON.stringify({ ...msg, from: meta.id }));
            }
            break;
          }

          case 'mute': {
            broadcast(meta.room, { type: 'mute', from: meta.id, muted: msg.muted }, ws, clients);
            break;
          }

          case 'screen_start': {
            broadcast(meta.room, { 
              type: 'screen_start', 
              from: meta.id, 
              hasAudio: msg.hasAudio,
              audioStreamId: msg.audioStreamId,
              audioTrackId: msg.audioTrackId,
            }, ws, clients);
            break;
          }

          case 'screen_stop': {
            broadcast(meta.room, { type: 'screen_stop', from: meta.id }, ws, clients);
            break;
          }
        }
      });

      ws.on('close', () => {
        const meta = clients.get(ws);
        if (meta && meta.room) {
          broadcast(meta.room, { type: 'peer_left', id: meta.id, name: meta.name }, ws, clients);
        }
        clients.delete(ws);
      });

      ws.on('error', () => {});
    });

    httpServer.listen(port, '0.0.0.0', () => {
      resolve({ port, ips: getLocalIPs() });
    });

    httpServer.on('error', (err) => {
      signalingServer = null;
      httpServer = null;
      reject(err);
    });
  });
}

function stopSignalingServer() {
  if (signalingServer) { signalingServer.close(); signalingServer = null; }
  if (httpServer) { httpServer.close(); httpServer = null; }
}

function broadcast(room, data, excludeWs, clients) {
  const msg = JSON.stringify(data);
  clients.forEach((m, ws) => {
    if (ws !== excludeWs && m.room === room && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

function findById(id, clients) {
  for (const [ws, m] of clients) {
    if (m.id === id) return ws;
  }
  return null;
}

// ── PipeWire Audio Manager ───────────────────────────────────────────────────
let pipewireSinkModule = null;   // module ID from pactl load-module
let pipewireMicModule = null;    // module ID for virtual mic source
let movedSinkInputs = [];        // [{id, originalSink}]

function execCmd(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim();
  } catch(e) {
    console.warn('[pipewire] cmd failed:', cmd, e.message);
    return null;
  }
}

function parseSinkInputs() {
  const out = execCmd('pactl list sink-inputs');
  if (!out) return [];

  const inputs = [];
  const blocks = out.split(/^Sink Input #/m).filter(Boolean);

  for (const block of blocks) {
    const idMatch = block.match(/^(\d+)/);
    if (!idMatch) continue;
    const id = idMatch[1];

    const sinkMatch = block.match(/^\s+Sink:\s+(\d+)/m);
    const sink = sinkMatch ? sinkMatch[1] : null;

    const pidMatch = block.match(/application\.process\.id\s*=\s*"(\d+)"/);
    const pid = pidMatch ? pidMatch[1] : null;

    const binaryMatch = block.match(/application\.process\.binary\s*=\s*"([^"]+)"/);
    const binary = binaryMatch ? binaryMatch[1] : null;

    inputs.push({ id, sink, pid, binary });
  }
  return inputs;
}

function getDefaultSinkName() {
  // Get the current default sink name
  const out = execCmd('pactl get-default-sink');
  return out ? out.trim() : null;
}

function getPwPortName(nodeName, direction) {
  // Get PipeWire port names for a node
  const flag = direction === 'output' ? '-o' : '-i';
  const out = execCmd(`pw-link ${flag}`);
  if (!out) return null;
  const lines = out.split('\n').filter(l => l.includes(nodeName));
  return lines.length > 0 ? lines : null;
}

async function setupPipeWireCapture() {
  // Create virtual sink
  const moduleId = execCmd('pactl load-module module-null-sink sink_name=voxlink_capture sink_properties=device.description=VoxLink-Capture');
  if (!moduleId) return { ok: false, error: 'Failed to create virtual sink' };
  pipewireSinkModule = moduleId.trim();
  console.log('[pipewire] virtual sink created, module:', pipewireSinkModule);

  // Wait for sink to be ready
  await new Promise(r => setTimeout(r, 400));

  // Create virtual microphone source from monitor
  const micModuleId = execCmd('pactl load-module module-virtual-source source_name=voxlink_mic source_properties=device.description=VoxLink-Mic master=voxlink_capture.monitor');
  if (micModuleId) {
    pipewireMicModule = micModuleId.trim();
    console.log('[pipewire] virtual mic created, module:', pipewireMicModule);
  }

  // Wait for devices to register
  await new Promise(r => setTimeout(r, 500));

  // Connect voxlink_capture.monitor to default headphones/speakers via pw-link
  // So host can still hear the audio while it's being captured
  const defaultSink = getDefaultSinkName();
  if (defaultSink) {
    console.log('[pipewire] connecting monitor to default sink:', defaultSink);
    execCmd(`pw-link voxlink_capture:monitor_FL "${defaultSink}:playback_FL"`);
    execCmd(`pw-link voxlink_capture:monitor_FR "${defaultSink}:playback_FR"`);
  }

  // Get our process PIDs (main + renderer)
  const ourPids = new Set([String(process.pid)]);
  try {
    const children = execCmd(`pgrep -P ${process.pid}`);
    if (children) children.split('\n').filter(Boolean).forEach(p => ourPids.add(p));
  } catch(e) {}
  console.log('[pipewire] our PIDs:', [...ourPids]);

  // Move all sink-inputs except ours to voxlink_capture
  const inputs = parseSinkInputs();
  movedSinkInputs = [];

  for (const input of inputs) {
    if (ourPids.has(input.pid)) {
      console.log('[pipewire] skipping our own sink-input:', input.id, 'pid:', input.pid);
      continue;
    }
    if (!input.sink) continue;

    const result = execCmd(`pactl move-sink-input ${input.id} voxlink_capture`);
    if (result !== null) {
      movedSinkInputs.push({ id: input.id, originalSink: input.sink });
      console.log('[pipewire] moved sink-input', input.id, 'binary:', input.binary);
    }
  }

  console.log('[pipewire] moved', movedSinkInputs.length, 'sink-inputs to voxlink_capture');
  return { ok: true, sinkName: 'voxlink_capture', micSourceName: 'voxlink_mic' };
}

async function teardownPipeWireCapture() {
  // Unload virtual mic first
  if (pipewireMicModule) {
    execCmd(`pactl unload-module ${pipewireMicModule}`);
    pipewireMicModule = null;
    console.log('[pipewire] virtual mic removed');
  }

  // Move sink-inputs back to original sinks
  for (const { id, originalSink } of movedSinkInputs) {
    execCmd(`pactl move-sink-input ${id} ${originalSink}`);
  }
  movedSinkInputs = [];

  // Unload virtual sink module
  if (pipewireSinkModule) {
    execCmd(`pactl unload-module ${pipewireSinkModule}`);
    pipewireSinkModule = null;
    console.log('[pipewire] virtual sink removed');
  }
}

// ── IPC Handlers ──────────────────────────────────────────────────────────────
ipcMain.handle('start-host', async (_, port) => {
  try {
    const result = await startSignalingServer(port || DEFAULT_PORT);
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('stop-host', () => {
  stopSignalingServer();
  return { ok: true };
});

ipcMain.handle('get-local-ips', () => getLocalIPs());

ipcMain.handle('get-screen-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 320, height: 180 },
  });
  return sources.map(s => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    display_id: s.display_id,
  }));
});

ipcMain.handle('enable-loopback', async () => {
  if (!audioLoopback) return { ok: false, reason: 'not available' };
  try {
    await audioLoopback.initMain(app);
    return { ok: true };
  } catch(e) {
    return { ok: false, reason: e.message };
  }
});

ipcMain.handle('pipewire-start', async () => {
  return await setupPipeWireCapture();
});

ipcMain.handle('pipewire-stop', async () => {
  await teardownPipeWireCapture();
  return { ok: true };
});

ipcMain.handle('show-notification', (_, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body, silent: false }).show();
  }
});
