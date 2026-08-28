import { createHmac, timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppConfig } from './config.js'
import type { JobDatabase } from './database.js'
import { resolveVkVideoSource, type VkVideoSource } from './vk-video.js'

const relayUsername = 'loader-vk'
const sourceCacheTtlMs = 2 * 60_000
const cancellationPollMs = 500

type VkResolver = (source: string) => Promise<VkVideoSource>

export function registerVkVideoRelay(
  app: FastifyInstance,
  database: JobDatabase,
  config: AppConfig,
  resolver: VkResolver = (source) => resolveVkVideoSource(source, { executablePath: config.ytDlpPath }),
  fetcher: typeof fetch = fetch,
): void {
  const sourceCache = new Map<string, { expiresAt: number, source: VkVideoSource }>()

  app.route<{ Params: { id: string } }>({
    method: ['GET', 'HEAD'],
    url: '/vk-import/:id',
    handler: async (request, reply) => {
      if (!authorizeRelay(request, config.sessionSecret)) {
        return reply
          .header('WWW-Authenticate', 'Basic realm="Loader VK Media"')
          .code(401)
          .send()
      }

      const job = database.getInternalJob(request.params.id)
      if (!job || job.sourceKind !== 'vkvideo' || !['transferring', 'verifying'].includes(job.status)) {
        return reply.code(404).send()
      }
      const range = request.headers.range
      if (range && !/^bytes=\d+-\d*$/u.test(range)) {
        return reply.header('Content-Range', `bytes */${job.totalBytes ?? '*'}`).code(416).send()
      }

      const controller = new AbortController()
      const cancellationTimer = setInterval(() => {
        const current = database.getInternalJob(job.id)
        if (!current || !['transferring', 'verifying'].includes(current.status)) controller.abort()
      }, cancellationPollMs)
      cancellationTimer.unref()
      let streaming = false

      try {
        const resolved = await cachedSource(job.id, job.source)
        if (controller.signal.aborted) return reply.code(410).send()
        const response = await fetcher(resolved.mediaUrl, {
          headers: { ...resolved.requestHeaders, ...(range ? { Range: range } : {}) },
          redirect: 'error',
          signal: controller.signal,
        })
        if (![200, 206].includes(response.status) || !response.body) {
          await response.body?.cancel()
          return reply.code(502).send()
        }
        const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
        if (contentType !== 'video/mp4') {
          await response.body.cancel()
          return reply.code(502).send()
        }

        copyHeader(response, reply, 'content-length')
        copyHeader(response, reply, 'content-range')
        copyHeader(response, reply, 'etag')
        copyHeader(response, reply, 'last-modified')
        reply.headers({
          'Accept-Ranges': response.headers.get('accept-ranges') ?? 'bytes',
          'Cache-Control': 'private, no-store',
          'Content-Type': 'video/mp4',
          'X-Accel-Buffering': 'no',
        })
        if (request.method === 'HEAD') {
          await response.body.cancel()
          return reply.code(response.status).send()
        }

        streaming = true
        reply.raw.once('close', () => {
          clearInterval(cancellationTimer)
          controller.abort()
        })
        return reply.code(response.status).send(
          Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream),
        )
      } catch {
        if (controller.signal.aborted) return reply.code(410).send()
        return reply.code(502).send()
      } finally {
        if (!streaming) {
          clearInterval(cancellationTimer)
          controller.abort()
        }
      }
    },
  })

  async function cachedSource(jobId: string, source: string): Promise<VkVideoSource> {
    const cached = sourceCache.get(jobId)
    if (cached && cached.expiresAt > Date.now()) return cached.source
    sourceCache.delete(jobId)
    const resolved = await resolver(source)
    sourceCache.set(jobId, { expiresAt: Date.now() + sourceCacheTtlMs, source: resolved })
    if (sourceCache.size > 100) {
      for (const [id, entry] of sourceCache) {
        if (entry.expiresAt <= Date.now() || sourceCache.size > 100) sourceCache.delete(id)
      }
    }
    return resolved
  }
}

export function buildVkRelayUrl(config: Pick<AppConfig, 'publicUrl' | 'sessionSecret'>, jobId: string): string {
  const url = new URL(`/vk-import/${encodeURIComponent(jobId)}`, config.publicUrl)
  url.username = relayUsername
  url.password = relayPassword(config.sessionSecret, jobId)
  return url.href
}

export function vkRelayAuthorization(config: Pick<AppConfig, 'sessionSecret'>, jobId: string): string {
  return `Basic ${Buffer.from(`${relayUsername}:${relayPassword(config.sessionSecret, jobId)}`).toString('base64')}`
}

function authorizeRelay(request: FastifyRequest<{ Params: { id: string } }>, secret: string): boolean {
  const authorization = request.headers.authorization
  if (!authorization?.startsWith('Basic ')) return false
  let decoded: string
  try {
    decoded = Buffer.from(authorization.slice('Basic '.length), 'base64').toString('utf8')
  } catch {
    return false
  }
  const separator = decoded.indexOf(':')
  if (separator < 0 || decoded.slice(0, separator) !== relayUsername) return false
  return safeEqual(decoded.slice(separator + 1), relayPassword(secret, request.params.id))
}

function relayPassword(secret: string, jobId: string): string {
  return createHmac('sha256', secret).update(`vk:${jobId}`).digest('base64url')
}

function safeEqual(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate)
  const expectedBytes = Buffer.from(expected)
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes)
}

function copyHeader(response: Response, reply: FastifyReply, name: string): void {
  const value = response.headers.get(name)
  if (value) reply.header(name, value)
}
