import assert from 'node:assert/strict'
import test from 'node:test'
import { YandexMediaLibrary } from './yandex-media-library.js'

test('медиатека кеширует download URL и читает только разрешённый range', async () => {
  const originalFetch = globalThis.fetch
  let downloadRequests = 0
  const ranges: string[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.hostname === 'cloud-api.yandex.net' && url.pathname.endsWith('/resources/download')) {
      downloadRequests += 1
      return Response.json({ href: 'https://downloader.disk.yandex.ru/disk/private' })
    }
    if (url.hostname === 'downloader.disk.yandex.ru') {
      ranges.push(String(new Headers(init?.headers).get('range')))
      return new Response(null, { status: 302, headers: { Location: 'https://s1.storage.yandex.net/rdisk/private' } })
    }
    if (url.hostname === 's1.storage.yandex.net') {
      ranges.push(String(new Headers(init?.headers).get('range')))
      return new Response(Buffer.from('abcd'), { status: 206 })
    }
    throw new Error(`unexpected URL ${url.href}`)
  }) as typeof fetch

  try {
    const library = new YandexMediaLibrary('x'.repeat(32))
    assert.equal((await library.readRange('/Movies/film.mp4', 10, 4)).toString(), 'abcd')
    assert.equal((await library.readRange('/Movies/film.mp4', 20, 4)).toString(), 'abcd')
    assert.equal(downloadRequests, 1)
    assert.deepEqual(ranges, ['bytes=10-13', 'bytes=10-13', 'bytes=20-23'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('медиатека отклоняет внешний download URL и traversal', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ href: 'https://example.com/private' })) as typeof fetch
  try {
    const library = new YandexMediaLibrary('x'.repeat(32))
    await assert.rejects(() => library.readRange('/Movies/file', 0, 4), /недопустимую ссылку/u)
    await assert.rejects(() => library.getResource('/../secret'), /Недопустимый путь/u)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('медиатека запрашивает тип каталога вместе с пагинацией', async () => {
  const originalFetch = globalThis.fetch
  let fields = ''
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    fields = url.searchParams.get('fields') || ''
    return Response.json({
      type: 'dir',
      path: 'disk:/Media',
      _embedded: {
        items: [{ name: 'Movies', path: 'disk:/Media/Movies', type: 'dir', modified: '2026-01-01T00:00:00Z' }],
        limit: 1_000,
        offset: 0,
        total: 1,
      },
    })
  }) as typeof fetch
  try {
    const resources = await new YandexMediaLibrary('x'.repeat(32)).listDirectory('/')
    assert.deepEqual(resources.map((resource) => resource.name), ['Movies'])
    assert.match(fields, /(^|,)type(,|$)/u)
  } finally {
    globalThis.fetch = originalFetch
  }
})
