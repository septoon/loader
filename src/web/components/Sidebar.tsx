import type { Job } from '../../shared/types'
import { logout } from '../api'
import { Brand } from './Brand'
import { Icon, type IconName } from './Icon'

export type JobFilter = 'active' | 'completed' | 'failed'

interface SidebarProps {
  filter: JobFilter
  jobs: Job[]
  onFilterChange: (filter: JobFilter) => void
  onLoggedOut: () => void
  onSettings: () => void
}

export function Sidebar({ filter, jobs, onFilterChange, onLoggedOut, onSettings }: SidebarProps) {
  const items: Array<{ id: JobFilter, label: string, icon: IconName, count: number }> = [
    { id: 'active', label: 'Активные', icon: 'active', count: jobs.filter(isActive).length },
    { id: 'completed', label: 'Завершённые', icon: 'check', count: jobs.filter((job) => job.status === 'completed').length },
    { id: 'failed', label: 'Ошибки', icon: 'warning', count: jobs.filter(isFailed).length },
  ]

  const signOut = async () => {
    await logout()
    onLoggedOut()
  }

  return <aside className="sidebar">
    <div className="sidebar-brand"><Brand /></div>
    <nav className="sidebar-nav" aria-label="Загрузки">
      {items.map((item) => <button
        key={item.id}
        className={filter === item.id ? 'sidebar-link is-active' : 'sidebar-link'}
        onClick={() => onFilterChange(item.id)}
        type="button"
      >
        <Icon name={item.icon} />
        <span>{item.label}</span>
        {item.count > 0 && <span className="nav-count">{item.count}</span>}
      </button>)}
    </nav>
    <div className="sidebar-footer">
      <button className="sidebar-link" type="button" onClick={onSettings}>
        <Icon name="settings" /><span>Состояние</span>
      </button>
      <button className="sidebar-link" type="button" onClick={() => void signOut()}>
        <Icon name="logout" /><span>Выйти</span>
      </button>
    </div>
  </aside>
}

export function isActive(job: Job): boolean {
  return ['queued', 'transferring', 'verifying', 'paused'].includes(job.status)
}

export function isFailed(job: Job): boolean {
  return ['failed', 'cancelled'].includes(job.status)
}
