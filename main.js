// main.js — NexDrop Application Core
import { NexPeer } from './peer.js'

// ── Constants ─────────────────────────────────────────────
const CHUNK_SIZE    = 65536          // 64 KB per chunk
const BUFFER_LIMIT  = 8 * 1024 * 1024  // 8 MB — throttle threshold
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── State ──────────────────────────────────────────────────
let myId     = null
let outQueue = []       // { id, file, status, progress, speed, startTime }
let recvMap  = {}       // transferId → { name, size, mime, chunks[], received, total, from, startTime }
let received = []       // completed received file entries
const stats  = { sent: 0, recv: 0, bytes: 0 }

// ── NexPeer instance ───────────────────────────────────────
const nexPeer = new NexPeer({
  onOpen(id) {
    myId = id
    document.getElementById('myId').textContent = id
    setConnStatus('live', 'Ready')
    log('Session started · ' + id, 'hi')
    enableDropZone()
  },

  onConnection(peerId, direction) {
    if (direction === 'incoming') {
      log('Incoming connection from ' + shortId(peerId), 'hi')
    } else {
      log('Connected → ' + peerId, 'ok')
      toast('Connected', 'ok', '🔗', shortId(peerId))
    }
    updatePeersUI()
    updateStats()
    enableDropZone()
    updateSendBtn()
  },

  onData(data, from) {
    handleIncomingData(data, from)
  },

  onDisconnect(peerId) {
    log('Disconnected from ' + shortId(peerId), 'err')
    toast('Peer disconnected', 'err', '🔌')
    updatePeersUI()
    updateStats()
    updateSendBtn()
  },

  onError(err) {
    const msg = err?.message || String(err)
    log('Error: ' + msg, 'err')
    if (err?.type === 'peer-unavailable') toast('Peer not found or offline', 'err', '❌')
    else if (err?.type === 'network')     setConnStatus('busy', 'Reconnecting…')
  },
})

// ── Boot ───────────────────────────────────────────────────
nexPeer.init()
setConnStatus('', 'Initializing…')

// ── Connect ────────────────────────────────────────────────
function connectToPeer() {
  const input = document.getElementById('peerInput')
  const id    = input.value.trim()
  if (!id) { toast('Enter a peer ID', 'err', '⚠️'); return }
  try {
    nexPeer.connect(id)
    log('Connecting to ' + id + '…')
    input.value = ''
  } catch (e) {
    toast(e.message, 'err', '⚠️')
    log('Connect error: ' + e.message, 'err')
  }
}

function disconnectPeer(peerId) {
  nexPeer.disconnect(peerId)
}

// ── Incoming data handler ──────────────────────────────────
function handleIncomingData(data, from) {
  // File metadata — start of a new incoming transfer
  if (data.type === 'file-meta') {
    recvMap[data.tid] = {
      name: data.name,
      size: data.size,
      mime: data.mime || 'application/octet-stream',
      chunks: new Array(data.total),
      received: 0,
      total: data.total,
      from,
      startTime: Date.now(),
    }
    renderRecvInProgress()
    log('Receiving: ' + data.name + ' (' + fmtBytes(data.size) + ') from ' + shortId(from))
    return
  }

  // Chunk data
  if (data.type === 'chunk') {
    const t = recvMap[data.tid]
    if (!t) return
    t.chunks[data.idx] = data.buf
    t.received++
    updateRecvProgressBar(data.tid, t)
    if (t.received === t.total) finalizeReceive(data.tid, t)
  }
}

function finalizeReceive(tid, t) {
  const blob = new Blob(t.chunks, { type: t.mime })
  const url  = URL.createObjectURL(blob)

  received.unshift({
    name: t.name,
    size: t.size,
    url,
    mime: t.mime,
    from: t.from,
    time: new Date(),
  })

  stats.recv++
  stats.bytes += t.size
  updateStats()
  delete recvMap[tid]

  renderRecvInProgress()
  renderReceived()
  log('✓ Received: ' + t.name + ' (' + fmtBytes(t.size) + ')', 'ok')
  toast('File received: ' + t.name, 'ok', '📥', fmtBytes(t.size) + ' · from ' + shortId(t.from))
}

// ── File selection ─────────────────────────────────────────
function handleFiles(files) {
  for (const file of files) {
    outQueue.push({ id: uid(), file, status: 'pending', progress: 0, speed: 0, startTime: 0 })
  }
  document.getElementById('fileInput').value = ''
  renderOutgoing()
  updateSendBtn()
}

// ── Drop zone setup ────────────────────────────────────────
const dropZone  = document.getElementById('dropZone')
const fileInput = document.getElementById('fileInput')

dropZone.addEventListener('dragover', e => {
  e.preventDefault()
  if (!dropZone.classList.contains('disabled')) dropZone.classList.add('active-drop')
})
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('active-drop'))
dropZone.addEventListener('drop', e => {
  e.preventDefault()
  dropZone.classList.remove('active-drop')
  if (!dropZone.classList.contains('disabled')) handleFiles(e.dataTransfer.files)
})
fileInput.addEventListener('change', () => handleFiles(fileInput.files))

function enableDropZone() {
  dropZone.classList.remove('disabled')
  document.getElementById('dropTitle').textContent = 'Drop Files Here'
  document.getElementById('dropSub').textContent   = 'Or click to browse · Any format, any size'
}

// ── Send all pending files ─────────────────────────────────
async function sendAll() {
  const peers   = nexPeer.getConnections()
  const pending = outQueue.filter(f => f.status === 'pending')

  if (!peers.length)   { toast('No peers connected', 'err', '⚠️'); return }
  if (!pending.length) { toast('No files to send', 'hi', 'ℹ️');    return }

  document.getElementById('sendAllBtn').disabled = true

  for (const entry of pending) {
    for (const conn of peers) {
      await sendFile(entry, conn)
    }
  }

  updateSendBtn()
}

async function sendFile(entry, conn) {
  const { file } = entry
  const tid   = uid()
  const buf   = await file.arrayBuffer()
  const total = Math.ceil(buf.byteLength / CHUNK_SIZE) || 1

  entry.status    = 'sending'
  entry.progress  = 0
  entry.startTime = Date.now()
  renderOutgoing()
  log('Sending: ' + file.name + ' → ' + shortId(conn.peer))

  // 1. Send metadata
  conn.send({ type: 'file-meta', tid, name: file.name, size: file.size, mime: file.type, total })

  // 2. Send chunks with flow control
  let offset = 0
  let idx    = 0

  while (offset < buf.byteLength) {
    // Throttle if receiver buffer is too full
    while (conn.dataChannel && conn.dataChannel.bufferedAmount > BUFFER_LIMIT) {
      await sleep(25)
    }

    const slice = buf.slice(offset, offset + CHUNK_SIZE)
    conn.send({ type: 'chunk', tid, idx, buf: slice })

    offset += CHUNK_SIZE
    idx++

    const pct     = Math.min(100, Math.round((offset / buf.byteLength) * 100))
    const elapsed = (Date.now() - entry.startTime) / 1000 || 0.001
    entry.speed   = Math.round(offset / elapsed)
    entry.progress = pct
    patchFileItem(entry)
  }

  // 3. Mark done
  entry.status   = 'done'
  entry.progress = 100
  entry.speed    = 0
  stats.sent++
  stats.bytes += file.size
  updateStats()
  patchFileItem(entry)
  log('✓ Sent: ' + file.name, 'ok')
  toast('Sent: ' + file.name, 'ok', '🚀', fmtBytes(file.size) + ' → ' + shortId(conn.peer))
}

// ── Render: Outgoing queue ─────────────────────────────────
function renderOutgoing() {
  const wrap  = document.getElementById('outWrap')
  const list  = document.getElementById('outList')
  const badge = document.getElementById('outBadge')
  const info  = document.getElementById('sendBarInfo')

  if (!outQueue.length) { wrap.style.display = 'none'; return }
  wrap.style.display = 'block'
  badge.textContent  = outQueue.length

  const totalSize = outQueue.reduce((s, f) => s + f.file.size, 0)
  info.innerHTML  = `<strong>${outQueue.length}</strong> file${outQueue.length > 1 ? 's' : ''} · ${fmtBytes(totalSize)}`

  list.innerHTML = ''
  outQueue.forEach(entry => {
    const { id, file, status, progress, speed } = entry
    const el = document.createElement('div')
    el.className = 'file-item status-' + status
    el.id = 'fi-' + id

    const speedStr = (status === 'sending' && speed > 0)
      ? `<span class="file-speed">· ${fmtBytes(speed)}/s</span>` : ''

    el.innerHTML = `
      <div class="file-icon-box">${fileEmoji(file.name)}</div>
      <div class="file-meta-wrap">
        <div class="file-nm">${esc(file.name)}</div>
        <div class="file-sub">${fmtBytes(file.size)} · ${file.type || 'binary'} ${speedStr}</div>
        <div class="progress-track">
          <div class="progress-fill" style="width:${progress}%"></div>
        </div>
      </div>
      <div class="file-action-wrap">
        ${status === 'sending' ? `<span class="file-pct">${progress}%</span>` : ''}
        ${status === 'done'    ? `<span class="status-icon">✅</span>` : ''}
        ${status === 'error'   ? `<span class="status-icon">❌</span>` : ''}
        ${status === 'pending' ? `
          <button class="btn btn-icon btn-sm" onclick="window.nexdrop.removeFile('${id}')" title="Remove">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>` : ''}
      </div>`
    list.appendChild(el)
  })
}

function patchFileItem(entry) {
  const el = document.getElementById('fi-' + entry.id)
  if (!el) return

  const fill    = el.querySelector('.progress-fill')
  const pctEl   = el.querySelector('.file-pct')
  const speedEl = el.querySelector('.file-speed')

  if (fill)    fill.style.width    = entry.progress + '%'
  if (pctEl)   pctEl.textContent   = entry.progress + '%'
  if (speedEl) speedEl.textContent = '· ' + fmtBytes(entry.speed) + '/s'

  if (entry.status === 'done') {
    el.className = 'file-item status-done'
    const aw = el.querySelector('.file-action-wrap')
    if (aw) aw.innerHTML = '<span class="status-icon">✅</span>'
  }
}

function removeFile(id) {
  outQueue = outQueue.filter(f => f.id !== id)
  renderOutgoing()
  updateSendBtn()
}

function clearPending() {
  outQueue = outQueue.filter(f => f.status !== 'pending')
  renderOutgoing()
  updateSendBtn()
}

// ── Render: Receiving in progress ─────────────────────────
function renderRecvInProgress() {
  const wrap = document.getElementById('recvWrap')
  const list = document.getElementById('recvList')
  const keys = Object.keys(recvMap)

  if (!keys.length) { wrap.style.display = 'none'; return }
  wrap.style.display = 'block'
  list.innerHTML = ''

  keys.forEach(tid => {
    const t   = recvMap[tid]
    const pct = Math.round((t.received / t.total) * 100)
    const el  = document.createElement('div')
    el.className = 'recv-progress'
    el.id = 'rv-' + tid
    el.innerHTML = `
      <div class="recv-progress-head">
        <span class="recv-progress-name">${esc(t.name)}</span>
        <span class="recv-progress-pct">${pct}%</span>
      </div>
      <div class="recv-track">
        <div class="recv-fill" id="rf-${tid}" style="width:${pct}%"></div>
      </div>`
    list.appendChild(el)
  })
}

function updateRecvProgressBar(tid, t) {
  const pct  = Math.round((t.received / t.total) * 100)
  const fill = document.getElementById('rf-' + tid)
  const pctEl = document.querySelector(`#rv-${tid} .recv-progress-pct`)
  if (fill)  fill.style.width    = pct + '%'
  if (pctEl) pctEl.textContent   = pct + '%'
}

// ── Render: Completed downloads ────────────────────────────
function renderReceived() {
  const wrap  = document.getElementById('doneWrap')
  const list  = document.getElementById('doneList')
  const badge = document.getElementById('doneBadge')

  if (!received.length) { wrap.style.display = 'none'; return }
  wrap.style.display = 'block'
  badge.textContent  = received.length
  list.innerHTML     = ''

  received.forEach(f => {
    const el = document.createElement('div')
    el.className = 'received-item'
    el.innerHTML = `
      <div class="file-icon-box">${fileEmoji(f.name)}</div>
      <div class="file-meta-wrap">
        <div class="file-nm">${esc(f.name)}</div>
        <div class="file-sub" style="font-family:var(--mono);font-size:11px;color:var(--sub);">
          ${fmtBytes(f.size)} · from ${shortId(f.from)} · ${f.time.toLocaleTimeString()}
        </div>
      </div>
      <a class="dl-btn" href="${f.url}" download="${esc(f.name)}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Save
      </a>`
    list.appendChild(el)
  })
}

function clearReceived() {
  received.forEach(f => URL.revokeObjectURL(f.url))
  received = []
  renderReceived()
}

// ── Render: Peers ──────────────────────────────────────────
function updatePeersUI() {
  const wrap = document.getElementById('peersWrap')
  const list = document.getElementById('peersList')
  const ids  = nexPeer.getPeerIds()

  if (!ids.length) { wrap.style.display = 'none'; return }
  wrap.style.display = 'block'
  list.innerHTML = ''

  ids.forEach(id => {
    const chip = document.createElement('div')
    chip.className = 'peer-chip'
    chip.innerHTML = `
      <div class="peer-chip-dot"></div>
      <span class="peer-chip-id">${id}</span>
      <button class="peer-chip-close" onclick="window.nexdrop.disconnectPeer('${id}')" title="Disconnect">×</button>`
    list.appendChild(chip)
  })
}

// ── Stats ──────────────────────────────────────────────────
function updateStats() {
  document.getElementById('sSent').textContent  = stats.sent
  document.getElementById('sRecv').textContent  = stats.recv
  document.getElementById('sData').textContent  = fmtBytes(stats.bytes)
  document.getElementById('sPeers').textContent = nexPeer.getPeerIds().length
}

// ── Send button state ──────────────────────────────────────
function updateSendBtn() {
  const btn     = document.getElementById('sendAllBtn')
  const pending = outQueue.filter(f => f.status === 'pending').length
  btn.disabled  = !pending || !nexPeer.getPeerIds().length
}

// ── Status pill ────────────────────────────────────────────
function setConnStatus(state, text) {
  const pill = document.getElementById('connPill')
  const span = document.getElementById('connTxt')
  pill.className    = 'conn-pill ' + state
  span.textContent  = text
}

// ── Copy ID ────────────────────────────────────────────────
function copyId() {
  if (!myId) return
  navigator.clipboard.writeText(myId).then(() => {
    const btn = document.getElementById('copyIdBtn')
    btn.classList.add('copied')
    btn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 6 9 17 4 12"/>
      </svg> Copied!`
    toast('Peer ID copied to clipboard', 'ok', '✓')
    setTimeout(() => {
      btn.classList.remove('copied')
      btn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2"/>
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
        </svg> Copy ID`
    }, 2200)
  })
}

// ── Log ────────────────────────────────────────────────────
function log(msg, cls = '') {
  const body = document.getElementById('logBody')
  const emp  = body.querySelector('.log-empty')
  if (emp) emp.remove()

  const row = document.createElement('div')
  row.className = 'log-row'
  const t = new Date().toLocaleTimeString('en-GB', { hour12: false })
  row.innerHTML = `<span class="log-ts">${t}</span><span class="log-txt ${cls}">${esc(msg)}</span>`
  body.appendChild(row)

  while (body.children.length > 80) body.removeChild(body.firstChild)
  body.scrollTop = body.scrollHeight
}

function clearLog() {
  document.getElementById('logBody').innerHTML = '<div class="log-empty">Log cleared.</div>'
}

// ── Toast ──────────────────────────────────────────────────
function toast(title, type = 'hi', ico = 'ℹ️', sub = '') {
  const container = document.getElementById('toasts')
  const el = document.createElement('div')
  el.className = `toast t-${type === 'ok' ? 'ok' : type === 'err' ? 'err' : 'hi'}`
  el.innerHTML = `
    <div class="toast-ico">${ico}</div>
    <div class="toast-body">
      <div class="toast-title">${esc(title)}</div>
      ${sub ? `<div class="toast-sub">${esc(sub)}</div>` : ''}
    </div>`
  container.appendChild(el)
  setTimeout(() => {
    el.style.transition = 'opacity 0.4s'
    el.style.opacity    = '0'
    setTimeout(() => el.remove(), 400)
  }, 3200)
}

// ── Canvas particle background ─────────────────────────────
function initCanvas() {
  const canvas = document.getElementById('bg-canvas')
  const ctx    = canvas.getContext('2d')
  let W, H, pts = []

  function resize() {
    W = canvas.width  = window.innerWidth
    H = canvas.height = window.innerHeight
    initPts()
  }

  function initPts() {
    const n = Math.floor((W * H) / 18000)
    pts = Array.from({ length: n }, () => ({
      x:  Math.random() * W,
      y:  Math.random() * H,
      vx: (Math.random() - 0.5) * 0.18,
      vy: (Math.random() - 0.5) * 0.18,
      r:  Math.random() * 1.2 + 0.3,
    }))
  }

  function draw() {
    ctx.clearRect(0, 0, W, H)

    // Edges between nearby nodes
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[i].x - pts[j].x
        const dy = pts[i].y - pts[j].y
        const d  = Math.hypot(dx, dy)
        if (d < 120) {
          ctx.beginPath()
          ctx.moveTo(pts[i].x, pts[i].y)
          ctx.lineTo(pts[j].x, pts[j].y)
          ctx.strokeStyle = `rgba(99,179,237,${0.08 * (1 - d / 120)})`
          ctx.lineWidth   = 0.5
          ctx.stroke()
        }
      }
    }

    // Nodes
    pts.forEach(p => {
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(99,179,237,0.4)'
      ctx.fill()
      p.x += p.vx; p.y += p.vy
      if (p.x < 0 || p.x > W) p.vx *= -1
      if (p.y < 0 || p.y > H) p.vy *= -1
    })

    requestAnimationFrame(draw)
  }

  window.addEventListener('resize', resize)
  resize()
  draw()
}

initCanvas()

// ── Utilities ──────────────────────────────────────────────
function fmtBytes(b) {
  if (!b) return '0 B'
  const K = 1024, u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(b) / Math.log(K))
  return (b / Math.pow(K, i)).toFixed(i > 0 ? 1 : 0) + ' ' + u[i]
}

function fileEmoji(name) {
  const ext = (name.split('.').pop() || '').toLowerCase()
  const map = {
    jpg:'🖼',jpeg:'🖼',png:'🖼',gif:'🖼',webp:'🖼',svg:'🖼',bmp:'🖼',ico:'🖼',
    mp4:'🎬',mov:'🎬',avi:'🎬',mkv:'🎬',webm:'🎬',flv:'🎬',
    mp3:'🎵',wav:'🎵',flac:'🎵',aac:'🎵',ogg:'🎵',m4a:'🎵',
    zip:'📦',rar:'📦','7z':'📦',tar:'📦',gz:'📦',bz2:'📦',
    js:'💻',ts:'💻',py:'💻',html:'💻',css:'💻',json:'💻',jsx:'💻',tsx:'💻',
    c:'💻',cpp:'💻',java:'💻',go:'💻',rs:'💻',php:'💻',rb:'💻',sh:'💻',
    pdf:'📑',doc:'📝',docx:'📝',txt:'📝',md:'📝',rtf:'📝',
    xls:'📊',xlsx:'📊',csv:'📊',ppt:'📊',pptx:'📊',
    exe:'⚙️',dmg:'⚙️',apk:'📱',ipa:'📱',
    sql:'🗄',db:'🗄',sqlite:'🗄',
  }
  return map[ext] || '📄'
}

function shortId(id) { return id ? id.substring(0, 12) + '…' : '?' }
function uid()       { return Math.random().toString(36).substr(2, 10) }
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── Expose public API to HTML (onclick handlers) ───────────
window.nexdrop = {
  connectToPeer,
  disconnectPeer,
  copyId,
  sendAll,
  removeFile,
  clearPending,
  clearReceived,
  clearLog,
}
