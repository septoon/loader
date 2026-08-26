import WebTorrent from 'webtorrent'

const client = new WebTorrent({
  dht: false,
  lsd: false,
  tracker: false,
  natUpnp: false,
  natPmp: false,
  maxConns: 4
})

process.on('message', message => {
  if (message?.type === 'seed') {
    client.seed(message.sourcePath, {
      announce: [],
      pieceLength: message.pieceLength
    }, torrent => {
      process.send?.({
        type: 'ready',
        port: client.torrentPort,
        torrentFile: Buffer.from(torrent.torrentFile).toString('base64')
      })
    })
  }
  if (message?.type === 'shutdown') {
    client.destroy(() => process.exit(0))
  }
})

process.on('disconnect', () => client.destroy(() => process.exit(0)))
