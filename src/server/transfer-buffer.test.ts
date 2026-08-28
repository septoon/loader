import assert from 'node:assert/strict'
import test from 'node:test'
import { createMeasuredUploadBody, detectBottleneck, readExactBuffer } from './transfer-buffer.js'

test('bounded transfer buffer читает ровно заданный диапазон', async () => {
  async function * source() {
    yield Buffer.from('abcd')
    yield Buffer.from('efgh')
  }
  assert.equal((await readExactBuffer(source(), 6)).toString(), 'abcdef')
  await assert.rejects(() => readExactBuffer(source(), 10), /раньше диапазона/u)
})

test('upload body отдаёт bounded buffer блоками и собирает wait-метрики', async () => {
  const input = Buffer.alloc(600 * 1024, 0x5a)
  const buffered: number[] = []
  const measured = createMeasuredUploadBody(input, (bytes) => buffered.push(bytes))
  const chunks: Buffer[] = []
  for await (const chunk of measured.body) chunks.push(Buffer.from(chunk))
  assert.deepEqual(Buffer.concat(chunks), input)
  assert.equal(measured.metrics.writeCount, 3)
  assert.equal(buffered.at(-1), 0)
  assert.ok(measured.metrics.bodyFeedMs >= 0)
})

test('bottleneck определяется только по раздельным достоверным скоростям', () => {
  assert.equal(detectBottleneck(40_000_000, 128_000), 'yandex')
  assert.equal(detectBottleneck(100_000, 1_000_000), 'source')
  assert.equal(detectBottleneck(1_000_000, 900_000), 'balanced')
  assert.equal(detectBottleneck(0, 900_000), null)
})
