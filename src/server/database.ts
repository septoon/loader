import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type {
  Destination, Job, JobEvent, JobFile, JobFileStatus, JobStatus, SourceAnalysis, TransferBottleneck,
} from '../shared/types.js'
import { isRemoteImportSource } from '../shared/types.js'
import type { SelectedTorrentFile } from './security.js'

interface JobRow {
  id: string
  source: string
  source_kind: Job['sourceKind']
  source_label: string
  title: string
  destination: Destination
  destination_path: string
  status: JobStatus
  progress: number | null
  bytes_transferred: number | null
  total_bytes: number | null
  speed_bytes_per_second: number | null
  source_speed_bytes_per_second: number | null
  yandex_upload_speed_bytes_per_second: number | null
  bottleneck: TransferBottleneck | null
  buffered_bytes: number | null
  buffer_capacity_bytes: number | null
  upload_request_ms: number | null
  upload_write_blocked_ms: number | null
  error_message: string | null
  operation_href: string | null
  created_at: string
  updated_at: string
}

interface JobFileRow {
  id: string
  job_id: string
  file_index: number
  relative_path: string
  destination_path: string
  size: number
  status: JobFileStatus
  bytes_transferred: number
  md5: string | null
  sha256: string | null
  upload_href: string | null
  source_checkpoint: string | null
  created_at: string
  updated_at: string
}

interface EventRow {
  id: number
  job_id: string
  level: JobEvent['level']
  message: string
  created_at: string
}

export interface InternalJobFile extends JobFile {
  jobId: string
  md5: string | null
  sha256: string | null
  uploadHref: string | null
  sourceCheckpoint: string | null
}

export interface InternalJob extends Job {
  source: string
  operationHref: string | null
  files: InternalJobFile[]
}

type JobPatch = Partial<Pick<InternalJob,
  'sourceLabel' | 'title' | 'destination' | 'destinationPath' | 'status' | 'progress'
  | 'bytesTransferred' | 'totalBytes' | 'speedBytesPerSecond' | 'sourceSpeedBytesPerSecond'
  | 'yandexUploadSpeedBytesPerSecond' | 'bottleneck' | 'bufferedBytes' | 'bufferCapacityBytes'
  | 'uploadRequestMs' | 'uploadWriteBlockedMs' | 'errorMessage' | 'operationHref'>>

type JobFilePatch = Partial<Pick<InternalJobFile,
  'status' | 'bytesTransferred' | 'md5' | 'sha256' | 'uploadHref' | 'sourceCheckpoint'>>

export class JobDatabase {
  readonly #database: DatabaseSync
  readonly #getJobStatement: StatementSync

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 })
    this.#database = new DatabaseSync(databasePath)
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_label TEXT NOT NULL,
        title TEXT NOT NULL,
        destination TEXT NOT NULL,
        destination_path TEXT NOT NULL,
        status TEXT NOT NULL,
        progress REAL,
        bytes_transferred INTEGER,
        total_bytes INTEGER,
        speed_bytes_per_second INTEGER,
        source_speed_bytes_per_second INTEGER,
        yandex_upload_speed_bytes_per_second INTEGER,
        bottleneck TEXT,
        buffered_bytes INTEGER,
        buffer_capacity_bytes INTEGER,
        upload_request_ms INTEGER,
        upload_write_blocked_ms INTEGER,
        error_message TEXT,
        operation_href TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs(status, created_at);
      CREATE TABLE IF NOT EXISTS job_files (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        file_index INTEGER NOT NULL,
        relative_path TEXT NOT NULL,
        destination_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        status TEXT NOT NULL,
        bytes_transferred INTEGER NOT NULL DEFAULT 0,
        md5 TEXT,
        sha256 TEXT,
        upload_href TEXT,
        source_checkpoint TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(job_id, file_index)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS job_files_job_idx ON job_files(job_id, file_index);
      CREATE TABLE IF NOT EXISTS job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `)
    const jobColumns = this.#database.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>
    const jobMigrations = [
      ['source_speed_bytes_per_second', 'INTEGER'],
      ['yandex_upload_speed_bytes_per_second', 'INTEGER'],
      ['bottleneck', 'TEXT'],
      ['buffered_bytes', 'INTEGER'],
      ['buffer_capacity_bytes', 'INTEGER'],
      ['upload_request_ms', 'INTEGER'],
      ['upload_write_blocked_ms', 'INTEGER'],
    ] as const
    for (const [column, type] of jobMigrations) {
      if (!jobColumns.some((entry) => entry.name === column)) {
        this.#database.exec(`ALTER TABLE jobs ADD COLUMN ${column} ${type}`)
      }
    }
    const jobFileColumns = this.#database.prepare('PRAGMA table_info(job_files)').all() as Array<{ name: string }>
    if (!jobFileColumns.some((column) => column.name === 'source_checkpoint')) {
      this.#database.exec('ALTER TABLE job_files ADD COLUMN source_checkpoint TEXT')
    }
    this.#getJobStatement = this.#database.prepare('SELECT * FROM jobs WHERE id = ?')
  }

  close(): void {
    this.#database.close()
  }

  createJob(analysis: SourceAnalysis, id = randomUUID()): InternalJob {
    const now = new Date().toISOString()
    this.#database.prepare(`
      INSERT INTO jobs (
        id, source, source_kind, source_label, title, destination, destination_path,
        status, total_bytes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
    `).run(
      id, analysis.source, analysis.sourceKind, analysis.sourceLabel, analysis.title,
      analysis.destination, analysis.destinationPath, analysis.totalBytes ?? null, now, now,
    )
    this.addEvent(id, 'info', 'Загрузка добавлена в очередь')
    return this.getInternalJob(id)!
  }

  listJobs(): Job[] {
    const rows = this.#database.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all() as unknown as JobRow[]
    return rows.map((row) => toPublicJob(row, this.listInternalFiles(row.id)))
  }

  getJob(id: string): Job | null {
    const job = this.getInternalJob(id)
    return job ? toPublicJobFromInternal(job) : null
  }

  getInternalJob(id: string): InternalJob | null {
    const row = this.#getJobStatement.get(id) as unknown as JobRow | undefined
    return row ? toInternalJob(row, this.listInternalFiles(id)) : null
  }

  nextRunnableJob(): InternalJob | null {
    const row = this.#database.prepare(`
      SELECT * FROM jobs
      WHERE (status = 'transferring' AND (operation_href IS NOT NULL OR source_kind NOT IN ('direct-url', 'vkvideo')))
         OR status = 'verifying'
         OR status = 'queued'
      ORDER BY CASE status WHEN 'transferring' THEN 0 WHEN 'verifying' THEN 1 ELSE 2 END, created_at
      LIMIT 1
    `).get() as unknown as JobRow | undefined
    return row ? toInternalJob(row, this.listInternalFiles(row.id)) : null
  }

  updateJob(id: string, patch: JobPatch): InternalJob {
    const columns: string[] = []
    const values: Array<string | number | null> = []
    const mapping: Record<keyof JobPatch, string> = {
      sourceLabel: 'source_label', title: 'title', destination: 'destination', destinationPath: 'destination_path',
      status: 'status', progress: 'progress', bytesTransferred: 'bytes_transferred', totalBytes: 'total_bytes',
      speedBytesPerSecond: 'speed_bytes_per_second', sourceSpeedBytesPerSecond: 'source_speed_bytes_per_second',
      yandexUploadSpeedBytesPerSecond: 'yandex_upload_speed_bytes_per_second', bottleneck: 'bottleneck',
      bufferedBytes: 'buffered_bytes', bufferCapacityBytes: 'buffer_capacity_bytes',
      uploadRequestMs: 'upload_request_ms', uploadWriteBlockedMs: 'upload_write_blocked_ms',
      errorMessage: 'error_message', operationHref: 'operation_href',
    }
    for (const [key, column] of Object.entries(mapping) as [keyof JobPatch, string][]) {
      if (Object.hasOwn(patch, key)) {
        columns.push(`${column} = ?`)
        values.push(patch[key] ?? null)
      }
    }
    if (columns.length === 0) return requireJob(this.getInternalJob(id))
    columns.push('updated_at = ?')
    values.push(new Date().toISOString(), id)
    this.#database.prepare(`UPDATE jobs SET ${columns.join(', ')} WHERE id = ?`).run(...values)
    return requireJob(this.getInternalJob(id))
  }

  upsertTorrentFiles(jobId: string, files: SelectedTorrentFile[]): InternalJobFile[] {
    if (files.length === 0) throw new Error('Список файлов торрента пуст')
    const now = new Date().toISOString()
    const statement = this.#database.prepare(`
      INSERT INTO job_files (
        id, job_id, file_index, relative_path, destination_path, size, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(job_id, file_index) DO UPDATE SET
        relative_path = excluded.relative_path,
        destination_path = excluded.destination_path,
        size = excluded.size,
        updated_at = excluded.updated_at
    `)
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      for (const file of files) {
        statement.run(randomUUID(), jobId, file.index, file.relativePath, file.destinationPath, file.length, now, now)
      }
      const placeholders = files.map(() => '?').join(', ')
      this.#database.prepare(`DELETE FROM job_files WHERE job_id = ? AND file_index NOT IN (${placeholders})`)
        .run(jobId, ...files.map((file) => file.index))
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
    return this.listInternalFiles(jobId)
  }

  updateJobFile(id: string, patch: JobFilePatch): InternalJobFile {
    const columns: string[] = []
    const values: Array<string | number | null> = []
    const mapping: Record<keyof JobFilePatch, string> = {
      status: 'status', bytesTransferred: 'bytes_transferred', md5: 'md5', sha256: 'sha256', uploadHref: 'upload_href',
      sourceCheckpoint: 'source_checkpoint',
    }
    for (const [key, column] of Object.entries(mapping) as [keyof JobFilePatch, string][]) {
      if (Object.hasOwn(patch, key)) {
        columns.push(`${column} = ?`)
        values.push(patch[key] ?? null)
      }
    }
    if (columns.length > 0) {
      columns.push('updated_at = ?')
      values.push(new Date().toISOString(), id)
      this.#database.prepare(`UPDATE job_files SET ${columns.join(', ')} WHERE id = ?`).run(...values)
    }
    const row = this.#database.prepare('SELECT * FROM job_files WHERE id = ?').get(id) as unknown as JobFileRow | undefined
    if (!row) throw new JobNotFoundError('Файл загрузки не найден')
    return toInternalFile(row)
  }

  pauseJob(id: string): InternalJob {
    const job = requireJob(this.getInternalJob(id))
    const canPause = job.status === 'queued'
      || (!isRemoteImportSource(job.sourceKind) && ['transferring', 'verifying'].includes(job.status))
    if (!canPause) throw new JobConflictError('Эту загрузку сейчас нельзя приостановить')
    const updated = this.updateJob(id, {
      status: 'paused', speedBytesPerSecond: 0, sourceSpeedBytesPerSecond: 0,
      yandexUploadSpeedBytesPerSecond: 0, bottleneck: null, bufferedBytes: 0,
    })
    this.addEvent(id, 'info', 'Загрузка приостановлена')
    return updated
  }

  resumeJob(id: string): InternalJob {
    const job = requireJob(this.getInternalJob(id))
    if (!['paused', 'failed'].includes(job.status)) throw new JobConflictError('Эту задачу нельзя продолжить')
    const updated = this.updateJob(id, {
      status: 'queued', errorMessage: null, speedBytesPerSecond: 0, sourceSpeedBytesPerSecond: 0,
      yandexUploadSpeedBytesPerSecond: 0, bottleneck: null, bufferedBytes: 0,
    })
    this.addEvent(id, 'info', job.status === 'failed' ? 'Загрузка возвращена в очередь' : 'Загрузка продолжена')
    return updated
  }

  cancelJob(id: string): InternalJob {
    const job = requireJob(this.getInternalJob(id))
    const canCancel = ['queued', 'paused', 'failed'].includes(job.status)
      || ((job.sourceKind === 'vkvideo' || !isRemoteImportSource(job.sourceKind))
        && ['transferring', 'verifying'].includes(job.status))
    if (!canCancel) throw new JobConflictError('Активный удалённый импорт нельзя безопасно отменить через API Яндекс Диска')
    const updated = this.updateJob(id, {
      status: 'cancelled', speedBytesPerSecond: 0, sourceSpeedBytesPerSecond: 0,
      yandexUploadSpeedBytesPerSecond: 0, bottleneck: null, bufferedBytes: 0, errorMessage: null,
    })
    this.addEvent(id, 'info', 'Загрузка отменена')
    return updated
  }

  addEvent(jobId: string, level: JobEvent['level'], message: string): void {
    this.#database.prepare('INSERT INTO job_events (job_id, level, message, created_at) VALUES (?, ?, ?, ?)')
      .run(jobId, level, message.slice(0, 1_000), new Date().toISOString())
  }

  listEvents(jobId: string): JobEvent[] {
    const rows = this.#database.prepare('SELECT * FROM job_events WHERE job_id = ? ORDER BY id DESC LIMIT 100')
      .all(jobId) as unknown as EventRow[]
    return rows.reverse().map((row) => ({
      id: row.id, jobId: row.job_id, level: row.level, message: row.message, createdAt: row.created_at,
    }))
  }

  private listInternalFiles(jobId: string): InternalJobFile[] {
    const rows = this.#database.prepare('SELECT * FROM job_files WHERE job_id = ? ORDER BY file_index')
      .all(jobId) as unknown as JobFileRow[]
    return rows.map(toInternalFile)
  }
}

export class JobNotFoundError extends Error {}
export class JobConflictError extends Error {}

function requireJob(job: InternalJob | null): InternalJob {
  if (!job) throw new JobNotFoundError('Загрузка не найдена')
  return job
}

function toInternalJob(row: JobRow, files: InternalJobFile[]): InternalJob {
  return { ...toPublicJob(row, files), source: row.source, operationHref: row.operation_href, files }
}

function toPublicJob(row: JobRow, files: JobFile[]): Job {
  return {
    id: row.id, sourceKind: row.source_kind, sourceLabel: row.source_label, title: row.title,
    destination: row.destination, destinationPath: row.destination_path, status: row.status,
    progress: row.progress, bytesTransferred: row.bytes_transferred, totalBytes: row.total_bytes,
    speedBytesPerSecond: row.speed_bytes_per_second,
    sourceSpeedBytesPerSecond: row.source_speed_bytes_per_second,
    yandexUploadSpeedBytesPerSecond: row.yandex_upload_speed_bytes_per_second,
    bottleneck: row.bottleneck, bufferedBytes: row.buffered_bytes, bufferCapacityBytes: row.buffer_capacity_bytes,
    uploadRequestMs: row.upload_request_ms, uploadWriteBlockedMs: row.upload_write_blocked_ms,
    errorMessage: row.error_message,
    files: files.map(toPublicFile), createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function toPublicJobFromInternal(job: InternalJob): Job {
  const { source: _source, operationHref: _operationHref, ...publicJob } = job
  return { ...publicJob, files: job.files.map(toPublicFile) }
}

function toInternalFile(row: JobFileRow): InternalJobFile {
  return {
    id: row.id, jobId: row.job_id, index: row.file_index, relativePath: row.relative_path,
    destinationPath: row.destination_path, size: row.size, status: row.status,
    bytesTransferred: row.bytes_transferred, md5: row.md5, sha256: row.sha256, uploadHref: row.upload_href,
    sourceCheckpoint: row.source_checkpoint,
  }
}

function toPublicFile(file: JobFile): JobFile {
  return {
    id: file.id, index: file.index, relativePath: file.relativePath, destinationPath: file.destinationPath,
    size: file.size, status: file.status, bytesTransferred: file.bytesTransferred,
  }
}
