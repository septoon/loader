import { useRef, useState } from 'react'
import type { Destination, SourceAnalysis } from '../../shared/types'
import { analyzeSource, analyzeTorrent, createJob, createTorrentJob } from '../api'
import { Icon } from './Icon'

interface SourceComposerProps {
  disabled: boolean
  onCreated: () => void
  onError: (message: string) => void
}

const destinationLabels: Record<Destination, string> = {
  auto: 'Авто',
  movies: 'Фильмы',
  tv: 'Сериалы',
  unsorted: 'Без категории',
}

export function SourceComposer({ disabled, onCreated, onError }: SourceComposerProps) {
  const [source, setSource] = useState('')
  const [destination, setDestination] = useState<Destination>('auto')
  const [analysis, setAnalysis] = useState<SourceAnalysis | null>(null)
  const [loading, setLoading] = useState(false)
  const [torrentFile, setTorrentFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const analyze = async () => {
    setLoading(true)
    try {
      setAnalysis(torrentFile
        ? await analyzeTorrent(torrentFile, destination)
        : await analyzeSource(source, destination))
    } catch (error) {
      onError(toMessage(error))
    } finally {
      setLoading(false)
    }
  }

  const submit = async () => {
    if (!analysis?.supported) return
    setLoading(true)
    try {
      if (torrentFile) await createTorrentJob(torrentFile, destination)
      else await createJob(analysis.source, analysis.destination)
      setSource('')
      setTorrentFile(null)
      setAnalysis(null)
      onCreated()
    } catch (error) {
      onError(toMessage(error))
    } finally {
      setLoading(false)
    }
  }

  const selectTorrentFile = async (file?: File) => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.torrent')) {
      onError('Поддерживаются только файлы .torrent')
      return
    }
    setTorrentFile(file)
    setSource('')
    setLoading(true)
    try {
      setAnalysis(await analyzeTorrent(file, destination))
    } catch (error) {
      setTorrentFile(null)
      setAnalysis(null)
      onError(toMessage(error))
    } finally {
      setLoading(false)
    }
  }

  return <section className="source-section" aria-labelledby="add-heading">
    <div className="source-grid">
      <label
        className={dragging ? 'source-input is-dragging' : 'source-input'}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          void selectTorrentFile(event.dataTransfer.files[0])
        }}
      >
        <Icon name="link" />
        <input
          value={source}
          onFocus={() => { if (torrentFile) { setTorrentFile(null); setAnalysis(null) } }}
          onChange={(event) => { setSource(event.target.value); setTorrentFile(null); setAnalysis(null) }}
          onKeyDown={(event) => { if (event.key === 'Enter') void analyze() }}
          placeholder={torrentFile ? torrentFile.name : 'Вставьте ссылку или магнет-ссылку'}
          aria-label="Ссылка или магнет-ссылка"
          disabled={disabled || loading}
        />
        <span>{torrentFile ? `${formatBytes(torrentFile.size)} · готов к добавлению` : 'Или перетащите сюда .torrent-файл'}</span>
      </label>
      <input
        ref={fileInput}
        className="visually-hidden"
        type="file"
        aria-label="Выбрать .torrent"
        onChange={(event) => { void selectTorrentFile(event.target.files?.[0]); event.target.value = '' }}
      />
      <button className="button button-secondary file-button" type="button" onClick={() => fileInput.current?.click()} disabled={disabled || loading}>
        <Icon name="upload" />{torrentFile ? 'Заменить .torrent' : 'Выбрать .torrent'}
      </button>
      <label className="destination-select">
        <span className="visually-hidden">Каталог назначения</span>
        <select value={destination} onChange={(event) => { setDestination(event.target.value as Destination); setAnalysis(null) }} disabled={disabled || loading}>
          {Object.entries(destinationLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select>
        <Icon name="chevron" />
      </label>
      <button className="button button-primary" type="button" onClick={() => void analyze()} disabled={disabled || loading || (!source.trim() && !torrentFile)}>
        {loading ? 'Проверка…' : 'Проверить'}
      </button>
    </div>

    {analysis && <div className={analysis.supported ? 'analysis-panel' : 'analysis-panel is-warning'}>
      <div className="analysis-icon"><Icon name={analysis.supported ? 'check' : 'warning'} /></div>
      <div className="analysis-copy">
        <strong>{analysis.title}</strong>
        <span>{analysis.note}{analysis.totalBytes ? ` · ${formatBytes(analysis.totalBytes)}` : ''}</span>
        <small><Icon name="folder" />{analysis.destinationPath}</small>
      </div>
      {analysis.supported && <button className="button button-primary compact" type="button" onClick={() => void submit()} disabled={loading}>
        Начать загрузку
      </button>}
    </div>}
  </section>
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось выполнить запрос'
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} Б`
  const units = ['КБ', 'МБ', 'ГБ']
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)) - 1, units.length - 1)
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value / (1024 ** (exponent + 1)))} ${units[exponent]}`
}
