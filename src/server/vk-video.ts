import { execFile } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import ipaddr from 'ipaddr.js'

const vkVideoPath = /^\/video(?:\/)?(-?\d{1,20})_(\d{1,20})(?:\/|$)/u
const supportedHosts = new Set(['vkvideo.ru', 'www.vkvideo.ru', 'vk.com', 'www.vk.com', 'm.vk.com'])
const trustedMediaSuffixes = ['.vkuser.net', '.okcdn.ru', '.mycdn.me', '.userapi.com', '.vk-cdn.net']
const maximumMetadataBytes = 8 * 1024 * 1024
const publicHostCache = new Map<string, number>()

export interface VkVideoId {
  ownerId: string
  videoId: string
  id: string
  canonicalSource: string
}

export interface VkVideoSource extends VkVideoId {
  title: string
  durationSeconds: number
  resolution: string
  totalBytes: number | null
  mediaUrl: string
  requestHeaders: Record<string, string>
}

export interface VkVideoResolveOptions {
  executablePath?: string
  execute?: (executablePath: string, arguments_: string[]) => Promise<string>
  fetcher?: typeof fetch
  validateMediaUrl?: (value: string) => Promise<URL>
}

export class VkVideoSourceError extends Error {}

export function isVkVideoHost(hostnameValue: string): boolean {
  return supportedHosts.has(hostnameValue.toLowerCase().replace(/\.$/u, ''))
}

export function getVkVideoId(source: URL): VkVideoId | null {
  if (!isVkVideoHost(source.hostname)) return null
  const match = vkVideoPath.exec(source.pathname)
  if (!match?.[1] || !match[2]) return null
  const ownerId = match[1]
  const videoId = match[2]
  return {
    ownerId,
    videoId,
    id: `${ownerId}_${videoId}`,
    canonicalSource: `https://m.vk.com/video${ownerId}_${videoId}`,
  }
}

export async function resolveVkVideoSource(
  sourceValue: string,
  options: VkVideoResolveOptions = {},
): Promise<VkVideoSource> {
  const identifier = getVkVideoId(new URL(sourceValue))
  if (!identifier) throw new VkVideoSourceError('Поддерживается ссылка на отдельное видео VK')
  const execute = options.execute ?? executeYtDlp
  const output = await execute(options.executablePath ?? 'yt-dlp', [
    '--ignore-config',
    '--no-playlist',
    '--skip-download',
    '--dump-single-json',
    '--no-warnings',
    '--socket-timeout', '20',
    '--retries', '2',
    '--extractor-retries', '2',
    '--format', 'best[protocol^=http][ext=mp4][height<=1080]/best[protocol^=http][height<=1080]/best[protocol^=http]',
    identifier.canonicalSource,
  ])
  if (Buffer.byteLength(output) > maximumMetadataBytes) {
    throw new VkVideoSourceError('VK Видео вернуло слишком большой ответ метаданных')
  }

  const metadata = parseMetadata(output)
  if (metadata.id !== identifier.id && metadata.id !== `-${identifier.id}`) {
    throw new VkVideoSourceError('VK Видео вернуло метаданные другого ролика')
  }
  const title = requiredString(metadata.title, 'VK Видео не вернуло название ролика')
  const mediaUrl = await (options.validateMediaUrl ?? validateVkMediaUrl)(
    requiredString(metadata.url, 'VK Видео не вернуло прямой медиапоток'),
  )
  const protocol = requiredString(metadata.protocol, 'VK Видео не вернуло протокол медиапотока')
  if (!protocol.startsWith('http')) throw new VkVideoSourceError('VK Видео не вернуло совместимый HTTP-медиапоток')
  if (metadata.ext !== 'mp4') throw new VkVideoSourceError('VK Видео не вернуло совместимый MP4-поток')

  const requestHeaders = selectRequestHeaders(metadata.http_headers)
  const probe = await probeMedia(mediaUrl, requestHeaders, options.fetcher ?? fetch)
  const height = positiveInteger(metadata.height)
  const durationSeconds = positiveNumber(metadata.duration)
  const metadataSize = positiveInteger(metadata.filesize) ?? positiveInteger(metadata.filesize_approx)
  return {
    ...identifier,
    title,
    durationSeconds: durationSeconds ?? 0,
    resolution: height ? `${height}p` : 'MP4',
    totalBytes: metadataSize ?? probe.totalBytes,
    mediaUrl: mediaUrl.href,
    requestHeaders,
  }
}

interface YtDlpMetadata {
  id?: unknown
  title?: unknown
  url?: unknown
  protocol?: unknown
  ext?: unknown
  height?: unknown
  duration?: unknown
  filesize?: unknown
  filesize_approx?: unknown
  http_headers?: unknown
}

function executeYtDlp(executablePath: string, arguments_: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executablePath, arguments_, {
      encoding: 'utf8',
      timeout: 45_000,
      maxBuffer: maximumMetadataBytes,
      windowsHide: true,
    }, (error, stdout) => {
      if (!error) {
        resolve(stdout)
        return
      }
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') reject(new VkVideoSourceError('Сервис обработки VK Видео не настроен'))
      else if (error.killed) reject(new VkVideoSourceError('VK Видео не ответило за отведённое время'))
      else reject(new VkVideoSourceError('VK Видео не открыло ролик. Проверьте, что он доступен без входа'))
    })
  })
}

function parseMetadata(value: string): YtDlpMetadata {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
    return parsed as YtDlpMetadata
  } catch {
    throw new VkVideoSourceError('VK Видео вернуло некорректные метаданные')
  }
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new VkVideoSourceError(message)
  return value.trim()
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function selectRequestHeaders(value: unknown): Record<string, string> {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const headers: Record<string, string> = {}
  for (const name of ['User-Agent', 'Accept', 'Accept-Language', 'Sec-Fetch-Mode', 'Referer']) {
    const header = source[name]
    if (typeof header === 'string' && header.length > 0 && header.length <= 1_000 && !/[\r\n]/u.test(header)) {
      headers[name] = header
    }
  }
  if (!headers['User-Agent']) headers['User-Agent'] = 'Mozilla/5.0 (compatible; Loader/0.1)'
  return headers
}

async function validateVkMediaUrl(value: string): Promise<URL> {
  const url = new URL(value)
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '')
  const trustedHost = trustedMediaSuffixes.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix))
  if (url.protocol !== 'https:' || !trustedHost || url.username || url.password || url.port) {
    throw new VkVideoSourceError('VK Видео вернуло недопустимый адрес медиапотока')
  }
  const cachedUntil = publicHostCache.get(hostname) ?? 0
  if (cachedUntil > Date.now()) return url
  const addresses = await lookup(hostname, { all: true, verbatim: true }).catch(() => [])
  if (addresses.length === 0 || addresses.some(({ address }) => {
    return !ipaddr.isValid(address) || ipaddr.process(address).range() !== 'unicast'
  })) {
    throw new VkVideoSourceError('Медиапоток VK указывает на служебную сеть')
  }
  publicHostCache.set(hostname, Date.now() + 5 * 60_000)
  return url
}

async function probeMedia(
  url: URL,
  requestHeaders: Record<string, string>,
  fetcher: typeof fetch,
): Promise<{ totalBytes: number | null }> {
  let response: Response
  try {
    response = await fetcher(url.href, {
      headers: { ...requestHeaders, Range: 'bytes=0-0' },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new VkVideoSourceError('Не удалось открыть медиапоток VK')
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (![200, 206].includes(response.status) || contentType !== 'video/mp4') {
    await response.body?.cancel()
    throw new VkVideoSourceError(`VK Видео не вернуло MP4-поток: HTTP ${response.status}`)
  }
  const totalBytes = totalSizeFromHeaders(response.headers, response.status)
  await response.body?.cancel()
  return { totalBytes }
}

function totalSizeFromHeaders(headers: Headers, status: number): number | null {
  if (status === 206) {
    const total = Number(/\/([0-9]+)$/u.exec(headers.get('content-range') ?? '')?.[1])
    if (Number.isSafeInteger(total) && total > 0) return total
  }
  const length = Number(headers.get('content-length'))
  return Number.isSafeInteger(length) && length > 0 ? length : null
}
