import { createHash } from 'node:crypto'
import { fork } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdtemp, open, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import WebTorrent from 'webtorrent'

import { BoundedPieceStore } from './bounded-piece-store.mjs'

const MiB = 1024 * 1024
const sourceSize = Number.parseInt(process.env.POC_SOURCE_MIB ?? '256', 10) * MiB
const cacheLimit = Number.parseInt(process.env.POC_CACHE_MIB ?? '24', 10) * MiB
const pieceLength = 1 * MiB
const failAtChunk = Number.parseInt(process.env.POC_FAIL_CHUNK ?? '37', 10)
const targetDelayMs = Number.parseInt(process.env.POC_TARGET_DELAY_MS ?? '0', 10)
const downloadLimit = Number.parseInt(process.env.POC_DOWNLOAD_MIBPS ?? '24', 10) * MiB
const verbose = process.env.POC_VERBOSE === '1'

const workRoot = await mkdtemp(path.join(os.tmpdir(), 'loader-poc-'))
const sourcePath = path.join(workRoot, 'Loader.Legal.Test.2026.mkv')
const cachePath = path.join(workRoot, 'receiver-cache')

const source = await open(sourcePath, 'w', 0o600)
await source.truncate(sourceSize)
await source.close()

let expectedOffset = 0
let receivedBytes = 0
let failedOnce = false
let retries = 0
const targetHash = createHash('sha256')

const target = http.createServer((request, response) => {
  if (request.method !== 'PUT' || request.url !== '/upload') {
    response.writeHead(404).end()
    return
  }

  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(request.headers['content-range'] ?? '')
  if (!match) {
    response.writeHead(400).end('Missing Content-Range')
    return
  }

  const start = Number(match[1])
  const end = Number(match[2])
  const total = Number(match[3])
  const chunkIndex = Math.floor(start / pieceLength)
  if (start !== expectedOffset || end < start || total !== sourceSize) {
    response.writeHead(412).end('Unexpected range')
    return
  }

  const chunks = []
  let length = 0
  request.on('data', chunk => {
    chunks.push(chunk)
    length += chunk.length
  })
  request.on('end', () => {
    const body = Buffer.concat(chunks, length)
    if (body.length !== end - start + 1) {
      response.writeHead(400).end('Short body')
      return
    }
    if (chunkIndex === failAtChunk && !failedOnce) {
      failedOnce = true
      response.destroy()
      return
    }
    setTimeout(() => {
      targetHash.update(body)
      expectedOffset = end + 1
      receivedBytes += body.length
      response.writeHead(expectedOffset === total ? 201 : 202).end()
    }, targetDelayMs)
  })
})

await new Promise(resolve => target.listen(0, '127.0.0.1', resolve))
const targetAddress = target.address()
const targetUrl = `http://127.0.0.1:${targetAddress.port}/upload`

const sourceHashPromise = hashFile(sourcePath)
const baselineRss = process.memoryUsage().rss
let peakRss = baselineRss
const memorySampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
}, 25)

const receiver = createClient()
const seeder = fork(new URL('./seeder-child.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
const startedAt = performance.now()

try {
  if (verbose) console.error('poc: seeding source')
  const seededTorrent = await seedInChild(seeder, sourcePath)
  if (verbose) console.error(`poc: seed ready on ${seededTorrent.port}`)
  const torrent = await add(receiver, seededTorrent.torrentFile, {
    deselect: true,
    store: BoundedPieceStore,
    storeCacheSlots: 0,
    storeOpts: {
      cachePath,
      maxBytes: cacheLimit,
      reserveBytes: 0,
      headroomPieces: 3
    },
    strategy: 'sequential'
  })
  if (verbose) console.error(`poc: receiver ready for ${torrent.infoHash}`)
  torrent.addPeer(`127.0.0.1:${seededTorrent.port}`)

  const file = torrent.files[0]
  const store = torrent.loaderPieceStore
  if (!store) throw new Error('Bounded store was not attached')
  const progressTimer = verbose
    ? setInterval(() => {
        const stored = [...store.sizes.keys()].sort((a, b) => a - b)
        const queued = store.pending.map(item => item.index)
        console.error(`poc: cursor=${store.readCursor} cache=${store.usedBytes / MiB}MiB stored=${stored.join(',')} pending=${queued.join(',')} downloaded=${torrent.downloaded / MiB}MiB`)
      }, 5_000)
    : null

  let uploaded = 0
  try {
    for await (const chunk of file) {
      const pieceIndex = Math.floor((file.offset + uploaded) / torrent.pieceLength)
      store.setReadCursor(pieceIndex)
      await putWithRetry(targetUrl, chunk, uploaded, sourceSize)
      uploaded += chunk.byteLength
      await store.release(pieceIndex)
      if (verbose && uploaded % (16 * MiB) === 0) console.error(`poc: uploaded ${uploaded / MiB} MiB`)
    }
  } finally {
    if (progressTimer) clearInterval(progressTimer)
  }

  const durationSeconds = (performance.now() - startedAt) / 1000
  const sourceHash = await sourceHashPromise
  const uploadedHash = targetHash.digest('hex')
  if (uploaded !== sourceSize || receivedBytes !== sourceSize) throw new Error('Transferred byte count mismatch')
  if (sourceHash !== uploadedHash) throw new Error('SHA-256 mismatch')
  if (!failedOnce || retries < 1) throw new Error('Failure injection did not exercise retry')
  if (store.peakBytes > cacheLimit + (3 * pieceLength)) throw new Error('Cache hard bound exceeded')

  console.log(JSON.stringify({
    result: 'passed',
    sourceBytes: sourceSize,
    sourceSha256: sourceHash,
    cacheLimitBytes: cacheLimit,
    peakCacheBytes: store.peakBytes,
    cacheToSourceRatio: Number((store.peakBytes / sourceSize).toFixed(4)),
    baselineRssBytes: baselineRss,
    peakRssBytes: peakRss,
    rssDeltaBytes: peakRss - baselineRss,
    injectedDisconnectAtChunk: failAtChunk,
    retries,
    durationSeconds: Number(durationSeconds.toFixed(2)),
    throughputMiBps: Number((sourceSize / MiB / durationSeconds).toFixed(2))
  }, null, 2))
} finally {
  clearInterval(memorySampler)
  await destroyClient(receiver)
  await stopSeeder(seeder)
  await new Promise(resolve => target.close(resolve))
  await rm(workRoot, { recursive: true, force: true })
}

function createClient () {
  return new WebTorrent({
    dht: false,
    lsd: false,
    tracker: false,
    natUpnp: false,
    natPmp: false,
    maxConns: 4,
    downloadLimit
  })
}

function seedInChild (child, input) {
  return new Promise((resolve, reject) => {
    const onExit = code => reject(new Error(`Seeder exited before ready with code ${code}`))
    child.once('exit', onExit)
    child.once('message', message => {
      child.off('exit', onExit)
      resolve({ port: message.port, torrentFile: Buffer.from(message.torrentFile, 'base64') })
    })
    child.send({ type: 'seed', sourcePath: input, pieceLength })
  })
}

function add (client, torrentId, options) {
  return new Promise((resolve, reject) => {
    const onError = error => reject(error)
    client.once('error', onError)
    client.add(torrentId, options, torrent => {
      client.off('error', onError)
      resolve(torrent)
    })
  })
}

async function putWithRetry (url, chunk, offset, total) {
  const end = offset + chunk.byteLength - 1
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'PUT',
        signal: AbortSignal.timeout(5_000),
        headers: {
          'content-length': String(chunk.byteLength),
          'content-range': `bytes ${offset}-${end}/${total}`
        },
        body: chunk
      })
      if (response.status !== 201 && response.status !== 202) {
        throw new Error(`Upload target returned ${response.status}: ${await response.text()}`)
      }
      return
    } catch (error) {
      if (attempt === 2) throw error
      retries += 1
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)))
    }
  }
}

async function hashFile (filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

function destroyClient (client) {
  return new Promise(resolve => client.destroy(resolve))
}

function stopSeeder (child) {
  if (child.exitCode !== null || !child.connected) return Promise.resolve()
  return new Promise(resolve => {
    child.once('exit', resolve)
    child.send({ type: 'shutdown' })
  })
}
