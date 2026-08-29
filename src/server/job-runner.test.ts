import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { AppConfig } from './config.js'
import { JobDatabase } from './database.js'
import { JobRunner } from './job-runner.js'

test('graceful stop не запускает отложенный tick после закрытия SQLite', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'loader-runner-stop-'))
  const config: AppConfig = {
    host: '127.0.0.1', port: 8787, databasePath: path.join(root, 'loader.db'), webRoot: path.join(root, 'web'),
    password: 'test-password', sessionSecret: 's'.repeat(48), secureCookies: false, yandexToken: null,
    torrentMetadataDir: path.join(root, 'torrents'), pieceCacheDir: path.join(root, 'cache'),
    pieceCacheMaxBytes: 32 * 1024 * 1024, diskReserveBytes: 16 * 1024 * 1024,
    torrentMetadataTimeoutMs: 60_000, uploadTimeoutMs: 60_000,
    publicUrl: 'http://127.0.0.1:8787', ytDlpPath: 'yt-dlp',
  }
  const database = new JobDatabase(config.databasePath)
  const runner = new JobRunner(database, null, config)

  try {
    runner.start()
    await runner.stop()
    database.close()
    assert.doesNotThrow(() => runner.wake())
    await new Promise<void>((resolve) => setImmediate(resolve))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
