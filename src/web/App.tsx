import { useCallback, useEffect, useState } from 'react'
import type { HealthResponse, Job } from '../shared/types'
import { getHealth, getJobs, getSession, login } from './api'
import { Brand } from './components/Brand'
import { Icon } from './components/Icon'
import { JobsPanel } from './components/JobsPanel'
import { type JobFilter, Sidebar } from './components/Sidebar'
import { SourceComposer } from './components/SourceComposer'

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)

  useEffect(() => {
    void getSession().then(setAuthenticated).catch(() => setAuthenticated(false))
  }, [])

  if (authenticated === null) return <div className="boot-screen"><Brand /><span>Подключение…</span></div>
  if (!authenticated) return <LoginScreen onSuccess={() => setAuthenticated(true)} />
  return <Dashboard onLoggedOut={() => setAuthenticated(false)} />
}

function Dashboard({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [filter, setFilter] = useState<JobFilter>('active')
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [nextJobs, nextHealth] = await Promise.all([getJobs(), getHealth()])
      setJobs(nextJobs)
      setHealth(nextHealth)
    } catch (requestError) {
      setError(toMessage(requestError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    let stream: EventSource | null = null
    let retry: number | null = null
    let disposed = false
    const connect = () => {
      if (disposed) return
      stream = new EventSource('/api/events')
      stream.addEventListener('jobs', (event) => {
        try {
          const snapshot = JSON.parse((event as MessageEvent<string>).data) as { jobs: Job[] }
          setJobs(snapshot.jobs)
          setLoading(false)
        } catch {
          setError('Получено некорректное обновление очереди')
        }
      })
      stream.onerror = () => {
        stream?.close()
        void refresh()
        retry = window.setTimeout(connect, 3_000)
      }
    }
    connect()
    return () => {
      disposed = true
      stream?.close()
      if (retry !== null) window.clearTimeout(retry)
    }
  }, [refresh])

  return <div className="app-shell">
    <Sidebar filter={filter} jobs={jobs} onFilterChange={setFilter} onLoggedOut={onLoggedOut} onSettings={() => setSettingsOpen(true)} />
    <main className="main-content">
      <header className="page-header">
        <div className="mobile-brand"><Brand /></div>
        <div className="page-heading"><h1 id="add-heading">Добавить загрузку</h1><p>Ссылка, магнет или .torrent — сразу на Яндекс Диск</p></div>
        <div className={health?.storageConfigured ? 'connection-status is-connected' : 'connection-status'}>
          <span className="connection-mark"><Icon name={health?.storageConfigured ? 'cloud' : 'warning'} /></span>
          <span>{health?.storageConfigured ? 'Яндекс Диск подключён' : 'Яндекс Диск не настроен'}</span>
        </div>
      </header>
      <SourceComposer disabled={!health?.storageConfigured} onCreated={() => void refresh()} onError={setError} />
      {loading
        ? <div className="loading-line"><span /></div>
        : <JobsPanel jobs={jobs} filter={filter} onFilterChange={setFilter} onChanged={() => void refresh()} onError={setError} />}
    </main>
    {error && <div className="toast" role="alert"><Icon name="warning"/><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Закрыть"><Icon name="cancel"/></button></div>}
    {settingsOpen && <ServicePanel health={health} onClose={() => setSettingsOpen(false)} />}
  </div>
}

function ServicePanel({ health, onClose }: { health: HealthResponse | null, onClose: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="service-dialog" role="dialog" aria-modal="true" aria-labelledby="service-heading">
      <header><div><span>Состояние сервиса</span><h2 id="service-heading">Лоадер готов к работе</h2></div><button type="button" onClick={onClose} aria-label="Закрыть"><Icon name="cancel"/></button></header>
      <dl>
        <div><dt>Яндекс Диск</dt><dd className={health?.storageConfigured ? 'is-ok' : 'is-error'}>{health?.storageConfigured ? 'Подключён' : 'Не настроен'}</dd></div>
        <div><dt>Торрент-транспорт</dt><dd className={health?.torrentAvailable ? 'is-ok' : 'is-error'}>{health?.torrentAvailable ? 'Доступен' : 'Недоступен'}</dd></div>
        <div><dt>Активных передач</dt><dd>{health?.activeTransfers ?? 0}</dd></div>
      </dl>
      <p>Прямые ссылки импортирует Яндекс Диск. Торренты передаются последовательно через ограниченный кеш VPS и поддерживают продолжение после разрыва.</p>
      <button className="button button-primary" type="button" onClick={onClose}>Готово</button>
    </section>
  </div>
}

function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError(null)
    try {
      await login(password)
      onSuccess()
    } catch (requestError) {
      setError(toMessage(requestError))
    } finally {
      setLoading(false)
    }
  }

  return <main className="login-screen">
    <form className="login-panel" onSubmit={(event) => void submit(event)}>
      <Brand />
      <div><h1>Вход в Лоадер</h1><p>Доступ к личной очереди загрузок</p></div>
      <label><span>Пароль</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus /></label>
      {error && <div className="login-error"><Icon name="warning" />{error}</div>}
      <button className="button button-primary" type="submit" disabled={!password || loading}>{loading ? 'Вход…' : 'Войти'}</button>
    </form>
  </main>
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Сервис временно недоступен'
}
