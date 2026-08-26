import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import createTorrent from 'create-torrent'
import { buildApp } from './app.js'
import type { AppConfig } from './config.js'
import { JobDatabase } from './database.js'
import { JobRunner } from './job-runner.js'

test('authenticated API анализирует magnet и multipart .torrent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'loader-api-'))
  const sourcePath = path.join(root, 'Фильм.mkv')
  await writeFile(sourcePath, Buffer.alloc(32 * 1024, 7))
  const torrent = await createTorrentBuffer(sourcePath)
  const config: AppConfig = {
    host: '127.0.0.1', port: 8787, databasePath: path.join(root, 'loader.db'), webRoot: path.join(root, 'missing-web'),
    password: 'test-password', sessionSecret: 's'.repeat(48), secureCookies: false, yandexToken: null,
    torrentMetadataDir: path.join(root, 'torrents'), pieceCacheDir: path.join(root, 'cache'),
    pieceCacheMaxBytes: 32 * 1024 * 1024, diskReserveBytes: 16 * 1024 * 1024,
    torrentMetadataTimeoutMs: 60_000, uploadTimeoutMs: 60_000,
  }
  const database = new JobDatabase(config.databasePath)
  const runner = new JobRunner(database, null, config)
  const app = await buildApp({ config, database, runner })

  try {
    const denied = await app.inject({ method: 'GET', url: '/api/jobs' })
    assert.equal(denied.statusCode, 401)

    const login = await app.inject({ method: 'POST', url: '/api/session', payload: { password: config.password } })
    assert.equal(login.statusCode, 200)
    const cookie = String(login.headers['set-cookie']).split(';', 1)[0]

    const magnet = await app.inject({
      method: 'POST', url: '/api/sources/analyze', headers: { cookie },
      payload: { source: `magnet:?xt=urn:btih:${'b'.repeat(40)}&dn=Фильм`, destination: 'movies' },
    })
    assert.equal(magnet.statusCode, 200)
    assert.equal(magnet.json().supported, true)

    const boundary = 'loader-test-boundary'
    const multipart = multipartTorrent(boundary, torrent)
    const analyzed = await app.inject({
      method: 'POST', url: '/api/sources/analyze-torrent',
      headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(multipart.length) },
      payload: multipart,
    })
    assert.equal(analyzed.statusCode, 200, analyzed.body)
    assert.equal(analyzed.json().sourceKind, 'torrent-file')
    assert.equal(analyzed.json().fileCount, 1)
    assert.equal(analyzed.json().destinationPath, '/Media/Movies/Фильм.mkv')
  } finally {
    await app.close()
    await runner.stop()
    database.close()
    await rm(root, { recursive: true, force: true })
  }
})

function createTorrentBuffer(input: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    createTorrent(input, { pieceLength: 16 * 1024, announce: [] }, (error, torrent) => {
      if (error || !torrent) reject(error ?? new Error('Не удалось создать тестовый torrent'))
      else resolve(torrent)
    })
  })
}

function multipartTorrent(boundary: string, torrent: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="destination"\r\n\r\nmovies\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="torrent"; filename="Фильм.torrent"\r\nContent-Type: application/x-bittorrent\r\n\r\n`),
    torrent,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
}
