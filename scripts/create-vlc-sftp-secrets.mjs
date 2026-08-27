import { randomBytes } from 'node:crypto'
import { access, chmod, mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ssh2 from 'ssh2'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const secretsDirectory = path.join(projectRoot, 'runtime', 'secrets')
const credentialsPath = path.join(secretsDirectory, 'vlc-sftp.env')
const hostKeyPath = path.join(secretsDirectory, 'vlc-sftp-host-key')

await mkdir(secretsDirectory, { recursive: true, mode: 0o700 })
await chmod(secretsDirectory, 0o700)
if (await exists(credentialsPath) || await exists(hostKeyPath)) {
  throw new Error('VLC SFTP secrets уже созданы; существующие значения не изменены')
}

const password = randomBytes(18).toString('hex')
const keyPair = ssh2.utils.generateKeyPairSync('ed25519')
await writeFile(credentialsPath, `VLC_SFTP_USER=vlc\nVLC_SFTP_PASSWORD=${password}\n`, { mode: 0o600, flag: 'wx' })
try {
  await writeFile(hostKeyPath, keyPair.private, { mode: 0o600, flag: 'wx' })
} catch (error) {
  await unlink(credentialsPath)
  throw error
}
await chmod(credentialsPath, 0o600)
await chmod(hostKeyPath, 0o600)

console.log('VLC SFTP credentials и host key созданы в runtime/secrets/ с правами 0600')

async function exists(filePath) {
  try {
    await access(filePath)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}
