import { readFile, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { createMD5, createSHA256, type IHasher } from 'hash-wasm'
import { Readable } from 'node:stream'
import WebTorrent from 'webtorrent'
import type { AppConfig } from './config.js'
import { BoundedPieceStore } from './bounded-piece-store.js'
import { JobDatabase, type InternalJob, type InternalJobFile } from './database.js'
import { selectTorrentFiles } from './security.js'
import {
  bytesPerSecond, createMeasuredUploadBody, detectBottleneck, readExactBufferWithRetry, uploadChunkBytes,
} from './transfer-buffer.js'
import { buildTorrentRelayUrl } from './torrent-relay-auth.js'
import { YandexDiskAdapter, YandexUploadSessionExpiredError, type FileDigests } from './yandex-disk.js'

interface ActiveTransfer {
  controller: AbortController
  client: any
  torrent: any | null
  relayError: Error | null
  phase: 'starting' | 'hashing' | 'transferring' | 'remote-import'
  pauseGate: PauseGate
  finished: Promise<void>
  finish: () => void
}

interface TorrentHashCheckpoint {
  version: 1
  offset: number
  size: number
  md5State: string
  sha256State: string
}

export interface ResumableTorrentHash {
  readonly offset: number
  readonly restored: boolean
  readonly discardedCheckpoint: boolean
  update: (chunk: Uint8Array) => void
  checkpoint: () => string
  digest: () => FileDigests
}

const torrentHashCheckpointIntervalBytes = 4 * 1024 * 1024

export class TorrentSourceUnavailableError extends Error {}

export const torrentClientOptions = {
  lsd: false,
  natUpnp: false,
  natPmp: false,
  maxConns: 45,
  // utp-native 2.5.3 can emit UTP_ECONNRESET after WebTorrent has detached
  // its peer listeners. Keep the worker on the stable TCP path instead of
  // allowing a routine peer disconnect to terminate the whole API process.
  utp: false,
} as const

export class PauseGate {
  #paused = false
  readonly #waiters = new Set<() => void>()

  get paused(): boolean {
    return this.#paused
  }

  pause(): void {
    this.#paused = true
  }

  resume(): void {
    this.#paused = false
    for (const resolve of this.#waiters) resolve()
    this.#waiters.clear()
  }

  async wait(signal: AbortSignal): Promise<void> {
    while (this.#paused) {
      signal.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const resumed = () => {
          cleanup()
          resolve()
        }
        const aborted = () => {
          cleanup()
          reject(signal.reason instanceof Error ? signal.reason : new Error('Загрузка остановлена'))
        }
        const cleanup = () => {
          this.#waiters.delete(resumed)
          signal.removeEventListener('abort', aborted)
        }
        this.#waiters.add(resumed)
        signal.addEventListener('abort', aborted, { once: true })
        if (!this.#paused) resumed()
      })
    }
  }
}

export class TorrentTransfer {
  readonly #active = new Map<string, ActiveTransfer>()

  constructor(
    private readonly database: JobDatabase,
    private readonly storage: YandexDiskAdapter,
    private readonly config: AppConfig,
    private readonly notify: () => void,
  ) {}

  pause(jobId: string): void {
    const transfer = this.#active.get(jobId)
    if (!transfer) return
    if (transfer.phase === 'hashing') transfer.pauseGate.pause()
    else this.abort(jobId)
  }

  resume(jobId: string): boolean {
    const transfer = this.#active.get(jobId)
    if (!transfer?.pauseGate.paused) return false
    transfer.pauseGate.resume()
    for (const torrent of transfer.client.torrents ?? []) refreshTorrentPeers(torrent)
    return true
  }

  abort(jobId: string): void {
    const transfer = this.#active.get(jobId)
    transfer?.controller.abort(new Error('Загрузка остановлена пользователем'))
    transfer?.pauseGate.resume()
  }

  async waitForStop(jobId: string): Promise<void> {
    await this.#active.get(jobId)?.finished
  }

  abortAll(): void {
    for (const transfer of this.#active.values()) {
      transfer.controller.abort(new Error('Сервис останавливается'))
      transfer.pauseGate.resume()
    }
  }

  async process(job: InternalJob): Promise<void> {
    const controller = new AbortController()
    const cachePath = path.join(this.config.pieceCacheDir, job.id)
    const client = new WebTorrent(torrentClientOptions)
    let finish: () => void = () => undefined
    const finished = new Promise<void>((resolve) => { finish = resolve })
    const transfer: ActiveTransfer = {
      controller, client, torrent: null, relayError: null,
      phase: 'starting', pauseGate: new PauseGate(), finished, finish,
    }
    this.#active.set(job.id, transfer)

    try {
      const torrentId = await this.loadTorrentId(job)
      const torrent = await openTorrent(client, torrentId, {
        signal: controller.signal,
        timeoutMs: this.config.torrentMetadataTimeoutMs,
        cachePath,
        maxBytes: this.config.pieceCacheMaxBytes,
        reserveBytes: this.config.diskReserveBytes,
      })
      transfer.torrent = torrent
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

      if (files.length === 1) {
        await this.processSingleFileRemoteImport(job.id, files[0]!, transfer)
      } else {
        for (const fileRecord of files) {
          controller.signal.throwIfAborted()
          const torrentFile = torrent.files[fileRecord.index]
          if (!torrentFile || Number(torrentFile.length) !== fileRecord.size) {
            throw new Error(`Состав торрента изменился: ${fileRecord.relativePath}`)
          }
          await this.processFile(job.id, torrent, torrentFile, fileRecord, transfer)
        }
      }

      const completed = this.database.updateJob(job.id, {
        status: 'completed',
        progress: 1,
        bytesTransferred: totalBytes,
        totalBytes,
        speedBytesPerSecond: 0,
        bufferedBytes: 0,
        errorMessage: null,
      })
      this.database.addEvent(job.id, 'info', 'Все файлы сохранены и проверены на Яндекс Диске')
      this.notify()
      void completed
    } finally {
      this.#active.delete(job.id)
      try {
        await destroyClient(client)
        await rm(cachePath, { recursive: true, force: true })
      } finally {
        transfer.finish()
      }
    }
  }

  createRelayStream(jobId: string, fileIndex: number, start: number, end: number): Readable {
    const transfer = this.#active.get(jobId)
    const torrentFile = transfer?.torrent?.files?.[fileIndex]
    if (!transfer || !torrentFile || transfer.controller.signal.aborted) {
      throw new Error('Торрент-поток сейчас недоступен')
    }
    const expectedSize = Number(torrentFile.length)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end < start || end >= expectedSize) {
      throw new Error('Некорректный диапазон торрент-потока')
    }
    const source = readTorrentRelayRange(
      transfer.torrent, torrentFile, start, end, transfer.controller.signal,
      Math.min(this.config.torrentMetadataTimeoutMs, 120_000),
    )
    const stream = Readable.from(source, { objectMode: false })
    stream.once('error', (error) => {
      transfer.relayError = error instanceof Error ? error : new Error('Торрент-поток оборвался')
    })
    return stream
  }

  private async processSingleFileRemoteImport(
    jobId: string,
    initialFile: InternalJobFile,
    transfer: ActiveTransfer,
  ): Promise<void> {
    const signal = transfer.controller.signal
    transfer.phase = 'remote-import'
    let file = initialFile
    let operationHref = this.database.getInternalJob(jobId)?.operationHref ?? null

    if (file.status === 'completed' && file.md5) {
      const existing = await this.storage.getMetadataOrNull(file.destinationPath)
      if (existing?.type === 'file' && existing.size === file.size && existing.md5 === file.md5) return
      file = this.database.updateJobFile(file.id, { status: 'pending', bytesTransferred: 0, md5: null })
    }

    if (!operationHref) {
      const existing = await this.storage.getMetadataOrNull(file.destinationPath)
      if (existing) throw new Error(`Путь назначения уже занят другим файлом: ${file.destinationPath}`)
      this.database.updateJobFile(file.id, {
        status: 'transferring', bytesTransferred: 0, uploadHref: null, sourceCheckpoint: null,
      })
      this.database.updateJob(jobId, {
        status: 'transferring', progress: null, bytesTransferred: null,
        speedBytesPerSecond: 0, sourceSpeedBytesPerSecond: 0, yandexUploadSpeedBytesPerSecond: 0,
        bottleneck: null, bufferedBytes: 0, bufferCapacityBytes: null, errorMessage: null,
      })
      this.database.addEvent(jobId, 'info', 'Яндекс Диск начал быстрый импорт торрент-потока через защищённый relay')
      this.notify()
      operationHref = await this.storage.startRemoteImport(
        buildTorrentRelayUrl(this.config, jobId, file.index), file.destinationPath,
      )
      this.database.updateJob(jobId, { operationHref })
    }

    while (true) {
      signal.throwIfAborted()
      const operation = await this.storage.getOperation(operationHref)
      if (operation.status === 'success') break
      if (operation.status === 'failed') {
        this.database.updateJob(jobId, { operationHref: null })
        if (transfer.relayError) throw transfer.relayError
        throw new Error('Яндекс Диск сообщил об ошибке быстрого импорта торрент-потока')
      }
      await delay(1_500, signal)
    }

    const metadata = await waitForRemoteMetadata(this.storage, file.destinationPath, file.size, signal)
    this.database.updateJobFile(file.id, {
      status: 'completed', bytesTransferred: file.size, md5: metadata.md5,
      uploadHref: null, sourceCheckpoint: null,
    })
    this.database.updateJob(jobId, { operationHref: null })
    this.database.addEvent(jobId, 'info', `Быстрый импорт завершён и проверен: ${file.relativePath}`)
    this.updateAggregate(jobId, 0)
    this.notify()
  }

  private async processFile(
    jobId: string,
    torrent: any,
    torrentFile: any,
    initialFile: InternalJobFile,
    transfer: ActiveTransfer,
  ): Promise<void> {
    const signal = transfer.controller.signal
    let file = initialFile
    if (file.status === 'completed') {
      const metadata = await this.storage.getMetadataOrNull(file.destinationPath)
      if (metadata?.type === 'file' && metadata.size === file.size && metadata.md5 === file.md5) return
      file = this.database.updateJobFile(file.id, { status: 'pending', bytesTransferred: 0, uploadHref: null })
    }

    let digests: FileDigests | null = file.md5 && file.sha256
      ? { md5: file.md5, sha256: file.sha256 }
      : null

    // Finish checkpoints created by releases that hashed the whole torrent
    // before starting the upload. New files use the one-pass path below.
    if (!digests && file.status === 'hashing' && file.sourceCheckpoint) {
      transfer.phase = 'hashing'
      const hash = await createResumableTorrentHash(file.size, file.sourceCheckpoint)
      if (hash.discardedCheckpoint) {
        this.database.addEvent(jobId, 'info', 'Повреждённая контрольная точка проверки отброшена')
      } else if (!hash.restored && file.bytesTransferred > 0) {
        this.database.addEvent(jobId, 'info', 'Предыдущий прогресс не имел контрольной точки и не может быть продолжен')
      }
      this.database.updateJobFile(file.id, {
        status: 'hashing', bytesTransferred: hash.offset,
        sourceCheckpoint: hash.restored ? file.sourceCheckpoint : null,
      })
      this.database.updateJob(jobId, {
        status: 'verifying', progress: hash.offset / file.size, bytesTransferred: hash.offset,
        speedBytesPerSecond: 0, sourceSpeedBytesPerSecond: 0, bottleneck: 'source', errorMessage: null,
      })
      this.database.addEvent(jobId, 'info', hash.restored
        ? `Проверка продолжена с ${formatBytes(hash.offset)}: ${file.relativePath}`
        : `Проверяется источник: ${file.relativePath}`)
      this.notify()
      const checkpoint = createHashCheckpointReporter(jobId, file.id, hash.offset, this.database, this.notify)
      digests = await hashTorrentFile(
        torrent,
        torrentFile,
        signal,
        hash,
        checkpoint,
        this.config.torrentMetadataTimeoutMs,
        () => {
          this.updateAggregate(jobId, 0)
          this.notify()
        },
        () => transfer.pauseGate.wait(signal),
      )
      file = this.database.updateJobFile(file.id, {
        ...digests, status: 'pending', bytesTransferred: 0, sourceCheckpoint: null,
      })
      this.updateAggregate(jobId, 0)
    }

    transfer.phase = 'transferring'

    const existing = await this.storage.getMetadataOrNull(file.destinationPath)
    if (existing) {
      if (digests && existing.type === 'file' && existing.size === file.size && existing.md5 === digests.md5) {
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
        offset = await this.storage.getStableUploadOffset(uploadHref, file.size)
      } catch (error) {
        if (error instanceof YandexUploadSessionExpiredError) {
          uploadHref = null
          file = this.database.updateJobFile(file.id, {
            uploadHref: null, bytesTransferred: 0, sourceCheckpoint: null,
          })
          this.updateAggregate(jobId, 0)
          this.database.addEvent(jobId, 'info', 'Временная сессия Яндекс Диска истекла; создана новая передача с 0 Б')
        } else if (file.sourceCheckpoint || file.bytesTransferred > 0) {
          throw new Error('Яндекс временно не подтвердил сохранённую отметку; повторите позже')
        } else {
          uploadHref = null
          file = this.database.updateJobFile(file.id, { uploadHref: null, bytesTransferred: 0 })
        }
      }
    }

    let hash: ResumableTorrentHash | null = null
    if (!digests) {
      hash = await createResumableTorrentHash(file.size, file.sourceCheckpoint)
      if (hash.discardedCheckpoint) {
        this.database.addEvent(jobId, 'info', 'Повреждённая контрольная точка потока отброшена')
      }
      if (hash.offset > offset) {
        if (offset !== 0) throw new Error('Контрольная точка хеша опережает подтверждённые данные Яндекс Диска')
        hash = await createResumableTorrentHash(file.size, null)
        this.database.updateJobFile(file.id, { sourceCheckpoint: null })
        this.database.addEvent(jobId, 'info', 'Сессия Яндекс Диска начата заново; контрольная точка потока сброшена')
      }
      if (hash.offset < offset) {
        this.database.addEvent(jobId, 'info', `Восстанавливается проверка до отметки Яндекс Диска ${formatBytes(offset)}`)
        await catchUpTorrentHash(
          torrent, torrentFile, signal, hash, offset, this.config.torrentMetadataTimeoutMs,
          (checkpoint) => this.database.updateJobFile(file.id, { sourceCheckpoint: checkpoint }),
          () => {
            this.database.updateJob(jobId, { sourceSpeedBytesPerSecond: 0, bottleneck: 'source' })
            this.notify()
          },
        )
      }
    }

    this.database.updateJobFile(file.id, {
      status: 'transferring', bytesTransferred: offset,
      sourceCheckpoint: hash ? hash.checkpoint() : file.sourceCheckpoint,
    })
    this.database.updateJob(jobId, {
      status: 'transferring', errorMessage: null, speedBytesPerSecond: 0,
      sourceSpeedBytesPerSecond: 0, yandexUploadSpeedBytesPerSecond: 0,
      bottleneck: null, bufferedBytes: 0,
      bufferCapacityBytes: Math.min(uploadChunkBytes, file.size - offset),
    })
    this.database.addEvent(jobId, 'info', `${offset > 0 ? 'Продолжается' : 'Началась'} передача${hash ? ' с одновременной проверкой' : ''}: ${file.relativePath}`)
    this.updateAggregate(jobId, 0)
    this.notify()

    let consecutiveFailures = 0
    while (offset < file.size) {
      signal.throwIfAborted()
      if (!uploadHref) {
        uploadHref = await this.storage.requestUpload(file.destinationPath)
        this.database.updateJobFile(file.id, { uploadHref })
      }

      const rangeStart = offset
      const length = Math.min(uploadChunkBytes, file.size - rangeStart)
      const buffered = createBufferedBytesReporter(jobId, length, this.database, this.notify)
      const sourceRead = await readExactBufferWithRetry(
        () => readTorrentFile(
          torrent, torrentFile, rangeStart, signal,
          createSourceSpeedReporter(jobId, rangeStart, this.database, this.notify),
          this.config.torrentMetadataTimeoutMs,
          () => {
            this.database.updateJob(jobId, { sourceSpeedBytesPerSecond: 0, bottleneck: 'source' })
            this.notify()
          },
        ),
        length,
        signal,
        buffered,
        undefined,
        1,
      )
      const buffer = sourceRead.buffer
      const sourceSpeed = bytesPerSecond(length, sourceRead.readMs)
      const beforeUpload = this.database.getInternalJob(jobId)
      this.database.updateJob(jobId, {
        sourceSpeedBytesPerSecond: sourceSpeed,
        bottleneck: detectBottleneck(sourceSpeed, beforeUpload?.yandexUploadSpeedBytesPerSecond ?? 0),
        bufferedBytes: length,
        bufferCapacityBytes: length,
      })
      const measured = createMeasuredUploadBody(buffer, buffered)
      try {
        const uploadStarted = performance.now()
        await this.storage.uploadRange(
          uploadHref, rangeStart, file.size, measured.body, signal, this.config.uploadTimeoutMs, length,
        )
        const uploadRequestMs = performance.now() - uploadStarted
        const yandexUploadSpeed = bytesPerSecond(length, uploadRequestMs)
        offset = rangeStart + length
        consecutiveFailures = 0
        if (hash) {
          commitTorrentHashBuffer(hash, rangeStart, offset, buffer)
          if (offset === file.size) {
            digests = hash.digest()
            this.database.updateJobFile(file.id, {
              bytesTransferred: offset, ...digests, sourceCheckpoint: null,
            })
          } else {
            this.database.updateJobFile(file.id, {
              bytesTransferred: offset, sourceCheckpoint: hash.checkpoint(),
            })
          }
        } else {
          this.database.updateJobFile(file.id, { bytesTransferred: offset })
        }
        this.updateAggregate(jobId, yandexUploadSpeed)
        this.database.updateJob(jobId, {
          sourceSpeedBytesPerSecond: sourceSpeed,
          yandexUploadSpeedBytesPerSecond: yandexUploadSpeed,
          bottleneck: detectBottleneck(sourceSpeed, yandexUploadSpeed),
          bufferedBytes: 0,
          bufferCapacityBytes: length,
          uploadRequestMs: Math.round(uploadRequestMs),
          uploadWriteBlockedMs: Math.round(measured.metrics.writeBlockedMs),
        })
        this.notify()
      } catch (error) {
        measured.body.destroy()
        signal.throwIfAborted()
        consecutiveFailures += 1
        if (consecutiveFailures >= 4) throw error
        try {
          const stableOffset = await this.storage.getStableUploadOffset(uploadHref, file.size)
          if (stableOffset < rangeStart || stableOffset > rangeStart + length) {
            throw new Error('Яндекс вернул отметку вне текущего диапазона')
          }
          if (hash && stableOffset > rangeStart) {
            commitTorrentHashBuffer(hash, rangeStart, stableOffset, buffer)
            if (stableOffset === file.size) {
              digests = hash.digest()
              this.database.updateJobFile(file.id, {
                bytesTransferred: stableOffset, ...digests, sourceCheckpoint: null,
              })
            } else {
              this.database.updateJobFile(file.id, {
                bytesTransferred: stableOffset, sourceCheckpoint: hash.checkpoint(),
              })
            }
          }
          offset = stableOffset
        } catch {
          throw error
        }
        if (!hash) this.database.updateJobFile(file.id, { bytesTransferred: offset })
        this.database.addEvent(jobId, 'info', `Соединение восстановлено с отметки ${formatBytes(offset)}`)
        this.updateAggregate(jobId, 0)
        this.database.updateJob(jobId, { bufferedBytes: 0 })
        this.notify()
        await delay(750 * consecutiveFailures, signal)
      }
    }

    if (!digests) throw new Error('Не удалось завершить проверку переданного файла')
    await this.storage.waitForFileMetadata(file.destinationPath, file.size, digests.md5)

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
    return readTorrentMetadata(job.id, this.config.torrentMetadataDir)
  }
}

export async function readTorrentMetadata(jobId: string, metadataDirectory: string): Promise<Buffer> {
  const root = await realpath(path.resolve(metadataDirectory))
  const metadataPath = await realpath(path.join(root, `${jobId}.torrent`))
  if (!metadataPath.startsWith(`${root}${path.sep}`)) throw new Error('Путь .torrent находится вне защищённого каталога')
  const value = await readFile(metadataPath)
  if (value.byteLength > 4 * 1024 * 1024) throw new Error('.torrent превышает лимит 4 МиБ')
  return value
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
    rememberDiscoveredPeers(torrent)
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
  hash: ResumableTorrentHash,
  onCheckpoint: (offset: number, checkpoint: string) => void,
  inactivityTimeoutMs: number,
  onInactive?: () => void,
  waitIfPaused?: () => Promise<void>,
): Promise<FileDigests> {
  let lastCheckpointOffset = hash.offset
  const persistCheckpoint = (force = false) => {
    if (hash.offset === lastCheckpointOffset) return
    if (!force && hash.offset - lastCheckpointOffset < torrentHashCheckpointIntervalBytes) return
    onCheckpoint(hash.offset, hash.checkpoint())
    lastCheckpointOffset = hash.offset
  }
  const sourceInactive = () => {
    persistCheckpoint(true)
    onInactive?.()
  }

  try {
    for await (const chunk of readTorrentFile(
      torrent, file, hash.offset, signal, undefined, inactivityTimeoutMs, sourceInactive, waitIfPaused,
    )) {
      hash.update(chunk)
      persistCheckpoint()
    }
  } catch (error) {
    persistCheckpoint(true)
    throw error
  }
  persistCheckpoint(true)
  return hash.digest()
}

async function catchUpTorrentHash(
  torrent: any,
  file: any,
  signal: AbortSignal,
  hash: ResumableTorrentHash,
  targetOffset: number,
  inactivityTimeoutMs: number,
  onCheckpoint: (checkpoint: string) => void,
  onInactive?: () => void,
): Promise<void> {
  while (hash.offset < targetOffset) {
    const rangeStart = hash.offset
    const length = Math.min(uploadChunkBytes, targetOffset - rangeStart)
    const source = await readExactBufferWithRetry(
      () => readTorrentFile(torrent, file, rangeStart, signal, undefined, inactivityTimeoutMs, onInactive),
      length,
      signal,
      undefined,
      undefined,
      1,
    )
    hash.update(source.buffer)
    onCheckpoint(hash.checkpoint())
  }
}

export function commitTorrentHashBuffer(
  hash: ResumableTorrentHash,
  rangeStart: number,
  confirmedOffset: number,
  buffer: Uint8Array,
): void {
  const confirmedLength = confirmedOffset - rangeStart
  if (hash.offset !== rangeStart
    || !Number.isSafeInteger(confirmedLength)
    || confirmedLength <= 0
    || confirmedLength > buffer.byteLength) {
    throw new Error('Подтверждённый диапазон Яндекс Диска не совпадает с контрольной точкой хеша')
  }
  hash.update(buffer.subarray(0, confirmedLength))
}

export async function createResumableTorrentHash(
  expectedSize: number,
  serializedCheckpoint: string | null,
): Promise<ResumableTorrentHash> {
  const [md5, sha256] = await Promise.all([createMD5(), createSHA256()])
  md5.init()
  sha256.init()
  let offset = 0
  let restored = false
  let discardedCheckpoint = false

  if (serializedCheckpoint) {
    try {
      const checkpoint = decodeTorrentHashCheckpoint(serializedCheckpoint, expectedSize)
      md5.load(decodeHashState(checkpoint.md5State))
      sha256.load(decodeHashState(checkpoint.sha256State))
      offset = checkpoint.offset
      restored = true
    } catch {
      md5.init()
      sha256.init()
      discardedCheckpoint = true
    }
  }

  return {
    get offset() { return offset },
    restored,
    discardedCheckpoint,
    update(chunk) {
      if (offset + chunk.byteLength > expectedSize) throw new Error('Проверка торрента вышла за ожидаемый размер файла')
      md5.update(chunk)
      sha256.update(chunk)
      offset += chunk.byteLength
    },
    checkpoint() {
      return encodeTorrentHashCheckpoint({
        version: 1,
        offset,
        size: expectedSize,
        md5State: encodeHashState(md5),
        sha256State: encodeHashState(sha256),
      })
    },
    digest() {
      if (offset !== expectedSize) {
        throw new Error(`Проверка торрента неполна: ${formatBytes(offset)} из ${formatBytes(expectedSize)}`)
      }
      return { md5: md5.digest('hex'), sha256: sha256.digest('hex') }
    },
  }
}

function encodeTorrentHashCheckpoint(checkpoint: TorrentHashCheckpoint): string {
  return JSON.stringify(checkpoint)
}

function decodeTorrentHashCheckpoint(value: string, expectedSize: number): TorrentHashCheckpoint {
  const checkpoint = JSON.parse(value) as Partial<TorrentHashCheckpoint>
  if (checkpoint.version !== 1
    || checkpoint.size !== expectedSize
    || !Number.isSafeInteger(checkpoint.offset)
    || (checkpoint.offset ?? -1) < 0
    || (checkpoint.offset ?? expectedSize + 1) > expectedSize
    || !isBase64Url(checkpoint.md5State)
    || !isBase64Url(checkpoint.sha256State)) {
    throw new Error('Некорректная контрольная точка проверки торрента')
  }
  return checkpoint as TorrentHashCheckpoint
}

function encodeHashState(hash: IHasher): string {
  return Buffer.from(hash.save()).toString('base64url')
}

function decodeHashState(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'base64url'))
}

function isBase64Url(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9_-]+$/u.test(value)
}

async function * readTorrentFile(
  torrent: any,
  file: any,
  start: number,
  signal: AbortSignal,
  onProgress?: (bytes: number) => void,
  inactivityTimeoutMs?: number,
  onInactive?: () => void,
  waitIfPaused?: () => Promise<void>,
): AsyncGenerator<Buffer> {
  const store = torrent.store?.store ?? torrent.store
  const pieceStore: BoundedPieceStore | undefined = torrent.loaderPieceStore ?? store?.loaderPieceStore ?? store
  const firstPiece = Math.floor((Number(file.offset) + start) / Number(torrent.pieceLength))
  const lastPiece = Math.floor((Number(file.offset) + Number(file.length) - 1) / Number(torrent.pieceLength))
  pieceStore?.setReadCursor?.(firstPiece)
  const iterator = file[Symbol.asyncIterator]({ start })
  pieceStore?.constrainToReadWindow?.(firstPiece, lastPiece)
  reconnectManualPeers(torrent)
  const refreshPeers = () => {
    refreshTorrentPeers(torrent)
    onInactive?.()
  }
  let offset = start
  let releasePiece: number | null = null
  try {
    while (true) {
      await waitIfPaused?.()
      const next = await nextWithAbort(iterator, signal, inactivityTimeoutMs, refreshPeers)
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

async function * readTorrentRelayRange(
  torrent: any,
  file: any,
  start: number,
  end: number,
  signal: AbortSignal,
  inactivityTimeoutMs: number,
): AsyncGenerator<Buffer> {
  let offset = start
  while (offset <= end) {
    signal.throwIfAborted()
    const length = Math.min(uploadChunkBytes, end - offset + 1)
    const rangeStart = offset
    const source = await readExactBufferWithRetry(
      () => readTorrentFile(
        torrent, file, rangeStart, signal, undefined, inactivityTimeoutMs,
        () => refreshTorrentPeers(torrent),
      ),
      length,
      signal,
      undefined,
      async (attempt) => {
        refreshTorrentPeers(torrent)
        await delay(750 * attempt, signal)
      },
      3,
    )
    yield source.buffer
    offset += length
  }
}

async function waitForRemoteMetadata(
  storage: YandexDiskAdapter,
  destinationPath: string,
  expectedSize: number,
  signal: AbortSignal,
): Promise<{ md5: string }> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    signal.throwIfAborted()
    const metadata = await storage.getMetadataOrNull(destinationPath)
    if (metadata?.type === 'file' && metadata.size === expectedSize && metadata.md5) {
      return { md5: metadata.md5 }
    }
    await delay(1_500, signal)
  }
  throw new Error('Яндекс Диск не подтвердил размер и MD5 импортированного файла')
}

export function refreshTorrentPeers(torrent: any): void {
  const connected = new Set<string>(torrent.loaderConnectedPeers ?? [])
  const candidates = new Set<string>(torrent.loaderDiscoveredPeers ?? [])
  let reconnectCount = 0
  for (const peer of candidates) {
    if (reconnectCount >= 50) break
    if (connected.has(peer)) continue
    try {
      torrent.removePeer(peer)
      torrent.addPeer(peer)
      reconnectCount += 1
    } catch {
      // The address can become invalid between discovery and reconnect.
    }
  }
  try {
    torrent.discovery?.tracker?.update?.({ numwant: 50 })
  } catch {
    // The normal discovery interval and inactivity timeout remain active.
  }
}

function rememberDiscoveredPeers(torrent: any): void {
  const peers = new Set<string>()
  const connectedPeers = new Set<string>()
  torrent.loaderDiscoveredPeers = peers
  torrent.loaderConnectedPeers = connectedPeers
  torrent.on('peer', (peer: unknown) => {
    if (typeof peer !== 'string') return
    if (peers.size >= 200) return
    peers.add(peer)
  })
  torrent.on('wire', (wire: any, peer: unknown) => {
    if (typeof peer !== 'string') return
    connectedPeers.add(peer)
    const forget = () => connectedPeers.delete(peer)
    wire.once?.('close', forget)
    wire.once?.('error', forget)
    if (connectedPeers.size <= 50) return
    const oldest = connectedPeers.values().next().value
    if (oldest) connectedPeers.delete(oldest)
  })
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
  onInactive?: () => void,
): Promise<IteratorResult<Uint8Array>> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout | null = null
    let refreshInterval: NodeJS.Timeout | null = null
    const cleanup = () => {
      signal.removeEventListener('abort', abort)
      if (timeout) clearTimeout(timeout)
      if (refreshInterval) clearInterval(refreshInterval)
    }
    const abort = () => {
      cleanup()
      void iterator.return?.()
      reject(signal.reason instanceof Error ? signal.reason : new Error('Загрузка остановлена'))
    }
    signal.addEventListener('abort', abort, { once: true })
    if (inactivityTimeoutMs) {
      const refreshIntervalMs = Math.min(30_000, Math.max(1_000, Math.floor(inactivityTimeoutMs / 2)))
      if (onInactive) refreshInterval = setInterval(onInactive, refreshIntervalMs)
      timeout = setTimeout(() => {
        cleanup()
        void iterator.return?.()
        reject(new TorrentSourceUnavailableError('Торрент-поток не отвечает'))
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

function createHashCheckpointReporter(
  jobId: string,
  fileId: string,
  initialOffset: number,
  database: JobDatabase,
  notify: () => void,
): (offset: number, checkpoint: string) => void {
  let lastBytes = initialOffset
  let lastTime = Date.now()
  return (offset, checkpoint) => {
    if (!database.getInternalJob(jobId)) return
    const now = Date.now()
    const seconds = Math.max((now - lastTime) / 1_000, 0.001)
    const speed = Math.max(0, Math.round((offset - lastBytes) / seconds))
    database.updateJobFile(fileId, { bytesTransferred: offset, sourceCheckpoint: checkpoint })
    const job = database.getInternalJob(jobId)
    if (job) {
      const total = job.files.reduce((sum, file) => sum + file.size, 0)
      const transferred = job.files.reduce((sum, file) => sum + Math.min(file.bytesTransferred, file.size), 0)
      database.updateJob(jobId, {
        progress: total > 0 ? transferred / total : null,
        bytesTransferred: transferred,
        totalBytes: total,
        speedBytesPerSecond: speed,
        sourceSpeedBytesPerSecond: speed,
        bottleneck: 'source',
      })
    }
    lastBytes = offset
    lastTime = now
    notify()
  }
}

function createSourceSpeedReporter(
  jobId: string,
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
    const job = database.getInternalJob(jobId)
    database.updateJob(jobId, {
      sourceSpeedBytesPerSecond: speed,
      bottleneck: detectBottleneck(speed, job?.yandexUploadSpeedBytesPerSecond ?? 0),
    })
    lastBytes = offset
    lastTime = now
    lastPersisted = now
    notify()
  }
}

function createBufferedBytesReporter(
  jobId: string,
  capacity: number,
  database: JobDatabase,
  notify: () => void,
): (bytes: number) => void {
  let lastPersisted = 0
  return (bytes) => {
    const now = Date.now()
    if (bytes !== 0 && bytes !== capacity && now - lastPersisted < 750) return
    database.updateJob(jobId, { bufferedBytes: bytes, bufferCapacityBytes: capacity })
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
