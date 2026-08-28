import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { YandexDiskAdapter } from './yandex-disk.js'

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
