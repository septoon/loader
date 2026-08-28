import { timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { MediaCredentials } from './media-secrets.js'
import { normalizeSftpPath } from './media-sftp-server.js'
import { type MediaResource, YandexMediaLibrary } from './yandex-media-library.js'

interface WildcardParams {
  '*': string
}

export function registerMediaWebDav(
  app: FastifyInstance,
  library: YandexMediaLibrary,
  credentials: MediaCredentials,
): void {
  app.addHttpMethod('PROPFIND', { hasBody: true })
  for (const contentType of ['application/xml', 'text/xml']) {
    app.addContentTypeParser(contentType, { parseAs: 'string' }, (_request, body, done) => done(null, body))
  }
  for (const url of ['/vlc', '/vlc/', '/vlc/*']) {
    app.route<{ Params: WildcardParams }>({
      method: ['OPTIONS', 'PROPFIND', 'GET', 'HEAD'],
      url,
      handler: async (request, reply) => {
        if (!authenticate(request, credentials)) {
          reply.header('WWW-Authenticate', 'Basic realm="Loader Media", charset="UTF-8"')
          return reply.code(401).send()
        }
        setDavHeaders(reply)
        const mediaPath = request.params['*'] === undefined
          ? '/'
          : normalizeSftpPath(`/${request.params['*']}`)
        if (!mediaPath) return reply.code(400).send()
        if (request.method === 'OPTIONS') return reply.code(204).send()
        const resource = await library.getResource(mediaPath)
        if (!resource) return reply.code(404).send()
        if (request.method === 'PROPFIND') return respondPropfind(request, reply, library, resource, mediaPath)
        if (resource.type === 'dir') return respondPlaylist(request, reply, library, mediaPath)
        return respondFile(request, reply, library, resource, mediaPath)
      },
    })
  }
}

async function respondPlaylist(
  request: FastifyRequest,
  reply: FastifyReply,
  library: YandexMediaLibrary,
  mediaPath: string,
): Promise<FastifyReply> {
  const files = await collectPlaylistFiles(library, mediaPath)
  const baseUrl = new URL('/vlc/', `${request.protocol}://${request.headers.host ?? request.hostname}`)
  const body = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><playlist version="1" xmlns="http://xspf.org/ns/0/"><title>Loader Media</title><trackList>${files
    .map(({ resource, path }) => {
      const location = new URL(`/vlc${encodePath(path)}`, baseUrl).href
      return `<track><title>${escapeXml(resource.name)}</title><location>${escapeXml(location)}</location></track>`
    })
    .join('')}</trackList></playlist>`)
  reply.headers({
    'Cache-Control': 'no-store',
    'Content-Disposition': 'inline; filename="loader-media.xspf"',
    'Content-Length': String(body.byteLength),
    'Content-Type': 'application/xspf+xml; charset=utf-8',
  })
  if (request.method === 'HEAD') return reply.code(200).send()
  return reply.code(200).send(body)
}

async function collectPlaylistFiles(
  library: YandexMediaLibrary,
  rootPath: string,
): Promise<Array<{ resource: MediaResource, path: string }>> {
  const directories = [rootPath]
  const files: Array<{ resource: MediaResource, path: string }> = []
  let visited = 0
  while (directories.length > 0) {
    const directory = directories.shift()!
    if (directory.split('/').filter(Boolean).length > 32) throw new Error('Медиатека содержит слишком глубокую структуру')
    for (const resource of await library.listDirectory(directory)) {
      visited += 1
      if (visited > 10_000) throw new Error('Медиатека содержит слишком много объектов для плейлиста')
      const resourcePath = normalizeSftpPath(`${directory === '/' ? '' : directory}/${resource.name}`)
      if (!resourcePath) continue
      if (resource.type === 'dir') directories.push(resourcePath)
      else if (isPlaylistMedia(resource.name)) files.push({ resource, path: resourcePath })
    }
  }
  return files
}

async function respondPropfind(
  request: FastifyRequest,
  reply: FastifyReply,
  library: YandexMediaLibrary,
  resource: MediaResource,
  mediaPath: string,
): Promise<FastifyReply> {
  const depth = String(request.headers.depth ?? '1')
  if (!['0', '1'].includes(depth)) return reply.code(403).send()
  const resources = [resource]
  if (depth === '1' && resource.type === 'dir') resources.push(...await library.listDirectory(mediaPath))
  const body = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${resources
    .map((item) => davResponse(item, resource, mediaPath))
    .join('')}</D:multistatus>`
  reply.type('application/xml; charset=utf-8')
  return reply.code(207).send(body)
}

async function respondFile(
  request: FastifyRequest,
  reply: FastifyReply,
  library: YandexMediaLibrary,
  resource: MediaResource,
  mediaPath: string,
): Promise<FastifyReply> {
  const range = parseRange(request.headers.range, resource.size)
  if (!range) {
    reply.header('Content-Range', `bytes */${resource.size}`)
    return reply.code(416).send()
  }
  const partial = request.headers.range !== undefined
  const length = range.end - range.start + 1
  reply.headers({
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType(resource.name),
    'Content-Length': String(length),
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(resource.name)}`,
  })
  if (partial) reply.header('Content-Range', `bytes ${range.start}-${range.end}/${resource.size}`)
  if (request.method === 'HEAD') return reply.code(partial ? 206 : 200).send()

  const controller = new AbortController()
  request.raw.once('aborted', () => controller.abort())
  reply.raw.once('close', () => {
    if (!reply.raw.writableEnded) controller.abort()
  })
  const body = await library.openRead(mediaPath, range.start, range.end, controller.signal)
  return reply.code(partial ? 206 : 200).send(Readable.fromWeb(body as unknown as import('node:stream/web').ReadableStream))
}

function authenticate(request: FastifyRequest, credentials: MediaCredentials): boolean {
  const header = request.headers.authorization
  if (!header?.startsWith('Basic ')) return false
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
    const separator = decoded.indexOf(':')
    if (separator < 1) return false
    return safeEqual(decoded.slice(0, separator), credentials.username)
      && safeEqual(decoded.slice(separator + 1), credentials.password)
  } catch {
    return false
  }
}

function safeEqual(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate)
  const expectedBytes = Buffer.from(expected)
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes)
}

function setDavHeaders(reply: FastifyReply): void {
  reply.headers({ DAV: '1', Allow: 'OPTIONS, PROPFIND, HEAD, GET', 'MS-Author-Via': 'DAV' })
}

function parseRange(value: string | undefined, size: number): { start: number; end: number } | null {
  if (!Number.isSafeInteger(size) || size < 1) return null
  if (value === undefined) return { start: 0, end: size - 1 }
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value)
  if (!match || (!match[1] && !match[2])) return null
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix < 1) return null
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) return null
  return { start, end: Math.min(requestedEnd, size - 1) }
}

function davResponse(item: MediaResource, requested: MediaResource, requestedPath: string): string {
  const relativePath = item === requested ? requestedPath : `${requestedPath === '/' ? '' : requestedPath}/${item.name}`
  const href = `/vlc${encodePath(relativePath)}${item.type === 'dir' && relativePath !== '/' ? '/' : ''}`
  const resourceType = item.type === 'dir' ? '<D:collection/>' : ''
  const contentLength = item.type === 'file' ? `<D:getcontentlength>${item.size}</D:getcontentlength>` : ''
  const mime = item.type === 'file' ? `<D:getcontenttype>${contentType(item.name)}</D:getcontenttype>` : ''
  return `<D:response><D:href>${escapeXml(href)}</D:href><D:propstat><D:prop><D:displayname>${escapeXml(item.name)}</D:displayname><D:resourcetype>${resourceType}</D:resourcetype>${contentLength}${mime}<D:getlastmodified>${new Date(item.modifiedAt * 1_000).toUTCString()}</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
}

function encodePath(value: string): string {
  if (value === '/') return '/'
  return value.split('/').map((segment) => encodeURIComponent(segment)).join('/')
}

function escapeXml(value: string): string {
  return value.replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function contentType(name: string): string {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return ({
    mp4: 'video/mp4', m4v: 'video/x-m4v', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
    ts: 'video/mp2t', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg',
    m4a: 'audio/mp4', flac: 'audio/flac', srt: 'application/x-subrip', ass: 'text/x-ssa',
  } as Record<string, string>)[extension] ?? 'application/octet-stream'
}

function isPlaylistMedia(name: string): boolean {
  return /\.(?:mp4|m4v|mkv|avi|ts|mov|webm|mp3|m4a|flac)$/iu.test(name)
}
