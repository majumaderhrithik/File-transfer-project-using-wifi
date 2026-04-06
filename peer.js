// peer.js — PeerJS connection management for NexDrop

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
}

export class NexPeer {
  constructor({ onOpen, onConnection, onData, onDisconnect, onError }) {
    this._onOpen       = onOpen
    this._onConnection = onConnection
    this._onData       = onData
    this._onDisconnect = onDisconnect
    this._onError      = onError

    this.peer  = null
    this.conns = {}   // peerId → DataConnection
  }

  // ── Init ──────────────────────────────────────
  init() {
    import('peerjs').then(({ Peer }) => {
      this.peer = new Peer(undefined, {
        host: '0.peerjs.com',
        port: 443,
        path: '/',
        secure: true,
        debug: 0,
        config: ICE_CONFIG,
      })

      this.peer.on('open',        id  => this._onOpen(id))
      this.peer.on('connection',  c   => this._accept(c))
      this.peer.on('disconnected',()  => this._handleDisconnect())
      this.peer.on('error',       err => this._handleError(err))
    })
  }

  // ── Connect to remote peer ────────────────────
  connect(peerId) {
    if (!this.peer) throw new Error('Peer not initialized')
    if (this.conns[peerId]) throw new Error('Already connected')
    if (peerId === this.peer.id) throw new Error('Cannot connect to yourself')

    const conn = this.peer.connect(peerId, {
      reliable: true,
      serialization: 'binary',
    })
    this._wire(conn)
    return conn
  }

  // ── Disconnect from a peer ────────────────────
  disconnect(peerId) {
    if (this.conns[peerId]) {
      this.conns[peerId].close()
      delete this.conns[peerId]
    }
  }

  // ── Send data to a specific peer ──────────────
  send(peerId, data) {
    const conn = this.conns[peerId]
    if (!conn) throw new Error('Not connected to ' + peerId)
    conn.send(data)
  }

  // ── Send data to ALL connected peers ──────────
  broadcast(data) {
    Object.values(this.conns).forEach(c => c.send(data))
  }

  // ── Get bufferedAmount for flow control ───────
  getBufferedAmount(peerId) {
    const conn = this.conns[peerId]
    if (!conn || !conn.dataChannel) return 0
    return conn.dataChannel.bufferedAmount
  }

  // ── List connected peer IDs ───────────────────
  getPeerIds() {
    return Object.keys(this.conns)
  }

  getConnections() {
    return Object.values(this.conns)
  }

  // ── Internal: wire events on a connection ─────
  _wire(conn) {
    conn.on('open', () => {
      this.conns[conn.peer] = conn
      this._onConnection(conn.peer, 'open')
    })
    conn.on('data',  data => this._onData(data, conn.peer))
    conn.on('close', ()   => {
      delete this.conns[conn.peer]
      this._onDisconnect(conn.peer)
    })
    conn.on('error', err  => this._onError(err, conn.peer))
  }

  _accept(conn) {
    this._onConnection(conn.peer, 'incoming')
    this._wire(conn)
  }

  _handleDisconnect() {
    this._onError({ message: 'Signal server disconnected — reconnecting…', type: 'network' })
    setTimeout(() => {
      try { this.peer.reconnect() } catch (_) {}
    }, 2000)
  }

  _handleError(err) {
    this._onError(err)
  }
}
