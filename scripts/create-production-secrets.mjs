import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const secretsDirectory = path.join(projectRoot, 'runtime', 'secrets')
const environmentPath = path.join(secretsDirectory, 'loader.env')
const passwordPath = path.join(secretsDirectory, 'loader-password')

await mkdir(secretsDirectory, { recursive: true, mode: 0o700 })
await chmod(secretsDirectory, 0o700)

const environmentHandle = await open(environmentPath, 'wx', 0o600).catch((error) => {
  if (error.code === 'EEXIST') throw new Error('Production secrets уже созданы; существующие значения не изменены')
  throw error
})

const password = randomBytes(24).toString('base64url')
const sessionSecret = randomBytes(48).toString('hex')
const environment = [
  'NODE_ENV=production',
  'LOADER_HOST=127.0.0.1',
  'LOADER_PORT=8787',
  'LOADER_DATABASE_PATH=runtime/data/loader.db',
  `LOADER_PASSWORD=${password}`,
  `LOADER_SESSION_SECRET=${sessionSecret}`,
  'LOADER_TRUST_PROXY=1',
  'LOADER_NODE_BINARY=/home/deploy/.local/node-v22/bin/node',
  'LOADER_PIECE_CACHE_MIB=128',
  'LOADER_DISK_RESERVE_MIB=1024',
  'LOADER_TORRENT_METADATA_TIMEOUT_MIN=10',
  'LOADER_UPLOAD_TIMEOUT_MIN=180',
  '',
].join('\n')

try {
  await environmentHandle.writeFile(environment, 'utf8')
  await environmentHandle.sync()
} finally {
  await environmentHandle.close()
}
await writeFile(passwordPath, `${password}\n`, { mode: 0o600, flag: 'wx' })
await chmod(environmentPath, 0o600)
await chmod(passwordPath, 0o600)

console.log('Production secrets созданы в runtime/secrets/ с правами 0600')
