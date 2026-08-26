import type { Destination, HealthResponse, Job, JobEvent, SourceAnalysis } from '../shared/types'

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export async function getSession(): Promise<boolean> {
  const response = await request<{ authenticated: boolean }>('/api/session')
  return response.authenticated
}

export async function login(password: string): Promise<void> {
  await request('/api/session', { method: 'POST', body: JSON.stringify({ password }) })
}

export async function logout(): Promise<void> {
  await request('/api/session', { method: 'DELETE' })
}

export function getHealth(): Promise<HealthResponse> {
  return request('/api/health')
}

export async function getJobs(): Promise<Job[]> {
  return (await request<{ jobs: Job[] }>('/api/jobs')).jobs
}

export function analyzeSource(source: string, destination: Destination): Promise<SourceAnalysis> {
  return request('/api/sources/analyze', {
    method: 'POST',
    body: JSON.stringify({ source, destination }),
  })
}

export function analyzeTorrent(file: File, destination: Destination): Promise<SourceAnalysis> {
  const body = new FormData()
  body.append('destination', destination)
  body.append('torrent', file, file.name)
  return request('/api/sources/analyze-torrent', { method: 'POST', body })
}

export async function createJob(source: string, destination: Destination): Promise<Job> {
  return (await request<{ job: Job }>('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({ source, destination }),
  })).job
}

export async function createTorrentJob(file: File, destination: Destination): Promise<Job> {
  const body = new FormData()
  body.append('destination', destination)
  body.append('torrent', file, file.name)
  return (await request<{ job: Job }>('/api/jobs/torrent', { method: 'POST', body })).job
}

export async function getJobEvents(id: string): Promise<JobEvent[]> {
  return (await request<{ events: JobEvent[] }>(`/api/jobs/${id}/events`)).events
}

export async function mutateJob(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<Job> {
  const endpoint = action === 'cancel' ? `/api/jobs/${id}` : `/api/jobs/${id}/${action}`
  return (await request<{ job: Job }>(endpoint, { method: action === 'cancel' ? 'DELETE' : 'POST' })).job
}

async function request<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  const requestInit: RequestInit = {
    ...init,
    credentials: 'same-origin',
  }
  if (!(init.body instanceof FormData)) {
    const headers = new Headers(init.headers)
    headers.set('Content-Type', 'application/json')
    requestInit.headers = headers
  }
  const response = await fetch(url, requestInit)
  const body = response.status === 204 ? null : await response.json().catch(() => null) as { error?: string } | null
  if (!response.ok) throw new ApiError(body?.error || `Ошибка HTTP ${response.status}`, response.status)
  return body as T
}
