import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rename, rm, stat, statfs, unlink } from 'node:fs/promises'
import path from 'node:path'

const noop = () => {}

export class BoundedPieceStore {
  constructor (chunkLength, options = {}) {
    this.chunkLength = chunkLength
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024
    this.reserveBytes = options.reserveBytes ?? 0
    this.headroomPieces = options.headroomPieces ?? 3
    this.maxPendingPieces = options.maxPendingPieces ?? 8
    this.root = options.cachePath ?? options.path ?? path.join(process.cwd(), 'cache', 'pieces')
    this.torrent = options.torrent
    this.readCursor = 0
    this.usedBytes = 0
    this.peakBytes = 0
    this.closed = false
    this.sizes = new Map()
    this.pending = []
    this.writing = false
    this.capacityPaused = false
    this.ready = this.#initialize()

    if (this.torrent) this.torrent.loaderPieceStore = this
  }

  async #initialize () {
    await mkdir(this.root, { recursive: true })
    const entries = await readdir(this.root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.piece')) continue
      const index = Number.parseInt(entry.name.slice(0, -6), 10)
      if (!Number.isInteger(index)) continue
      const info = await stat(path.join(this.root, entry.name))
      this.sizes.set(index, info.size)
      this.usedBytes += info.size
    }
    this.peakBytes = this.usedBytes
  }

  setReadCursor (index) {
    this.readCursor = index
    this.#drain()
  }

  put (index, buffer, callback = noop) {
    if (this.closed) return queueMicrotask(() => callback(new Error('Piece store is closed')))
    if (this.pending.length >= this.maxPendingPieces && index > this.readCursor + this.headroomPieces) {
      this.#pauseSelection()
      callback(null)
      queueMicrotask(() => {
        if (this.torrent?.bitfield?.get(index)) this.torrent._markUnverified(index)
      })
      return
    }
    this.pending.push({ index, buffer, callback })
    this.pending.sort((a, b) => a.index - b.index)
    this.#drain()
  }

  async #drain () {
    if (this.writing || this.closed) return
    this.writing = true
    try {
      await this.ready
      while (this.pending.length > 0 && !this.closed) {
        const next = this.pending[0]
        const existingSize = this.sizes.get(next.index) ?? 0
        let projected = this.usedBytes - existingSize + next.buffer.byteLength
        const isCritical = next.index <= this.readCursor + this.headroomPieces
        const hardLimit = this.maxBytes + (this.headroomPieces * this.chunkLength)
        if (projected > this.maxBytes && !isCritical) {
          this.pending.shift()
          this.#pauseSelection()
          next.callback(null)
          queueMicrotask(() => {
            if (this.torrent?.bitfield?.get(next.index)) this.torrent._markUnverified(next.index)
          })
          continue
        }
        while (isCritical && projected > hardLimit) {
          const evicted = await this.#evictFarthestAfter(next.index)
          if (!evicted) break
          projected = this.usedBytes - existingSize + next.buffer.byteLength
        }
        if (projected > hardLimit) break

        const disk = await statfs(this.root)
        const freeBytes = Number(disk.bavail) * Number(disk.bsize)
        if (freeBytes - next.buffer.byteLength < this.reserveBytes) {
          const error = new Error('Reserved system disk space would be crossed')
          error.code = 'LOADER_DISK_GUARD'
          this.pending.shift()
          next.callback(error)
          continue
        }

        this.pending.shift()
        try {
          const destination = this.#piecePath(next.index)
          const temporary = `${destination}.${randomUUID()}.tmp`
          const handle = await open(temporary, 'wx', 0o600)
          try {
            await handle.writeFile(next.buffer)
            await handle.sync()
          } finally {
            await handle.close()
          }
          await rename(temporary, destination)
          const replacedSize = this.sizes.get(next.index) ?? 0
          this.usedBytes = Math.max(0, this.usedBytes - replacedSize) + next.buffer.byteLength
          this.peakBytes = Math.max(this.peakBytes, this.usedBytes)
          this.sizes.set(next.index, next.buffer.byteLength)
          next.callback(null)
        } catch (error) {
          next.callback(error)
        }
      }
    } finally {
      this.writing = false
    }
  }

  get (index, options, callback = noop) {
    if (typeof options === 'function') {
      callback = options
      options = {}
    }
    this.ready.then(async () => {
      const handle = await open(this.#piecePath(index), 'r')
      try {
        const info = await handle.stat()
        const offset = options?.offset ?? 0
        const length = options?.length ?? info.size - offset
        const buffer = Buffer.allocUnsafe(length)
        const result = await handle.read(buffer, 0, length, offset)
        if (result.bytesRead !== length) throw new Error(`Short piece read: ${result.bytesRead}/${length}`)
        callback(null, buffer)
      } finally {
        await handle.close()
      }
    }).catch(callback)
  }

  async release (index) {
    await this.ready
    const size = this.sizes.get(index)
    if (size === undefined) return
    await unlink(this.#piecePath(index)).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
    this.sizes.delete(index)
    this.usedBytes = Math.max(0, this.usedBytes - size)
    if (this.torrent?.bitfield?.get(index) && typeof this.torrent._markUnverified === 'function') {
      this.torrent._markUnverified(index)
    }
    this.#resumeSelectionIfSafe()
    this.#drain()
  }

  close (callback = noop) {
    this.closed = true
    queueMicrotask(() => callback(null))
  }

  destroy (callback = noop) {
    this.closed = true
    this.ready.then(() => rm(this.root, { recursive: true, force: true })).then(
      () => callback(null),
      callback
    )
  }

  #piecePath (index) {
    return path.join(this.root, `${String(index).padStart(10, '0')}.piece`)
  }

  #pauseSelection () {
    if (this.capacityPaused || !this.torrent?.pieces?.length) return
    this.capacityPaused = true
    this.torrent._deselect(0, this.torrent.pieces.length - 1, true)
  }

  #resumeSelectionIfSafe () {
    if (!this.capacityPaused || !this.torrent?.pieces?.length) return
    if (this.usedBytes > this.maxBytes - (2 * this.chunkLength)) return
    this.capacityPaused = false
    this.torrent._select(this.readCursor, this.torrent.pieces.length - 1, 1, null, true)
  }

  async #evictFarthestAfter (index) {
    const candidate = [...this.sizes.keys()].filter(piece => piece > index).sort((a, b) => b - a)[0]
    if (candidate === undefined) return false
    const size = this.sizes.get(candidate)
    await unlink(this.#piecePath(candidate)).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
    this.sizes.delete(candidate)
    this.usedBytes = Math.max(0, this.usedBytes - size)
    if (this.torrent?.bitfield?.get(candidate)) this.torrent._markUnverified(candidate)
    return true
  }
}
