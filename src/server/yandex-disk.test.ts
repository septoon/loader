import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { YandexDiskAdapter, YandexUploadSessionExpiredError } from './yandex-disk.js'

test('Yandex uploader отправляет промежуточный Content-Range, а не остаток файла', async () => {
  const originalFetch = globalThis.fetch
  let headers = new Headers()
  let uploaded = Buffer.alloc(0)
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    headers = new Headers(init?.headers)
    const chunks: Buffer[] = []
    for await (const chunk of init?.body as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
    uploaded = Buffer.concat(chunks)
    return new Response(null, { status: 202 })
  }) as typeof fetch
  try {
    await new YandexDiskAdapter('x'.repeat(32)).uploadRange(
      'https://uploader.disk.yandex.net/upload/id', 8, 100, Readable.from(Buffer.alloc(16)),
      new AbortController().signal, 10_000, 16,
    )
    assert.equal(headers.get('content-length'), '16')
    assert.equal(headers.get('content-range'), 'bytes 8-23/100')
    assert.equal(uploaded.byteLength, 16)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Yandex upload offset восстанавливается без заранее известных хешей файла', async () => {
  const originalFetch = globalThis.fetch
  const seenHeaders: Headers[] = []
  let calls = 0
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls += 1
    seenHeaders.push(new Headers(init?.headers))
    return new Response(null, { status: 200, headers: { 'Content-Length': '3145728' } })
  }) as typeof fetch
  try {
    const offset = await new YandexDiskAdapter('x'.repeat(32)).getStableUploadOffset(
      'https://uploader.disk.yandex.net/upload/id', 10_000_000, 0,
    )
    assert.equal(offset, 3_145_728)
    assert.equal(calls, 4)
    assert.ok(seenHeaders.every((headers) => headers.get('size') === '10000000'))
    assert.ok(seenHeaders.every((headers) => !headers.has('etag') && !headers.has('sha256')))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('истёкшая Yandex upload session отличается от временной сетевой ошибки', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch
  try {
    await assert.rejects(
      new YandexDiskAdapter('x'.repeat(32)).getStableUploadOffset(
        'https://uploader.disk.yandex.net/upload/id', 10_000_000, 0,
      ),
      YandexUploadSessionExpiredError,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
