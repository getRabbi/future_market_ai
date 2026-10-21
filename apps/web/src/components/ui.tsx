import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../lib/api.js';
import { formatValue, humanize, isStatusKey, tone } from '../lib/format.js';

export function Badge({ value }: { value: unknown }) {
  return <span className={`badge ${tone(value)}`}>{String(value)}</span>;
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  const hint = e.code === 'MFA_REQUIRED' || /multi-factor/i.test(e.message ?? '') ? 'This action needs a two-factor session. Enrol TOTP under Account & security, sign out and sign back in.' : e.status === 401 ? 'Your session has ended. Sign in again.' : e.status === 403 ? 'Your role does not allow this action.' : null;
  return (
    <div className="notice error" role="alert">
      <strong>{e.message ?? String(error)}</strong>
      {e.code ? <span className="muted small"> ({e.code})</span> : null}
      {hint ? <div className="small">{hint}</div> : null}
      {e.details ? (
        <details className="small">
          <summary>Details</summary>
          <pre>{JSON.stringify(e.details, null, 2)}</pre>
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

export function DataTable({ rows, columns, onRowClick, actions, empty = 'Nothing here yet.' }: { rows: Record<string, unknown>[]; columns?: string[]; onRowClick?: (r: Record<string, unknown>) => void; actions?: (r: Record<string, unknown>) => ReactNode; empty?: string }) {
  if (rows.length === 0) return <p className="muted small">{empty}</p>;
  const keys = new Set(rows.flatMap((r) => Object.keys(r)));
  let cols = (columns ?? []).filter((c) => keys.has(c));
  if (cols.length === 0) cols = [...keys].filter((k) => k !== 'tenantId').slice(0, 7);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} scope="col">
                {humanize(c)}
              </th>
            ))}
            {actions ? <th scope="col">Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={String(r.id ?? i)} className={onRowClick ? 'clickable' : undefined} tabIndex={onRowClick ? 0 : undefined} onClick={onRowClick ? () => onRowClick(r) : undefined} onKeyDown={onRowClick ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onRowClick(r)) : undefined}>
              {cols.map((c) => (
                <td key={c}>{isStatusKey(c) && r[c] !== null && r[c] !== undefined ? <Badge value={r[c]} /> : <span className="cell">{formatValue(c, r[c])}</span>}</td>
              ))}
              {actions ? (
                <td onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
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

/** JSON body editor: parses on submit and shows the server's validation issues verbatim. */
export function JsonForm({ initial, submitLabel, onSubmit, note }: { initial: unknown; submitLabel: string; onSubmit: (body: unknown) => Promise<unknown>; note?: string }) {
  const [text, setText] = useState(() => JSON.stringify(initial, null, 2));
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (err) {
      setError(new ApiError(`Invalid JSON: ${(err as Error).message}`, 0, 'CLIENT', null));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setResult(await onSubmit(body));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      {note ? <p className="small muted">{note}</p> : null}
      <textarea aria-label="Request body (JSON)" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      <div className="row">
        <button type="button" className="primary" onClick={submit} disabled={busy}>
          {busy ? 'Working…' : submitLabel}
        </button>
        <button type="button" onClick={() => setText(JSON.stringify(initial, null, 2))} disabled={busy}>
          Reset
        </button>
      </div>
      <ErrorNotice error={error} />
      {result !== undefined ? (
        <details open>
          <summary className="small">Response</summary>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </details>
      ) : null}
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
        <header className="row" style={{ justifyContent: 'space-between', marginBottom: '0.75rem' }}>
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

export function Json({ value }: { value: unknown }) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="logo">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path d="M9 22l5-6 4 3 5-8" stroke="var(--accent-contrast)" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
