import { timingSafeEqual } from 'node:crypto'
import type { Server as NetServer } from 'node:net'
import path from 'node:path'
import ssh2, { type Attributes, type FileEntry, type Server as SshServer, type SFTPWrapper } from 'ssh2'
import type { MediaLibrary, MediaResource } from './yandex-media-library.js'

const { Server, utils: { sftp: { OPEN_MODE, STATUS_CODE } } } = ssh2
const deniedOpenFlags = OPEN_MODE.WRITE | OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.TRUNC | OPEN_MODE.EXCL
const directoryBatchSize = 100
const maxConcurrentReads = 16
const maxReadLength = 256 * 1024

interface DirectoryHandle {
  type: 'directory'
  path: string
  entries: FileEntry[] | null
  offset: number
}

interface FileHandle {
  type: 'file'
  path: string
  resource: MediaResource
}

type OpenHandle = DirectoryHandle | FileHandle

export interface MediaSftpOptions {
  hostKey: Buffer
  username: string
  password: string
  library: MediaLibrary
  maxConnections?: number
  onError?: (message: string) => void
}

export class MediaSftpServer {
  private readonly server: SshServer
  private activeConnections = 0

  constructor(private readonly options: MediaSftpOptions) {
    const allowedUser = Buffer.from(options.username)
    const allowedPassword = Buffer.from(options.password)
    this.server = new Server({
      hostKeys: [options.hostKey],
      ident: 'Loader-Media',
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
    }, (client) => {
      this.activeConnections += 1
      if (this.activeConnections > (options.maxConnections ?? 8)) {
        client.end()
        return
      }
      let authenticated = false
      client.on('authentication', (context) => {
        if (context.method !== 'password') return context.reject(['password'])
        if (safeEqual(Buffer.from(context.username), allowedUser)
          && safeEqual(Buffer.from(context.password), allowedPassword)) {
          authenticated = true
          context.accept()
        } else {
          context.reject(['password'])
        }
      }).on('ready', () => {
        if (!authenticated) return client.end()
        client.on('session', (accept) => {
          const session = accept()
          session.on('sftp', (acceptSftp) => this.attachSftp(acceptSftp()))
          session.on('shell', (_accept, reject) => reject())
          session.on('exec', (_accept, reject) => reject())
        })
      }).on('error', (error) => {
        options.onError?.(`SSH: ${error.message}`)
      }).on('close', () => {
        this.activeConnections = Math.max(0, this.activeConnections - 1)
      })
    })
    this.server.on('error', (error: Error) => options.onError?.(`SFTP server: ${error.message}`))
  }

  async listen(host: string, port: number): Promise<NetServer> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      this.server.once('error', onError)
      this.server.listen(port, host, () => {
        this.server.off('error', onError)
        resolve()
      })
    })
    return this.server
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve())
    })
  }

  private attachSftp(stream: SFTPWrapper): void {
    const handles = new Map<number, OpenHandle>()
    let nextHandle = 1
    let pendingReads = 0
    const createHandle = (value: OpenHandle): Buffer => {
      const id = nextHandle++
      handles.set(id, value)
      const handle = Buffer.alloc(4)
      handle.writeUInt32BE(id)
      return handle
    }
    const getHandle = (handle: Buffer): OpenHandle | null => {
      if (handle.length !== 4) return null
      return handles.get(handle.readUInt32BE(0)) ?? null
    }
    const fail = (requestId: number, error: unknown): void => {
      this.options.onError?.(`SFTP operation: ${error instanceof Error ? error.message : 'unknown error'}`)
      stream.status(requestId, STATUS_CODE.FAILURE)
    }

    stream.on('REALPATH', (requestId, input) => {
      const normalized = normalizeSftpPath(input)
      if (!normalized) return stream.status(requestId, STATUS_CODE.NO_SUCH_FILE)
      stream.name(requestId, [{ filename: normalized, longname: normalized, attrs: directoryAttributes() }])
    })
    stream.on('STAT', (requestId, input) => void this.respondStat(stream, requestId, input))
    stream.on('LSTAT', (requestId, input) => void this.respondStat(stream, requestId, input))
    stream.on('OPENDIR', (requestId, input) => {
      const normalized = normalizeSftpPath(input)
      if (!normalized) return stream.status(requestId, STATUS_CODE.NO_SUCH_FILE)
      void this.options.library.getResource(normalized).then((resource) => {
        if (!resource || resource.type !== 'dir') return stream.status(requestId, STATUS_CODE.NO_SUCH_FILE)
        stream.handle(requestId, createHandle({ type: 'directory', path: normalized, entries: null, offset: 0 }))
      }).catch((error) => fail(requestId, error))
    })
    stream.on('READDIR', (requestId, rawHandle) => {
      const handle = getHandle(rawHandle)
      if (!handle || handle.type !== 'directory') return stream.status(requestId, STATUS_CODE.FAILURE)
      const respond = (entries: FileEntry[]): void => {
        if (handle.offset >= entries.length) return stream.status(requestId, STATUS_CODE.EOF)
        const batch = entries.slice(handle.offset, handle.offset + directoryBatchSize)
        handle.offset += batch.length
        stream.name(requestId, batch)
      }
      if (handle.entries) return respond(handle.entries)
      void this.options.library.listDirectory(handle.path).then((resources) => {
        handle.entries = resources.map(toFileEntry)
        respond(handle.entries)
      }).catch((error) => fail(requestId, error))
    })
    stream.on('OPEN', (requestId, input, flags) => {
      const normalized = normalizeSftpPath(input)
      if (!normalized || !(flags & OPEN_MODE.READ) || (flags & deniedOpenFlags)) {
        return stream.status(requestId, STATUS_CODE.PERMISSION_DENIED)
      }
      void this.options.library.getResource(normalized).then((resource) => {
        if (!resource || resource.type !== 'file') return stream.status(requestId, STATUS_CODE.NO_SUCH_FILE)
        stream.handle(requestId, createHandle({ type: 'file', path: normalized, resource }))
      }).catch((error) => fail(requestId, error))
    })
    stream.on('READ', (requestId, rawHandle, offset, length) => {
      const handle = getHandle(rawHandle)
      if (!handle || handle.type !== 'file') return stream.status(requestId, STATUS_CODE.FAILURE)
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1) {
        return stream.status(requestId, STATUS_CODE.BAD_MESSAGE)
      }
      if (offset >= handle.resource.size) return stream.status(requestId, STATUS_CODE.EOF)
      if (pendingReads >= maxConcurrentReads) return stream.status(requestId, STATUS_CODE.FAILURE)
      const boundedLength = Math.min(length, maxReadLength, handle.resource.size - offset)
      pendingReads += 1
      void this.options.library.readRange(handle.path, offset, boundedLength).then((data) => {
        if (data.length === 0) return stream.status(requestId, STATUS_CODE.EOF)
        stream.data(requestId, data)
      }).catch((error) => fail(requestId, error)).finally(() => {
        pendingReads = Math.max(0, pendingReads - 1)
      })
    })
    stream.on('FSTAT', (requestId, rawHandle) => {
      const handle = getHandle(rawHandle)
      if (!handle) return stream.status(requestId, STATUS_CODE.FAILURE)
      stream.attrs(requestId, handle.type === 'file' ? resourceAttributes(handle.resource) : directoryAttributes())
    })
    stream.on('CLOSE', (requestId, rawHandle) => {
      if (rawHandle.length !== 4 || !handles.delete(rawHandle.readUInt32BE(0))) {
        return stream.status(requestId, STATUS_CODE.FAILURE)
      }
      stream.status(requestId, STATUS_CODE.OK)
    })
    const deny = (requestId: number): void => stream.status(requestId, STATUS_CODE.PERMISSION_DENIED)
    stream.on('WRITE', deny)
    stream.on('FSETSTAT', deny)
    stream.on('SETSTAT', deny)
    stream.on('REMOVE', deny)
    stream.on('RMDIR', deny)
    stream.on('MKDIR', deny)
    stream.on('RENAME', deny)
    stream.on('SYMLINK', deny)
    stream.on('READLINK', (requestId) => stream.status(requestId, STATUS_CODE.OP_UNSUPPORTED))
    stream.on('EXTENDED', (requestId) => stream.status(requestId, STATUS_CODE.OP_UNSUPPORTED))
  }

  private async respondStat(stream: SFTPWrapper, requestId: number, input: string): Promise<void> {
    const normalized = normalizeSftpPath(input)
    if (!normalized) return stream.status(requestId, STATUS_CODE.NO_SUCH_FILE)
    try {
      const resource = await this.options.library.getResource(normalized)
      if (!resource) return stream.status(requestId, STATUS_CODE.NO_SUCH_FILE)
      stream.attrs(requestId, resourceAttributes(resource))
    } catch (error) {
      this.options.onError?.(`SFTP stat: ${error instanceof Error ? error.message : 'unknown error'}`)
      stream.status(requestId, STATUS_CODE.FAILURE)
    }
  }
}

export function normalizeSftpPath(input: string): string | null {
  if (input.includes('\0') || input.length > 2_048) return null
  const absolute = input.startsWith('/') ? input : `/${input}`
  if (absolute.split('/').includes('..')) return null
  const normalized = path.posix.normalize(absolute)
  if (!normalized.startsWith('/')) return null
  return normalized === '/.' ? '/' : normalized
}

function safeEqual(input: Buffer, expected: Buffer): boolean {
  if (input.length !== expected.length) return false
  return timingSafeEqual(input, expected)
}

function resourceAttributes(resource: MediaResource): Attributes {
  return resource.type === 'dir' ? directoryAttributes(resource.modifiedAt) : {
    mode: 0o100444,
    uid: 0,
    gid: 0,
    size: resource.size,
    atime: resource.modifiedAt,
    mtime: resource.modifiedAt,
  }
}

function directoryAttributes(modifiedAt = 0): Attributes {
  return { mode: 0o040555, uid: 0, gid: 0, size: 0, atime: modifiedAt, mtime: modifiedAt }
}

function toFileEntry(resource: MediaResource): FileEntry {
  const attrs = resourceAttributes(resource)
  const kind = resource.type === 'dir' ? 'd' : '-'
  return {
    filename: resource.name,
    longname: `${kind}r--r--r-- 1 0 0 ${attrs.size} ${resource.name}`,
    attrs,
  }
}
