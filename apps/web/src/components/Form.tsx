import { type ReactNode, useId, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { EVIDENCE_FORM, evidenceLine, evidenceNotice, QUARANTINE_HELP } from '../lib/fieldsets.js';
import { formatValue, humanize, isStatusKey, isUuid } from '../lib/format.js';
import { buildBody, type EvidenceField, evidenceReadiness, type Field, type FormNotice, type FormSpec, humanError, initialValues, isVisible, mapIssues, type PairsField, READINESS_LABEL, type RecordField, type Row, type RowsField, rowId, type TagsField, type Values, validate } from '../lib/forms.js';
import { Badge, DataTable, Drawer, ErrorNotice, pickRows, useApi } from './ui.js';

export type { FormNotice };

/* ------------------------------------------------------------------ */
/* Guided form                                                         */
/* ------------------------------------------------------------------ */

/**
 * A form built from field descriptions: required and optional fields are marked, problems show
 * next to the field in plain language, and an advanced JSON view stays one click away for
 * people who need fields the form does not offer. The server validates every submission.
 */
export function GuidedForm({
  spec,
  submitLabel,
  onSubmit,
  onCancel,
  onDone,
  success,
  intro,
  allowJson = true,
  resetOnSuccess = true,
  disabledReason,
}: {
  spec: FormSpec;
  submitLabel: string;
  onSubmit: (body: Row) => Promise<unknown>;
  onCancel?: () => void;
  onDone?: (result: unknown) => void;
  success?: (result: unknown) => FormNotice | null;
  intro?: ReactNode;
  allowJson?: boolean;
  resetOnSuccess?: boolean;
  /** When set, the submit button is disabled and this explains why. */
  disabledReason?: string | null;
}) {
  const formId = useId();
  const [values, setValues] = useState<Values>(() => initialValues(spec.fields));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [notice, setNotice] = useState<FormNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [json, setJson] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const visible = spec.fields.filter((f) => isVisible(f, values));
  const main = visible.filter((f) => !f.advanced);
  const advanced = visible.filter((f) => f.advanced);
  const hasRequired = visible.some((f) => f.required);

  const set = (key: string, v: unknown) => {
    setValues((cur) => ({ ...cur, [key]: v }));
    if (errors[key]) setErrors(({ [key]: _, ...rest }) => rest);
  };

  const submit = async () => {
    setFailure(null);
    setNotice(null);
    let body: Row;
    if (json !== null) {
      try {
        body = JSON.parse(json) as Row;
      } catch (err) {
        setFailure(new Error(`The JSON could not be read: ${(err as Error).message}`));
        return;
      }
    } else {
      const found = validate(spec.fields, values);
      setErrors(found);
      if (Object.keys(found).length) {
        const first = spec.fields.find((f) => found[f.key]);
        if (first?.advanced) formRef.current?.querySelector('details.more')?.setAttribute('open', '');
        requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
        return;
      }
      body = buildBody(spec, values);
    }
    setBusy(true);
    try {
      const result = await onSubmit(body);
      setNotice(success ? success(result) : { tone: 'ok', title: 'Saved.' });
      if (resetOnSuccess) setValues(initialValues(spec.fields));
      setErrors({});
      onDone?.(result);
    } catch (err) {
      setFailure(err);
      if (json === null) setErrors(mapIssues(spec.fields, (err as { details?: unknown }).details).fields);
    } finally {
      setBusy(false);
    }
  };

  const errorCount = Object.keys(errors).length;
  return (
    <form
      ref={formRef}
      className="guided"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {intro ? <div className="form-intro">{intro}</div> : null}
      {json === null ? (
        <>
          {hasRequired ? (
            <p className="form-legend">
              Fields marked <span className="req">*</span> are required.
            </p>
          ) : null}
          <div className="form-grid">
            {main.map((f) => (
              <FieldRow key={`${f.key}-${f.label}`} field={f} idBase={formId} values={values} error={errors[f.key]} onChange={(v) => set(f.key, v)} onSet={set} />
            ))}
          </div>
          {advanced.length ? (
            <details className="more">
              <summary>More options</summary>
              <div className="form-grid">
                {advanced.map((f) => (
                  <FieldRow key={`${f.key}-${f.label}`} field={f} idBase={formId} values={values} error={errors[f.key]} onChange={(v) => set(f.key, v)} onSet={set} />
                ))}
              </div>
            </details>
          ) : null}
        </>
      ) : (
        <div className="field">
          <label htmlFor={`${formId}-json`}>Request (JSON)</label>
          <textarea id={`${formId}-json`} className="json" value={json} spellCheck={false} onChange={(e) => setJson(e.target.value)} rows={14} />
          <p className="help">For advanced use. The server checks everything exactly as for the form; changes here are not copied back to the form.</p>
        </div>
      )}
      {errorCount ? (
        <div className="notice error" role="alert">
          <strong>{errorCount === 1 ? 'One field needs' : `${errorCount} fields need`} attention before this can be sent.</strong>
        </div>
      ) : null}
      {failure ? <ErrorNotice error={failure} fields={spec.fields} /> : null}
      {notice ? <Notice notice={notice} /> : null}
      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy || Boolean(disabledReason)} title={disabledReason ?? undefined}>
          {busy ? 'Working…' : submitLabel}
        </button>
        {onCancel ? (
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        ) : null}
        {allowJson ? (
          <button type="button" className="link" onClick={() => setJson(json === null ? JSON.stringify(buildBody(spec, values), null, 2) : null)} disabled={busy}>
            {json === null ? 'Advanced: edit as JSON' : 'Back to the form'}
          </button>
        ) : null}
      </div>
      {disabledReason ? <p className="help">{disabledReason}</p> : null}
    </form>
  );
}

export function Notice({ notice }: { notice: FormNotice }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={`notice ${notice.tone === 'warn' ? 'warn' : 'ok'}`} role="status">
      <strong>{notice.title}</strong>
      {notice.text ? <div className="small">{notice.text}</div> : null}
      {notice.items?.length ? (
        <ul className="small tight">
          {notice.items.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      ) : null}
      {notice.secret ? (
        <div className="secret">
          <span className="small">{notice.secret.label}</span>
          <code className="mono">{notice.secret.value}</code>
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard?.writeText(notice.secret!.value).then(
                () => setCopied(true),
                () => setCopied(false),
              )
            }
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One field: label, control, help and error                           */
/* ------------------------------------------------------------------ */

function FieldRow({ field: f, idBase, values, error, onChange, onSet }: { field: Field; idBase: string; values: Values; error?: string; onChange: (v: unknown) => void; onSet: (key: string, v: unknown) => void }) {
  const id = `${idBase}-${f.key.replace(/\W/g, '-')}`;
  const helpId = f.help ? `${id}-help` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [helpId, errId].filter(Boolean).join(' ') || undefined;
  const group = f.type === 'choices' || f.type === 'evidence' || f.type === 'rows' || f.type === 'pairs' || f.type === 'tags' || (f.type === 'record' && f.multiple);
  const wide = group || f.type === 'textarea';
  const heading = (
    <>
      {f.label}
      {f.required ? (
        <span className="req" aria-hidden="true">
          {' '}
          *
        </span>
      ) : (
        <span className="opt"> optional</span>
      )}
      {f.required ? <span className="sr-only"> (required)</span> : null}
    </>
  );
  const control = <Control field={f} id={id} value={values[f.key]} values={values} onChange={onChange} onSet={onSet} invalid={Boolean(error)} describedBy={describedBy} />;
  if (f.type === 'toggle') {
    return (
      <div className={`field toggle${wide ? ' wide' : ''}`}>
        <label className="check" htmlFor={id}>
          {control}
          <span>{f.label}</span>
        </label>
        {f.help ? (
          <p className="help" id={helpId}>
            {f.help}
          </p>
        ) : null}
        {error ? (
          <p className="field-error" id={errId}>
            {error}
          </p>
        ) : null}
      </div>
    );
  }
  return group ? (
    <fieldset className={`field group${wide ? ' wide' : ''}${error ? ' has-error' : ''}`} aria-describedby={describedBy}>
      <legend>{heading}</legend>
      {f.help ? (
        <p className="help" id={helpId}>
          {f.help}
        </p>
      ) : null}
      {control}
      {error ? (
        <p className="field-error" id={errId}>
          {error}
        </p>
      ) : null}
    </fieldset>
  ) : (
    <div className={`field${wide ? ' wide' : ''}${error ? ' has-error' : ''}`}>
      <label htmlFor={id}>{heading}</label>
      {control}
      {f.help ? (
        <p className="help" id={helpId}>
          {f.help}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={errId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Control({ field: f, id, value, values, onChange, onSet, invalid, describedBy }: { field: Field; id: string; value: unknown; values: Values; onChange: (v: unknown) => void; onSet: (key: string, v: unknown) => void; invalid: boolean; describedBy?: string }) {
  const aria = { 'aria-invalid': invalid || undefined, 'aria-describedby': describedBy } as const;
  const loadFile = (text: string, name: string) => {
    onChange(text);
    const target = 'fromFile' in f ? f.fromFile?.nameTo : undefined;
    if (target && !values[target]) onSet(target, name);
  };
  switch (f.type) {
    case 'text':
    case 'email':
    case 'url':
      return (
        <div className="stack-xs">
          <input id={id} type={f.type === 'text' ? 'text' : f.type} value={String(value ?? '')} placeholder={f.placeholder} maxLength={f.maxLength} onChange={(e) => onChange(e.target.value)} {...aria} />
          {f.fromFile ? <FileLoader accept={f.fromFile.accept} hash={f.fromFile.hash} onLoad={loadFile} /> : null}
        </div>
      );
    case 'textarea': {
      const s = String(value ?? '');
      return (
        <div className="stack-xs">
          <textarea id={id} className="prose" rows={f.rows ?? 4} value={s} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} {...aria} />
          <div className="row between">
            {f.fromFile ? <FileLoader accept={f.fromFile.accept} hash={f.fromFile.hash} onLoad={loadFile} /> : <span />}
            {f.maxLength ? (
              <span className={`counter${s.length > f.maxLength ? ' over' : ''}`}>
                {s.length.toLocaleString()} / {f.maxLength.toLocaleString()}
              </span>
            ) : null}
          </div>
        </div>
      );
    }
    case 'number':
      return (
        <div className="input-unit">
          <input id={id} type="text" inputMode="decimal" value={String(value ?? '')} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} {...aria} />
          {f.unit ? <span className="unit">{f.unit}</span> : null}
        </div>
      );
    case 'select': {
      const hasBlank = f.options.some((o) => o.value === '');
      const hint = f.options.find((o) => o.value === value)?.hint;
      return (
        <div className="stack-xs">
          <select id={id} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} {...aria}>
            {!hasBlank ? (
              <option value="" disabled={f.required}>
                Choose…
              </option>
            ) : null}
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {hint ? <span className="help">{hint}</span> : null}
        </div>
      );
    }
    case 'choices': {
      const list = (value as string[]) ?? [];
      return (
        <div className="choice-chips">
          {f.options.map((o) => (
            <label key={o.value} className={`chip-check${list.includes(o.value) ? ' on' : ''}`}>
              <input type="checkbox" checked={list.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...list, o.value] : list.filter((x) => x !== o.value))} />
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    case 'tags':
      return <TagsInput field={f} id={id} value={(value as string[]) ?? []} onChange={onChange} invalid={invalid} />;
    case 'date':
      return <input id={id} type="date" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} {...aria} />;
    case 'datetime':
      return <input id={id} type="datetime-local" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} {...aria} />;
    case 'toggle':
      return <input id={id} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} {...aria} />;
    case 'record':
      return <RecordPicker field={f} id={id} value={value} values={values} onChange={onChange} invalid={invalid} describedBy={describedBy} />;
    case 'evidence':
      return <EvidencePicker field={f} id={id} value={value} onChange={onChange} />;
    case 'rows':
      return <RowsInput field={f} id={id} value={(value as Values[]) ?? []} onChange={onChange} />;
    case 'pairs':
      return <PairsInput field={f} id={id} value={(value as [string, string][]) ?? []} onChange={onChange} />;
  }
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function FileLoader({ accept, hash, onLoad }: { accept: string; hash?: boolean | undefined; onLoad: (text: string, name: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="file-loader">
      <button type="button" className="link" onClick={() => ref.current?.click()}>
        {hash ? 'Compute from the file…' : 'Load from a file…'}
      </button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          const name = file.name.replace(/\.[^.]+$/, '');
          setError(null);
          if (hash) return onLoad(await sha256Hex(await file.arrayBuffer()), name);
          if (file.size > 2_000_000) return setError('That file is larger than 2 MB. Paste the relevant part instead.');
          onLoad(await file.text(), name);
        }}
      />
      {error ? <span className="field-error"> {error}</span> : null}
    </span>
  );
}

function TagsInput({ field: f, id, value, onChange, invalid }: { field: TagsField; id: string; value: string[]; onChange: (v: unknown) => void; invalid: boolean }) {
  const [draft, setDraft] = useState('');
  const norm = (s: string) => (f.case === 'upper' ? s.toUpperCase() : f.case === 'lower' ? s.toLowerCase() : s).trim();
  const add = (raw: string) => {
    const items = raw.split(/[,\n]/).map(norm).filter(Boolean);
    const next = [...value];
    for (const i of items) if (!next.includes(i)) next.push(i);
    onChange(next);
    setDraft('');
  };
  const left = (f.suggestions ?? []).filter((s) => !value.includes(s));
  return (
    <div className="tags">
      {value.length ? (
        <ul className="tag-list" aria-label={`${f.label}: chosen`}>
          {value.map((t) => (
            <li key={t} className="tag">
              {t}
              <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((x) => x !== t))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="row">
        <input
          id={id}
          value={draft}
          placeholder={f.placeholder ?? 'Type and press Enter'}
          aria-invalid={invalid || undefined}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ',') && draft.trim()) {
              e.preventDefault();
              add(draft);
            }
          }}
          onBlur={() => draft.trim() && add(draft)}
        />
      </div>
      {left.length ? (
        <div className="row suggestions">
          <span className="help">Quick add:</span>
          {left.map((s) => (
            <button key={s} type="button" className="chip-btn" onClick={() => add(s)}>
              + {s}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RowsInput({ field: f, id, value, onChange }: { field: RowsField; id: string; value: Values[]; onChange: (v: unknown) => void }) {
  const update = (i: number, key: string, v: unknown) => onChange(value.map((row, j) => (j === i ? { ...row, [key]: v } : row)));
  return (
    <div className="rows-input">
      {value.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until saved
        <div className="row-item" key={i}>
          <div className="row between">
            <strong className="small">
              {f.itemLabel ?? 'Entry'} {i + 1}
            </strong>
            {value.length > (f.min ?? 0) ? (
              <button type="button" className="link danger-link" onClick={() => onChange(value.filter((_, j) => j !== i))}>
                Remove
              </button>
            ) : null}
          </div>
          <div className="form-grid">
            {f.fields
              .filter((sf) => isVisible(sf, row))
              .map((sf) => (
                <FieldRow key={`${sf.key}-${sf.label}`} field={sf} idBase={`${id}-${i}`} values={row} onChange={(v) => update(i, sf.key, v)} onSet={(k, v) => update(i, k, v)} />
              ))}
          </div>
        </div>
      ))}
      {!f.max || value.length < f.max ? (
        <button type="button" onClick={() => onChange([...value, initialValues(f.fields)])}>
          + {f.addLabel}
        </button>
      ) : null}
    </div>
  );
}

function PairsInput({ field: f, id, value, onChange }: { field: PairsField; id: string; value: [string, string][]; onChange: (v: unknown) => void }) {
  const rows: [string, string][] = value.length ? value : [['', '']];
  const update = (i: number, part: 0 | 1, v: string) => onChange(rows.map((r, j) => (j === i ? (part === 0 ? [v, r[1]] : [r[0], v]) : r)));
  return (
    <div className="pairs">
      {rows.map(([k, v], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: pairs have no identity until saved
        <div className="pair" key={i}>
          {f.keyOptions ? (
            <select aria-label={`${f.keyLabel} ${i + 1}`} id={i === 0 ? id : undefined} value={k} onChange={(e) => update(i, 0, e.target.value)}>
              <option value="">Choose…</option>
              {f.keyOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input aria-label={`${f.keyLabel} ${i + 1}`} id={i === 0 ? id : undefined} value={k} placeholder={f.keyPlaceholder} onChange={(e) => update(i, 0, e.target.value)} />
          )}
          <input aria-label={`${f.valueLabel} ${i + 1}`} value={v} placeholder={f.valuePlaceholder} onChange={(e) => update(i, 1, e.target.value)} />
          <button type="button" aria-label={`Remove line ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))} disabled={rows.length === 1 && !k && !v}>
            ×
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rows, ['', '']])}>
        + Add a line
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pickers                                                             */
/* ------------------------------------------------------------------ */

function RecordPicker({ field: f, id, value, values, onChange, invalid, describedBy }: { field: RecordField; id: string; value: unknown; values: Values; onChange: (v: unknown) => void; invalid: boolean; describedBy?: string }) {
  const src = f.source;
  const path = typeof src.list === 'function' ? src.list(values) : src.list;
  const list = useApi<unknown>(path);
  const [q, setQ] = useState('');
  const valueKey = src.valueKey ?? 'id';
  const rows = pickRows(list.data, src.pick).filter((r) => (src.filter ? src.filter(r) : true));
  if (!path) return <p className="help">Fill in the fields above first.</p>;
  if (list.loading && !list.data) return <p className="help loading-line">Loading choices…</p>;
  if (list.error) return <p className="help">The list could not be loaded ({humanError(list.error).title}).</p>;
  if (rows.length === 0) {
    return (
      <p className="empty-inline">
        {src.empty}{' '}
        {src.href ? (
          <a href={src.href} target="_blank" rel="noreferrer">
            Open in a new tab
          </a>
        ) : null}
      </p>
    );
  }
  if (!f.multiple) {
    return (
      <select id={id} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid || undefined} aria-describedby={describedBy}>
        <option value="">Choose…</option>
        {rows.map((r) => (
          <option key={String(r[valueKey])} value={String(r[valueKey])}>
            {src.label(r)}
            {src.detail ? ` — ${src.detail(r)}` : ''}
          </option>
        ))}
      </select>
    );
  }
  const chosen = (value as string[]) ?? [];
  const shown = q ? rows.filter((r) => `${src.label(r)} ${src.detail?.(r) ?? ''}`.toLowerCase().includes(q.toLowerCase())) : rows;
  return (
    <div className="picker">
      {rows.length > 8 ? <input type="search" aria-label={`Search ${f.label}`} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} /> : null}
      <ul className="pick-list">
        {shown.map((r) => {
          const v = String(r[valueKey]);
          return (
            <li key={v}>
              <label className={`pick${chosen.includes(v) ? ' on' : ''}`}>
                <input type="checkbox" checked={chosen.includes(v)} onChange={(e) => onChange(e.target.checked ? [...chosen, v] : chosen.filter((x) => x !== v))} />
                <span>
                  <span className="pick-title">{src.label(r)}</span>
                  {src.detail ? <span className="pick-detail">{src.detail(r)}</span> : null}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <p className="help">{chosen.length ? `${chosen.length} chosen` : 'None chosen'}</p>
    </div>
  );
}

/**
 * Evidence picker: only admitted, up-to-date evidence can be chosen (the same rule the server
 * enforces); anything else is listed with the reason. New evidence can be added in place.
 */
export function EvidencePicker({ field: f, id, value, onChange }: { field: Pick<EvidenceField, 'label' | 'multiple' | 'kinds'>; id: string; value: unknown; onChange: (v: unknown) => void }) {
  const list = useApi<Row[]>('/v1/evidence?limit=300');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<FormNotice | null>(null);
  const chosen = f.multiple ? ((value as string[]) ?? []) : value ? [String(value)] : [];
  const all = (list.data ?? []).filter((e) => !f.kinds || f.kinds.includes(String(e.kind)));
  const now = new Date();
  const ready = all.filter((e) => evidenceReadiness(e, now) === 'ready');
  const blocked = all.filter((e) => evidenceReadiness(e, now) !== 'ready');
  const match = (e: Row) => !q || `${e.summary ?? ''} ${e.sourceOwner ?? ''} ${e.sourceUriOrObjectId ?? ''}`.toLowerCase().includes(q.toLowerCase());
  const toggle = (eid: string, on: boolean) => onChange(f.multiple ? (on ? [...chosen, eid] : chosen.filter((x) => x !== eid)) : on ? eid : '');

  return (
    <div className="picker evidence-picker">
      {list.loading && !list.data ? <p className="help loading-line">Loading evidence…</p> : null}
      {list.error ? <p className="help">Evidence could not be loaded ({humanError(list.error).title}).</p> : null}
      {list.data && ready.length === 0 ? (
        <div className="empty-inline">
          <strong>No usable evidence yet.</strong> Add the report, page or data that proves this. It becomes usable once it is admitted (rights, personal data and reliability known).
        </div>
      ) : null}
      {ready.length > 6 ? <input type="search" aria-label="Search evidence" placeholder="Search evidence…" value={q} onChange={(e) => setQ(e.target.value)} /> : null}
      {ready.length ? (
        <ul className="pick-list" id={id}>
          {ready.filter(match).map((e) => {
            const eid = rowId(e);
            const on = chosen.includes(eid);
            return (
              <li key={eid}>
                <label className={`pick${on ? ' on' : ''}`}>
                  <input type={f.multiple ? 'checkbox' : 'radio'} name={`${id}-evidence`} checked={on} onChange={(ev) => toggle(eid, ev.target.checked)} />
                  <span>
                    <span className="pick-title">{String(e.summary ?? e.sourceUriOrObjectId)}</span>
                    <span className="pick-detail">{evidenceLine(e)}</span>
                  </span>
                  <span className="badge ok">{READINESS_LABEL.ready}</span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : null}
      {blocked.length ? (
        <details className="small">
          <summary>
            {blocked.length} not usable yet ({blocked.length === 1 ? 'it needs' : 'they need'} review or {blocked.length === 1 ? 'is' : 'are'} out of date)
          </summary>
          <ul className="pick-list muted-list">
            {blocked.map((e) => {
              const r = evidenceReadiness(e, now);
              const reasons = Array.isArray(e.quarantineReasons) ? (e.quarantineReasons as string[]) : [];
              return (
                <li key={rowId(e)} className="pick disabled">
                  <span>
                    <span className="pick-title">{String(e.summary ?? e.sourceUriOrObjectId)}</span>
                    <span className="pick-detail">{r === 'quarantined' && reasons.length ? reasons.map((x) => QUARANTINE_HELP[x] ?? x).join(' ') : evidenceLine(e)}</span>
                  </span>
                  <span className={`badge ${r === 'quarantined' || r === 'stale' ? 'warn' : 'danger'}`}>{READINESS_LABEL[r]}</span>
                </li>
              );
            })}
          </ul>
          <a href="/app/evidence" target="_blank" rel="noreferrer">
            Review evidence in a new tab
          </a>
        </details>
      ) : null}
      {added ? <Notice notice={added} /> : null}
      <div className="row">
        <button type="button" onClick={() => setAdding(true)}>
          + Add new evidence
        </button>
        <button type="button" className="link" onClick={() => void list.reload()} disabled={list.loading}>
          {list.loading ? 'Refreshing…' : 'Refresh list'}
        </button>
        <span className="help">{chosen.length ? `${chosen.length} chosen` : 'None chosen'}</span>
      </div>
      {adding ? (
        <Drawer title="Add evidence" onClose={() => setAdding(false)}>
          <EvidenceForm
            onDone={async (rec) => {
              await list.reload();
              const ok = rec.status === 'admitted' && evidenceReadiness(rec) === 'ready';
              if (ok) toggle(rowId(rec), true);
              setAdded(evidenceNotice(rec, true));
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        </Drawer>
      ) : null}
    </div>
  );
}

/** The guided "Add evidence" form (M01), also used inside the evidence picker. */
export function EvidenceForm({ onDone, onCancel }: { onDone?: (rec: Row) => void; onCancel?: () => void }) {
  return <GuidedForm spec={EVIDENCE_FORM} submitLabel="Add evidence" onSubmit={(body) => api('POST', '/v1/evidence', body)} success={(r) => evidenceNotice(r as Row)} onDone={(r) => onDone?.(r as Row)} {...(onCancel ? { onCancel } : {})} />;
}

/* ------------------------------------------------------------------ */
/* Readable records                                                    */
/* ------------------------------------------------------------------ */

const HIDDEN = new Set(['tenantId', 'tenant_id', 'normalizedText', 'contentSha256', 'objectKey', 'contentObjectKey', 'schemaVersion']);

/** Any API result as labelled values instead of raw JSON; the JSON stays under "Technical details". */
export function ReadableRecord({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined) return <p className="muted small">Nothing to show.</p>;
  if (Array.isArray(value)) {
    if (value.every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
      return depth > 1 ? <span>{formatValue('', value)}</span> : <DataTable rows={value as Row[]} empty="Nothing here." />;
    }
    return <span>{formatValue('', value)}</span>;
  }
  if (typeof value !== 'object') return <span>{formatValue('', value)}</span>;
  const entries = Object.entries(value as Row).filter(([k]) => !HIDDEN.has(k));
  return (
    <div className="stack">
      <dl className={`kv${depth ? ' nested' : ''}`}>
        {entries.map(([k, v]) => (
          <div key={k} className="kv-row">
            <dt>{humanize(k)}</dt>
            <dd>
              {v && typeof v === 'object' && depth < 2 && (!Array.isArray(v) || v.some((x) => x && typeof x === 'object')) ? (
                <ReadableRecord value={v} depth={depth + 1} />
              ) : isStatusKey(k) && v !== null && v !== undefined ? (
                <Badge value={v} />
              ) : (
                <span title={isUuid(v) ? String(v) : undefined}>{formatValue(k, v)}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {depth === 0 ? (
        <details className="small">
          <summary>Technical details</summary>
          <pre>{JSON.stringify(value, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}
