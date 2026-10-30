import { useState } from 'react';
import { api } from '../lib/api.js';
import type { Resource, RowAction } from '../lib/catalog.js';
import { type FormNotice, type Row, resolvePath, rowId } from '../lib/forms.js';
import { GuidedForm, Notice, ReadableRecord } from './Form.js';
import { useJourney } from './Journey.js';
import { DataTable, Drawer, EmptyState, ErrorNotice, pickRows, useApi } from './ui.js';

const actionPath = (a: RowAction, row: Row) => a.path.replace(':id', encodeURIComponent(rowId(row)));

function visible(a: RowAction, row: Row): boolean {
  return !a.when || a.when.values.includes(row[a.when.field]);
}

/**
 * One catalog resource: its list with row actions, and its guided create form. A create button
 * opens the form in place (and hides while it is open), so each action has exactly one button.
 */
export function ResourcePanel({ resource, headingLevel = 2 }: { resource: Resource; headingLevel?: 2 | 3 }) {
  const me = useJourney()?.me;
  const list = useApi<unknown>(resource.list ?? null);
  const rows = resource.rows ? resource.rows(list.data) : pickRows(list.data, resource.pick);
  const [creating, setCreating] = useState(!resource.list);
  const [detail, setDetail] = useState<{ title: string; value: unknown } | null>(null);
  const [active, setActive] = useState<{ action: RowAction; row: Row } | null>(null);
  const [flash, setFlash] = useState<FormNotice | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [running, setRunning] = useState<string | null>(null);
  const Heading = `h${headingLevel}` as 'h2' | 'h3';
  const headingId = `res-${resource.title.replace(/\W+/g, '-').toLowerCase()}`;
  const mine = (a: RowAction, row: Row) => Boolean(a.notMine && me && row[a.notMine.field] === `user:${me.userId}`);

  const call = (a: RowAction, row: Row, input: Row = {}) => {
    const method = a.method ?? 'POST';
    return method === 'GET' ? api('GET', actionPath(a, row)) : api(method, actionPath(a, row), { ...(a.body ?? {}), ...input });
  };
  const after = async (a: RowAction, result: unknown) => {
    if (a.showResult) setDetail({ title: a.label, value: result });
    else setFlash({ tone: 'ok', title: a.done ?? `${a.label}: done.` });
    if ((a.method ?? 'POST') !== 'GET') await list.reload();
  };
  const runNow = async (a: RowAction, row: Row) => {
    setActionError(null);
    setFlash(null);
    setRunning(`${rowId(row)}:${a.label}`);
    try {
      await after(a, await call(a, row));
    } catch (err) {
      setActionError(err);
    } finally {
      setRunning(null);
      setActive(null);
    }
  };

  const openDetail = async (row: Row) => {
    if (!resource.detail) return setDetail({ title: resource.title, value: row });
    try {
      setDetail({ title: resource.title, value: await api('GET', actionPath({ label: '', path: resource.detail }, row)) });
    } catch (err) {
      setActionError(err);
    }
  };

  const create = resource.create;
  const loaded = !resource.list || list.data !== null;
  return (
    <section className="card resource" aria-labelledby={headingId}>
      <header>
        <div>
          <Heading id={headingId}>{resource.title}</Heading>
          {resource.description ? <p className="small muted desc">{resource.description}</p> : null}
        </div>
        <div className="row">
          {create && resource.list && !creating ? (
            <button type="button" className="primary" onClick={() => setCreating(true)}>
              + {create.label}
            </button>
          ) : null}
          {resource.list ? (
            <button type="button" className="ghost" onClick={() => void list.reload()} disabled={list.loading} aria-label={`Refresh ${resource.title}`}>
              {list.loading ? 'Loading…' : 'Refresh'}
            </button>
          ) : null}
        </div>
      </header>

      {create && creating ? (
        <div className="create-card">
          {resource.list ? <h3>{create.label}</h3> : null}
          <GuidedForm
            spec={create.form}
            submitLabel={create.submitLabel ?? create.label}
            intro={create.intro}
            onSubmit={async (body) => {
              const { path, body: rest } = resolvePath(create.path, body, create.form.pathParams);
              return api(create.method ?? 'POST', path, rest);
            }}
            success={create.success ? (r) => create.success!((r ?? {}) as Row) : undefined}
            onDone={() => {
              if (resource.list) void list.reload();
            }}
            {...(resource.list ? { onCancel: () => setCreating(false) } : {})}
          />
        </div>
      ) : null}

      {flash ? <Notice notice={flash} /> : null}
      <ErrorNotice error={list.error ?? actionError} />

      {resource.list ? (
        <DataTable
          rows={rows}
          columns={resource.columns}
          labels={resource.labels}
          loading={!loaded || (list.loading && rows.length === 0)}
          onRowClick={(r) => void openDetail(r)}
          empty={<EmptyState title={resource.empty ?? 'Nothing here yet.'}>{create && !creating ? `Use “${create.label}” above to start.` : null}</EmptyState>}
          actions={
            resource.rowActions?.length
              ? (row) => {
                  const acts = resource.rowActions!.filter((a) => visible(a, row));
                  const waiting = acts.find((a) => mine(a, row) && a.notMine?.note);
                  return (
                    <>
                      {acts
                        .filter((a) => !mine(a, row))
                        .map((a) => {
                          const busy = running === `${rowId(row)}:${a.label}`;
                          return (
                            <button
                              key={a.label}
                              type="button"
                              className={`sm${a.danger ? ' danger' : ''}`}
                              disabled={busy}
                              onClick={() => {
                                setFlash(null);
                                setActionError(null);
                                if (a.form || a.confirm) setActive({ action: a, row });
                                else void runNow(a, row);
                              }}
                            >
                              {busy ? 'Working…' : a.label}
                            </button>
                          );
                        })}
                      {waiting ? <span className="small muted">{waiting.notMine!.note}</span> : null}
                    </>
                  );
                }
              : undefined
          }
        />
      ) : null}

      {active?.action.form ? (
        <Drawer title={active.action.label} onClose={() => setActive(null)}>
          <GuidedForm
            spec={typeof active.action.form === 'function' ? active.action.form(active.row) : active.action.form}
            submitLabel={active.action.label}
            intro={typeof active.action.intro === 'function' ? active.action.intro(active.row) : active.action.intro}
            resetOnSuccess={false}
            onSubmit={(body) => call(active.action, active.row, body)}
            success={() => null}
            onDone={(r) => {
              const a = active.action;
              setActive(null);
              void after(a, r);
            }}
            onCancel={() => setActive(null)}
          />
        </Drawer>
      ) : null}
      {active && !active.action.form ? (
        <Drawer title={active.action.label} onClose={() => setActive(null)}>
          <div className="stack">
            <p>{active.action.confirm}</p>
            <div className="form-actions">
              <button type="button" className={active.action.danger ? 'danger solid' : 'primary'} disabled={running !== null} onClick={() => void runNow(active.action, active.row)}>
                {running ? 'Working…' : `Yes, ${active.action.label.charAt(0).toLowerCase()}${active.action.label.slice(1)}`}
              </button>
              <button type="button" onClick={() => setActive(null)}>
                Cancel
              </button>
            </div>
          </div>
        </Drawer>
      ) : null}
      {detail ? (
        <Drawer title={detail.title} onClose={() => setDetail(null)}>
          <ReadableRecord value={detail.value} />
        </Drawer>
      ) : null}
    </section>
  );
}
