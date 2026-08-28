import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Fastify from 'fastify'
import type { AppConfig } from './config.js'
import { JobDatabase } from './database.js'
import { buildVkRelayUrl, registerVkVideoRelay, vkRelayAuthorization } from './vk-relay.js'

test('защищённый VK relay не раскрывает поток без Basic auth и проксирует MP4', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'loader-vk-relay-'))
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
    source: 'https://m.vk.com/video-1_2', sourceKind: 'vkvideo', sourceLabel: 'VK Видео · -1_2',
    title: 'Видео.mp4', destination: 'movies', destinationPath: '/Media/Movies/Видео.mp4',
    supported: true, note: 'VK', totalBytes: 5,
  })
  database.updateJob(job.id, { status: 'transferring' })
  const app = Fastify()
  registerVkVideoRelay(app, database, config, async () => ({
    ownerId: '-1', videoId: '2', id: '-1_2', canonicalSource: 'https://m.vk.com/video-1_2',
    title: 'Видео', durationSeconds: 10, resolution: '720p', totalBytes: 5,
    mediaUrl: 'https://media.okcdn.ru/video.mp4?sig=secret', requestHeaders: { 'User-Agent': 'Loader Test' },
  }), async (_input, init) => {
    assert.equal((init?.headers as Record<string, string>)['User-Agent'], 'Loader Test')
    return new Response('video', { status: 200, headers: { 'Content-Type': 'video/mp4', 'Content-Length': '5' } })
  })

  try {
    const denied = await app.inject({ method: 'GET', url: `/vk-import/${job.id}` })
    assert.equal(denied.statusCode, 401)
    assert.match(String(denied.headers['www-authenticate']), /Basic/u)

    const response = await app.inject({
      method: 'GET', url: `/vk-import/${job.id}`,
      headers: { authorization: vkRelayAuthorization(config, job.id) },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['content-type'], 'video/mp4')
    assert.equal(response.body, 'video')
    const relayUrl = new URL(buildVkRelayUrl(config, job.id))
    assert.equal(relayUrl.hostname, 'loader.example')
    assert.equal(relayUrl.username, 'loader-vk')
    assert.notEqual(relayUrl.password, '')
  } finally {
    await app.close()
    database.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('отмена активной VK-задачи обрывает relay stream', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'loader-vk-relay-cancel-'))
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
    source: 'https://m.vk.com/video-1_2', sourceKind: 'vkvideo', sourceLabel: 'VK Видео · -1_2',
    title: 'Видео.mp4', destination: 'movies', destinationPath: '/Media/Movies/Видео.mp4',
    supported: true, note: 'VK', totalBytes: 1_000,
  })
  database.updateJob(job.id, { status: 'transferring' })
  const app = Fastify()
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
  let observedSignal: AbortSignal | undefined
  let markFetchStarted: (() => void) | undefined
  const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve })
  let markAborted: (() => void) | undefined
  const aborted = new Promise<void>((resolve) => { markAborted = resolve })
  registerVkVideoRelay(app, database, config, async () => ({
    ownerId: '-1', videoId: '2', id: '-1_2', canonicalSource: 'https://m.vk.com/video-1_2',
    title: 'Видео', durationSeconds: 10, resolution: '720p', totalBytes: 1_000,
    mediaUrl: 'https://media.okcdn.ru/video.mp4?sig=secret', requestHeaders: {},
  }), async (_input, init) => {
    observedSignal = init?.signal ?? undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
        controller.enqueue(new Uint8Array([1]))
      },
    })
    observedSignal?.addEventListener('abort', () => {
      streamController?.error(new Error('aborted'))
      markAborted?.()
    }, { once: true })
    markFetchStarted?.()
    return new Response(body, { status: 200, headers: { 'Content-Type': 'video/mp4', 'Content-Length': '1000' } })
  })

  try {
    const request = app.inject({
      method: 'GET', url: `/vk-import/${job.id}`,
      headers: { authorization: vkRelayAuthorization(config, job.id) },
    }).catch(() => undefined)
    await fetchStarted
    database.cancelJob(job.id)
    await Promise.race([
      aborted,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('relay не остановлен')), 2_000)),
    ])
    assert.equal(observedSignal?.aborted, true)
    await request
  } finally {
    await app.close()
    database.close()
    await rm(root, { recursive: true, force: true })
  }
})
