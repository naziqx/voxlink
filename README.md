# VoxLink

Local network voice chat with screen sharing. No accounts, no external servers.
Works over Radmin VPN, ZeroTier, or any local network.

## Requirements

- Node.js 18+
- npm
- For screen sharing on Wayland (Arch Linux): `xdg-desktop-portal` + `xdg-desktop-portal-wlr` or `xdg-desktop-portal-gnome`

```
# Arch Linux
sudo pacman -S xdg-desktop-portal xdg-desktop-portal-wlr
```

## Install

```bash
npm install
```

## Run (development)

```bash
npm start
```

## How to use

### Hosting a session
1. Open VoxLink on your machine
2. Enter your name
3. Click the **Host** tab
4. Click **Start & Host**
5. Share your Radmin VPN / ZeroTier IP with friends

### Joining a session
1. Open VoxLink
2. Enter your name
3. Enter the host's IP (Radmin/ZeroTier virtual IP)
4. Click **Connect**

## Build

### Linux (AppImage + deb)
```bash
npm run build:linux
# Output: dist/
```

### Windows (NSIS installer)
```bash
npm run build:win
# Cross-compile from Linux requires Wine or build on Windows
```

## Architecture

- **Electron** — desktop app shell (Chromium, works on Wayland via PipeWire)
- **WebRTC** — P2P audio and screen share between all participants
- **WebSocket signaling server** — runs embedded in the host's app, used only to exchange WebRTC offers/answers. No audio passes through it.
- **No accounts** — just a name. No data stored anywhere.

## Troubleshooting

### Screen share not working on Wayland
Make sure `xdg-desktop-portal` is running:
```bash
systemctl --user status xdg-desktop-portal
systemctl --user start xdg-desktop-portal
```

### Can't connect
- Make sure you're on the same Radmin/ZeroTier network
- Check that port 7842 is not blocked by firewall:
  ```bash
  # Linux
  sudo ufw allow 7842
  # or
  sudo firewall-cmd --add-port=7842/tcp --permanent
  ```
- The host must have port 7842 open

### Audio echo
Use headphones — WebRTC echo cancellation works best with headphones.
