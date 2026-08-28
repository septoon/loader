import { performance } from 'node:perf_hooks'
import { Readable } from 'node:stream'
import type { TransferBottleneck } from '../shared/types.js'

export const uploadChunkBytes = 8 * 1024 * 1024
const uploadWriteBytes = 256 * 1024

export interface UploadBodyMetrics {
  bodyFeedMs: number
  writeBlockedMs: number
  maxWriteBlockedMs: number
  writeCount: number
}

export async function readExactBuffer(
  source: AsyncIterable<Buffer>,
  length: number,
  onBufferedBytes?: (bytes: number) => void,
): Promise<Buffer> {
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error('Некорректная длина буфера передачи')
  const buffer = Buffer.allocUnsafe(length)
  let written = 0
  for await (const chunk of source) {
    const copied = Math.min(chunk.byteLength, length - written)
    chunk.copy(buffer, written, 0, copied)
    written += copied
    onBufferedBytes?.(written)
    if (written === length) return buffer
  }
  throw new Error(`Источник завершился раньше диапазона: осталось ${length - written} байт`)
}

export function createMeasuredUploadBody(
  buffer: Buffer,
  onBufferedBytes?: (bytes: number) => void,
): { body: Readable, metrics: UploadBodyMetrics } {
  const metrics: UploadBodyMetrics = { bodyFeedMs: 0, writeBlockedMs: 0, maxWriteBlockedMs: 0, writeCount: 0 }
  const started = performance.now()
  async function * chunks(): AsyncGenerator<Buffer> {
    for (let offset = 0; offset < buffer.byteLength; offset += uploadWriteBytes) {
      const nextOffset = Math.min(buffer.byteLength, offset + uploadWriteBytes)
      const beforeWrite = performance.now()
      yield buffer.subarray(offset, nextOffset)
      const blockedMs = performance.now() - beforeWrite
      metrics.writeBlockedMs += blockedMs
      metrics.maxWriteBlockedMs = Math.max(metrics.maxWriteBlockedMs, blockedMs)
      metrics.writeCount += 1
      onBufferedBytes?.(buffer.byteLength - nextOffset)
    }
    metrics.bodyFeedMs = performance.now() - started
  }
  return {
    body: Readable.from(chunks(), { objectMode: false, highWaterMark: uploadWriteBytes }),
    metrics,
  }
}

export function bytesPerSecond(bytes: number, milliseconds: number): number {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 0
  return Math.max(0, Math.round(bytes / (milliseconds / 1_000)))
}

export function detectBottleneck(sourceSpeed: number, yandexUploadSpeed: number): TransferBottleneck | null {
  if (sourceSpeed <= 0 || yandexUploadSpeed <= 0) return null
  if (sourceSpeed < yandexUploadSpeed * 0.8) return 'source'
  if (yandexUploadSpeed < sourceSpeed * 0.8) return 'yandex'
  return 'balanced'
}
