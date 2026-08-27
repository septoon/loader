import { lookup } from 'node:dns/promises'
import ipaddr from 'ipaddr.js'

const videoPath = /^\/(?:video(?:\/private)?|(?:play\/)?embed)\/([a-f0-9]{32})(?:\/|$)/iu
const maximumPlaylistBytes = 5 * 1024 * 1024
const publicHostCache = new Map<string, number>()

export interface RutubeSegment {
  url: string
  duration: number
}

export interface RutubeSource {
  id: string
  title: string
  durationSeconds: number
  bandwidth: number
  resolution: string
  segments: RutubeSegment[]
}

export class RutubeSourceError extends Error {}

export function getRutubeVideoId(source: URL): string | null {
  const hostname = source.hostname.toLowerCase().replace(/\.$/, '')
  if (!['rutube.ru', 'www.rutube.ru'].includes(hostname)) return null
  return videoPath.exec(source.pathname)?.[1]?.toLowerCase() ?? null
}

export async function resolveRutubeSource(
  sourceValue: string,
  fetcher: typeof fetch = fetch,
  validateMediaUrl: (value: string) => Promise<URL> = validateRutubeMediaUrl,
): Promise<RutubeSource> {
  const source = new URL(sourceValue)
  const id = getRutubeVideoId(source)
  if (!id) throw new RutubeSourceError('Поддерживается ссылка на отдельное видео Rutube')
  const headers = rutubeRequestHeaders(source.href)
  const optionsUrl = `https://rutube.ru/api/play/options/${id}/?format=json`
  const optionsResponse = await fetcher(optionsUrl, requestOptions(headers))
  const optionsText = await readLimitedText(optionsResponse, maximumPlaylistBytes)
  const options = parseJson(optionsText)
  if (!optionsResponse.ok) {
    const detail = firstString(options, ['detail', 'languages', 0, 'title'])
      ?? firstString(options, ['detail'])
    throw new RutubeSourceError(detail || `Rutube не открыл видео: HTTP ${optionsResponse.status}`)
  }

  const title = firstString(options, ['title'])
  const masterValue = firstString(options, ['video_balancer', 'm3u8'])
    ?? firstString(options, ['video_balancer', 'default'])
  if (!title || !masterValue) throw new RutubeSourceError('Rutube не вернул доступный HLS-поток')
  const masterUrl = await validateMediaUrl(masterValue)
  const masterResponse = await fetcher(masterUrl.href, requestOptions(headers))
  if (!masterResponse.ok) throw new RutubeSourceError(`Rutube не вернул список качеств: HTTP ${masterResponse.status}`)
  const variants = parseMasterPlaylist(await readLimitedText(masterResponse, maximumPlaylistBytes), masterUrl)
  const variant = selectVariant(variants)
  variant.url = await validateMediaUrl(variant.url.href)
  const mediaResponse = await fetcher(variant.url.href, requestOptions(headers))
  if (!mediaResponse.ok) throw new RutubeSourceError(`Rutube не вернул медиаплейлист: HTTP ${mediaResponse.status}`)
  const segments = await parseMediaPlaylist(
    await readLimitedText(mediaResponse, maximumPlaylistBytes),
    variant.url,
    validateMediaUrl,
  )
  const durationSeconds = segments.reduce((sum, segment) => sum + segment.duration, 0)
  return {
    id,
    title,
    durationSeconds,
    bandwidth: variant.bandwidth,
    resolution: variant.resolution,
    segments,
  }
}

export function rutubeRequestHeaders(source: string): Record<string, string> {
  return {
    'User-Agent': 'Mozilla/5.0 (compatible; Loader/0.1)',
    Referer: source,
  }
}

interface Variant {
  url: URL
  bandwidth: number
  resolution: string
  height: number
}

function parseMasterPlaylist(value: string, baseUrl: URL): Variant[] {
  const lines = playlistLines(value)
  const variants: Variant[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue
    const uri = lines.slice(index + 1).find((candidate) => candidate && !candidate.startsWith('#'))
    if (!uri) continue
    const bandwidth = Number(attribute(line, 'BANDWIDTH'))
    const resolution = attribute(line, 'RESOLUTION') ?? ''
    const height = Number(resolution.split('x')[1])
    if (!Number.isSafeInteger(bandwidth) || bandwidth <= 0 || !Number.isSafeInteger(height) || height <= 0) continue
    variants.push({ url: new URL(uri, baseUrl), bandwidth, resolution, height })
  }
  if (variants.length === 0) throw new RutubeSourceError('В HLS Rutube не найдено поддерживаемое качество')
  return variants
}

function selectVariant(variants: Variant[]): Variant {
  const bounded = variants.filter((variant) => variant.height <= 720)
  return [...(bounded.length > 0 ? bounded : variants)].sort((left, right) => {
    return right.height - left.height || right.bandwidth - left.bandwidth
  })[0]!
}

async function parseMediaPlaylist(
  value: string,
  baseUrl: URL,
  validateMediaUrl: (value: string) => Promise<URL>,
): Promise<RutubeSegment[]> {
  const lines = playlistLines(value)
  if (!lines.includes('#EXT-X-ENDLIST')) throw new RutubeSourceError('Прямые эфиры Rutube пока не поддерживаются')
  if (lines.some((line) => line.startsWith('#EXT-X-KEY:'))) {
    throw new RutubeSourceError('Зашифрованный HLS Rutube не поддерживается')
  }
  if (lines.some((line) => line.startsWith('#EXT-X-MAP:') || line.startsWith('#EXT-X-BYTERANGE:')
    || line === '#EXT-X-DISCONTINUITY')) {
    throw new RutubeSourceError('Этот вариант HLS нельзя безопасно объединить без транскодирования')
  }

  const segments: RutubeSegment[] = []
  let duration: number | null = null
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      duration = Number(line.slice('#EXTINF:'.length).split(',')[0])
      continue
    }
    if (!line || line.startsWith('#')) continue
    if (!Number.isFinite(duration) || duration! <= 0) throw new RutubeSourceError('HLS-сегмент не содержит длительность')
    const url = await validateMediaUrl(new URL(line, baseUrl).href)
    segments.push({ url: url.href, duration: duration! })
    duration = null
  }
  if (segments.length === 0 || segments.length > 10_000) {
    throw new RutubeSourceError('Rutube вернул некорректное количество HLS-сегментов')
  }
  return segments
}

async function validateRutubeMediaUrl(value: string): Promise<URL> {
  const url = new URL(value)
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  const trustedHost = hostname === 'rutube.ru' || hostname.endsWith('.rutube.ru')
    || hostname === 'rtbcdn.ru' || hostname.endsWith('.rtbcdn.ru')
  if (url.protocol !== 'https:' || !trustedHost || url.username || url.password || url.port) {
    throw new RutubeSourceError('Rutube вернул недопустимый адрес медиапотока')
  }
  const cachedUntil = publicHostCache.get(hostname) ?? 0
  if (cachedUntil > Date.now()) return url
  const addresses = await lookup(hostname, { all: true, verbatim: true }).catch(() => [])
  if (addresses.length === 0 || addresses.some(({ address }) => {
    return !ipaddr.isValid(address) || ipaddr.process(address).range() !== 'unicast'
  })) {
    throw new RutubeSourceError('Медиапоток Rutube указывает на служебную сеть')
  }
  publicHostCache.set(hostname, Date.now() + 5 * 60_000)
  return url
}

function requestOptions(headers: Record<string, string>): RequestInit {
  return { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) }
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  const text = await response.text()
  if (Buffer.byteLength(text) > limit) throw new RutubeSourceError('Ответ Rutube превышает безопасный лимит')
  return text
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new RutubeSourceError('Rutube вернул некорректный JSON')
  }
}

function firstString(value: unknown, path: Array<string | number>): string | null {
  let current = value
  for (const key of path) {
    if (!current || typeof current !== 'object') return null
    current = (current as Record<string | number, unknown>)[key]
  }
  return typeof current === 'string' && current.trim() ? current.trim() : null
}

function playlistLines(value: string): string[] {
  const lines = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
  if (lines[0] !== '#EXTM3U') throw new RutubeSourceError('Rutube вернул некорректный HLS-плейлист')
  return lines
}

function attribute(line: string, name: string): string | null {
  const match = new RegExp(`(?:^|,)${name}=("[^"]*"|[^,]*)`, 'u').exec(line.slice(line.indexOf(':') + 1))
  return match?.[1]?.replace(/^"|"$/gu, '') ?? null
}
