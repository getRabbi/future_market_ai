import type { ReactNode } from 'react';
import type { IconName } from '../lib/nav.js';

/** Interface icons beyond the navigation set. */
export type UiIcon =
  | 'bell'
  | 'help'
  | 'plus'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-left'
  | 'arrow-right'
  | 'check'
  | 'x'
  | 'menu'
  | 'alert-triangle'
  | 'alert-circle'
  | 'info'
  | 'refresh'
  | 'bolt'
  | 'server'
  | 'database'
  | 'cloud'
  | 'lock'
  | 'external'
  | 'sort'
  | 'building'
  | 'download'
  | 'globe'
  | 'logout'
  | 'send'
  | 'pause'
  | 'play';

export type AnyIcon = IconName | UiIcon;

const P: Record<AnyIcon, ReactNode> = {
  home: (
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
    </>
  ),
  journey: (
    <>
      <path d="m12 2.5 9.5 4.8-9.5 4.8-9.5-4.8z" />
      <path d="m2.5 12 9.5 4.8 9.5-4.8" />
      <path d="m2.5 16.7 9.5 4.8 9.5-4.8" />
    </>
  ),
  setup: (
    <>
      <rect x="4" y="4" width="16" height="17" rx="2" />
      <path d="M9 2.5h6v3H9z" />
      <path d="m8.5 13.5 2.5 2.5 4.5-4.5" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.2" />
    </>
  ),
  autopilot: (
    <>
      <path d="m3 17 6-6 4 4 8-8" />
      <path d="M14 7h7v7" />
    </>
  ),
  layers: (
    <>
      <path d="m12 2.5 9.5 4.8-9.5 4.8-9.5-4.8z" />
      <path d="m2.5 12 9.5 4.8 9.5-4.8" />
      <path d="m2.5 16.7 9.5 4.8 9.5-4.8" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4.5" width="18" height="17" rx="2" />
      <path d="M16 2.5v4M8 2.5v4M3 10h18M8 14h2M14 14h2M8 17.5h2" />
    </>
  ),
  share: (
    <>
      <circle cx="18" cy="5" r="2.8" />
      <circle cx="6" cy="12" r="2.8" />
      <circle cx="18" cy="19" r="2.8" />
      <path d="m8.6 13.4 6.8 4.1M15.4 6.5l-6.8 4.1" />
    </>
  ),
  megaphone: (
    <>
      <path d="M3 10.5v3a1 1 0 0 0 1 1h2l11 5V4.5l-11 5H4a1 1 0 0 0-1 1z" />
      <path d="M8 14.5 9.5 20h2.5l-1-4.6M20.5 9.5v5" />
    </>
  ),
  message: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  phone: (
    <>
      <rect x="6" y="2.5" width="12" height="19" rx="2.2" />
      <path d="M11 18h2" />
    </>
  ),
  chart: (
    <>
      <path d="M3 3v18h18" />
      <path d="M8 17v-4M13 17V8M18 17v-7" />
    </>
  ),
  compass: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20.5 20.5-4.5-4.5" />
      <path d="M8.5 11.5 10 13l3.5-4" />
    </>
  ),
  trend: (
    <>
      <path d="M3 3v18h18" />
      <path d="m7 15 4-4 3 3 5-6" />
    </>
  ),
  bulb: (
    <>
      <path d="M9 18h6M10 21.5h4" />
      <path d="M12 2.5a6.5 6.5 0 0 0-3.8 11.8c.5.4.8 1 .8 1.7v.5h6V16c0-.7.3-1.3.8-1.7A6.5 6.5 0 0 0 12 2.5z" />
    </>
  ),
  flask: (
    <>
      <path d="M9 2.5h6M10 2.5v6.2L4.6 18.6A1.6 1.6 0 0 0 6 21h12a1.6 1.6 0 0 0 1.4-2.4L14 8.7V2.5" />
      <path d="M7.2 15h9.6" />
    </>
  ),
  'check-circle': (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.2 2.4 2.4 4.6-4.9" />
    </>
  ),
  shield: (
    <>
      <path d="M12 21.5s7.5-3.6 7.5-9.5V5.3L12 2.5 4.5 5.3V12c0 5.9 7.5 9.5 7.5 9.5z" />
      <path d="m9 11.8 2.2 2.2 4-4.2" />
    </>
  ),
  alert: (
    <>
      <path d="M12 21.5s7.5-3.6 7.5-9.5V5.3L12 2.5 4.5 5.3V12c0 5.9 7.5 9.5 7.5 9.5z" />
      <path d="M12 8v4.5M12 15.8h.01" />
    </>
  ),
  'file-check': (
    <>
      <path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z" />
      <path d="M14 2.5V8h5.5" />
      <path d="m9 15 2 2 4-4" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
  plug: (
    <>
      <path d="M12 21.5V17M9 7.5V2.5M15 7.5V2.5" />
      <path d="M18 7.5V12a6 6 0 0 1-12 0V7.5z" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.2 2" />
    </>
  ),
  pen: (
    <>
      <path d="M12 20.5h8.5" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2.2" />
      <circle cx="9" cy="9" r="1.8" />
      <path d="m21 15-5-5L5 21" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  book: (
    <>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2.5H6.5A2.5 2.5 0 0 0 4 5z" />
      <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" />
    </>
  ),
  mail: (
    <>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2" />
      <path d="m21.5 7-9.5 6-9.5-6" />
    </>
  ),
  chat: <path d="M7.9 20A9 9 0 1 0 4 16.1L2.5 21.5z" />,
  users: (
    <>
      <circle cx="9" cy="8" r="3.8" />
      <path d="M2.5 21a6.5 6.5 0 0 1 13 0" />
      <path d="M16 3.3a3.8 3.8 0 0 1 0 7.4M21.5 21a6.5 6.5 0 0 0-3.5-5.8" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20.5 20.5-4.5-4.5" />
    </>
  ),
  tag: (
    <>
      <path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z" />
      <circle cx="7.5" cy="7.5" r="1.4" />
    </>
  ),
  file: (
    <>
      <path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z" />
      <path d="M14 2.5V8h5.5M8.5 13h7M8.5 17h4.5" />
    </>
  ),
  brain: (
    <>
      <path d="M3 21h18" />
      <rect x="5" y="11" width="3" height="7" rx="1" />
      <rect x="10.5" y="5" width="3" height="13" rx="1" />
      <rect x="16" y="8.5" width="3" height="9.5" rx="1" />
    </>
  ),
  bell: (
    <>
      <path d="M6 8.5a6 6 0 0 1 12 0c0 6.5 2.5 8.5 2.5 8.5h-17S6 15 6 8.5" />
      <path d="M10.3 20.5a1.9 1.9 0 0 0 3.4 0" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.2 9.2a2.9 2.9 0 0 1 5.6 1c0 1.9-2.8 2.7-2.8 2.7M12 16.8h.01" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  'chevron-right': <path d="m9 6 6 6-6 6" />,
  'chevron-left': <path d="m15 6-6 6 6 6" />,
  'arrow-right': <path d="M5 12h14M13 6l6 6-6 6" />,
  check: <path d="M5 12.5l4.2 4.2L19 7" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  menu: <path d="M4 6.5h16M4 12h16M4 17.5h16" />,
  'alert-triangle': (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  'alert-circle': (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.8v4.6M12 16.2h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16.2v-4.6M12 7.8h.01" />
    </>
  ),
  refresh: (
    <>
      <path d="M20.5 12a8.5 8.5 0 0 1-14.6 5.9L3.5 15.5" />
      <path d="M3.5 12a8.5 8.5 0 0 1 14.6-5.9l2.4 2.4" />
      <path d="M20.5 3.5v5h-5M3.5 20.5v-5h5" />
    </>
  ),
  bolt: <path d="M13 2.5 4.5 13.5h7l-1 8 8.5-11h-7z" />,
  server: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5.5" rx="8" ry="3" />
      <path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  cloud: (
    <>
      <path d="M17.5 19H8.5a6 6 0 1 1 5.8-7.5h1.2a3.8 3.8 0 0 1 2 7.5z" />
      <path d="m9.5 14.5 2 2 3.5-3.5" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  external: <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />,
  sort: <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />,
  building: <path d="M3 21h18M5.5 21V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v16M9.5 7h1.5M13 7h1.5M9.5 11h1.5M13 11h1.5M9.5 15h1.5M13 15h1.5" />,
  download: <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  ),
  logout: <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />,
  send: (
    <>
      <path d="m21.5 2.5-6.5 19-4-8.5-8.5-4z" />
      <path d="M21.5 2.5 11 13" />
    </>
  ),
  pause: <path d="M9 5v14M15 5v14" />,
  play: <path d="M7 4.5v15l12-7.5z" />,
};

/** Decorative stroke icon; the surrounding text always carries the meaning. */
export function Ico({ name, size = 18, className }: { name: AnyIcon; size?: number; className?: string }) {
  return (
    <svg aria-hidden="true" focusable="false" className={className ? `ico ${className}` : 'ico'} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {P[name]}
    </svg>
  );
}
