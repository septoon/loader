import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { AppConfig } from './config.js'
import { JobDatabase, type InternalJob, type InternalJobFile } from './database.js'
import { resolveRutubeSource, rutubeRequestHeaders, type RutubeSegment } from './rutube.js'
import {
  bytesPerSecond, createMeasuredUploadBody, detectBottleneck, readExactBufferWithRetry, uploadChunkBytes,
} from './transfer-buffer.js'
import { YandexDiskAdapter, type FileDigests } from './yandex-disk.js'

interface ActiveTransfer {
  controller: AbortController
}

interface HashedSource extends FileDigests {
  size: number
  segmentSizes: number[]
}

export class RutubeTransfer {
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
    this.#active.set(job.id, { controller })
    try {
      const source = await resolveRutubeSource(job.source)
      controller.signal.throwIfAborted()
      let file = job.files[0]
      let segmentSizes = file ? decodeSegmentSizes(file.sourceCheckpoint, source.segments.length, file.size) : null

      if (!file?.md5 || !file.sha256) {
        this.database.updateJob(job.id, {
          status: 'verifying', progress: null, bytesTransferred: 0, totalBytes: null,
          speedBytesPerSecond: 0, errorMessage: null,
        })
        this.database.addEvent(job.id, 'info', `Rutube: проверяется поток ${source.resolution}`)
        this.notify()
        const progress = createJobProgressReporter(job.id, this.database, this.notify)
        const hashed = await hashSegments(source.segments, job.source, controller.signal, progress)
        segmentSizes = hashed.segmentSizes
        const files = this.database.upsertTorrentFiles(job.id, [{
          index: 0,
          name: job.title,
          path: job.title,
          relativePath: job.title,
          destinationPath: job.destinationPath,
          length: hashed.size,
        }])
        file = this.database.updateJobFile(files[0]!.id, {
          md5: hashed.md5,
          sha256: hashed.sha256,
          status: 'pending',
          bytesTransferred: 0,
          sourceCheckpoint: encodeSegmentSizes(hashed.segmentSizes),
        })
        this.database.updateJob(job.id, {
          progress: 0, bytesTransferred: 0, totalBytes: hashed.size, speedBytesPerSecond: 0,
        })
        this.database.addEvent(job.id, 'info', `Rutube: поток подготовлен, ${formatBytes(hashed.size)}`)
        this.notify()
      }
      if (!file?.md5 || !file.sha256) throw new Error('Не удалось сохранить контрольные суммы Rutube')
      const digests: FileDigests = { md5: file.md5, sha256: file.sha256 }
      if (!segmentSizes) {
        this.database.updateJob(job.id, {
          status: 'verifying', progress: null, bytesTransferred: 0, totalBytes: file.size,
          speedBytesPerSecond: 0, errorMessage: null,
        })
        this.database.addEvent(job.id, 'info', 'Rutube: восстанавливается карта HLS-сегментов')
        this.notify()
        const progress = createJobProgressReporter(job.id, this.database, this.notify, file.size)
        const rebuilt = await hashSegments(source.segments, job.source, controller.signal, progress)
        if (rebuilt.size !== file.size || rebuilt.md5 !== digests.md5 || rebuilt.sha256 !== digests.sha256) {
          throw new Error('Поток Rutube изменился после предыдущей проверки')
        }
        segmentSizes = rebuilt.segmentSizes
        file = this.database.updateJobFile(file.id, { sourceCheckpoint: encodeSegmentSizes(rebuilt.segmentSizes) })
      }

      if (file.status === 'completed') {
        const metadata = await this.storage.getMetadataOrNull(file.destinationPath)
        if (metadata?.type === 'file' && metadata.size === file.size && metadata.md5 === file.md5) {
          this.complete(job.id, file)
          return
        }
        file = this.database.updateJobFile(file.id, { status: 'pending', bytesTransferred: 0, uploadHref: null })
      }

      const existing = await this.storage.getMetadataOrNull(file.destinationPath)
      if (existing) {
        if (existing.type === 'file' && existing.size === file.size && existing.md5 === file.md5) {
          this.complete(job.id, file)
          return
        }
        throw new Error(`Путь назначения уже занят другим файлом: ${file.destinationPath}`)
      }

      let uploadHref = file.uploadHref
      let offset = 0
      if (uploadHref) {
        this.database.updateJob(job.id, { status: 'verifying', speedBytesPerSecond: 0, errorMessage: null })
        this.database.addEvent(job.id, 'info', 'Rutube: восстанавливается контрольная точка передачи')
        this.notify()
        try {
          offset = await this.storage.getStableUploadOffset(uploadHref, file.size)
        } catch {
          uploadHref = null
          this.database.updateJobFile(file.id, { uploadHref: null, bytesTransferred: 0 })
        }
      }
      this.database.updateJobFile(file.id, { status: 'transferring', bytesTransferred: offset })
      this.database.updateJob(job.id, {
        status: 'transferring', progress: offset / file.size, bytesTransferred: offset,
        totalBytes: file.size, speedBytesPerSecond: 0, sourceSpeedBytesPerSecond: 0,
        yandexUploadSpeedBytesPerSecond: 0, bottleneck: null, bufferedBytes: 0,
        bufferCapacityBytes: Math.min(uploadChunkBytes, file.size - offset), errorMessage: null,
      })
      this.database.addEvent(job.id, 'info', `${offset > 0 ? 'Продолжается' : 'Началась'} передача Rutube: ${file.relativePath}`)
      this.notify()

      let consecutiveFailures = 0
      while (offset < file.size) {
        controller.signal.throwIfAborted()
        if (!uploadHref) {
          uploadHref = await this.storage.requestUpload(file.destinationPath)
          this.database.updateJobFile(file.id, { uploadHref })
        }
        if (!segmentSizes) throw new Error('Не найдены размеры сегментов Rutube')

        const length = Math.min(uploadChunkBytes, file.size - offset)
        const buffered = createBufferedBytesReporter(job.id, length, this.database, this.notify)
        const sourceRead = await readExactBufferWithRetry(
          () => readSegments(
            source.segments, segmentSizes, file.size, job.source, offset, controller.signal,
            createSourceProgressReporter(job.id, offset, this.database, this.notify),
          ),
          length,
          controller.signal,
          buffered,
          async (attempt) => {
            this.database.updateJob(job.id, { sourceSpeedBytesPerSecond: 0, bottleneck: 'source', bufferedBytes: 0 })
            this.database.addEvent(job.id, 'info', `Поток Rutube прервался, повтор ${attempt}/3 с ${formatBytes(offset)}`)
            this.notify()
            await delay(400 * (2 ** (attempt - 1)), controller.signal)
          },
        )
        const buffer = sourceRead.buffer
        const sourceSpeed = bytesPerSecond(length, sourceRead.readMs)
        const beforeUpload = this.database.getInternalJob(job.id)
        this.database.updateJob(job.id, {
          sourceSpeedBytesPerSecond: sourceSpeed,
          bottleneck: detectBottleneck(sourceSpeed, beforeUpload?.yandexUploadSpeedBytesPerSecond ?? 0),
          bufferedBytes: length,
          bufferCapacityBytes: length,
        })
        const measured = createMeasuredUploadBody(buffer, buffered)
        try {
          const uploadStarted = performance.now()
          await this.storage.uploadRange(
            uploadHref, offset, file.size, measured.body, controller.signal, this.config.uploadTimeoutMs, length,
          )
          const uploadRequestMs = performance.now() - uploadStarted
          const yandexUploadSpeed = bytesPerSecond(length, uploadRequestMs)
          offset += length
          consecutiveFailures = 0
          this.database.updateJobFile(file.id, { bytesTransferred: offset })
          this.database.updateJob(job.id, {
            progress: offset / file.size, bytesTransferred: offset, totalBytes: file.size,
            speedBytesPerSecond: yandexUploadSpeed,
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
          controller.signal.throwIfAborted()
          consecutiveFailures += 1
          if (consecutiveFailures >= 4) throw error
          try {
            offset = await this.storage.getStableUploadOffset(uploadHref, file.size)
          } catch {
            uploadHref = null
            offset = 0
            this.database.updateJobFile(file.id, { uploadHref: null, bytesTransferred: 0 })
          }
          this.database.updateJobFile(file.id, { bytesTransferred: offset })
          this.database.updateJob(job.id, {
            progress: offset / file.size, bytesTransferred: offset, totalBytes: file.size, speedBytesPerSecond: 0,
          })
          this.database.addEvent(job.id, 'info', `Соединение Rutube восстановлено с отметки ${formatBytes(offset)}`)
          this.notify()
          await delay(750 * consecutiveFailures, controller.signal)
        }
      }

      await this.storage.waitForFileMetadata(file.destinationPath, file.size, digests.md5)

      this.complete(job.id, file)
    } finally {
      this.#active.delete(job.id)
    }
  }

  private complete(jobId: string, file: InternalJobFile): void {
    this.database.updateJobFile(file.id, { status: 'completed', bytesTransferred: file.size })
    const completed = this.database.updateJob(jobId, {
      status: 'completed', progress: 1, bytesTransferred: file.size, totalBytes: file.size,
      speedBytesPerSecond: 0, errorMessage: null,
    })
    this.database.addEvent(jobId, 'info', 'Видео Rutube сохранено и проверено на Яндекс Диске')
    this.notify()
    void completed
  }
}

export async function hashSegments(
  segments: RutubeSegment[],
  source: string,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
): Promise<HashedSource> {
  const md5 = createHash('md5')
  const sha256 = createHash('sha256')
  const segmentSizes: number[] = []
  let total = 0
  for (const segment of segments) {
    signal.throwIfAborted()
    const response = await fetchSegment(segment.url, source, signal)
    let size = 0
    for await (const chunk of responseChunks(response, signal)) {
      md5.update(chunk)
      sha256.update(chunk)
      size += chunk.byteLength
      total += chunk.byteLength
      onProgress(total)
    }
    if (size <= 0) throw new Error('Rutube вернул пустой HLS-сегмент')
    segmentSizes.push(size)
  }
  return { md5: md5.digest('hex'), sha256: sha256.digest('hex'), size: total, segmentSizes }
}

export async function * readSegments(
  segments: RutubeSegment[],
  sizes: Array<number | null>,
  totalBytes: number,
  source: string,
  start: number,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
): AsyncGenerator<Buffer> {
  if (sizes.length !== segments.length) throw new Error('Карта HLS-сегментов имеет неверную длину')
  let base = 0
  for (let index = 0; index < segments.length; index += 1) {
    const knownSize = sizes[index] ?? null
    if (knownSize !== null && base + knownSize <= start) {
      base += knownSize
      continue
    }
    if (base < start && knownSize === null) throw new Error('Не удалось восстановить позицию внутри HLS-потока')
    signal.throwIfAborted()
    const requestedOffset = Math.max(0, start - base)
    const response = await fetchSegment(segments[index]!.url, source, signal, requestedOffset || undefined)
    const ranged = requestedOffset > 0 && response.status === 206
    const responseSize = readResponseTotalSize(response, ranged)
    const size = knownSize ?? responseSize
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Rutube не вернул размер HLS-сегмента')
    let consumed = ranged ? requestedOffset : 0
    let skip = ranged ? 0 : requestedOffset
    for await (const original of responseChunks(response, signal)) {
      let chunk = original
      if (skip >= chunk.byteLength) {
        skip -= chunk.byteLength
        consumed += chunk.byteLength
        continue
      }
      if (skip > 0) {
        chunk = chunk.subarray(skip)
        consumed += skip
        skip = 0
      }
      consumed += chunk.byteLength
      onProgress(base + consumed)
      yield chunk
    }
    if (consumed !== size) throw new Error(`Размер HLS-сегмента изменился: ${consumed}/${size}`)
    sizes[index] = size
    base += size
  }
  if (base !== totalBytes) throw new Error(`Размер потока Rutube изменился: ${base}/${totalBytes}`)
}

async function fetchSegment(url: string, source: string, signal: AbortSignal, offset?: number): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const headers = rutubeRequestHeaders(source)
      if (offset !== undefined) headers.Range = `bytes=${offset}-`
      const response = await fetch(url, {
        headers, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
      })
      if (response.ok && (!offset || [200, 206].includes(response.status))) return response
      await response.body?.cancel()
      lastError = new Error(`Rutube не вернул HLS-сегмент: HTTP ${response.status}`)
      if (![429, 500, 502, 503, 504].includes(response.status)) break
    } catch (error) {
      lastError = error
      signal.throwIfAborted()
    }
    await delay(400 * (2 ** attempt), signal)
  }
  throw lastError instanceof Error ? lastError : new Error('Не удалось получить HLS-сегмент Rutube')
}

async function * responseChunks(response: Response, signal: AbortSignal): AsyncGenerator<Buffer> {
  if (!response.body) throw new Error('Rutube вернул пустой ответ')
  const reader = response.body.getReader()
  try {
    while (true) {
      signal.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      yield Buffer.from(next.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function createJobProgressReporter(
  jobId: string,
  database: JobDatabase,
  notify: () => void,
  totalBytes?: number,
): (bytes: number) => void {
  return createProgressReporter((bytes, speed) => {
    database.updateJob(jobId, {
      bytesTransferred: bytes,
      speedBytesPerSecond: speed,
      sourceSpeedBytesPerSecond: speed,
      bottleneck: 'source',
      ...(totalBytes ? { progress: bytes / totalBytes, totalBytes } : {}),
    })
    notify()
  })
}

function createSourceProgressReporter(
  jobId: string,
  initialOffset: number,
  database: JobDatabase,
  notify: () => void,
): (bytes: number) => void {
  return createProgressReporter((bytes, speed) => {
    void bytes
    const job = database.getInternalJob(jobId)
    database.updateJob(jobId, {
      sourceSpeedBytesPerSecond: speed,
      bottleneck: detectBottleneck(speed, job?.yandexUploadSpeedBytesPerSecond ?? 0),
    })
    notify()
  }, initialOffset)
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

function createProgressReporter(
  persist: (bytes: number, speed: number) => void,
  initialOffset = 0,
): (bytes: number) => void {
  let lastBytes = initialOffset
  let lastTime = Date.now()
  let lastPersisted = lastTime
  return (bytes) => {
    const now = Date.now()
    if (now - lastPersisted < 750 && bytes > initialOffset) return
    const seconds = Math.max((now - lastTime) / 1_000, 0.001)
    persist(bytes, Math.max(0, Math.round((bytes - lastBytes) / seconds)))
    lastBytes = bytes
    lastTime = now
    lastPersisted = now
  }
}

function assertTotalSize(sizes: number[], expected: number): void {
  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (sizes.some((size) => !Number.isSafeInteger(size) || size <= 0) || total !== expected) {
    throw new Error(`Размер потока Rutube изменился: ${total}/${expected}`)
  }
}

function readResponseTotalSize(response: Response, ranged: boolean): number {
  if (ranged) return Number(response.headers.get('content-range')?.split('/').at(-1))
  return Number(response.headers.get('content-length'))
}

function encodeSegmentSizes(sizes: number[]): string {
  assertTotalSize(sizes, sizes.reduce((sum, size) => sum + size, 0))
  return JSON.stringify(sizes)
}

function decodeSegmentSizes(value: string | null, segmentCount: number, expectedTotal: number): number[] | null {
  if (!value) return null
  try {
    const sizes = JSON.parse(value) as unknown
    if (!Array.isArray(sizes) || sizes.length !== segmentCount
      || sizes.some((size) => !Number.isSafeInteger(size) || size <= 0)) return null
    const typed = sizes as number[]
    return typed.reduce((sum, size) => sum + size, 0) === expectedTotal ? typed : null
  } catch {
    return null
  }
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
