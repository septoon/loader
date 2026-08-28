import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PauseGate, readTorrentMetadata, refreshTorrentPeers, torrentClientOptions } from './torrent-transfer.js'

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
