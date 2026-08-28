import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeSource, InputError, sanitizePublicError, selectTorrentFiles } from './security.js'

test('прямой публичный URL нормализуется без утечки query в UI', async () => {
  const result = await analyzeSource('https://1.1.1.1/video/film.mp4?token=secret', 'movies')
  assert.equal(result.sourceKind, 'direct-url')
  assert.equal(result.title, 'film.mp4')
  assert.equal(result.sourceLabel, '1.1.1.1/video/film.mp4')
  assert.equal(result.destinationPath, '/Media/Movies/film.mp4')
  assert.equal(result.supported, true)
})

test('SSRF-проверка отклоняет локальные IPv4 и IPv6', async () => {
  await assert.rejects(() => analyzeSource('http://127.0.0.1/file.mp4', 'auto'), InputError)
  await assert.rejects(() => analyzeSource('http://[::1]/file.mp4', 'auto'), InputError)
  await assert.rejects(() => analyzeSource('http://[::ffff:127.0.0.1]/file.mp4', 'auto'), InputError)
})

test('URL со встроенными учётными данными отклоняется', async () => {
  await assert.rejects(() => analyzeSource('https://user:password@1.1.1.1/file.mp4', 'tv'), /учётными данными/)
})

test('страница VK получает настоящее название и не отправляется в Яндекс как HTML', async () => {
  const result = await analyzeSource(
    'https://vkvideo.ru/video-221995703_456240730',
    'auto',
    async () => ({
      ownerId: '-221995703', videoId: '456240730', id: '-221995703_456240730',
      canonicalSource: 'https://m.vk.com/video-221995703_456240730', title: 'Изгой (2000) 4К',
      durationSeconds: 8626, resolution: '1080p', totalBytes: 3_758_096_384,
      mediaUrl: 'https://media.okcdn.ru/video.mp4', requestHeaders: { 'User-Agent': 'Loader Test' },
    }),
    async () => undefined,
  )
  assert.equal(result.sourceKind, 'vkvideo')
  assert.equal(result.title, 'Изгой (2000) 4К.mp4')
  assert.equal(result.destinationPath, '/Media/Movies/Изгой (2000) 4К.mp4')
  assert.equal(result.totalBytes, 3_758_096_384)
})

test('корректная магнет-ссылка готова к постановке в очередь без раскрытия трекеров', async () => {
  const result = await analyzeSource(`magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=Сериал&tr=https://secret.example/passkey`, 'tv')
  assert.equal(result.title, 'Сериал')
  assert.equal(result.supported, true)
  assert.equal(result.destinationPath, '/Media/TV/Сериал')
  assert.equal(result.sourceLabel.includes('secret.example'), false)
})

test('состав торрента сохраняет безопасные подпапки и отбрасывает sample', () => {
  const result = selectTorrentFiles('auto', 'Сериал S01', [
    { index: 0, name: 'S01E01.mkv', path: 'Сериал S01/Season 1/S01E01.mkv', length: 1_000_000 },
    { index: 1, name: 'S01E01.srt', path: 'Сериал S01/Season 1/S01E01.srt', length: 5_000 },
    { index: 2, name: 'sample.mkv', path: 'Сериал S01/sample.mkv', length: 20_000 },
  ])
  assert.equal(result.destination, 'tv')
  assert.equal(result.files.length, 2)
  assert.equal(result.files[0]?.destinationPath, '/Media/TV/Сериал S01/Season 1/S01E01.mkv')
})

test('публичная ошибка скрывает URL и OAuth значение', () => {
  const result = sanitizePublicError(new Error('failed https://example.test/path?token=1 OAuth very-secret'))
  assert.equal(result.includes('token=1'), false)
  assert.equal(result.includes('very-secret'), false)
})
