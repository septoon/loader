import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { loadConfig } from './config.js'
import { MediaSftpServer } from './media-sftp-server.js'
import { YandexMediaLibrary } from './yandex-media-library.js'

const root = process.cwd()
const appConfig = loadConfig(root)
if (!appConfig.yandexToken) throw new Error('Для VLC SFTP не настроен токен Яндекс Диска')

const secretsRoot = path.resolve(root, 'runtime/secrets')
const credentialsPath = path.join(secretsRoot, 'vlc-sftp.env')
const hostKeyPath = path.join(secretsRoot, 'vlc-sftp-host-key')
assertPrivateFile(credentialsPath)
assertPrivateFile(hostKeyPath)
const credentials = parseCredentials(readFileSync(credentialsPath, 'utf8'))
const port = parsePort(process.env.LOADER_VLC_SFTP_PORT)
const host = process.env.LOADER_VLC_SFTP_HOST?.trim() || '0.0.0.0'

const server = new MediaSftpServer({
  hostKey: readFileSync(hostKeyPath),
  username: credentials.username,
  password: credentials.password,
  library: new YandexMediaLibrary(appConfig.yandexToken),
  onError: (message) => console.error(message),
})

await server.listen(host, port)
console.log(`VLC SFTP слушает ${host}:${port}, корень /Media, режим read-only`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.close().finally(() => process.exit(0))
  })
}

function assertPrivateFile(filePath: string): void {
  const info = statSync(filePath)
  if (!info.isFile() || (info.mode & 0o077) !== 0) {
    throw new Error(`${path.basename(filePath)} должен быть обычным файлом с правами 0600`)
  }
}

function parseCredentials(value: string): { username: string; password: string } {
  const entries = new Map(value.split(/\r?\n/u).filter(Boolean).map((line) => {
    const separator = line.indexOf('=')
    if (separator < 1) throw new Error('Неверный формат vlc-sftp.env')
    return [line.slice(0, separator), line.slice(separator + 1)]
  }))
  const username = entries.get('VLC_SFTP_USER')?.trim() || ''
  const password = entries.get('VLC_SFTP_PASSWORD')?.trim() || ''
  if (!/^[a-z][a-z0-9_-]{2,31}$/u.test(username) || password.length < 24 || /\s/u.test(password)) {
    throw new Error('Неверные учётные данные VLC SFTP')
  }
  return { username, password }
}

function parsePort(value: string | undefined): number {
  const port = value === undefined ? 2_022 : Number(value)
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error('LOADER_VLC_SFTP_PORT должен быть целым числом от 1024 до 65535')
  }
  return port
}
