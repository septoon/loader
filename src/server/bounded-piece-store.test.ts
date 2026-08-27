import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { BoundedPieceStore } from './bounded-piece-store.js'

test('bounded cache keeps the active read window selected when full', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'loader-piece-store-'))
  const deselections: Array<[number, number]> = []
  const selections: Array<[number, number]> = []
  const torrent = {
    pieces: Array.from({ length: 20 }),
    bitfield: { get: () => false },
    _deselect: (start: number, end: number) => deselections.push([start, end]),
    _select: (start: number, end: number) => selections.push([start, end]),
  }
  const store = new BoundedPieceStore(8, {
    cachePath: root,
    maxBytes: 16,
    reserveBytes: 0,
    headroomPieces: 1,
    maxPendingPieces: 8,
    torrent,
  })

  try {
    await store.ready
    await put(store, 5)
    await put(store, 6)
    await put(store, 7)

    assert.deepEqual(deselections.at(-1), [0, 19])
    assert.deepEqual(selections.at(-1), [0, 1])

    store.setReadCursor(1)
    assert.deepEqual(selections.at(-1), [1, 2])

    await put(store, 1)
    const value = await get(store, 1)
    assert.deepEqual(value, Buffer.alloc(8, 1))
  } finally {
    await new Promise<void>((resolve) => store.destroy(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

function put(store: BoundedPieceStore, index: number): Promise<void> {
  return new Promise((resolve, reject) => {
    store.put(index, Buffer.alloc(8, index), (error) => error ? reject(error) : resolve())
  })
}

function get(store: BoundedPieceStore, index: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    store.get(index, {}, (error, buffer) => {
      if (error || !buffer) reject(error ?? new Error('Часть не прочитана'))
      else resolve(buffer)
    })
  })
}
