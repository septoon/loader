import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readTorrentMetadata, refreshTorrentPeers } from './torrent-transfer.js'

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
    removePeer: (peer: string) => removed.push(peer),
    addPeer: (peer: string) => added.push(peer),
    discovery: {
      tracker: {
        update: (options: unknown) => updates.push(options),
      },
    },
  })

  assert.deepEqual(removed, ['peer-1', 'peer-2'])
  assert.deepEqual(added, ['peer-1', 'peer-2'])
  assert.deepEqual(updates, [{ numwant: 50 }])
  assert.doesNotThrow(() => refreshTorrentPeers({}))
})
