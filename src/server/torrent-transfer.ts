import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import WebTorrent from 'webtorrent'
import type { AppConfig } from './config.js'
import { BoundedPieceStore } from './bounded-piece-store.js'
import { JobDatabase, type InternalJob, type InternalJobFile } from './database.js'
import { selectTorrentFiles } from './security.js'
import { YandexDiskAdapter, type FileDigests } from './yandex-disk.js'

interface ActiveTransfer {
  controller: AbortController
  client: any
}

export class TorrentTransfer {
  readonly #active = new Map<string, ActiveTransfer>()

  constructor(
    private readonly database: JobDatabase,
    private readonly storage: YandexDiskAdapter,
    private readonly config: AppConfig,
    private readonly notify: () => void,
  ) {}

  abort(jobId: string): void {
    this.#active.get(jobId)?.controller.abort(new Error('Загрузка остановлена пользователем'))
  }

  abortAll(): void {
    for (const transfer of this.#active.values()) transfer.controller.abort(new Error('Сервис останавливается'))
  }

  async process(job: InternalJob): Promise<void> {
    const controller = new AbortController()
    const cachePath = path.join(this.config.pieceCacheDir, job.id)
    const client = new WebTorrent({ lsd: false, natUpnp: false, natPmp: false, maxConns: 45 })
    this.#active.set(job.id, { controller, client })

    try {
      const torrentId = await this.loadTorrentId(job)
      const torrent = await openTorrent(client, torrentId, {
        signal: controller.signal,
        timeoutMs: this.config.torrentMetadataTimeoutMs,
        cachePath,
        maxBytes: this.config.pieceCacheMaxBytes,
        reserveBytes: this.config.diskReserveBytes,
      })
      controller.signal.throwIfAborted()

      const descriptors = torrent.files.map((file: any, index: number) => ({
        index,
        name: String(file.name),
        path: String(file.path),
        length: Number(file.length),
      }))
      const selected = selectTorrentFiles(job.destination, String(torrent.name), descriptors)
      const files = this.database.upsertTorrentFiles(job.id, selected.files)
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
      this.database.updateJob(job.id, {
        sourceLabel: `BitTorrent · ${String(torrent.infoHash).slice(0, 8).toUpperCase()}`,
        title: String(torrent.name).slice(0, 180),
        destination: selected.destination,
        destinationPath: selected.destinationPath,
        status: 'verifying',
        totalBytes,
        errorMessage: null,
      })
      this.database.addEvent(job.id, 'info', `Получены метаданные: ${files.length} файл(ов), ${formatBytes(totalBytes)}`)
      this.notify()

      for (const fileRecord of files) {
        controller.signal.throwIfAborted()
        const torrentFile = torrent.files[fileRecord.index]
        if (!torrentFile || Number(torrentFile.length) !== fileRecord.size) {
          throw new Error(`Состав торрента изменился: ${fileRecord.relativePath}`)
        }
        await this.processFile(job.id, torrent, torrentFile, fileRecord, controller.signal)
      }

      const completed = this.database.updateJob(job.id, {
        status: 'completed',
        progress: 1,
        bytesTransferred: totalBytes,
        totalBytes,
        speedBytesPerSecond: 0,
        errorMessage: null,
      })
      this.database.addEvent(job.id, 'info', 'Все файлы сохранены и проверены на Яндекс Диске')
      this.notify()
      void completed
    } finally {
      this.#active.delete(job.id)
      await destroyClient(client)
      await rm(cachePath, { recursive: true, force: true })
    }
  }

  private async processFile(
    jobId: string,
    torrent: any,
    torrentFile: any,
    initialFile: InternalJobFile,
    signal: AbortSignal,
  ): Promise<void> {
    let file = initialFile
    if (file.status === 'completed') {
      const metadata = await this.storage.getMetadataOrNull(file.destinationPath)
      if (metadata?.type === 'file' && metadata.size === file.size && metadata.md5 === file.md5) return
      file = this.database.updateJobFile(file.id, { status: 'pending', bytesTransferred: 0, uploadHref: null })
    }

    let digests: FileDigests
    if (file.md5 && file.sha256) {
      digests = { md5: file.md5, sha256: file.sha256 }
    } else {
      this.database.updateJobFile(file.id, { status: 'hashing', bytesTransferred: 0 })
      this.database.updateJob(jobId, { status: 'verifying', progress: null, speedBytesPerSecond: 0 })
      this.database.addEvent(jobId, 'info', `Проверяется источник: ${file.relativePath}`)
      this.notify()
      const progress = createProgressReporter(jobId, file.id, 0, this.database, this.notify)
      digests = await hashTorrentFile(torrent, torrentFile, signal, progress, this.config.torrentMetadataTimeoutMs)
      file = this.database.updateJobFile(file.id, { ...digests, status: 'pending', bytesTransferred: 0 })
      this.updateAggregate(jobId, 0)
    }

    const existing = await this.storage.getMetadataOrNull(file.destinationPath)
    if (existing) {
      if (existing.type === 'file' && existing.size === file.size && existing.md5 === digests.md5) {
        this.database.updateJobFile(file.id, { status: 'completed', bytesTransferred: file.size })
        this.updateAggregate(jobId, 0)
        this.database.addEvent(jobId, 'info', `Уже сохранён и проверен: ${file.relativePath}`)
        this.notify()
        return
      }
      throw new Error(`Путь назначения уже занят другим файлом: ${file.destinationPath}`)
    }

    let uploadHref = file.uploadHref
    let offset = 0
    if (uploadHref) {
      try {
        offset = await this.storage.getStableUploadOffset(uploadHref, digests, file.size)
      } catch {
        uploadHref = null
        this.database.updateJobFile(file.id, { uploadHref: null, bytesTransferred: 0 })
      }
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      signal.throwIfAborted()
      if (!uploadHref) {
        uploadHref = await this.storage.requestUpload(file.destinationPath)
        this.database.updateJobFile(file.id, { uploadHref })
      }
      if (offset >= file.size) {
        await this.storage.waitForFileMetadata(file.destinationPath, file.size, digests.md5)
        break
      }

      this.database.updateJobFile(file.id, { status: 'transferring', bytesTransferred: offset })
      this.database.updateJob(jobId, { status: 'transferring', errorMessage: null })
      this.database.addEvent(jobId, 'info', `${offset > 0 ? 'Продолжается' : 'Началась'} передача: ${file.relativePath}`)
      this.notify()

      const progress = createProgressReporter(jobId, file.id, offset, this.database, this.notify)
      const body = Readable.from(
        readTorrentFile(torrent, torrentFile, offset, signal, progress, this.config.torrentMetadataTimeoutMs),
        { objectMode: false, highWaterMark: 256 * 1024 },
      )
      try {
        await this.storage.uploadRange(uploadHref, offset, file.size, body, signal, this.config.uploadTimeoutMs)
        await this.storage.waitForFileMetadata(file.destinationPath, file.size, digests.md5)
        break
      } catch (error) {
        body.destroy()
        signal.throwIfAborted()
        if (attempt === 3) throw error
        try {
          offset = await this.storage.getStableUploadOffset(uploadHref, digests, file.size)
        } catch {
          uploadHref = null
          offset = 0
          this.database.updateJobFile(file.id, { uploadHref: null, bytesTransferred: 0 })
        }
        this.database.addEvent(jobId, 'info', `Соединение восстановлено с отметки ${formatBytes(offset)}`)
        this.updateAggregate(jobId, 0)
        await delay(750 * (attempt + 1), signal)
      }
    }

    this.database.updateJobFile(file.id, { status: 'completed', bytesTransferred: file.size })
    this.updateAggregate(jobId, 0)
    this.database.addEvent(jobId, 'info', `Файл сохранён и проверен: ${file.relativePath}`)
    this.notify()
  }

  private updateAggregate(jobId: string, speed: number): void {
    const job = this.database.getInternalJob(jobId)
    if (!job) return
    const total = job.files.reduce((sum, file) => sum + file.size, 0)
    const transferred = job.files.reduce((sum, file) => sum + Math.min(file.bytesTransferred, file.size), 0)
    this.database.updateJob(jobId, {
      progress: total > 0 ? transferred / total : null,
      bytesTransferred: transferred,
      totalBytes: total || null,
      speedBytesPerSecond: speed,
    })
  }

  private async loadTorrentId(job: InternalJob): Promise<string | Buffer> {
    if (job.sourceKind === 'magnet') return job.source
    const metadataPath = path.resolve(job.source)
    const root = path.resolve(this.config.torrentMetadataDir)
    if (!metadataPath.startsWith(`${root}${path.sep}`)) throw new Error('Путь .torrent находится вне защищённого каталога')
    const value = await readFile(metadataPath)
    if (value.byteLength > 4 * 1024 * 1024) throw new Error('.torrent превышает лимит 4 МиБ')
    return value
  }
}

async function openTorrent(
  client: any,
  torrentId: string | Buffer,
  options: { signal: AbortSignal, timeoutMs: number, cachePath: string, maxBytes: number, reserveBytes: number },
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Не удалось получить метаданные торрента за отведённое время')), options.timeoutMs)
    const abort = () => finish(options.signal.reason instanceof Error ? options.signal.reason : new Error('Загрузка остановлена'))
    let settled = false
    const torrent = client.add(torrentId, {
      deselect: true,
      store: BoundedPieceStore,
      storeCacheSlots: 0,
      storeOpts: {
        cachePath: options.cachePath,
        maxBytes: options.maxBytes,
        reserveBytes: options.reserveBytes,
        headroomPieces: 3,
        maxPendingPieces: 8,
      },
      strategy: 'sequential',
    }, (readyTorrent: any) => finish(null, readyTorrent))
    const error = (cause: Error) => finish(cause)
    torrent.once('error', error)
    client.once('error', error)
    options.signal.addEventListener('abort', abort, { once: true })

    function finish(cause: Error | null, readyTorrent?: any): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      options.signal.removeEventListener('abort', abort)
      torrent?.removeListener('error', error)
      client.removeListener('error', error)
      if (cause) reject(cause)
      else resolve(readyTorrent)
    }
  })
}

async function hashTorrentFile(
  torrent: any,
  file: any,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
  inactivityTimeoutMs: number,
): Promise<FileDigests> {
  const md5 = createHash('md5')
  const sha256 = createHash('sha256')
  for await (const chunk of readTorrentFile(torrent, file, 0, signal, onProgress, inactivityTimeoutMs)) {
    md5.update(chunk)
    sha256.update(chunk)
  }
  return { md5: md5.digest('hex'), sha256: sha256.digest('hex') }
}

async function * readTorrentFile(
  torrent: any,
  file: any,
  start: number,
  signal: AbortSignal,
  onProgress?: (bytes: number) => void,
  inactivityTimeoutMs?: number,
): AsyncGenerator<Buffer> {
  const store = torrent.store?.store ?? torrent.store
  const pieceStore: BoundedPieceStore | undefined = torrent.loaderPieceStore ?? store?.loaderPieceStore ?? store
  const firstPiece = Math.floor((Number(file.offset) + start) / Number(torrent.pieceLength))
  pieceStore?.setReadCursor?.(firstPiece)
  const iterator = file[Symbol.asyncIterator]({ start })
  reconnectManualPeers(torrent)
  let offset = start
  let releasePiece: number | null = null
  try {
    while (true) {
      const next = await nextWithAbort(iterator, signal, inactivityTimeoutMs)
      if (next.done) break
      signal.throwIfAborted()
      if (releasePiece !== null) await pieceStore?.release?.(releasePiece)
      const chunk = Buffer.from(next.value)
      const piece = Math.floor((Number(file.offset) + offset) / Number(torrent.pieceLength))
      pieceStore?.setReadCursor?.(piece)
      releasePiece = piece
      offset += chunk.byteLength
      onProgress?.(offset)
      yield chunk
    }
    if (offset !== Number(file.length)) {
      throw new Error(`Источник торрента завершился раньше ожидаемого: ${formatBytes(offset)} из ${formatBytes(Number(file.length))}`)
    }
  } finally {
    if (releasePiece !== null) await pieceStore?.release?.(releasePiece)
    await iterator.return?.()
  }
}

function reconnectManualPeers(torrent: any): void {
  for (const peer of torrent.peerAddresses ?? []) {
    try {
      torrent.removePeer(peer)
      torrent.addPeer(peer)
    } catch {
      // Discovery keeps running; a duplicate or stale explicit peer is harmless.
    }
  }
}

async function nextWithAbort(
  iterator: AsyncIterator<Uint8Array>,
  signal: AbortSignal,
  inactivityTimeoutMs?: number,
): Promise<IteratorResult<Uint8Array>> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout | null = null
    const cleanup = () => {
      signal.removeEventListener('abort', abort)
      if (timeout) clearTimeout(timeout)
    }
    const abort = () => {
      cleanup()
      void iterator.return?.()
      reject(signal.reason instanceof Error ? signal.reason : new Error('Загрузка остановлена'))
    }
    signal.addEventListener('abort', abort, { once: true })
    if (inactivityTimeoutMs) {
      timeout = setTimeout(() => {
        cleanup()
        void iterator.return?.()
        reject(new Error('Данные торрента не поступают: нет доступных раздающих пиров'))
      }, inactivityTimeoutMs)
    }
    iterator.next().then(
      (result) => {
        cleanup()
        resolve(result)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

function createProgressReporter(
  jobId: string,
  fileId: string,
  initialOffset: number,
  database: JobDatabase,
  notify: () => void,
): (offset: number) => void {
  let lastBytes = initialOffset
  let lastTime = Date.now()
  let lastPersisted = lastTime
  return (offset) => {
    const now = Date.now()
    if (now - lastPersisted < 750 && offset > initialOffset) return
    const seconds = Math.max((now - lastTime) / 1_000, 0.001)
    const speed = Math.max(0, Math.round((offset - lastBytes) / seconds))
    database.updateJobFile(fileId, { bytesTransferred: offset })
    const job = database.getInternalJob(jobId)
    if (job) {
      const total = job.files.reduce((sum, file) => sum + file.size, 0)
      const transferred = job.files.reduce((sum, file) => sum + Math.min(file.bytesTransferred, file.size), 0)
      database.updateJob(jobId, {
        progress: total > 0 ? transferred / total : null,
        bytesTransferred: transferred,
        totalBytes: total,
        speedBytesPerSecond: speed,
      })
    }
    lastBytes = offset
    lastTime = now
    lastPersisted = now
    notify()
  }
}

function destroyClient(client: any): Promise<void> {
  if (!client || client.destroyed) return Promise.resolve()
  return new Promise((resolve) => client.destroy(() => resolve()))
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds)
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(signal.reason instanceof Error ? signal.reason : new Error('Загрузка остановлена'))
    }
    signal.addEventListener('abort', abort, { once: true })
    function done(): void {
      signal.removeEventListener('abort', abort)
      resolve()
    }
  })
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} Б`
  const units = ['КиБ', 'МиБ', 'ГиБ', 'ТиБ']
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)) - 1, units.length - 1)
  return `${(value / (1024 ** (exponent + 1))).toFixed(1)} ${units[exponent]}`
}
