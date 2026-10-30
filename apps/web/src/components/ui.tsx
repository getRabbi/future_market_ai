import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { type ApiError, api } from '../lib/api.js';
import { formatValue, humanize, isStatusKey, isUuid, statusLabel, tone } from '../lib/format.js';
import { type Field, humanError } from '../lib/forms.js';

export function Badge({ value }: { value: unknown }) {
  return <span className={`badge ${tone(value)}`}>{statusLabel(value)}</span>;
}

/** Errors in plain language: what went wrong, what to do, and field problems as a list. */
export function ErrorNotice({ error, fields }: { error: unknown; fields?: Field[] }) {
  if (!error) return null;
  const h = humanError(error, fields);
  const e = error as ApiError;
  return (
    <div className="notice error" role="alert">
      <strong>{h.title}</strong>
      {h.hint ? <div className="small">{h.hint}</div> : null}
      {h.items.length ? (
        <ul className="small tight">
          {h.items.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      ) : null}
      {e.code || e.details ? (
        <details className="small">
          <summary>Technical details</summary>
          <pre>{JSON.stringify({ code: e.code ?? null, status: e.status ?? null, message: e.message, details: e.details ?? null }, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}

/** GET a resource, with reload. `path === null` skips loading. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    setError(null);
    try {
      setData(await api<T>('GET', path));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, loading, reload: load };
}

export function pickRows(data: unknown, pick?: string): Record<string, unknown>[] {
  const v = pick && data && typeof data === 'object' ? (data as Record<string, unknown>)[pick] : data;
  if (Array.isArray(v)) return v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
  return [];
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      {children ? <div className="small muted">{children}</div> : null}
      {action ? <div className="row">{action}</div> : null}
    </div>
  );
}

export function LoadingRows({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="skeleton" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="sk-line" />
      <div className="sk-line" />
      <div className="sk-line" />
    </div>
  );
}

export function DataTable({
  rows,
  columns,
  labels,
  onRowClick,
  actions,
  empty = 'Nothing here yet.',
  loading = false,
}: {
  rows: Record<string, unknown>[];
  columns?: string[];
  labels?: Record<string, string>;
  onRowClick?: (r: Record<string, unknown>) => void;
  actions?: (r: Record<string, unknown>) => ReactNode;
  empty?: ReactNode;
  loading?: boolean;
}) {
  if (rows.length === 0) return loading ? <LoadingRows /> : typeof empty === 'string' ? <p className="muted small">{empty}</p> : empty;
  const keys = new Set(rows.flatMap((r) => Object.keys(r)));
  let cols = (columns ?? []).filter((c) => keys.has(c));
  if (cols.length === 0) cols = [...keys].filter((k) => k !== 'tenantId' && !isUuid(rows[0]?.[k])).slice(0, 7);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} scope="col">
                {labels?.[c] ?? humanize(c)}
              </th>
            ))}
            {actions ? <th scope="col">Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={String(r.id ?? r.evidenceId ?? i)}
              className={onRowClick ? 'clickable' : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              title={onRowClick ? 'Open details' : undefined}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onRowClick(r);
                      }
                    }
                  : undefined
              }
            >
              {cols.map((c) => (
                <td key={c} data-label={labels?.[c] ?? humanize(c)}>
                  {isStatusKey(c) && r[c] !== null && r[c] !== undefined ? (
                    <Badge value={r[c]} />
                  ) : (
                    <span className="cell" title={isUuid(r[c]) ? String(r[c]) : undefined}>
                      {formatValue(c, r[c])}
                    </span>
                  )}
                </td>
              ))}
              {actions ? (
                <td className="actions-cell" data-label="Actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                  <div className="row">{actions(r)}</div>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <button type="button" className="backdrop" aria-label="Close dialog" tabIndex={-1} onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <header className="drawer-head">
          <h2>{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            Close
          </button>
        </header>
        {children}
      </aside>
    </>
  );
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="logo">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path d="M9 22l5-6 4 3 5-8" stroke="var(--accent-contrast)" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
