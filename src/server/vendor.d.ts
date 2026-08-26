declare module 'webtorrent' {
  const WebTorrent: any
  export default WebTorrent
}

declare module 'parse-torrent' {
  const parseTorrent: (value: string | Uint8Array | Buffer | object) => Promise<any>
  export default parseTorrent
}
