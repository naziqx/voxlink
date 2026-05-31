const { app, BrowserWindow, ipcMain, desktopCapturer, Notification } = require('electron');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');
const os = require('os');
const http = require('http');

// Must be set BEFORE app ready
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
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
      resolve({ port, ips: getLocalIPs() });
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

ipcMain.handle('show-notification', (_, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body, silent: false }).show();
  }
});
