import { useState } from 'react';
import { api } from '../lib/api.js';
import type { Resource, RowAction } from '../lib/catalog.js';
import { DataTable, Drawer, ErrorNotice, Json, JsonForm, pickRows, useApi } from './ui.js';

const sub = (path: string, row: Record<string, unknown>) => path.replace(':id', encodeURIComponent(String(row.id ?? '')));

function visible(a: RowAction, row: Record<string, unknown>): boolean {
  return !a.when || a.when.values.includes(row[a.when.field]);
}

export function ResourcePanel({ resource }: { resource: Resource }) {
  const list = useApi<unknown>(resource.list ?? null);
  const [detail, setDetail] = useState<{ title: string; value: unknown } | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [prompting, setPrompting] = useState<{ action: RowAction; row: Record<string, unknown> } | null>(null);
  const [showCreate, setShowCreate] = useState(!resource.list);
  const rows = pickRows(list.data, resource.pick);

  const run = async (a: RowAction, row: Record<string, unknown>, input?: string) => {
    setActionError(null);
    try {
      let body: Record<string, unknown> | undefined = a.body ? { ...a.body } : undefined;
      if (a.prompt) {
        const v = a.prompt.json ? JSON.parse(input ?? '{}') : input;
        body = a.prompt.field === '*' ? { ...(body ?? {}), ...(v as Record<string, unknown>) } : { ...(body ?? {}), [a.prompt.field]: v };
      }
      // Row actions without a body are GET reads (lineage, stats, performance) unless the path is a known mutation.
      const isRead = !a.body && !a.prompt && !a.method && /\/(lineage|points|stats|performance|snapshots|download-url)$/.test(a.path);
      const res = isRead ? await api('GET', sub(a.path, row)) : await api(a.method ?? 'POST', sub(a.path, row), body ?? {});
      setDetail({ title: `${a.label}`, value: res });
      if (!isRead) await list.reload();
    } catch (err) {
      setActionError(err);
    } finally {
      setPrompting(null);
    }
  };

  const openDetail = async (row: Record<string, unknown>) => {
    if (!resource.detail) return setDetail({ title: 'Record', value: row });
    try {
      setDetail({ title: 'Record', value: await api('GET', sub(resource.detail, row)) });
    } catch (err) {
      setActionError(err);
    }
  };

  return (
    <section className="card" aria-labelledby={`res-${resource.title}`}>
      <header>
        <h2 id={`res-${resource.title}`}>{resource.title}</h2>
        <div className="row">
          {resource.list ? (
            <button type="button" onClick={() => void list.reload()} disabled={list.loading}>
              {list.loading ? 'Loading…' : 'Refresh'}
            </button>
          ) : null}
          {resource.create && resource.list ? (
            <button type="button" className="primary" onClick={() => setShowCreate((v) => !v)} aria-expanded={showCreate}>
              {resource.create.label}
            </button>
          ) : null}
        </div>
      </header>
      {resource.note ? <p className="small muted">{resource.note}</p> : null}
      {resource.create && showCreate ? (
        <div className="card" style={{ background: 'var(--surface-2)' }}>
          <JsonForm
            initial={resource.create.example}
            submitLabel={resource.create.label}
            note={resource.create.note}
            onSubmit={async (body) => {
              const res = await api(resource.create!.method ?? 'POST', resource.create!.path, body);
              if (resource.list) await list.reload();
              return res;
            }}
          />
        </div>
      ) : null}
      <ErrorNotice error={list.error ?? actionError} />
      {resource.list ? (
        <DataTable
          rows={rows}
          columns={resource.columns}
          onRowClick={(r) => void openDetail(r)}
          actions={
            resource.rowActions?.length
              ? (row) =>
                  resource
                    .rowActions!.filter((a) => visible(a, row))
                    .map((a) => (
                      <button key={a.label} type="button" className={a.danger ? 'danger' : undefined} onClick={() => (a.prompt ? setPrompting({ action: a, row }) : void run(a, row))}>
                        {a.label}
                      </button>
                    ))
              : undefined
          }
        />
      ) : null}
      {!resource.list && rows.length === 0 && list.data && typeof list.data === 'object' ? <Json value={list.data} /> : null}
      {prompting ? <PromptDialog action={prompting.action} onCancel={() => setPrompting(null)} onSubmit={(v) => void run(prompting.action, prompting.row, v)} /> : null}
      {detail ? (
        <Drawer title={detail.title} onClose={() => setDetail(null)}>
          <Json value={detail.value} />
        </Drawer>
      ) : null}
    </section>
  );
}

function PromptDialog({ action, onSubmit, onCancel }: { action: RowAction; onSubmit: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(action.prompt?.json ? '{\n  \n}' : '');
  return (
    <Drawer title={action.label} onClose={onCancel}>
      <div className="field">
        <label htmlFor="prompt-input">{action.prompt?.label}</label>
        {action.prompt?.json ? <textarea id="prompt-input" value={v} onChange={(e) => setV(e.target.value)} /> : <input id="prompt-input" value={v} onChange={(e) => setV(e.target.value)} />}
      </div>
      <div className="row">
        <button type="button" className={action.danger ? 'danger' : 'primary'} onClick={() => onSubmit(v)} disabled={!v.trim()}>
          {action.label}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </Drawer>
  );
}
