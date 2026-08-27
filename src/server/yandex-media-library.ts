const apiRoot = 'https://cloud-api.yandex.net/v1/disk'

export interface MediaResource {
  name: string
  path: string
  type: 'file' | 'dir'
  size: number
  modifiedAt: number
}

interface ResourceResponse {
  name?: string
  path: string
  type: 'file' | 'dir'
  size?: number
  modified?: string
  _embedded?: {
    items: ResourceResponse[]
    limit: number
    offset: number
    total: number
  }
}

interface DownloadResponse {
  href: string
}

export interface MediaLibrary {
  getResource(relativePath: string): Promise<MediaResource | null>
  listDirectory(relativePath: string): Promise<MediaResource[]>
  readRange(relativePath: string, offset: number, length: number): Promise<Buffer>
}

export class YandexMediaLibrary implements MediaLibrary {
  private readonly downloadUrls = new Map<string, { href: string; expiresAt: number }>()

  constructor(
    private readonly token: string,
    private readonly root = '/Media',
  ) {}

  async getResource(relativePath: string): Promise<MediaResource | null> {
    try {
      const value = await this.apiRequest<ResourceResponse>('/resources', {
        path: this.diskPath(relativePath),
        fields: 'name,path,type,size,modified',
      })
      return toMediaResource(value)
    } catch (error) {
      if (error instanceof YandexMediaHttpError && error.status === 404) return null
      throw error
    }
  }

  async listDirectory(relativePath: string): Promise<MediaResource[]> {
    const path = this.diskPath(relativePath)
    const resources: MediaResource[] = []
    let offset = 0
    let total = 1
    while (offset < total) {
      const value = await this.apiRequest<ResourceResponse>('/resources', {
        path,
        fields: 'type,_embedded.items.name,_embedded.items.path,_embedded.items.type,_embedded.items.size,_embedded.items.modified,_embedded.limit,_embedded.offset,_embedded.total',
        limit: 1_000,
        offset,
      })
      if (value.type !== 'dir' || !value._embedded) throw new Error('Запрошенный путь не является каталогом')
      resources.push(...value._embedded.items.map(toMediaResource))
      total = value._embedded.total
      const received = value._embedded.items.length
      if (received === 0) break
      offset += received
    }
    return resources
  }

  async readRange(relativePath: string, offset: number, length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1 || length > 512 * 1024) {
      throw new Error('Некорректный диапазон чтения')
    }
    const body = await this.openRead(relativePath, offset, offset + length - 1)
    const data = Buffer.from(await new Response(body).arrayBuffer())
    if (data.length > length) return data.subarray(0, length)
    return data
  }

  async openRead(relativePath: string, start: number, end: number, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      throw new Error('Некорректный диапазон чтения')
    }
    for (let refresh = 0; refresh < 2; refresh += 1) {
      let url = await this.getDownloadUrl(relativePath, refresh > 0)
      for (let redirect = 0; redirect < 3; redirect += 1) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 30_000)
        signal?.addEventListener('abort', () => controller.abort(), { once: true })
        const response = await fetch(url, {
          headers: { Range: `bytes=${start}-${end}` },
          redirect: 'manual',
          signal: controller.signal,
        }).finally(() => clearTimeout(timeout))
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location')
          if (!location) throw new Error('Яндекс Диск вернул редирект без адреса')
          url = validateDownloadUrl(new URL(location, url).href)
          this.downloadUrls.set(relativePath, { href: url.href, expiresAt: Date.now() + 5 * 60_000 })
          continue
        }
        if ([401, 403, 404].includes(response.status) && refresh === 0) break
        if (![200, 206].includes(response.status)) {
          throw new YandexMediaHttpError(response.status, `Яндекс Диск отклонил чтение: HTTP ${response.status}`)
        }
        if (!response.body) throw new Error('Яндекс Диск вернул пустой поток')
        return response.body
      }
    }
    throw new Error('Не удалось обновить ссылку чтения Яндекс Диска')
  }

  private diskPath(relativePath: string): string {
    if (!relativePath.startsWith('/') || relativePath.split('/').includes('..')) {
      throw new Error('Недопустимый путь медиатеки')
    }
    if (relativePath === '/') return this.root
    return `${this.root}${relativePath}`
  }

  private async getDownloadUrl(relativePath: string, forceRefresh: boolean): Promise<URL> {
    const cached = this.downloadUrls.get(relativePath)
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) return validateDownloadUrl(cached.href)
    const download = await this.apiRequest<DownloadResponse>('/resources/download', {
      path: this.diskPath(relativePath),
    })
    const url = validateDownloadUrl(download.href)
    if (this.downloadUrls.size >= 100) this.downloadUrls.delete(this.downloadUrls.keys().next().value ?? '')
    this.downloadUrls.set(relativePath, { href: url.href, expiresAt: Date.now() + 5 * 60_000 })
    return url
  }

  private async apiRequest<T>(resource: string, query: Record<string, string | number>): Promise<T> {
    const url = new URL(`${apiRoot}${resource}`)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value))
    const response = await fetch(url, {
      headers: { Authorization: `OAuth ${this.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    })
    const text = (await response.text()).slice(0, 8_192)
    if (!response.ok) {
      throw new YandexMediaHttpError(response.status, `Яндекс Диск отклонил запрос: HTTP ${response.status}`)
    }
    return JSON.parse(text) as T
  }
}

class YandexMediaHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function toMediaResource(value: ResourceResponse): MediaResource {
  const name = value.name || value.path.slice(value.path.lastIndexOf('/') + 1) || 'Media'
  const size = value.type === 'file' && Number.isSafeInteger(value.size) ? value.size ?? 0 : 0
  const modified = value.modified ? Date.parse(value.modified) : 0
  return {
    name,
    path: value.path,
    type: value.type,
    size,
    modifiedAt: Number.isFinite(modified) ? Math.floor(modified / 1_000) : 0,
  }
}

function validateDownloadUrl(value: string): URL {
  const url = new URL(value)
  const allowedHost = url.hostname === 'downloader.disk.yandex.ru'
    || url.hostname.endsWith('.storage.yandex.net')
    || url.hostname.endsWith('.disk.yandex.net')
  if (url.protocol !== 'https:' || !allowedHost || url.username || url.password || url.port) {
    throw new Error('Яндекс Диск вернул недопустимую ссылку скачивания')
  }
  return url
}
