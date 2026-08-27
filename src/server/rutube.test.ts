import assert from 'node:assert/strict'
import test from 'node:test'
import { getRutubeVideoId, resolveRutubeSource, RutubeSourceError } from './rutube.js'

test('Rutube resolver выбирает максимум 720p и последовательные TS-сегменты', async () => {
  const source = 'https://rutube.ru/video/16ce30f9d9cf9473aba6334eae7a9fa3/?r=wd'
  const responses = new Map<string, Response>([
    ['https://rutube.ru/api/play/options/16ce30f9d9cf9473aba6334eae7a9fa3/?format=json', jsonResponse({
      title: 'Мастер игры, 2 сезон, 7 выпуск',
      video_balancer: { m3u8: 'https://bl.rutube.ru/master.m3u8' },
    })],
    ['https://bl.rutube.ru/master.m3u8', textResponse(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1379000,RESOLUTION=1280x720
https://river-1.rutube.ru/720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3590000,RESOLUTION=1920x1080
https://river-1.rutube.ru/1080.m3u8
`)],
    ['https://river-1.rutube.ru/720.m3u8', textResponse(`#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4,
segment-1.ts
#EXTINF:3.5,
segment-2.ts
#EXT-X-ENDLIST
`)],
  ])
  const fetcher = async (input: string | URL | Request) => {
    const key = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const response = responses.get(key)
    if (!response) throw new Error(`Unexpected URL: ${key}`)
    return response.clone()
  }
  const result = await resolveRutubeSource(source, fetcher as typeof fetch, async (value) => new URL(value))

  assert.equal(getRutubeVideoId(new URL(source)), '16ce30f9d9cf9473aba6334eae7a9fa3')
  assert.equal(result.title, 'Мастер игры, 2 сезон, 7 выпуск')
  assert.equal(result.resolution, '1280x720')
  assert.equal(result.durationSeconds, 7.5)
  assert.deepEqual(result.segments.map((segment) => segment.url), [
    'https://river-1.rutube.ru/segment-1.ts',
    'https://river-1.rutube.ru/segment-2.ts',
  ])
})

test('Rutube resolver отклоняет зашифрованный HLS', async () => {
  const source = 'https://rutube.ru/video/16ce30f9d9cf9473aba6334eae7a9fa3/'
  const fetcher = async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/api/play/options/')) return jsonResponse({
      title: 'Видео', video_balancer: { m3u8: 'https://bl.rutube.ru/master.m3u8' },
    })
    if (url.endsWith('/master.m3u8')) return textResponse(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=825000,RESOLUTION=640x360
https://river-1.rutube.ru/media.m3u8
`)
    return textResponse(`#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:4,
segment.ts
#EXT-X-ENDLIST
`)
  }
  await assert.rejects(
    () => resolveRutubeSource(source, fetcher as typeof fetch, async (value) => new URL(value)),
    RutubeSourceError,
  )
})

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function textResponse(value: string): Response {
  return new Response(value, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } })
}
