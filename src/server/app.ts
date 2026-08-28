import { randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import parseTorrent from 'parse-torrent'
import type { Destination, HealthResponse } from '../shared/types.js'
import type { AppConfig } from './config.js'
import { JobConflictError, JobDatabase, JobNotFoundError } from './database.js'
import { JobRunner } from './job-runner.js'
import type { MediaCredentials } from './media-secrets.js'
import { registerMediaWebDav } from './media-webdav.js'
import { analyzeSource, InputError, sanitizePublicError, selectTorrentFiles } from './security.js'
import { registerVkVideoRelay } from './vk-relay.js'
import { resolveVkVideoSource } from './vk-video.js'
import type { YandexMediaLibrary } from './yandex-media-library.js'

const sessionCookie = 'loader_session'

interface Dependencies {
  config: AppConfig
  database: JobDatabase
  runner: JobRunner
  media?: { library: YandexMediaLibrary, credentials: MediaCredentials }
}

export async function buildApp({ config, database, runner, media }: Dependencies) {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      redact: ['req.headers.cookie', 'req.headers.authorization', 'req.body.source', 'req.body.password'],
    },
    trustProxy: process.env.LOADER_TRUST_PROXY === '1',
  })

  await app.register(cookie, { secret: config.sessionSecret, hook: 'onRequest' })
  await app.register(rateLimit, { global: false })
  await app.register(multipart, {
    limits: { files: 1, fields: 4, fileSize: 4 * 1024 * 1024, parts: 5 },
  })

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.headers({
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    })
    return payload
  })

  app.get<{ Reply: HealthResponse }>('/api/health', async () => ({
    status: 'ok',
    storageConfigured: config.yandexToken !== null,
    torrentAvailable: true,
    activeTransfers: database.listJobs().filter((job) => ['transferring', 'verifying'].includes(job.status)).length,
  }))

  app.get('/api/session', async (request) => ({ authenticated: isAuthenticated(request) }))

  app.post<{ Body: { password?: string } }>('/api/session', {
    config: { rateLimit: { max: 8, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!safeEqual(request.body?.password ?? '', config.password)) {
      return reply.code(401).send({ error: 'Неверный пароль' })
    }
    reply.setCookie(sessionCookie, 'authorized', {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: config.secureCookies,
      signed: true,
      maxAge: 30 * 24 * 60 * 60,
    })
    return { authenticated: true }
  })

  app.delete('/api/session', async (_request, reply) => {
    reply.clearCookie(sessionCookie, { path: '/' })
    return reply.code(204).send()
  })

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/') || ['/api/health', '/api/session'].includes(request.url)) return
    if (!isAuthenticated(request)) return reply.code(401).send({ error: 'Требуется вход' })
  })

  registerVkVideoRelay(app, database, config)
  if (media) registerMediaWebDav(app, media.library, media.credentials)

  app.post<{ Body: { source?: string, destination?: Destination } }>('/api/sources/analyze', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    try {
      return await analyzeConfiguredSource(request.body?.source ?? '', request.body?.destination ?? 'auto')
    } catch (error) {
      return sendKnownError(reply, error)
    }
  })

  app.post('/api/sources/analyze-torrent', {
    config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    try {
      const upload = await readTorrentUpload(request)
      return (await inspectTorrent(upload.buffer, upload.destination, upload.filename, '')).analysis
    } catch (error) {
      return sendKnownError(reply, normalizeTorrentError(error))
    }
  })

  app.get('/api/jobs', async () => ({ jobs: database.listJobs() }))

  app.post<{ Body: { source?: string, destination?: Destination } }>('/api/jobs', {
    config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    try {
      const analysis = await analyzeConfiguredSource(request.body?.source ?? '', request.body?.destination ?? 'auto')
      if (!analysis.supported) return reply.code(422).send({ error: analysis.note })
      const job = database.createJob(analysis)
      runner.notify(job)
      runner.wake()
      return reply.code(201).send({ job })
    } catch (error) {
      return sendKnownError(reply, error)
    }
  })

  app.post('/api/jobs/torrent', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    let metadataPath: string | null = null
    try {
      const upload = await readTorrentUpload(request)
      const id = randomUUID()
      await mkdir(config.torrentMetadataDir, { recursive: true, mode: 0o700 })
      metadataPath = path.join(config.torrentMetadataDir, `${id}.torrent`)
      const inspected = await inspectTorrent(upload.buffer, upload.destination, upload.filename, metadataPath)
      await writeFile(metadataPath, upload.buffer, { mode: 0o600, flag: 'wx' })
      database.createJob(inspected.analysis, id)
      database.upsertTorrentFiles(id, inspected.files)
      const job = database.getJob(id)!
      runner.notify(job)
      runner.wake()
      return reply.code(201).send({ job })
    } catch (error) {
      if (metadataPath) await unlink(metadataPath).catch(() => undefined)
      return sendKnownError(reply, normalizeTorrentError(error))
    }
  })

  app.get<{ Params: { id: string } }>('/api/jobs/:id/events', async (request, reply) => {
    if (!database.getJob(request.params.id)) return reply.code(404).send({ error: 'Загрузка не найдена' })
    return { events: database.listEvents(request.params.id) }
  })

  app.post<{ Params: { id: string } }>('/api/jobs/:id/pause', async (request, reply) => mutateJob(reply, () => {
    return runner.pauseJob(request.params.id)
  }))

  app.post<{ Params: { id: string } }>('/api/jobs/:id/resume', async (request, reply) => mutateJob(reply, () => {
    return runner.resumeJob(request.params.id)
  }))

  app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => mutateJob(reply, () => {
    return runner.cancelJob(request.params.id)
  }))

  app.get('/api/events', async (request, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const sendSnapshot = () => {
      reply.raw.write(`event: jobs\ndata: ${JSON.stringify({ jobs: database.listJobs() })}\n\n`)
    }
    const heartbeat = setInterval(() => reply.raw.write(': проверка связи\n\n'), 20_000)
    const close = () => {
      clearInterval(heartbeat)
      runner.events.off('change', sendSnapshot)
    }
    request.raw.on('close', close)
    runner.events.on('change', sendSnapshot)
    sendSnapshot()
    return reply
  })

  if (existsSync(config.webRoot)) {
    await app.register(fastifyStatic, { root: config.webRoot })
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Метод API не найден' })
      return reply.sendFile('index.html')
    })
  }

  return app

  function analyzeConfiguredSource(source: string, destination: Destination) {
    return analyzeSource(source, destination, (value) => {
      return resolveVkVideoSource(value, { executablePath: config.ytDlpPath })
    })
  }

  function isAuthenticated(request: FastifyRequest): boolean {
    const signed = request.cookies[sessionCookie]
    return Boolean(signed && request.unsignCookie(signed).valid)
  }
}

function safeEqual(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate)
  const expectedBytes = Buffer.from(expected)
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes)
}

function mutateJob(reply: FastifyReply, mutation: () => unknown) {
  try {
    return { job: mutation() }
  } catch (error) {
    return sendKnownError(reply, error)
  }
}

function sendKnownError(reply: FastifyReply, error: unknown) {
  if (error instanceof InputError) return reply.code(400).send({ error: error.message })
  if (error instanceof JobNotFoundError) return reply.code(404).send({ error: error.message })
  if (error instanceof JobConflictError) return reply.code(409).send({ error: error.message })
  return reply.code(500).send({ error: sanitizePublicError(error) })
}

async function readTorrentUpload(request: FastifyRequest): Promise<{ buffer: Buffer, destination: Destination, filename: string }> {
  const part = await request.file()
  if (!part) throw new InputError('Выберите .torrent-файл')
  const destinationField = part.fields.destination
  const destination = typeof destinationField === 'object' && destinationField && 'value' in destinationField
    ? String(destinationField.value)
    : 'auto'
  const buffer = await part.toBuffer()
  if (buffer.byteLength === 0) throw new InputError('.torrent-файл пуст')
  const parsedDestination = ['auto', 'movies', 'tv', 'unsorted'].includes(destination)
    ? destination as Destination
    : null
  if (!parsedDestination) throw new InputError('Неизвестный каталог назначения')
  return { buffer, destination: parsedDestination, filename: safeUploadName(part.filename) }
}

async function inspectTorrent(buffer: Buffer, destination: Destination, filename: string, source: string) {
  const parsed = await parseTorrent(buffer)
  const descriptors = (parsed.files ?? []).map((file: any, index: number) => ({
    index,
    name: String(file.name),
    path: String(file.path),
    length: Number(file.length),
  }))
  const selected = selectTorrentFiles(destination, String(parsed.name), descriptors)
  const totalBytes = selected.files.reduce((sum, file) => sum + file.length, 0)
  return {
    analysis: {
      source,
      sourceKind: 'torrent-file' as const,
      sourceLabel: `Торрент-файл · ${filename}`,
      title: String(parsed.name).slice(0, 180),
      destination: selected.destination,
      destinationPath: selected.destinationPath,
      supported: true,
      note: `Будет передано ${selected.files.length} файл(ов) без полного сохранения на VPS`,
      fileCount: selected.files.length,
      totalBytes,
    },
    files: selected.files,
  }
}

function safeUploadName(value: string): string {
  return path.basename(value).normalize('NFC').replaceAll(/[\u0000-\u001f<>:"/\\|?*]/g, ' ').trim().slice(0, 140) || 'загрузка.torrent'
}

function normalizeTorrentError(error: unknown): unknown {
  if (error instanceof InputError) return error
  if (error && typeof error === 'object' && 'code' in error && error.code === 'FST_REQ_FILE_TOO_LARGE') {
    return new InputError('.torrent превышает лимит 4 МиБ')
  }
  if (error instanceof Error && /torrent|bencode|info hash|required field/i.test(error.message)) {
    return new InputError('Некорректный или неподдерживаемый .torrent-файл')
  }
  return error
}
