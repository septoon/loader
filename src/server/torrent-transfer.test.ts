import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  commitTorrentHashBuffer, createResumableTorrentHash, PauseGate, readTorrentMetadata,
  refreshTorrentPeers, torrentClientOptions,
} from './torrent-transfer.js'

test('torrent worker disables crash-prone native uTP transport', () => {
  assert.equal(torrentClientOptions.utp, false)
})

test('hash pause gate resumes in memory and aborts without losing control', async () => {
  const gate = new PauseGate()
  const controller = new AbortController()
  gate.pause()
  let resumed = false
  const waiting = gate.wait(controller.signal).then(() => { resumed = true })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(resumed, false)
  gate.resume()
  await waiting
  assert.equal(resumed, true)

  gate.pause()
  const aborted = gate.wait(controller.signal)
  controller.abort(new Error('stop'))
  await assert.rejects(aborted, /stop/)
})

test('torrent hash checkpoint resumes MD5 and SHA-256 across a new process state', async () => {
  const content = Buffer.from('durable torrent hash checkpoint '.repeat(4096))
  const split = Math.floor(content.byteLength * 0.43)
  const first = await createResumableTorrentHash(content.byteLength, null)
  first.update(content.subarray(0, split))
  const checkpoint = first.checkpoint()

  const resumed = await createResumableTorrentHash(content.byteLength, checkpoint)
  assert.equal(resumed.restored, true)
  assert.equal(resumed.offset, split)
  resumed.update(content.subarray(split))

  assert.deepEqual(resumed.digest(), {
    md5: createHash('md5').update(content).digest('hex'),
    sha256: createHash('sha256').update(content).digest('hex'),
  })
})

test('повреждённая или чужая torrent hash checkpoint безопасно начинает проверку заново', async () => {
  const malformed = await createResumableTorrentHash(1024, '{"version":1,"offset":512}')
  assert.equal(malformed.restored, false)
  assert.equal(malformed.discardedCheckpoint, true)
  assert.equal(malformed.offset, 0)

  const original = await createResumableTorrentHash(1024, null)
  original.update(Buffer.alloc(512, 1))
  const wrongSize = await createResumableTorrentHash(2048, original.checkpoint())
  assert.equal(wrongSize.restored, false)
  assert.equal(wrongSize.discardedCheckpoint, true)
  assert.equal(wrongSize.offset, 0)
})

test('torrent hash продвигается только до подтверждённого Яндексом offset', async () => {
  const content = Buffer.from('abcdefgh')
  const hash = await createResumableTorrentHash(content.byteLength, null)
  commitTorrentHashBuffer(hash, 0, 3, content)
  assert.equal(hash.offset, 3)

  const resumed = await createResumableTorrentHash(content.byteLength, hash.checkpoint())
  commitTorrentHashBuffer(resumed, 3, content.byteLength, content.subarray(3))
  assert.deepEqual(resumed.digest(), {
    md5: createHash('md5').update(content).digest('hex'),
    sha256: createHash('sha256').update(content).digest('hex'),
  })
  assert.throws(() => commitTorrentHashBuffer(resumed, 0, 1, content), /не совпадает/u)
})

test('torrent metadata восстанавливается через shared runtime после смены release', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'loader-release-'))
  const shared = path.join(root, 'shared', 'torrents')
  const currentRuntime = path.join(root, 'releases', 'new', 'runtime')
  const jobId = '0b4fb2ec-653b-41e5-9b91-a2ec9f7a34b7'
  const expected = Buffer.from('torrent metadata')

  try {
    await mkdir(path.dirname(currentRuntime), { recursive: true })
    await mkdir(shared, { recursive: true })
    await symlink(path.join(root, 'shared'), currentRuntime)
    await writeFile(path.join(shared, `${jobId}.torrent`), expected)

    const actual = await readTorrentMetadata(jobId, path.join(currentRuntime, 'torrents'))
    assert.deepEqual(actual, expected)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('при ожидании данных повторный поиск пиров обновляет tracker announce', () => {
  const updates: unknown[] = []
  const removed: string[] = []
  const added: string[] = []
  refreshTorrentPeers({
    loaderDiscoveredPeers: new Set(['peer-1', 'peer-2']),
    loaderConnectedPeers: new Set(['peer-2']),
    removePeer: (peer: string) => removed.push(peer),
    addPeer: (peer: string) => added.push(peer),
    discovery: {
      tracker: {
        update: (options: unknown) => updates.push(options),
      },
    },
  })

  assert.deepEqual(removed, ['peer-2', 'peer-1'])
  assert.deepEqual(added, ['peer-2', 'peer-1'])
  assert.deepEqual(updates, [{ numwant: 50 }])
  assert.doesNotThrow(() => refreshTorrentPeers({}))
})
