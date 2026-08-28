import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { registerMediaWebDav } from './media-webdav.js'
import type { MediaResource, YandexMediaLibrary } from './yandex-media-library.js'

const root: MediaResource = { name: 'Media', path: 'disk:/Media', type: 'dir', size: 0, modifiedAt: 1 }
const movie: MediaResource = { name: 'Фильм.mp4', path: 'disk:/Media/Фильм.mp4', type: 'file', size: 10, modifiedAt: 2 }

test('WebDAV показывает /Media и отдаёт VLC диапазон с Basic auth', async () => {
  const library = {
    async getResource(path: string) {
      if (path === '/') return root
      if (path === '/Фильм.mp4') return movie
      return null
    },
    async listDirectory() { return [movie] },
    async openRead(_path: string, start: number, end: number) {
      const data = Buffer.from('0123456789').subarray(start, end + 1)
      return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data); controller.close() } })
    },
  } as unknown as YandexMediaLibrary
  const app = Fastify()
  registerMediaWebDav(app, library, { username: 'vlc', password: 'a'.repeat(32) })
  const authorization = `Basic ${Buffer.from(`vlc:${'a'.repeat(32)}`).toString('base64')}`

  try {
    const unauthorized = await app.inject({ method: 'PROPFIND', url: '/vlc/' })
    assert.equal(unauthorized.statusCode, 401)
    assert.match(String(unauthorized.headers['www-authenticate']), /Basic/u)

    const listing = await app.inject({ method: 'PROPFIND', url: '/vlc/', headers: { authorization, depth: '1' } })
    assert.equal(listing.statusCode, 207)
    assert.match(listing.body, /Фильм\.mp4/u)
    assert.match(listing.body, /\/vlc\/%D0%A4/u)

    const playlist = await app.inject({ method: 'GET', url: '/vlc/', headers: { authorization, host: 'loader.test' } })
    assert.equal(playlist.statusCode, 200)
    assert.match(String(playlist.headers['content-type']), /application\/xspf\+xml/u)
    assert.match(playlist.body, /<title>Фильм\.mp4<\/title>/u)
    assert.match(playlist.body, /https?:\/\/loader\.test\/vlc\/%D0%A4/u)

    const playlistHead = await app.inject({ method: 'HEAD', url: '/vlc/', headers: { authorization } })
    assert.equal(playlistHead.statusCode, 200)
    assert.equal(playlistHead.body, '')

    const range = await app.inject({
      method: 'GET',
      url: `/vlc/${encodeURIComponent(movie.name)}`,
      headers: { authorization, range: 'bytes=3-6' },
    })
    assert.equal(range.statusCode, 206)
    assert.equal(range.headers['content-range'], 'bytes 3-6/10')
    assert.equal(range.body, '3456')

    const write = await app.inject({ method: 'PUT', url: '/vlc/new.mp4', headers: { authorization } })
    assert.equal(write.statusCode, 404)
  } finally {
    await app.close()
  }
})
