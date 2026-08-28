import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { JobConflictError, JobDatabase } from './database.js'

test('очередь и события сохраняются после повторного открытия SQLite', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'loader-db-'))
  const databasePath = path.join(directory, 'loader.db')
  try {
    const first = new JobDatabase(databasePath)
    const created = first.createJob({
      source: 'https://1.1.1.1/file.mp4',
      sourceKind: 'direct-url',
      sourceLabel: '1.1.1.1/file.mp4',
      title: 'file.mp4',
      destination: 'movies',
      destinationPath: '/Media/Movies/file.mp4',
      supported: true,
      note: 'test',
    })
    first.pauseJob(created.id)
    first.close()

    const second = new JobDatabase(databasePath)
    assert.equal(second.getJob(created.id)?.status, 'paused')
    assert.deepEqual(second.listEvents(created.id).map((event) => event.message), [
      'Загрузка добавлена в очередь',
      'Загрузка приостановлена',
    ])
    second.resumeJob(created.id)
    const transferring = second.updateJob(created.id, {
      status: 'transferring', sourceSpeedBytesPerSecond: 40_000_000,
      yandexUploadSpeedBytesPerSecond: 128_000, bottleneck: 'yandex',
      bufferedBytes: 0, bufferCapacityBytes: 8 * 1024 * 1024,
      uploadRequestMs: 64_000, uploadWriteBlockedMs: 200,
    })
    assert.equal(transferring.sourceSpeedBytesPerSecond, 40_000_000)
    assert.equal(transferring.yandexUploadSpeedBytesPerSecond, 128_000)
    assert.equal(transferring.bottleneck, 'yandex')
    assert.equal(transferring.uploadRequestMs, 64_000)
    assert.throws(() => second.cancelJob(transferring.id), JobConflictError)
    second.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
