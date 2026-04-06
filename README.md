# ⚡ NexDrop

**Instant peer-to-peer file transfer — no server, no sign-up, no limits.**

NexDrop uses WebRTC to send files directly between browsers. Files never touch any server — they travel encrypted, peer-to-peer, in real time.

![NexDrop Preview](https://img.shields.io/badge/status-live-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue)

---

## ✨ Features

- 🔗 **True P2P** — WebRTC DataChannel, zero server storage
- 📦 **Any file, any size** — chunked transfer with flow control
- ⚡ **Real-time progress** — per-file speed (MB/s) + progress bar
- 👥 **Multi-peer** — connect and send to multiple devices at once
- 🌐 **Cross-network** — STUN + TURN relay fallback for non-LAN use
- 🎨 **Modern UI** — animated particle background, glassmorphism design
- 📱 **Responsive** — works on mobile browsers too

---

## 🚀 Run Locally

### Requirements
- [Node.js](https://nodejs.org/) v18+
- A modern browser (Chrome, Edge, Firefox)

### Steps

```bash
# 1. Clone the repo
git clone https://github.com/YOUR_USERNAME/nexdrop.git
cd nexdrop

# 2. Install dependencies
npm install

# 3. Start dev server
npm run dev

# 4. Open in browser
# → http://localhost:5173
```

---

## 📦 Build for Production

```bash
npm run build
# Output is in the /dist folder
```

---

## 🌐 Deploy to GitHub Pages

```bash
# 1. Build the project
npm run build

# 2. Push dist/ to gh-pages branch (done automatically via GitHub Actions)
git push origin main
```

The included `.github/workflows/deploy.yml` automatically builds and deploys to GitHub Pages on every push to `main`.

---

## 🛠️ Tech Stack

| Technology | Purpose |
|---|---|
| [Vite](https://vitejs.dev/) | Build tool & dev server |
| [PeerJS](https://peerjs.com/) | WebRTC abstraction layer |
| WebRTC DataChannel | Actual P2P file transfer |
| STUN/TURN servers | NAT traversal & relay |
| Vanilla JS (ES Modules) | Zero framework overhead |

---

## 📖 How to Use

1. Open NexDrop on **two devices** (or two browser tabs)
2. On **Device A**: click **Copy ID**
3. On **Device B**: paste the ID → click **Connect**
4. Drag & drop files → click **Send All**
5. Receiver clicks **Save** to download

---

## 📄 License

MIT © NexDrop
