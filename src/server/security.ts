import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import ipaddr from 'ipaddr.js'
import type { Destination, SourceAnalysis } from '../shared/types.js'
import { destinations } from '../shared/types.js'

const destinationRoots: Record<Destination, string> = {
  auto: '/Media/Unsorted',
  movies: '/Media/Movies',
  tv: '/Media/TV',
  unsorted: '/Media/Unsorted',
}

export async function analyzeSource(sourceValue: string, destinationValue: string): Promise<SourceAnalysis> {
  const source = sourceValue.trim()
  const destination = parseDestination(destinationValue)
  if (!source || source.length > 8_192) {
    throw new InputError('Укажите ссылку длиной не более 8192 символов')
  }

  if (source.startsWith('magnet:?')) {
    const parameters = new URLSearchParams(source.slice('magnet:?'.length))
    const exactTopic = parameters.getAll('xt').find((value) => value.toLowerCase().startsWith('urn:btih:'))
    const hash = exactTopic?.slice('urn:btih:'.length) ?? ''
    if (!/^(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(hash)) {
      throw new InputError('Магнет-ссылка не содержит корректный BitTorrent info hash')
    }
    const title = inferMagnetTitle(parameters)
    return {
      source,
      sourceKind: 'magnet',
      sourceLabel: `Магнет · ${hash.slice(0, 8).toUpperCase()}`,
      title,
      destination,
      destinationPath: buildDestinationPath(destination, title),
      supported: true,
      note: destination === 'auto'
        ? 'После получения метаданных будет выбран каталог «Фильмы» или «Сериалы»'
        : 'Метаданные и состав файлов будут получены из BitTorrent-сети',
    }
  }

  let sourceUrl: URL
  try {
    sourceUrl = new URL(source)
  } catch {
    throw new InputError('Ссылка имеет неверный формат')
  }
  if (!['http:', 'https:'].includes(sourceUrl.protocol)) {
    throw new InputError('Поддерживаются только HTTP, HTTPS и магнет-ссылки')
  }
  if (sourceUrl.username || sourceUrl.password) {
    throw new InputError('Ссылки со встроенными учётными данными запрещены')
  }
  if (sourceUrl.port && !['80', '443'].includes(sourceUrl.port)) {
    throw new InputError('Нестандартный порт источника запрещён')
  }

  await assertPublicHost(sourceUrl.hostname)
  const title = inferUrlTitle(sourceUrl)
  return {
    source: sourceUrl.href,
    sourceKind: 'direct-url',
    sourceLabel: `${sourceUrl.hostname}${decodePathname(sourceUrl.pathname)}`,
    title,
    destination,
    destinationPath: buildDestinationPath(destination, title),
    supported: true,
    note: 'Яндекс Диск заберёт файл напрямую, без передачи байтов через Лоадер',
  }
}

export function parseDestination(value: string): Destination {
  if (!destinations.includes(value as Destination)) {
    throw new InputError('Неизвестный каталог назначения')
  }
  return value as Destination
}

export function buildDestinationPath(destination: Destination, title: string): string {
  const safeTitle = sanitizeFileName(title)
  return path.posix.join(destinationRoots[destination], safeTitle)
}

export interface TorrentFileDescriptor {
  index: number
  name: string
  path: string
  length: number
}

export interface SelectedTorrentFile extends TorrentFileDescriptor {
  relativePath: string
  destinationPath: string
}

export function selectTorrentFiles(
  destination: Destination,
  torrentName: string,
  files: TorrentFileDescriptor[],
): { destination: Destination, destinationPath: string, files: SelectedTorrentFile[] } {
  const safeTorrentName = sanitizeFileName(torrentName)
  const candidates = files
    .filter((file) => Number.isSafeInteger(file.length) && file.length > 0)
    .map((file) => ({ ...file, relativePath: sanitizeRelativePath(file.path, safeTorrentName) }))
  const videos = candidates.filter((file) => isVideo(file.name) && !isSample(file.relativePath))
  if (videos.length === 0) throw new InputError('В торренте не найден поддерживаемый видеофайл')

  const companions = candidates.filter((file) => {
    if (videos.includes(file)) return false
    const extension = path.posix.extname(file.name).toLowerCase()
    return ['.srt', '.ass', '.ssa', '.vtt', '.nfo', '.jpg', '.jpeg', '.png'].includes(extension)
      && file.length <= 20 * 1024 * 1024
  })
  const selected = [...videos, ...companions].sort((left, right) => left.index - right.index)
  const resolvedDestination = destination === 'auto'
    ? inferTorrentDestination(safeTorrentName, videos)
    : destination
  const root = destinationRoots[resolvedDestination]
  const useContainer = selected.length > 1
  const containerPath = useContainer ? path.posix.join(root, safeTorrentName) : root
  const mappedFiles = selected.map((file) => ({
    ...file,
    destinationPath: path.posix.join(containerPath, useContainer ? file.relativePath : sanitizeFileName(file.name)),
  }))

  return {
    destination: resolvedDestination,
    destinationPath: useContainer ? containerPath : mappedFiles[0]!.destinationPath,
    files: mappedFiles,
  }
}

export function sanitizePublicError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Неизвестная ошибка'
  return message
    .replaceAll(/https?:\/\/[^\s"']+/giu, '<ссылка скрыта>')
    .replaceAll(/OAuth\s+\S+/giu, 'OAuth <скрыто>')
    .slice(0, 1_000)
}

export class InputError extends Error {}

async function assertPublicHost(hostname: string): Promise<void> {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  if (normalized === 'localhost' || normalized.endsWith('.localhost')
    || normalized.endsWith('.local') || normalized.endsWith('.internal')) {
    throw new InputError('Локальные и внутренние адреса запрещены')
  }

  const addresses = isIP(normalized)
    ? [{ address: normalized }]
    : await lookup(normalized, { all: true, verbatim: true }).catch(() => {
      throw new InputError('Не удалось определить адрес источника')
    })

  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new InputError('Источник указывает на локальную или служебную сеть')
  }
}

function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false
  return ipaddr.process(address).range() === 'unicast'
}

function inferUrlTitle(url: URL): string {
  const lastSegment = decodePathname(url.pathname).split('/').filter(Boolean).at(-1)
  return sanitizeFileName(lastSegment || `Загрузка-${new Date().toISOString().slice(0, 10)}`)
}

function inferMagnetTitle(parameters: URLSearchParams): string {
  const displayName = parameters.get('dn')
  return sanitizeFileName(displayName || 'Торрент-загрузка')
}

function sanitizeFileName(value: string): string {
  const normalized = value.normalize('NFC').replaceAll(/[\u0000-\u001f<>:"/\\|?*]/g, ' ').replaceAll(/\s+/g, ' ').trim()
  if (!normalized || normalized === '.' || normalized === '..') {
    throw new InputError('Не удалось определить безопасное имя файла')
  }
  return normalized.slice(0, 180)
}

function sanitizeRelativePath(value: string, torrentName: string): string {
  const parts = value.replaceAll('\\', '/').split('/').filter(Boolean)
  if (parts.some((part) => part === '.' || part === '..')) throw new InputError('Торрент содержит небезопасный путь')
  const sanitized = parts.map(sanitizeFileName)
  if (sanitized.length > 1 && sanitized[0]?.localeCompare(torrentName, undefined, { sensitivity: 'accent' }) === 0) sanitized.shift()
  if (sanitized.length === 0) throw new InputError('Торрент содержит пустой путь файла')
  return sanitized.join('/')
}

function isVideo(name: string): boolean {
  return ['.mkv', '.mp4', '.avi', '.mov', '.m4v', '.ts', '.m2ts', '.webm', '.mpg', '.mpeg']
    .includes(path.posix.extname(name).toLowerCase())
}

function isSample(value: string): boolean {
  return /(^|[\/._ -])(sample|образец)([\/._ -]|$)/iu.test(value)
}

function inferTorrentDestination(name: string, videos: TorrentFileDescriptor[]): Destination {
  if (videos.length > 1 || /(?:^|\W)(?:s\d{1,2}(?:e\d{1,3})?|season|сезон)(?:\W|$)/iu.test(name)) return 'tv'
  return 'movies'
}

function decodePathname(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
