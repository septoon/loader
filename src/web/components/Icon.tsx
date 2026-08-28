import type { SVGProps } from 'react'

export type IconName = 'active' | 'check' | 'warning' | 'settings' | 'logout' | 'link' | 'upload'
  | 'folder' | 'chevron' | 'pause' | 'play' | 'cancel' | 'info' | 'files' | 'log'
  | 'cloud' | 'clock' | 'speed' | 'retry' | 'trash'

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props} {...common}>{paths[name]}</svg>
}

const paths: Record<IconName, React.ReactNode> = {
  active: <><circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4Z"/></>,
  check: <><circle cx="12" cy="12" r="9"/><path d="m8 12 2.6 2.6L16.5 9"/></>,
  warning: <><path d="M10.3 3.7 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 3h.01"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
  logout: <><path d="M10 5H5v14h5m4-3 4-4-4-4m4 4H9"/></>,
  link: <><path d="m9.5 14.5 5-5m-7.7 8.4-1 .9a3.4 3.4 0 0 1-4.8-4.8l3-3a3.4 3.4 0 0 1 4.8 0m6.4 2a3.4 3.4 0 0 0 4.8 0l3-3A3.4 3.4 0 0 0 18.2 5l-1 .9"/></>,
  upload: <><path d="M12 16V4m-4 4 4-4 4 4M5 14v5h14v-5"/></>,
  folder: <path d="M3 6.5h6l2 2h10v10H3Z"/>,
  chevron: <path d="m8 10 4 4 4-4"/>,
  pause: <path d="M9 6v12m6-12v12"/>,
  play: <path d="m9 6 9 6-9 6Z"/>,
  cancel: <path d="m7 7 10 10M17 7 7 17"/>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/></>,
  files: <><path d="M7 3h7l4 4v14H7Z"/><path d="M14 3v5h5"/></>,
  log: <><path d="M5 6h14M5 12h14M5 18h9"/><circle cx="3" cy="6" r=".5" fill="currentColor" stroke="none"/><circle cx="3" cy="12" r=".5" fill="currentColor" stroke="none"/><circle cx="3" cy="18" r=".5" fill="currentColor" stroke="none"/></>,
  cloud: <><path d="M7.2 18H6a4 4 0 0 1-.8-7.9A6.5 6.5 0 0 1 17.6 9a4.5 4.5 0 0 1 .4 9h-1"/><path d="M12 12v8m-3-3 3 3 3-3"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  speed: <><path d="M4 17a8 8 0 1 1 16 0M12 13l4-4"/><circle cx="12" cy="17" r="1"/></>,
  retry: <><path d="M20 7v5h-5"/><path d="M18.5 15a7 7 0 1 1 .3-7.6L20 12"/></>,
  trash: <><path d="M4 7h16M9 3h6l1 4H8l1-4Zm-2 4 1 14h8l1-14M10 11v6m4-6v6"/></>,
}
