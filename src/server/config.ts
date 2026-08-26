import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

export interface AppConfig {
  host: string
  port: number
  databasePath: string
  webRoot: string
  password: string
  sessionSecret: string
  secureCookies: boolean
  yandexToken: string | null
  torrentMetadataDir: string
  pieceCacheDir: string
  pieceCacheMaxBytes: number
  diskReserveBytes: number
  torrentMetadataTimeoutMs: number
  uploadTimeoutMs: number
}

export function loadConfig(root = process.cwd()): AppConfig {
  const production = process.env.NODE_ENV === 'production'
  const password = process.env.LOADER_PASSWORD?.trim() || (production ? '' : 'loader-local')
  const sessionSecret = process.env.LOADER_SESSION_SECRET?.trim()
    || (production ? '' : randomBytes(32).toString('hex'))

  if (!password) {
    throw new Error('LOADER_PASSWORD обязателен в production')
  }
  if (sessionSecret.length < 32) {
    throw new Error('LOADER_SESSION_SECRET должен содержать не менее 32 символов')
  }

  return {
    host: process.env.LOADER_HOST?.trim() || '127.0.0.1',
    port: parsePort(process.env.LOADER_PORT),
    databasePath: path.resolve(root, process.env.LOADER_DATABASE_PATH || 'runtime/data/loader.db'),
    webRoot: path.resolve(root, 'dist/web'),
    password,
    sessionSecret,
    secureCookies: production,
    yandexToken: loadYandexToken(root),
    torrentMetadataDir: path.resolve(root, process.env.LOADER_TORRENT_METADATA_DIR || 'runtime/torrents'),
    pieceCacheDir: path.resolve(root, process.env.LOADER_PIECE_CACHE_DIR || 'runtime/cache/pieces'),
    pieceCacheMaxBytes: parseMiB(process.env.LOADER_PIECE_CACHE_MIB, 128) * 1024 * 1024,
    diskReserveBytes: parseMiB(process.env.LOADER_DISK_RESERVE_MIB, 1_024) * 1024 * 1024,
    torrentMetadataTimeoutMs: parseMinutes(process.env.LOADER_TORRENT_METADATA_TIMEOUT_MIN, 10),
    uploadTimeoutMs: parseMinutes(process.env.LOADER_UPLOAD_TIMEOUT_MIN, 180),
  }
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 8787
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('LOADER_PORT должен быть целым числом от 1 до 65535')
  }
  return port
}

function parseMiB(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(parsed) || parsed < 16 || parsed > 1_024) {
    throw new Error('Размер кеша и резерва должен быть целым числом от 16 до 1024 МиБ')
  }
  return parsed
}

function parseMinutes(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_440) {
    throw new Error('Тайм-аут должен быть целым числом от 1 до 1440 минут')
  }
  return parsed * 60_000
}

function loadYandexToken(root: string): string | null {
  const environmentToken = process.env.YANDEX_DISK_TOKEN?.trim()
  if (environmentToken) return validateToken(environmentToken)

  const tokenPath = path.resolve(root, 'runtime/secrets/yandex-token')
  try {
    const info = statSync(tokenPath)
    if ((info.mode & 0o077) !== 0) {
      throw new Error('runtime/secrets/yandex-token должен иметь права 0600')
    }
    return validateToken(readFileSync(tokenPath, 'utf8').trim())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function validateToken(value: string): string {
  if (value.length < 20 || /\s/.test(value)) {
    throw new Error('Токен Яндекс Диска имеет неверный формат')
  }
  return value
}
