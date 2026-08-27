import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { JobDatabase } from './database.js'
import { JobRunner } from './job-runner.js'
import { loadMediaCredentialsOrNull } from './media-secrets.js'
import { YandexMediaLibrary } from './yandex-media-library.js'
import { YandexDiskAdapter } from './yandex-disk.js'

const config = loadConfig()
const database = new JobDatabase(config.databasePath)
const storage = config.yandexToken ? new YandexDiskAdapter(config.yandexToken) : null
const runner = new JobRunner(database, storage, config)
const mediaCredentials = loadMediaCredentialsOrNull()
const media = config.yandexToken && mediaCredentials ? {
  library: new YandexMediaLibrary(config.yandexToken),
  credentials: mediaCredentials,
} : undefined
const app = await buildApp({ config, database, runner, ...(media ? { media } : {}) })

app.addHook('onClose', async () => {
  await runner.stop()
  database.close()
})

runner.start()

try {
  await app.listen({ host: config.host, port: config.port })
  if (process.env.NODE_ENV !== 'production' && process.env.LOADER_PASSWORD === undefined) {
    app.log.warn('Для локальной разработки используется пароль loader-local')
  }
  if (!config.yandexToken) app.log.warn('Яндекс Диск не настроен: новые задачи завершатся ошибкой')
} catch (error) {
  app.log.error(error)
  process.exitCode = 1
}
