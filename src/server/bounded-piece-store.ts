import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm, statfs, unlink } from 'node:fs/promises'
import path from 'node:path'

type Callback = (error: Error | null, buffer?: Buffer) => void
type TorrentPrivateApi = {
  bitfield?: { get(index: number): boolean }
  pieces?: unknown[]
  _markUnverified?(index: number): void
  _deselect?(start: number, end: number, stream?: boolean): void
  _select?(start: number, end: number, priority: number, notify?: unknown, stream?: boolean): void
  loaderPieceStore?: BoundedPieceStore
}

interface StoreOptions {
  cachePath?: string
  path?: string
  maxBytes?: number
  reserveBytes?: number
  headroomPieces?: number
  maxPendingPieces?: number
  torrent?: TorrentPrivateApi
}

interface PendingPiece {
  index: number
  buffer: Buffer
  callback: Callback
}

const noop: Callback = () => undefined

export class BoundedPieceStore {
  readonly chunkLength: number
  readonly maxBytes: number
  readonly reserveBytes: number
  readonly headroomPieces: number
  readonly maxPendingPieces: number
  readonly root: string
  readonly torrent: TorrentPrivateApi | undefined
  readonly sizes = new Map<number, number>()
  readonly pending: PendingPiece[] = []
  readonly ready: Promise<void>
  readCursor = 0
  usedBytes = 0
  peakBytes = 0
  closed = false
  writing = false
  capacityPaused = false

  constructor(chunkLength: number, options: StoreOptions = {}) {
    this.chunkLength = chunkLength
    this.maxBytes = options.maxBytes ?? 128 * 1024 * 1024
    this.reserveBytes = options.reserveBytes ?? 1024 * 1024 * 1024
    this.headroomPieces = options.headroomPieces ?? 3
    this.maxPendingPieces = options.maxPendingPieces ?? 8
    this.root = options.cachePath ?? options.path ?? path.join(process.cwd(), 'runtime/cache/pieces')
    this.torrent = options.torrent
    this.ready = this.initialize()
    if (this.torrent) this.torrent.loaderPieceStore = this
  }

  setReadCursor(index: number): void {
    this.readCursor = index
    if (this.capacityPaused) this.selectReadWindow()
    void this.drain()
  }

  put(index: number, value: Uint8Array, callback: Callback = noop): void {
    const buffer = Buffer.from(value)
    if (this.closed) return queueMicrotask(() => callback(new Error('Кеш частей торрента закрыт')))
    if (this.pending.length >= this.maxPendingPieces && index > this.readCursor + this.headroomPieces) {
      this.pauseSelection()
      callback(null)
      queueMicrotask(() => {
        if (this.torrent?.bitfield?.get(index)) this.torrent._markUnverified?.(index)
      })
      return
    }
    this.pending.push({ index, buffer, callback })
    this.pending.sort((left, right) => left.index - right.index)
    void this.drain()
  }

  get(index: number, options: { offset?: number, length?: number } | Callback, callback: Callback = noop): void {
    if (typeof options === 'function') {
      callback = options
      options = {}
    }
    this.ready.then(async () => {
      const handle = await open(this.piecePath(index), 'r')
      try {
        const info = await handle.stat()
        const offset = options.offset ?? 0
        const length = options.length ?? info.size - offset
        const buffer = Buffer.allocUnsafe(length)
        const result = await handle.read(buffer, 0, length, offset)
        if (result.bytesRead !== length) throw new Error(`Неполное чтение части: ${result.bytesRead}/${length}`)
        callback(null, buffer)
      } finally {
        await handle.close()
      }
    }).catch((error: Error) => callback(error))
  }

  async release(index: number): Promise<void> {
    await this.ready
    const size = this.sizes.get(index)
    if (size === undefined) return
    await unlink(this.piecePath(index)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    this.sizes.delete(index)
    this.usedBytes = Math.max(0, this.usedBytes - size)
    if (this.torrent?.bitfield?.get(index)) this.torrent._markUnverified?.(index)
    this.resumeSelectionIfSafe()
    void this.drain()
  }

  close(callback: Callback = noop): void {
    this.closed = true
    queueMicrotask(() => callback(null))
  }

  destroy(callback: Callback = noop): void {
    this.closed = true
    this.ready.then(() => rm(this.root, { recursive: true, force: true })).then(
      () => callback(null),
      (error: Error) => callback(error),
    )
  }

  private async initialize(): Promise<void> {
    // A new WebTorrent instance has an empty bitfield and cannot trust cache
    // files left by a crashed process without re-validating every piece.
    await rm(this.root, { recursive: true, force: true })
    await mkdir(this.root, { recursive: true, mode: 0o700 })
  }

  private async drain(): Promise<void> {
    if (this.writing || this.closed) return
    this.writing = true
    try {
      await this.ready
      while (this.pending.length > 0 && !this.closed) {
        const next = this.pending[0]!
        const existingSize = this.sizes.get(next.index) ?? 0
        let projected = this.usedBytes - existingSize + next.buffer.byteLength
        const critical = next.index <= this.readCursor + this.headroomPieces
        const hardLimit = this.maxBytes + (this.headroomPieces * this.chunkLength)
        if (projected > this.maxBytes && !critical) {
          this.pending.shift()
          this.pauseSelection()
          next.callback(null)
          queueMicrotask(() => {
            if (this.torrent?.bitfield?.get(next.index)) this.torrent._markUnverified?.(next.index)
          })
          continue
        }
        while (critical && projected > hardLimit) {
          if (!await this.evictFarthestAfter(next.index)) break
          projected = this.usedBytes - existingSize + next.buffer.byteLength
        }
        if (projected > hardLimit) break

        const disk = await statfs(this.root)
        const freeBytes = Number(disk.bavail) * Number(disk.bsize)
        if (freeBytes - next.buffer.byteLength < this.reserveBytes) {
          const error = Object.assign(new Error('Остановлено защитой свободного места VPS'), { code: 'LOADER_DISK_GUARD' })
          this.pending.shift()
          next.callback(error)
          continue
        }

        this.pending.shift()
        try {
          const destination = this.piecePath(next.index)
          const temporary = `${destination}.${randomUUID()}.tmp`
          const handle = await open(temporary, 'wx', 0o600)
          try {
            await handle.writeFile(next.buffer)
            await handle.sync()
          } finally {
            await handle.close()
          }
          await rename(temporary, destination)
          this.usedBytes = Math.max(0, this.usedBytes - existingSize) + next.buffer.byteLength
          this.peakBytes = Math.max(this.peakBytes, this.usedBytes)
          this.sizes.set(next.index, next.buffer.byteLength)
          next.callback(null)
        } catch (error) {
          next.callback(error as Error)
        }
      }
    } finally {
      this.writing = false
    }
  }

  private piecePath(index: number): string {
    return path.join(this.root, `${String(index).padStart(10, '0')}.piece`)
  }

  private pauseSelection(): void {
    if (this.capacityPaused || !this.torrent?.pieces?.length) return
    this.capacityPaused = true
    this.selectReadWindow()
  }

  private resumeSelectionIfSafe(): void {
    if (!this.capacityPaused || !this.torrent?.pieces?.length) return
    if (this.usedBytes > this.maxBytes - (2 * this.chunkLength)) return
    this.capacityPaused = false
    this.torrent._select?.(this.readCursor, this.torrent.pieces.length - 1, 1, null, true)
  }

  private selectReadWindow(): void {
    if (!this.torrent?.pieces?.length) return
    const lastPiece = this.torrent.pieces.length - 1
    const windowEnd = Math.min(lastPiece, this.readCursor + this.headroomPieces)
    this.torrent._deselect?.(0, lastPiece, true)
    this.torrent._select?.(this.readCursor, windowEnd, 1, null, true)
  }

  private async evictFarthestAfter(index: number): Promise<boolean> {
    const candidate = [...this.sizes.keys()].filter((piece) => piece > index).sort((left, right) => right - left)[0]
    if (candidate === undefined) return false
    const size = this.sizes.get(candidate) ?? 0
    await unlink(this.piecePath(candidate)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    this.sizes.delete(candidate)
    this.usedBytes = Math.max(0, this.usedBytes - size)
    if (this.torrent?.bitfield?.get(candidate)) this.torrent._markUnverified?.(candidate)
    return true
  }
}
