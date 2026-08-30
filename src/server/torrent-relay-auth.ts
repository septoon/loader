import { createHmac, timingSafeEqual } from 'node:crypto'
import type { AppConfig } from './config.js'

const relayUsername = 'loader-torrent'

export function buildTorrentRelayUrl(
  config: Pick<AppConfig, 'publicUrl' | 'sessionSecret'>,
  jobId: string,
  fileIndex: number,
): string {
  const url = new URL(`/torrent-import/${encodeURIComponent(jobId)}/${fileIndex}`, config.publicUrl)
  url.username = relayUsername
  url.password = torrentRelayPassword(config.sessionSecret, jobId, fileIndex)
  return url.href
}

export function torrentRelayAuthorization(
  config: Pick<AppConfig, 'sessionSecret'>,
  jobId: string,
  fileIndex: number,
): string {
  const credentials = `${relayUsername}:${torrentRelayPassword(config.sessionSecret, jobId, fileIndex)}`
  return `Basic ${Buffer.from(credentials).toString('base64')}`
}

export function authorizeTorrentRelay(
  authorization: string | undefined,
  secret: string,
  jobId: string,
  fileIndex: number,
): boolean {
  if (!authorization?.startsWith('Basic ')) return false
  let decoded: string
  try {
    decoded = Buffer.from(authorization.slice('Basic '.length), 'base64').toString('utf8')
  } catch {
    return false
  }
  const separator = decoded.indexOf(':')
  if (separator < 0 || decoded.slice(0, separator) !== relayUsername) return false
  return safeEqual(decoded.slice(separator + 1), torrentRelayPassword(secret, jobId, fileIndex))
}

function torrentRelayPassword(secret: string, jobId: string, fileIndex: number): string {
  return createHmac('sha256', secret).update(`torrent:${jobId}:${fileIndex}`).digest('base64url')
}

function safeEqual(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate)
  const expectedBytes = Buffer.from(expected)
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes)
}
