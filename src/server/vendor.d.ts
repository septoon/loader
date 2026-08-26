declare module 'webtorrent' {
  const WebTorrent: any
  export default WebTorrent
}

declare module 'parse-torrent' {
  const parseTorrent: (value: string | Uint8Array | Buffer | object) => Promise<any>
  export default parseTorrent
}

declare module 'create-torrent' {
  const createTorrent: (input: string | Buffer, options: Record<string, unknown>, callback: (error: Error | null, torrent?: Buffer) => void) => void
  export default createTorrent
}
