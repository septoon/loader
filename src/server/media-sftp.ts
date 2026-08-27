import { loadConfig } from './config.js'
import { loadMediaCredentials, loadMediaHostKey } from './media-secrets.js'
import { MediaSftpServer } from './media-sftp-server.js'
import { YandexMediaLibrary } from './yandex-media-library.js'

const root = process.cwd()
const appConfig = loadConfig(root)
if (!appConfig.yandexToken) throw new Error('Для VLC SFTP не настроен токен Яндекс Диска')

const credentials = loadMediaCredentials(root)
const port = parsePort(process.env.LOADER_VLC_SFTP_PORT)
const host = process.env.LOADER_VLC_SFTP_HOST?.trim() || '0.0.0.0'

const server = new MediaSftpServer({
  hostKey: loadMediaHostKey(root),
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

function parsePort(value: string | undefined): number {
  const port = value === undefined ? 2_022 : Number(value)
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error('LOADER_VLC_SFTP_PORT должен быть целым числом от 1024 до 65535')
  }
  return port
}
