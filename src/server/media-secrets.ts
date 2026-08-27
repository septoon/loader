import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

export interface MediaCredentials {
  username: string
  password: string
}

export function loadMediaCredentials(root = process.cwd()): MediaCredentials {
  const credentialsPath = path.resolve(root, 'runtime/secrets/vlc-sftp.env')
  assertPrivateFile(credentialsPath)
  const entries = new Map(readFileSync(credentialsPath, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => {
    const separator = line.indexOf('=')
    if (separator < 1) throw new Error('Неверный формат vlc-sftp.env')
    return [line.slice(0, separator), line.slice(separator + 1)]
  }))
  const username = entries.get('VLC_SFTP_USER')?.trim() || ''
  const password = entries.get('VLC_SFTP_PASSWORD')?.trim() || ''
  if (!/^[a-z][a-z0-9_-]{2,31}$/u.test(username) || password.length < 24 || /\s/u.test(password)) {
    throw new Error('Неверные учётные данные VLC')
  }
  return { username, password }
}

export function loadMediaCredentialsOrNull(root = process.cwd()): MediaCredentials | null {
  try {
    return loadMediaCredentials(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function loadMediaHostKey(root = process.cwd()): Buffer {
  const hostKeyPath = path.resolve(root, 'runtime/secrets/vlc-sftp-host-key')
  assertPrivateFile(hostKeyPath)
  return readFileSync(hostKeyPath)
}

function assertPrivateFile(filePath: string): void {
  const info = statSync(filePath)
  if (!info.isFile() || (info.mode & 0o077) !== 0) {
    throw new Error(`${path.basename(filePath)} должен быть обычным файлом с правами 0600`)
  }
}
