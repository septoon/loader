import { useMemo, useState } from 'react'
import type { Job, JobEvent, JobFileStatus, JobStatus } from '../../shared/types'
import { getJobEvents, mutateJob } from '../api'
import { type JobFilter, isActive, isFailed } from './Sidebar'
import { Icon } from './Icon'

interface JobsPanelProps {
  jobs: Job[]
  filter: JobFilter
  onFilterChange: (filter: JobFilter) => void
  onChanged: () => void
  onError: (message: string) => void
}

type DetailTab = 'details' | 'files' | 'log'

export function JobsPanel({ jobs, filter, onFilterChange, onChanged, onError }: JobsPanelProps) {
  const [expandedId, setExpandedId] = useState<string | null>(
    jobs.find((job) => ['transferring', 'verifying'].includes(job.status))?.id ?? jobs.find(isActive)?.id ?? null,
  )
  const [detailTab, setDetailTab] = useState<DetailTab>('details')
  const [events, setEvents] = useState<Record<string, JobEvent[]>>({})
  const visibleJobs = useMemo(() => {
    const filtered = jobs.filter((job) => matchesFilter(job, filter))
    if (filter !== 'active') return filtered
    const priority: Partial<Record<JobStatus, number>> = { transferring: 0, verifying: 1, queued: 2, paused: 3 }
    return [...filtered].sort((left, right) => (priority[left.status] ?? 9) - (priority[right.status] ?? 9))
  }, [filter, jobs])
  const counts = {
    active: jobs.filter(isActive).length,
    completed: jobs.filter((job) => job.status === 'completed').length,
    failed: jobs.filter(isFailed).length,
  }

  const toggle = (id: string) => {
    setExpandedId((current) => current === id ? null : id)
    setDetailTab('details')
  }

  const setTab = async (job: Job, tab: DetailTab) => {
    setDetailTab(tab)
    if (tab !== 'log' || events[job.id]) return
    try {
      const jobEvents = await getJobEvents(job.id)
      setEvents((current) => ({ ...current, [job.id]: jobEvents }))
    } catch (error) {
      onError(toMessage(error))
    }
  }

  const action = async (job: Job, kind: 'pause' | 'resume' | 'cancel') => {
    try {
      await mutateJob(job.id, kind)
      onChanged()
    } catch (error) {
      onError(toMessage(error))
    }
  }

  return <section className="jobs-section" aria-label="Загрузки">
    <div className="status-tabs" role="tablist" aria-label="Состояние загрузок">
      {([['active', 'Активные'], ['completed', 'Завершённые'], ['failed', 'Ошибки']] as const).map(([id, label]) =>
        <button
          key={id}
          className={filter === id ? 'status-tab is-active' : 'status-tab'}
          type="button"
          role="tab"
          aria-selected={filter === id}
          onClick={() => onFilterChange(id)}
        >{label}<span>{counts[id]}</span></button>)}
    </div>

    <div className="jobs-head" aria-hidden="true">
      <span>Название</span><span>Назначение</span><span>Состояние</span><span>Прогресс</span><span>Скорость</span><span>Осталось</span><span>Действия</span>
    </div>

    {visibleJobs.length === 0
      ? <EmptyState filter={filter} />
      : <div className="jobs-list">
        {visibleJobs.map((job) => {
          const expanded = expandedId === job.id
          return <article className={expanded ? 'job is-expanded' : 'job'} key={job.id}>
            <button className="job-row-main" type="button" onClick={() => toggle(job.id)} aria-expanded={expanded}>
              <span className="job-title-cell">
                <Icon className={expanded ? 'row-chevron is-open' : 'row-chevron'} name="chevron" />
                <span className={`job-kind job-kind-${job.status}`}><Icon name={job.status === 'completed' ? 'check' : job.status === 'failed' ? 'warning' : 'cloud'} /></span>
                <span><strong>{job.title}</strong><small>{subtitle(job)}</small></span>
              </span>
              <span className="job-destination"><small>Назначение</small>{job.destinationPath}</span>
              <span className={`job-status status-${job.status}`}><small>Состояние</small>{statusLabel(job.status)}</span>
              <span className="job-progress-cell"><small>Прогресс</small><Progress job={job} /></span>
              <span className="job-metric"><small>Скорость</small>{job.speedBytesPerSecond ? `${formatBytes(job.speedBytesPerSecond)}/с` : '—'}</span>
              <span className="job-metric"><small>Осталось</small>{remaining(job)}</span>
              <span className="row-expand-mobile"><Icon name="chevron" /></span>
            </button>
            <div className="job-actions" onClick={(event) => event.stopPropagation()}>
              {(job.status === 'queued' || (job.sourceKind !== 'direct-url' && ['transferring', 'verifying'].includes(job.status)))
                && <button type="button" onClick={() => void action(job, 'pause')}><Icon name="pause"/><span>Пауза</span></button>}
              {['paused', 'failed'].includes(job.status) && <button type="button" onClick={() => void action(job, 'resume')}><Icon name={job.status === 'failed' ? 'retry' : 'play'}/><span>{job.status === 'failed' ? 'Повторить' : 'Продолжить'}</span></button>}
              {(['queued', 'paused', 'failed'].includes(job.status) || (job.sourceKind !== 'direct-url' && ['transferring', 'verifying'].includes(job.status)))
                && <button className="danger" type="button" onClick={() => void action(job, 'cancel')}><Icon name="cancel"/><span>Отменить</span></button>}
              {job.sourceKind === 'direct-url' && ['transferring', 'verifying'].includes(job.status) && <span className="action-note">Импорт выполняет Яндекс Диск</span>}
            </div>
            {expanded && <JobDetails job={job} tab={detailTab} events={events[job.id]} onTab={(tab) => void setTab(job, tab)} />}
          </article>
        })}
      </div>}
  </section>
}

function JobDetails({ job, tab, events, onTab }: { job: Job, tab: DetailTab, events: JobEvent[] | undefined, onTab: (tab: DetailTab) => void }) {
  return <div className="job-details">
    <div className="detail-tabs" role="tablist">
      <DetailButton active={tab === 'details'} icon="info" label="Сведения" onClick={() => onTab('details')} />
      <DetailButton active={tab === 'files'} icon="files" label="Файлы" onClick={() => onTab('files')} />
      <DetailButton active={tab === 'log'} icon="log" label="Журнал" onClick={() => onTab('log')} />
    </div>
    <div className="detail-content">
      {tab === 'details' && <dl>
        <div><dt>Назначение</dt><dd>{job.destinationPath}</dd></div>
        <div><dt>Источник</dt><dd>{job.sourceLabel}</dd></div>
        <div><dt>Добавлено</dt><dd>{formatDate(job.createdAt)}</dd></div>
        <div><dt>Режим</dt><dd>{job.sourceKind === 'direct-url' ? 'Прямой импорт без передачи через сервер' : job.sourceKind === 'rutube' ? 'Rutube HLS → Яндекс Диск без сохранения на VPS' : 'Последовательная передача без сохранения на сервере'}</dd></div>
        {job.errorMessage && <div className="error-detail"><dt>Ошибка</dt><dd>{job.errorMessage}</dd></div>}
      </dl>}
      {tab === 'files' && (job.files.length > 0
        ? <div className="file-list">{job.files.map((file) => <div className="file-list-row" key={file.id}>
          <Icon name={file.status === 'completed' ? 'check' : 'files'} />
          <span><strong>{file.relativePath}</strong><small>{formatBytes(file.size)} · {fileStatusLabel(file.status)}</small></span>
          <span>{file.size > 0 ? `${Math.round(file.bytesTransferred / file.size * 100)}%` : '—'}</span>
        </div>)}</div>
        : <div className="detail-placeholder"><Icon name="files"/><span>{job.sourceKind === 'direct-url' ? 'Один файл передаётся прямым импортом' : job.sourceKind === 'rutube' ? 'Размер файла появится после проверки HLS-потока' : 'Состав файлов появится после получения метаданных'}</span></div>)}
      {tab === 'log' && <div className="event-log">
        {!events && <span>Загрузка журнала…</span>}
        {events?.length === 0 && <span>Событий пока нет</span>}
        {events?.map((event) => <div key={event.id}><time>{formatEventTime(event.createdAt)}</time><span className={event.level === 'error' ? 'event-error' : ''}>{event.message}</span></div>)}
      </div>}
    </div>
  </div>
}

function DetailButton({ active, icon, label, onClick }: { active: boolean, icon: 'info' | 'files' | 'log', label: string, onClick: () => void }) {
  return <button type="button" className={active ? 'is-active' : ''} onClick={onClick}><Icon name={icon}/>{label}</button>
}

function Progress({ job }: { job: Job }) {
  const value = job.progress === null ? null : Math.round(job.progress * 100)
  const indeterminate = value === null && ['transferring', 'verifying'].includes(job.status)
  return <span className="progress-wrap">
    <span className="progress-label">{value === null ? statusLabel(job.status) : `${value}%`}</span>
    <span className={indeterminate ? 'progress-track is-indeterminate' : 'progress-track'}>
      <span style={indeterminate ? undefined : { width: `${value ?? 0}%` }} />
    </span>
    <span className="progress-bytes">{job.totalBytes ? `${formatBytes(job.bytesTransferred ?? 0)} из ${formatBytes(job.totalBytes)}` : 'Объём уточняется'}</span>
  </span>
}

function EmptyState({ filter }: { filter: JobFilter }) {
  const copy = filter === 'active'
    ? ['Активных загрузок нет', 'Добавьте ссылку, магнет или .torrent-файл выше.']
    : filter === 'completed'
      ? ['Завершённых загрузок пока нет', 'Проверенные файлы появятся здесь.']
      : ['Ошибок нет', 'Задачи, требующие внимания, появятся здесь.']
  return <div className="empty-state"><Icon name={filter === 'failed' ? 'check' : 'cloud'} /><strong>{copy[0]}</strong><span>{copy[1]}</span></div>
}

function matchesFilter(job: Job, filter: JobFilter): boolean {
  if (filter === 'active') return isActive(job)
  if (filter === 'completed') return job.status === 'completed'
  return isFailed(job)
}

function subtitle(job: Job): string {
  if (job.status === 'queued') return 'Ожидает запуска'
  if (job.status === 'paused') return 'Приостановлена'
  if (job.status === 'completed') return 'Сохранено на Яндекс Диске'
  if (job.status === 'failed') return 'Требуется внимание'
  if (job.status === 'cancelled') return 'Отменена'
  if (job.status === 'verifying') return job.sourceKind === 'direct-url'
    ? 'Проверка на Яндекс Диске'
    : job.sourceKind === 'rutube' ? 'Проверка потока Rutube' : 'Проверка торрент-источника'
  return 'Передача на Яндекс Диск'
}

function statusLabel(status: JobStatus): string {
  return ({
    queued: 'В очереди', transferring: 'Передача', verifying: 'Проверка', paused: 'Пауза',
    completed: 'Готово', failed: 'Ошибка', cancelled: 'Отменено',
  } satisfies Record<JobStatus, string>)[status]
}

function formatBytes(value: number): string {
  if (value <= 0) return '0 Б'
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value / (1024 ** exponent))} ${units[exponent]}`
}

function fileStatusLabel(status: JobFileStatus): string {
  return ({
    pending: 'ожидает', hashing: 'проверяется', transferring: 'передаётся', completed: 'готово', failed: 'ошибка',
  } satisfies Record<JobFileStatus, string>)[status]
}

function remaining(job: Job): string {
  if (!job.speedBytesPerSecond || !job.totalBytes || job.bytesTransferred === null) return '—'
  const seconds = Math.max(0, Math.round((job.totalBytes - job.bytesTransferred) / job.speedBytesPerSecond))
  return seconds < 60 ? `${seconds} с` : `${Math.ceil(seconds / 60)} мин`
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function formatEventTime(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value))
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось изменить загрузку'
}
