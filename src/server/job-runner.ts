import { EventEmitter } from 'node:events'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { isRemoteImportSource, type Job } from '../shared/types.js'
import type { AppConfig } from './config.js'
import { JobDatabase, type InternalJob } from './database.js'
import { sanitizePublicError } from './security.js'
import { RutubeTransfer } from './rutube-transfer.js'
import { TorrentSourceUnavailableError, TorrentTransfer } from './torrent-transfer.js'
import { buildVkRelayUrl } from './vk-relay.js'
import { YandexDiskAdapter } from './yandex-disk.js'

export class JobRunner {
  readonly events = new EventEmitter()
  readonly #torrent: TorrentTransfer | null
  readonly #rutube: RutubeTransfer | null
  #timer: NodeJS.Timeout | null = null
  #running: Promise<void> | null = null
  #stopping = false

  constructor(
    private readonly database: JobDatabase,
    private readonly storage: YandexDiskAdapter | null,
    private readonly config: AppConfig,
  ) {
    this.#torrent = storage
      ? new TorrentTransfer(database, storage, config, () => this.notify())
      : null
    this.#rutube = storage
      ? new RutubeTransfer(database, storage, config, () => this.notify())
      : null
  }

  start(): void {
    if (this.#timer) return
    this.#stopping = false
    this.#timer = setInterval(() => this.wake(), 1_500)
    this.#timer.unref()
    this.wake()
  }

  async stop(): Promise<void> {
    this.#stopping = true
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    this.#torrent?.abortAll()
    this.#rutube?.abortAll()
    await this.#running?.catch(() => undefined)
  }

  wake(): void {
    if (this.#stopping || this.#running) return
    this.#running = this.tick().finally(() => {
      this.#running = null
      if (!this.#stopping && this.database.nextRunnableJob()) queueMicrotask(() => this.wake())
    })
  }

  notify(job?: Job): void {
    this.events.emit('change', job ?? null)
  }

  pauseJob(id: string): Job {
    const job = this.database.pauseJob(id)
    if (job.sourceKind === 'torrent-file' || job.sourceKind === 'magnet') this.#torrent?.pause(job.id)
    else this.abortTransfer(job)
    this.notify(job)
    return job
  }

  resumeJob(id: string): Job {
    let job = this.database.resumeJob(id)
    if ((job.sourceKind === 'torrent-file' || job.sourceKind === 'magnet') && this.#torrent?.resume(job.id)) {
      job = this.database.updateJob(id, { status: 'verifying' })
    }
    this.notify(job)
    this.wake()
    return job
  }

  cancelJob(id: string): Job {
    const job = this.database.cancelJob(id)
    this.abortTransfer(job)
    this.notify(job)
    return job
  }

  async deleteJob(id: string): Promise<void> {
    const job = this.database.deleteJob(id)
    this.abortTransfer(job)
    this.notify()
    if (job.sourceKind === 'torrent-file' || job.sourceKind === 'magnet') {
      await this.#torrent?.waitForStop(job.id)
      await removeJobArtifact(this.config.pieceCacheDir, job.id)
    }
    if (job.sourceKind === 'torrent-file') {
      await removeJobArtifact(this.config.torrentMetadataDir, `${job.id}.torrent`)
    }
  }

  private async tick(): Promise<void> {
    const job = this.database.nextRunnableJob()
    if (job) await this.process(job)
  }

  private async process(job: InternalJob): Promise<void> {
    if (!this.storage) {
      this.fail(job, 'Яндекс Диск не настроен')
      return
    }

    if (job.sourceKind === 'rutube') {
      try {
        await this.#rutube!.process(job)
      } catch (error) {
        if (this.#stopping) return
        const current = this.database.getInternalJob(job.id)
        if (current && ['paused', 'cancelled'].includes(current.status)) return
        this.fail(job, sanitizePublicError(error))
      }
      return
    }

    if (!isRemoteImportSource(job.sourceKind)) {
      try {
        await this.#torrent!.process(job)
      } catch (error) {
        if (this.#stopping) return
        const current = this.database.getInternalJob(job.id)
        if (current && ['paused', 'cancelled'].includes(current.status)) return
        if (error instanceof TorrentSourceUnavailableError) {
          this.waitForTorrentPeers(job)
          return
        }
        this.fail(job, sanitizePublicError(error))
      }
      return
    }

    try {
      let operationHref = job.operationHref
      if (job.status === 'queued') {
        this.database.updateJob(job.id, { status: 'transferring', progress: null, errorMessage: null })
        this.database.addEvent(job.id, 'info', job.sourceKind === 'vkvideo'
          ? 'Яндекс Диск начал импорт VK Видео через защищённый поток'
          : 'Яндекс Диск начал прямой импорт')
        this.notify(this.database.getJob(job.id) ?? undefined)
        const remoteSource = job.sourceKind === 'vkvideo' ? buildVkRelayUrl(this.config, job.id) : job.source
        operationHref = await this.storage.startRemoteImport(remoteSource, job.destinationPath)
        this.database.updateJob(job.id, { operationHref })
      }

      if (job.status === 'verifying') {
        await this.verifyDirect(job)
        return
      }
      if (!operationHref) throw new Error('Не найдена контрольная точка операции импорта')

      const operation = await this.storage.getOperation(operationHref)
      if (operation.status === 'in-progress') return
      if (operation.status === 'failed') throw new Error('Яндекс Диск сообщил об ошибке удалённого импорта')

      this.database.updateJob(job.id, { status: 'verifying', progress: 1 })
      this.database.addEvent(job.id, 'info', 'Импорт завершён, проверяются метаданные')
      await this.verifyDirect(job)
    } catch (error) {
      this.fail(job, sanitizePublicError(error))
    }
  }

  private async verifyDirect(job: InternalJob): Promise<void> {
    const metadata = await this.storage!.getMetadata(job.destinationPath)
    if (metadata.type !== 'file' || !metadata.md5 || !Number.isSafeInteger(metadata.size)) {
      throw new Error('Итоговый файл не прошёл проверку метаданных')
    }
    const completed = this.database.updateJob(job.id, {
      status: 'completed', progress: 1, bytesTransferred: metadata.size ?? null,
      totalBytes: metadata.size ?? null, speedBytesPerSecond: 0, errorMessage: null,
    })
    this.database.addEvent(job.id, 'info', 'Файл сохранён и проверен на Яндекс Диске')
    this.notify(completed)
  }

  private fail(job: InternalJob, message: string): void {
    const current = this.database.getInternalJob(job.id)
    if (!current || ['paused', 'cancelled'].includes(current.status)) return
    for (const file of current.files.filter((entry) => ['hashing', 'transferring'].includes(entry.status))) {
      this.database.updateJobFile(file.id, { status: 'failed' })
    }
    const failed = this.database.updateJob(job.id, {
      status: 'failed', speedBytesPerSecond: 0, bufferedBytes: 0, errorMessage: message,
    })
    this.database.addEvent(job.id, 'error', message)
    this.notify(failed)
  }

  private waitForTorrentPeers(job: InternalJob): void {
    const current = this.database.getInternalJob(job.id)
    if (!current || ['paused', 'cancelled'].includes(current.status)) return
    const waiting = this.database.updateJob(job.id, {
      status: 'waiting', speedBytesPerSecond: 0, sourceSpeedBytesPerSecond: 0,
      bottleneck: 'source', bufferedBytes: 0,
      errorMessage: 'Переподключение к раздаче: новая peer-сессия запустится автоматически',
    })
    this.database.addEvent(job.id, 'info', 'Торрент-поток перестал отвечать; через 30 секунд будет создана новая peer-сессия')
    this.notify(waiting)
  }

  private abortTransfer(job: InternalJob): void {
    if (job.sourceKind === 'rutube') this.#rutube?.abort(job.id)
    else if (!isRemoteImportSource(job.sourceKind)) this.#torrent?.abort(job.id)
  }
}

async function removeJobArtifact(root: string, name: string): Promise<void> {
  const absoluteRoot = path.resolve(root)
  const target = path.resolve(absoluteRoot, name)
  if (!target.startsWith(`${absoluteRoot}${path.sep}`)) throw new Error('Некорректный путь служебных данных загрузки')
  await rm(target, { recursive: true, force: true })
}
