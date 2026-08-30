export const destinations = ['auto', 'movies', 'tv', 'unsorted'] as const

export type Destination = (typeof destinations)[number]
export type SourceKind = 'direct-url' | 'vkvideo' | 'rutube' | 'magnet' | 'torrent-file'
export type JobStatus =
  | 'queued'
  | 'transferring'
  | 'verifying'
  | 'waiting'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type JobFileStatus = 'pending' | 'hashing' | 'transferring' | 'completed' | 'failed'
export type TransferBottleneck = 'source' | 'yandex' | 'balanced'

export interface JobFile {
  id: string
  index: number
  relativePath: string
  destinationPath: string
  size: number
  status: JobFileStatus
  bytesTransferred: number
  verified: boolean
}

export interface Job {
  id: string
  sourceKind: SourceKind
  sourceLabel: string
  title: string
  destination: Destination
  destinationPath: string
  status: JobStatus
  progress: number | null
  bytesTransferred: number | null
  totalBytes: number | null
  speedBytesPerSecond: number | null
  sourceSpeedBytesPerSecond: number | null
  yandexUploadSpeedBytesPerSecond: number | null
  bottleneck: TransferBottleneck | null
  bufferedBytes: number | null
  bufferCapacityBytes: number | null
  uploadRequestMs: number | null
  uploadWriteBlockedMs: number | null
  errorMessage: string | null
  files: JobFile[]
  createdAt: string
  updatedAt: string
}

export interface JobEvent {
  id: number
  jobId: string
  level: 'info' | 'error'
  message: string
  createdAt: string
}

export interface SourceAnalysis {
  source: string
  sourceKind: SourceKind
  sourceLabel: string
  title: string
  destination: Destination
  destinationPath: string
  supported: boolean
  note: string
  fileCount?: number
  totalBytes?: number
}

export interface HealthResponse {
  status: 'ok'
  storageConfigured: boolean
  torrentAvailable: boolean
  activeTransfers: number
}

export function isRemoteImportSource(sourceKind: SourceKind): boolean {
  return sourceKind === 'direct-url' || sourceKind === 'vkvideo'
}
