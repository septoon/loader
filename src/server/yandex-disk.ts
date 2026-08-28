import type { Readable } from 'node:stream'

const apiRoot = 'https://cloud-api.yandex.net/v1/disk'
const operationPrefix = '/v1/disk/operations/'

interface Operation {
  status: 'in-progress' | 'success' | 'failed'
}

interface ResourceMetadata {
  path: string
  type: 'file' | 'dir'
  size?: number
  md5?: string
}

export interface FileDigests {
  md5: string
  sha256: string
}

export class YandexDiskAdapter {
  constructor(private readonly token: string) {}

  async startRemoteImport(source: string, destinationPath: string): Promise<string> {
    await this.ensureDirectory(parentPath(destinationPath))
    const operation = await this.apiRequest<{ href: string }>('/resources/upload', {
      url: source,
      path: destinationPath,
      disable_redirects: false,
    }, 'POST')
    return validateOperationHref(operation.href)
  }

  async getOperation(href: string): Promise<Operation> {
    const operationUrl = validateOperationHref(href)
    const response = await fetchWithRetry(new URL(operationUrl), {
      headers: { Authorization: `OAuth ${this.token}` },
    })
    const text = await readBody(response)
    if (!response.ok) {
      throw new Error(`Яндекс Диск не вернул состояние операции: HTTP ${response.status}: ${safeBody(text)}`)
    }
    return JSON.parse(text) as Operation
  }

  async getMetadata(resourcePath: string): Promise<ResourceMetadata> {
    return this.apiRequest<ResourceMetadata>('/resources', {
      path: resourcePath,
      fields: 'path,type,size,md5',
    })
  }

  async getMetadataOrNull(resourcePath: string): Promise<ResourceMetadata | null> {
    try {
      return await this.getMetadata(resourcePath)
    } catch (error) {
      if (error instanceof YandexHttpError && error.status === 404) return null
      throw error
    }
  }

  async requestUpload(destinationPath: string): Promise<string> {
    await this.ensureDirectory(parentPath(destinationPath))
    const upload = await this.apiRequest<{ href: string }>('/resources/upload', {
      path: destinationPath,
      overwrite: false,
      fields: 'href,method,templated,operation_id',
    })
    return validateUploadHref(upload.href)
  }

  async uploadRange(
    href: string,
    start: number,
    totalBytes: number,
    body: Readable,
    signal: AbortSignal,
    timeoutMs: number,
    uploadLength?: number,
  ): Promise<void> {
    const uploadUrl = validateUploadHref(href)
    const length = uploadLength ?? totalBytes - start
    const end = start + length - 1
    if (!Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(end) || end >= totalBytes) {
      throw new Error('Некорректный диапазон загрузки')
    }
    const headers: Record<string, string> = {
      'Content-Length': String(length),
      'Content-Type': 'application/octet-stream',
    }
    if (start > 0 || length < totalBytes) headers['Content-Range'] = `bytes ${start}-${end}/${totalBytes}`
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers,
      body: body as unknown as BodyInit,
      duplex: 'half',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    } as RequestInit)
    if (![201, 202].includes(response.status)) {
      const text = await readBody(response)
      throw new YandexHttpError(response.status, `Яндекс Диск отклонил поток: HTTP ${response.status}: ${safeBody(text)}`)
    }
    await response.body?.cancel()
  }

  async getStableUploadOffset(href: string, digests: FileDigests, totalBytes: number): Promise<number> {
    const deadline = Date.now() + 90_000
    let previous: number | null = null
    let stableCount = 0
    while (Date.now() < deadline) {
      const uploaded = await this.getUploadedSize(href, digests, totalBytes)
      if (uploaded === previous) stableCount += 1
      else {
        previous = uploaded
        stableCount = 1
      }
      if (stableCount >= 4) return uploaded
      await delay(1_000)
    }
    throw new Error('Яндекс Диск не зафиксировал стабильную контрольную точку загрузки')
  }

  async waitForFileMetadata(resourcePath: string, expectedSize: number, expectedMd5: string): Promise<ResourceMetadata> {
    const deadline = Date.now() + 90_000
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        const metadata = await this.getMetadata(resourcePath)
        if (metadata.type === 'file' && metadata.size === expectedSize && metadata.md5 === expectedMd5) return metadata
      } catch (error) {
        lastError = error
      }
      await delay(1_500)
    }
    throw new Error(`Файл не прошёл итоговую проверку${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
  }

  private async getUploadedSize(href: string, digests: FileDigests, totalBytes: number): Promise<number> {
    const response = await fetch(validateUploadHref(href), {
      method: 'HEAD',
      headers: { Etag: digests.md5, Sha256: digests.sha256, Size: String(totalBytes) },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    })
    if (response.status !== 200) throw new YandexHttpError(response.status, `Не удалось получить контрольную точку: HTTP ${response.status}`)
    const uploaded = Number(response.headers.get('content-length'))
    if (!Number.isSafeInteger(uploaded) || uploaded < 0 || uploaded > totalBytes) {
      throw new Error('Яндекс Диск вернул некорректную контрольную точку')
    }
    return uploaded
  }

  private async ensureDirectory(directoryPath: string): Promise<void> {
    const segments = directoryPath.split('/').filter(Boolean)
    let current = ''
    for (const segment of segments) {
      current += `/${segment}`
      const url = new URL(`${apiRoot}/resources`)
      url.searchParams.set('path', current)
      const response = await fetchWithRetry(url, {
        method: 'PUT',
        headers: { Authorization: `OAuth ${this.token}` },
      }, new Set([201, 409]))
      if (response.status === 201) continue
      const metadata = await this.getMetadata(current)
      if (metadata.type !== 'dir') throw new Error(`Путь ${current} занят файлом`)
    }
  }

  private async apiRequest<T>(resource: string, query: Record<string, string | boolean>, method = 'GET'): Promise<T> {
    const url = new URL(`${apiRoot}${resource}`)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value))
    const response = await fetchWithRetry(url, {
      method,
      headers: { Authorization: `OAuth ${this.token}` },
    })
    const text = await readBody(response)
    if (!response.ok) {
      throw new YandexHttpError(response.status, `Яндекс Диск отклонил запрос: HTTP ${response.status}: ${safeBody(text)}`)
    }
    return (text ? JSON.parse(text) : null) as T
  }
}

class YandexHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function fetchWithRetry(url: URL, options: RequestInit, acceptedStatuses?: Set<number>): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      })
      if (response.ok || acceptedStatuses?.has(response.status)
        || ![429, 500, 502, 503, 504].includes(response.status)) return response
      lastError = new Error(`временный HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await delay(500 * (2 ** attempt))
  }
  throw lastError
}

function validateOperationHref(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.hostname !== 'cloud-api.yandex.net'
    || !url.pathname.startsWith(operationPrefix) || url.username || url.password) {
    throw new Error('Яндекс Диск вернул недопустимую ссылку операции')
  }
  return url.href
}

function validateUploadHref(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.disk.yandex.net')
    || url.username || url.password || url.port) {
    throw new Error('Яндекс Диск вернул недопустимую ссылку загрузчика')
  }
  return url.href
}

function parentPath(value: string): string {
  const position = value.lastIndexOf('/')
  return position > 0 ? value.slice(0, position) : '/'
}

function readBody(response: Response): Promise<string> {
  return response.text().then((text) => text.slice(0, 8_192))
}

function safeBody(value: string): string {
  return value.replaceAll(/https?:\/\/[^\s"']+/giu, '<ссылка скрыта>')
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
