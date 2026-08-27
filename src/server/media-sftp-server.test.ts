import assert from 'node:assert/strict'
import test from 'node:test'
import ssh2 from 'ssh2'
import { MediaSftpServer, normalizeSftpPath } from './media-sftp-server.js'
import type { MediaLibrary, MediaResource } from './yandex-media-library.js'

const resources: MediaResource[] = [
  { name: 'Media', path: 'disk:/Media', type: 'dir', size: 0, modifiedAt: 1 },
  { name: 'Movies', path: 'disk:/Media/Movies', type: 'dir', size: 0, modifiedAt: 2 },
  { name: 'film.mp4', path: 'disk:/Media/Movies/film.mp4', type: 'file', size: 10, modifiedAt: 3 },
]
const content = Buffer.from('0123456789')

const library: MediaLibrary = {
  async getResource(relativePath) {
    return resources.find((resource) => relativePath === '/'
      ? resource.path === 'disk:/Media'
      : resource.path === `disk:/Media${relativePath}`) ?? null
  },
  async listDirectory(relativePath) {
    if (relativePath === '/') return [resources[1]!]
    if (relativePath === '/Movies') return [resources[2]!]
    return []
  },
  async readRange(_relativePath, offset, length) {
    return content.subarray(offset, offset + length)
  },
}

test('SFTP path не выходит из виртуального /Media', () => {
  assert.equal(normalizeSftpPath('/Movies/../secret'), null)
  assert.equal(normalizeSftpPath('../../secret'), null)
  assert.equal(normalizeSftpPath('Movies/film.mp4'), '/Movies/film.mp4')
  assert.equal(normalizeSftpPath('/Movies/'), '/Movies')
})

test('read-only SFTP перечисляет папки и читает диапазон файла', async () => {
  const keyPair = ssh2.utils.generateKeyPairSync('ed25519')
  const server = new MediaSftpServer({
    hostKey: Buffer.from(keyPair.private),
    username: 'vlc',
    password: 'a'.repeat(32),
    library,
  })
  const listener = await server.listen('127.0.0.1', 0)
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('SFTP test server did not start')
  const client = new ssh2.Client()

  try {
    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve).once('error', reject).connect({
        host: '127.0.0.1',
        port: address.port,
        username: 'vlc',
        password: 'a'.repeat(32),
        hostVerifier: () => true,
      })
    })
    const clientSftp = await new Promise<import('ssh2').SFTPWrapper>((resolve, reject) => {
      client.sftp((error, value) => error ? reject(error) : resolve(value))
    })
    const root = await new Promise<import('ssh2').FileEntryWithStats[]>((resolve, reject) => {
      clientSftp.readdir('/', (error, value) => error ? reject(error) : resolve(value))
    })
    assert.deepEqual(root.map((entry) => entry.filename), ['Movies'])

    const handle = await new Promise<Buffer>((resolve, reject) => {
      clientSftp.open('/Movies/film.mp4', 'r', (error, value) => error ? reject(error) : resolve(value))
    })
    const data = Buffer.alloc(4)
    const bytesRead = await new Promise<number>((resolve, reject) => {
      clientSftp.read(handle, data, 0, data.length, 3, (error, count) => error ? reject(error) : resolve(count))
    })
    assert.equal(bytesRead, 4)
    assert.equal(data.toString(), '3456')
    await new Promise<void>((resolve, reject) => clientSftp.close(handle, (error) => error ? reject(error) : resolve()))
    await assert.rejects(new Promise<Buffer>((resolve, reject) => {
      clientSftp.open('/Movies/film.mp4', 'w', (error, value) => error ? reject(error) : resolve(value))
    }), /Permission denied/u)
  } finally {
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()))
    client.end()
    await closed
    await server.close()
  }
})
