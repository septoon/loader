import type { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import type { AppConfig } from './config.js'
import type { JobDatabase } from './database.js'
import { authorizeTorrentRelay } from './torrent-relay-auth.js'

export interface TorrentRelayProvider {
  createRelayStream(jobId: string, fileIndex: number, start: number, end: number): Readable
}

export function registerTorrentRelay(
  app: FastifyInstance,
  database: JobDatabase,
  config: AppConfig,
  provider: TorrentRelayProvider,
): void {
  app.route<{ Params: { id: string, fileIndex: string } }>({
    method: ['GET', 'HEAD'],
    url: '/torrent-import/:id/:fileIndex',
    handler: async (request, reply) => {
      const fileIndex = Number(request.params.fileIndex)
      if (!Number.isSafeInteger(fileIndex) || fileIndex < 0) return reply.code(404).send()
      if (!authorizeTorrentRelay(
        request.headers.authorization, config.sessionSecret, request.params.id, fileIndex,
      )) {
        return reply.header('WWW-Authenticate', 'Basic realm="Loader Torrent Media"').code(401).send()
      }

      const job = database.getInternalJob(request.params.id)
      const file = job?.files.find((entry) => entry.index === fileIndex)
      if (!job || !file || !['transferring', 'verifying'].includes(job.status)) return reply.code(404).send()
      const range = parseRange(request.headers.range, file.size)
      if (!range) return reply.header('Content-Range', `bytes */${file.size}`).code(416).send()

      const partial = Boolean(request.headers.range)
      reply.headers({
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-store',
        'Content-Length': String(range.end - range.start + 1),
        'Content-Type': 'application/octet-stream',
        'X-Accel-Buffering': 'no',
      })
      if (partial) reply.header('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`)
      if (request.method === 'HEAD') return reply.code(partial ? 206 : 200).send()

      try {
        return reply.code(partial ? 206 : 200).send(
          provider.createRelayStream(job.id, fileIndex, range.start, range.end),
        )
      } catch {
        return reply.code(503).send()
      }
    },
  })
}

function parseRange(value: string | undefined, size: number): { start: number, end: number } | null {
  if (!Number.isSafeInteger(size) || size <= 0) return null
  if (!value) return { start: 0, end: size - 1 }
  const match = /^bytes=(\d+)-(\d*)$/u.exec(value)
  if (!match) return null
  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)
    || start < 0 || start >= size || requestedEnd < start) return null
  return { start, end: Math.min(requestedEnd, size - 1) }
}
