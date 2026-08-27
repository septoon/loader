import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import type { RutubeSegment } from './rutube.js'
import { hashSegments, readSegments } from './rutube-transfer.js'

test('Rutube transfer хеширует и продолжает объединённый TS-поток с точного offset', async () => {
  const chunks = [Buffer.from('segment-one'), Buffer.from('segment-two')]
  const server = createServer((request, response) => {
    const index = Number(request.url?.slice(1))
    const value = chunks[index]
    if (!value) return response.writeHead(404).end()
    const range = /^bytes=(\d+)-$/u.exec(String(request.headers.range ?? ''))
    if (range) {
      const start = Number(range[1])
      response.writeHead(206, {
        'Content-Length': value.byteLength - start,
        'Content-Range': `bytes ${start}-${value.byteLength - 1}/${value.byteLength}`,
      })
      return response.end(value.subarray(start))
    }
    response.writeHead(200, { 'Content-Length': value.byteLength })
    response.end(value)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not start')
  const segments: RutubeSegment[] = chunks.map((_chunk, index) => ({
    url: `http://127.0.0.1:${address.port}/${index}`,
    duration: 4,
  }))

  try {
    const hashed = await hashSegments(segments, 'https://rutube.ru/video/test/', new AbortController().signal, () => undefined)
    assert.equal(hashed.size, Buffer.concat(chunks).byteLength)
    assert.deepEqual(hashed.segmentSizes, chunks.map((chunk) => chunk.byteLength))
    assert.match(hashed.md5, /^[a-f0-9]{32}$/u)
    assert.match(hashed.sha256, /^[a-f0-9]{64}$/u)

    const start = chunks[0]!.byteLength + 3
    const output: Buffer[] = []
    for await (const chunk of readSegments(
      segments, hashed.segmentSizes, 'https://rutube.ru/video/test/', start,
      new AbortController().signal, () => undefined,
    )) output.push(chunk)
    assert.deepEqual(Buffer.concat(output), Buffer.concat(chunks).subarray(start))
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
