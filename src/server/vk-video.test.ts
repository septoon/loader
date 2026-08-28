import assert from 'node:assert/strict'
import test from 'node:test'
import { getVkVideoId, resolveVkVideoSource } from './vk-video.js'

test('VK URL нормализуется и получает название, размер и progressive MP4', async () => {
  const identifier = getVkVideoId(new URL('https://vkvideo.ru/video-221995703_456240730'))
  assert.equal(identifier?.id, '-221995703_456240730')
  assert.equal(identifier?.canonicalSource, 'https://m.vk.com/video-221995703_456240730')

  let arguments_: string[] = []
  const result = await resolveVkVideoSource(identifier!.canonicalSource, {
    executablePath: '/tools/yt-dlp',
    execute: async (executablePath, nextArguments) => {
      assert.equal(executablePath, '/tools/yt-dlp')
      arguments_ = nextArguments
      return JSON.stringify({
        id: '-221995703_456240730',
        title: 'Изгой (2000) 4К',
        url: 'https://media.okcdn.ru/video.mp4?sig=secret',
        protocol: 'https',
        ext: 'mp4',
        height: 1080,
        duration: 8626,
        http_headers: { 'User-Agent': 'Loader Test', Accept: '*/*', Cookie: 'must-not-pass' },
      })
    },
    validateMediaUrl: async (value) => new URL(value),
    fetcher: async (_input, init) => {
      assert.equal((init?.headers as Record<string, string>).Range, 'bytes=0-0')
      assert.equal((init?.headers as Record<string, string>)['User-Agent'], 'Loader Test')
      assert.equal(Object.hasOwn(init?.headers as Record<string, string>, 'Cookie'), false)
      return new Response(Buffer.from([0]), {
        status: 206,
        headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-0/3758096384' },
      })
    },
  })

  assert.equal(arguments_.at(-1), identifier!.canonicalSource)
  assert.equal(result.title, 'Изгой (2000) 4К')
  assert.equal(result.resolution, '1080p')
  assert.equal(result.totalBytes, 3_758_096_384)
  assert.equal(result.requestHeaders.Cookie, undefined)
})
