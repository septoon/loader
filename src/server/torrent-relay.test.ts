import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import Fastify from 'fastify'
import type { AppConfig } from './config.js'
import { JobDatabase } from './database.js'
import { registerTorrentRelay } from './torrent-relay.js'
import { buildTorrentRelayUrl, torrentRelayAuthorization } from './torrent-relay-auth.js'

test('torrent relay требует job-scoped auth и корректно отдаёт Range', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'loader-torrent-relay-'))
  const config: AppConfig = {
    host: '127.0.0.1', port: 8787, databasePath: path.join(root, 'loader.db'), webRoot: path.join(root, 'web'),
    password: 'password', sessionSecret: 's'.repeat(48), secureCookies: false, yandexToken: null,
    torrentMetadataDir: path.join(root, 'torrents'), pieceCacheDir: path.join(root, 'cache'),
    pieceCacheMaxBytes: 32 * 1024 * 1024, diskReserveBytes: 16 * 1024 * 1024,
    torrentMetadataTimeoutMs: 60_000, uploadTimeoutMs: 60_000,
    publicUrl: 'https://loader.example', ytDlpPath: '/tools/yt-dlp',
  }
  const database = new JobDatabase(config.databasePath)
  const job = database.createJob({
    source: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567', sourceKind: 'magnet',
    sourceLabel: 'Magnet', title: 'file.bin', destination: 'unsorted',
    destinationPath: '/Media/Unsorted/file.bin', supported: true, note: 'torrent', totalBytes: 10,
  })
  database.upsertTorrentFiles(job.id, [{
    index: 0, name: 'file.bin', path: 'file.bin', length: 10,
    relativePath: 'file.bin', destinationPath: '/Media/Unsorted/file.bin',
  }])
  database.updateJob(job.id, { status: 'transferring' })
  const content = Buffer.from('0123456789')
  const app = Fastify()
  registerTorrentRelay(app, database, config, {
    createRelayStream: (_jobId, _fileIndex, start, end) => Readable.from([content.subarray(start, end + 1)]),
  })

  try {
    const denied = await app.inject({ method: 'GET', url: `/torrent-import/${job.id}/0` })
    assert.equal(denied.statusCode, 401)

    const authorization = torrentRelayAuthorization(config, job.id, 0)
    const head = await app.inject({
      method: 'HEAD', url: `/torrent-import/${job.id}/0`, headers: { authorization },
    })
    assert.equal(head.statusCode, 200)
    assert.equal(head.headers['content-length'], '10')
    assert.equal(head.headers['accept-ranges'], 'bytes')

    const range = await app.inject({
      method: 'GET', url: `/torrent-import/${job.id}/0`,
      headers: { authorization, range: 'bytes=3-6' },
    })
    assert.equal(range.statusCode, 206)
    assert.equal(range.headers['content-range'], 'bytes 3-6/10')
    assert.equal(range.body, '3456')

    const relayUrl = new URL(buildTorrentRelayUrl(config, job.id, 0))
    assert.equal(relayUrl.username, 'loader-torrent')
    assert.notEqual(relayUrl.password, '')
  } finally {
    await app.close()
    database.close()
    await rm(root, { recursive: true, force: true })
  }
})
