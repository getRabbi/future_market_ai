/**
 * Guided forms: every create and action form in the control plane is described as the fields a
 * person fills in, never as a raw request body. The same description builds the request body,
 * checks obvious mistakes before sending, and maps the server's validation issues back onto the
 * fields in plain language. The server stays the authority: nothing here relaxes a server check.
 */

export type Row = Record<string, unknown>;
export type Values = Record<string, unknown>;

/** What a form or action shows once it succeeds. */
export interface FormNotice {
  tone?: 'ok' | 'warn';
  title: string;
  text?: string;
  items?: string[];
  secret?: { label: string; value: string };
}

export interface Option {
  value: string;
  label: string;
  hint?: string;
}

export const opts = (...pairs: [string, string, string?][]): Option[] => pairs.map(([value, label, hint]) => ({ value, label, ...(hint ? { hint } : {}) }));

/** Where a record picker reads its choices from. */
export interface RecordSource {
  /** GET path returning an array (or an object holding one at `pick`); may depend on other fields. */
  list: string | ((values: Values) => string | null);
  pick?: string;
  /** Row field holding the value to submit (default `id`). */
  valueKey?: string;
  label: (row: Row) => string;
  detail?: (row: Row) => string;
  /** Rows that may be chosen; the rest are not offered. */
  filter?: (row: Row) => boolean;
  /** Shown when nothing can be chosen, ideally saying where to create one. */
  empty: string;
  href?: string;
}

interface FieldBase {
  /** Dotted path in the request body, e.g. `identifier.value`. */
  key: string;
  label: string;
  help?: string;
  placeholder?: string;
  required?: boolean;
  /** Send null instead of leaving the key out when the field is empty. */
  emptyAsNull?: boolean;
  /** Show only while another field (same form or row) holds one of these values. */
  showIf?: { key: string; values: unknown[] };
  /** Initial value, as the input holds it. */
  initial?: unknown;
  /** Folded under "More options". */
  advanced?: boolean;
}

export interface TextField extends FieldBase {
  type: 'text' | 'textarea' | 'email' | 'url';
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  patternHint?: string;
  case?: 'upper' | 'lower';
  rows?: number;
  /** Offer "Load from a file" (read in the browser): its text, or its SHA-256 with `hash`; the file name can fill another field. */
  fromFile?: { accept: string; nameTo?: string; hash?: boolean };
}

export interface NumberField extends FieldBase {
  type: 'number';
  min?: number;
  max?: number;
  integer?: boolean;
  unit?: string;
  /** Sent value = typed value × scale (e.g. 0.01 for percent → fraction, 1e6 for money → micros). */
  scale?: number;
}

export interface SelectField extends FieldBase {
  type: 'select';
  options: Option[];
  /** Option values are numbers sent as numbers. */
  numeric?: boolean;
}

export interface ChoicesField extends FieldBase {
  type: 'choices';
  options: Option[];
  min?: number;
}

export interface TagsField extends FieldBase {
  type: 'tags';
  suggestions?: string[];
  min?: number;
  max?: number;
  case?: 'upper' | 'lower';
  itemPattern?: RegExp;
  itemHint?: string;
}

export interface DateField extends FieldBase {
  /** `date` sends YYYY-MM-DD unless `iso` asks for a timestamp at the start or end of that day. */
  type: 'date' | 'datetime';
  iso?: 'start' | 'end';
}

export interface ToggleField extends FieldBase {
  type: 'toggle';
}

export interface RecordField extends FieldBase {
  type: 'record';
  source: RecordSource;
  multiple?: boolean;
  min?: number;
}

export interface EvidenceField extends FieldBase {
  type: 'evidence';
  multiple?: boolean;
  min?: number;
  /** Only these evidence kinds qualify (e.g. signed contracts). */
  kinds?: string[];
}

export interface RowsField extends FieldBase {
  type: 'rows';
  fields: Field[];
  min?: number;
  max?: number;
  addLabel: string;
  itemLabel?: string;
}

export interface PairsField extends FieldBase {
  type: 'pairs';
  keyLabel: string;
  valueLabel: string;
  keyOptions?: Option[];
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  min?: number;
}

export type Field = TextField | NumberField | SelectField | ChoicesField | TagsField | DateField | ToggleField | RecordField | EvidenceField | RowsField | PairsField;

export interface FormSpec {
  fields: Field[];
  /** Values the person never edits (e.g. a schema version); functions are evaluated on submit. */
  fixed?: Record<string, unknown>;
  /** Last-step reshaping for bodies a flat field list cannot express. */
  transform?: (body: Row, values: Values) => Row;
  /** Fields substituted into the request path (`:key`) instead of the body. */
  pathParams?: string[];
}

/* ------------------------------------------------------------------ */
/* Values and bodies                                                   */
/* ------------------------------------------------------------------ */

function emptyRaw(f: Field): unknown {
  switch (f.type) {
    case 'choices':
    case 'tags':
    case 'rows':
    case 'pairs':
      return [];
    case 'record':
    case 'evidence':
      return f.multiple ? [] : '';
    case 'toggle':
      return false;
    default:
      return '';
  }
}

export function initialValues(fields: Field[]): Values {
  const v: Values = {};
  for (const f of fields) {
    const init = typeof f.initial === 'function' ? (f.initial as () => unknown)() : f.initial;
    if (f.type === 'rows') {
      const n = Array.isArray(init) ? 0 : Math.max(f.min ?? 0, 1);
      v[f.key] = Array.isArray(init) ? init.map((r) => ({ ...initialValues(f.fields), ...(r as Values) })) : Array.from({ length: n }, () => initialValues(f.fields));
    } else v[f.key] = init ?? emptyRaw(f);
  }
  return v;
}

export function isVisible(f: Field, values: Values): boolean {
  return !f.showIf || f.showIf.values.includes(values[f.showIf.key]);
}

export function isEmpty(raw: unknown): boolean {
  return raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '') || (Array.isArray(raw) && raw.length === 0);
}

function setPath(target: Row, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = target;
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = cur[p] as Row;
  }
  cur[parts[parts.length - 1]!] = value;
}

const toIsoDay = (day: string, at: 'start' | 'end') => new Date(`${day}T${at === 'start' ? '00:00:00' : '23:59:59'}`).toISOString();

/** Convert one raw input value to what the API expects; undefined = leave the key out. */
function convert(f: Field, raw: unknown): unknown {
  if (f.type === 'rows') return (raw as Values[]).map((row) => buildObject(f.fields, row));
  if (f.type === 'toggle') return Boolean(raw);
  if (isEmpty(raw)) return f.emptyAsNull ? null : undefined;
  switch (f.type) {
    case 'number': {
      const n = Number(String(raw).replace(',', '.'));
      const scaled = f.scale ? n * f.scale : n;
      // Money in micros and other scaled integers must stay integers after floating-point maths.
      return f.scale && f.scale >= 1 ? Math.round(scaled) : f.scale ? Number(scaled.toFixed(10)) : scaled;
    }
    case 'text':
    case 'textarea':
    case 'email':
    case 'url': {
      const s = String(raw).trim();
      return f.case === 'upper' ? s.toUpperCase() : f.case === 'lower' ? s.toLowerCase() : s;
    }
    case 'tags':
      return (raw as string[]).map((t) => (f.case === 'upper' ? t.toUpperCase() : f.case === 'lower' ? t.toLowerCase() : t));
    case 'date':
      return f.iso ? toIsoDay(String(raw), f.iso) : String(raw);
    case 'datetime':
      return new Date(String(raw)).toISOString();
    case 'select':
      return f.numeric ? Number(raw) : raw;
    case 'pairs':
      return Object.fromEntries((raw as [string, string][]).filter(([k, v]) => k.trim() && v.trim()).map(([k, v]) => [k.trim(), v.trim()]));
    default:
      return raw;
  }
}

function buildObject(fields: Field[], values: Values): Row {
  const out: Row = {};
  for (const f of fields) {
    if (!isVisible(f, values)) continue;
    const v = convert(f, values[f.key]);
    if (v !== undefined) setPath(out, f.key, v);
  }
  return out;
}

/** The request body for these values: visible fields, then fixed values, then the transform. */
export function buildBody(spec: FormSpec, values: Values): Row {
  const body = buildObject(spec.fields, values);
  for (const [k, v] of Object.entries(spec.fixed ?? {})) setPath(body, k, typeof v === 'function' ? (v as () => unknown)() : v);
  return spec.transform ? spec.transform(body, values) : body;
}

/** Substitute `:param` path segments from the body (removing them from it). */
export function resolvePath(path: string, body: Row, params: string[] = []): { path: string; body: Row } {
  const rest = { ...body };
  let out = path;
  for (const p of params) {
    const v = rest[p];
    delete rest[p];
    out = out.replace(`:${p}`, encodeURIComponent(String(v ?? '')));
  }
  return { path: out, body: rest };
}

/* ------------------------------------------------------------------ */
/* Client-side checks (the server re-checks everything)                */
/* ------------------------------------------------------------------ */

const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function checkField(f: Field, raw: unknown): string | null {
  if (f.type === 'rows') {
    const rows = raw as Values[];
    if (f.min && rows.length < f.min) return `Add at least ${f.min} ${f.min === 1 ? 'entry' : 'entries'}.`;
    for (const [i, row] of rows.entries()) {
      const errs = validate(f.fields, row);
      const first = Object.entries(errs)[0];
      if (first) {
        const sub = f.fields.find((x) => x.key === first[0]);
        return `${f.itemLabel ?? 'Entry'} ${i + 1}: ${sub ? `${sub.label}: ` : ''}${first[1]}`;
      }
    }
    return null;
  }
  if (isEmpty(raw) || (f.type === 'pairs' && (raw as [string, string][]).every(([k, v]) => !k.trim() || !v.trim()))) {
    if (!f.required) return null;
    return f.type === 'evidence' ? 'Choose the evidence that backs this.' : f.type === 'record' || f.type === 'select' ? 'Choose one.' : f.type === 'choices' || f.type === 'tags' ? 'Add at least one.' : 'This is required.';
  }
  switch (f.type) {
    case 'text':
    case 'textarea':
    case 'email':
    case 'url': {
      const s = String(raw).trim();
      if (f.minLength && s.length < f.minLength) return `Use at least ${f.minLength} characters (now ${s.length}).`;
      if (f.maxLength && s.length > f.maxLength) return `Use at most ${f.maxLength} characters (now ${s.length}).`;
      if (f.type === 'url' && !URL_RE.test(s)) return 'Enter a full web address starting with https://';
      if (f.type === 'email' && !EMAIL_RE.test(s)) return 'Enter an email address like name@example.com';
      if (f.pattern && !f.pattern.test(f.case === 'upper' ? s.toUpperCase() : f.case === 'lower' ? s.toLowerCase() : s)) return f.patternHint ?? 'This format is not accepted.';
      return null;
    }
    case 'number': {
      const n = Number(String(raw).replace(',', '.'));
      if (!Number.isFinite(n)) return 'Enter a number.';
      if (f.integer && !Number.isInteger(n)) return 'Enter a whole number.';
      if (f.min !== undefined && n < f.min) return `Use ${f.min}${f.unit ? ` ${f.unit}` : ''} or more.`;
      if (f.max !== undefined && n > f.max) return `Use ${f.max}${f.unit ? ` ${f.unit}` : ''} or less.`;
      return null;
    }
    case 'tags': {
      const list = raw as string[];
      if (f.min && list.length < f.min) return `Add at least ${f.min}.`;
      if (f.max && list.length > f.max) return `Use at most ${f.max}.`;
      const bad = f.itemPattern ? list.find((t) => !f.itemPattern!.test(t)) : undefined;
      return bad ? `“${bad}”: ${f.itemHint ?? 'this format is not accepted'}.` : null;
    }
    case 'choices':
    case 'record':
    case 'evidence': {
      const n = Array.isArray(raw) ? raw.length : 1;
      return 'min' in f && f.min && n < f.min ? `Choose at least ${f.min}.` : null;
    }
    case 'datetime':
    case 'date':
      return Number.isNaN(new Date(f.type === 'date' ? `${raw}T00:00:00` : String(raw)).getTime()) ? 'Enter a valid date.' : null;
    default:
      return null;
  }
}

/** Field key → plain-language problem, for visible fields only. */
export function validate(fields: Field[], values: Values): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    if (!isVisible(f, values)) continue;
    const e = checkField(f, values[f.key]);
    if (e) errors[f.key] = e;
  }
  return errors;
}

/* ------------------------------------------------------------------ */
/* Server issues → plain language                                      */
/* ------------------------------------------------------------------ */

interface Issue {
  code?: string;
  path?: (string | number)[];
  instancePath?: string;
  message?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  origin?: string;
  type?: string;
  format?: string;
  validation?: string;
  input?: unknown;
  received?: unknown;
  values?: unknown[];
  options?: unknown[];
  params?: { issue?: Issue };
}

/** One validation issue (Zod 3/4 or Fastify) in words a marketer understands. */
export function friendlyIssue(raw: Issue): string {
  const i = raw.params?.issue ?? raw;
  const kind = i.origin ?? i.type;
  switch (i.code) {
    case 'too_small':
      if (kind === 'string') return Number(i.minimum) <= 1 ? 'This is required.' : `Use at least ${i.minimum} characters.`;
      if (kind === 'array' || kind === 'set') return Number(i.minimum) <= 1 ? 'Add at least one.' : `Add at least ${i.minimum}.`;
      return `Use ${i.minimum} or more.`;
    case 'too_big':
      if (kind === 'string') return `Use at most ${i.maximum} characters.`;
      if (kind === 'array' || kind === 'set') return `Use at most ${i.maximum}.`;
      return `Use ${i.maximum} or less.`;
    case 'invalid_type':
      return i.input === undefined || i.received === 'undefined' || /received undefined|required/i.test(i.message ?? '') ? 'This is required.' : 'This value has the wrong type.';
    case 'invalid_format':
    case 'invalid_string': {
      const f = i.format ?? i.validation;
      if (f === 'uuid') return 'Choose an item from the list.';
      if (f === 'email') return 'Enter a valid email address.';
      if (f === 'url') return 'Enter a full web address starting with https://';
      if (f === 'datetime') return 'Enter a valid date and time.';
      return i.message && !/^Invalid/.test(i.message) ? i.message : 'This format is not accepted.';
    }
    case 'invalid_value':
    case 'invalid_enum_value':
      return 'Choose one of the offered options.';
    case 'invalid_union':
      return 'This combination of values is not accepted.';
    default:
      return i.message ?? 'This value is not accepted.';
  }
}

const issuePath = (i: Issue): string[] => (i.path ? i.path.map(String) : (i.instancePath ?? '').split('/').filter(Boolean));

/** Attach server issues to the field whose key is the longest prefix of the issue path. */
export function mapIssues(fields: Field[], details: unknown): { fields: Record<string, string>; other: string[] } {
  const out = { fields: {} as Record<string, string>, other: [] as string[] };
  if (!Array.isArray(details)) return out;
  const keys = fields.map((f) => f.key).sort((a, b) => b.length - a.length);
  for (const issue of details as Issue[]) {
    const path = issuePath(issue).join('.');
    const key = keys.find((k) => path === k || path.startsWith(`${k}.`));
    const msg = friendlyIssue(issue);
    if (key && !out.fields[key]) out.fields[key] = msg;
    else if (!key) out.other.push(path ? `${path.replace(/\./g, ' › ')}: ${msg}` : msg);
  }
  return out;
}

/** Known server messages, rewritten for people. Order matters: first match wins. */
const MESSAGES: [RegExp, string, string?][] = [
  [/requires a multi-factor authenticated session|MFA_REQUIRED/i, 'This needs a two-factor session.', 'Turn on two-factor sign-in under Account & security, then try again.'],
  [/requires one of roles: (.+)$/i, 'Your role cannot do this.', 'Ask someone with one of these roles: $1.'],
  [/requires a human user/i, 'Only a person can do this.'],
  [/evidence not admitted\/current/i, 'Some of the chosen evidence cannot be used.', 'It is quarantined, rejected or out of date. Pick evidence marked “Ready”, or review it in Evidence first.'],
  [/at least one evidence id is required/i, 'Choose the evidence that backs this.'],
  [/^evidence not found$/i, 'The chosen evidence no longer exists.', 'Refresh the list and choose again.'],
  [/must be approved by someone other than their author/i, 'You proposed this, so someone else has to approve it.', 'This four-eyes rule keeps every claim independently reviewed.'],
  [/an identical claim already exists/i, 'This claim is already in the registry.'],
  [/claims may only reference active facts/i, 'One of the linked facts is no longer current.', 'Resolve the fact conflict or pick current facts.'],
  [/testimonial claims need evidence/i, 'Testimonials need a genuine, consented customer statement as evidence.', 'Attach evidence of kind “Consent” or with a lawful-basis reference.'],
  [/restricted documents need allowedRoles/i, 'Choose which roles may read a restricted document.'],
  [/invalid regular expression/i, 'The pattern is not a valid regular expression.'],
  [/regex too complex/i, 'The pattern is too complex.', 'Avoid nested repeats like (a+)+.'],
  [/max_exclamations pattern must be a number/i, 'Enter the maximum number of exclamation marks.'],
  [/marketing purposes require consent as the lawful basis/i, 'Marketing permission must use “Consent” as the lawful basis.'],
  [/source is blocked/i, 'That source is blocked and cannot provide evidence.'],
  [/already registered/i, 'That source is already registered.'],
  [/^(.+) not found$/i, 'The $1 was not found.', 'It may have been removed. Refresh and try again.'],
  [/resource already exists/i, 'This already exists.'],
  [/^not permitted$/i, 'Your role cannot do this.'],
  [/request validation failed/i, 'Some fields need attention.'],
];

export interface HumanError {
  title: string;
  hint?: string;
  items: string[];
}

/** Turn any thrown error into a title, an optional hint and a list of field problems. */
export function humanError(err: unknown, fields: Field[] = []): HumanError {
  const e = err as { message?: string; status?: number; code?: string | null; details?: unknown };
  const message = e?.message ?? String(err);
  const detailsCode = (e?.details as { code?: string } | null)?.code;
  let title = message;
  let hint: string | undefined;
  for (const [re, t, h] of MESSAGES) {
    const m = message.match(re) ?? (detailsCode ? detailsCode.match(re) : null);
    if (m) {
      title = t.replace(/\$1/g, m[1] ?? '');
      hint = h?.replace(/\$1/g, m[1] ?? '');
      break;
    }
  }
  if (title === message) {
    if (e?.status === 401) title = 'Your session has ended. Sign in again.';
    else if (e?.status === 403) title = 'Your role cannot do this.';
    else if (e?.status === 429) title = 'Too many attempts. Wait a moment and try again.';
    else if (e?.status && e.status >= 500) title = 'Something went wrong on our side. Try again in a minute.';
    else title = message.charAt(0).toUpperCase() + message.slice(1);
  }
  const mapped = mapIssues(fields, e?.details);
  const labelled = Object.entries(mapped.fields).map(([k, v]) => `${fields.find((f) => f.key === k)?.label ?? k}: ${v}`);
  return { title, ...(hint ? { hint } : {}), items: [...labelled, ...mapped.other] };
}

/* ------------------------------------------------------------------ */
/* Evidence usability (mirrors the server's trusted-evidence rule)     */
/* ------------------------------------------------------------------ */

export type EvidenceReadiness = 'ready' | 'quarantined' | 'stale' | 'rejected' | 'expired';

export function evidenceReadiness(e: Row, now = new Date()): EvidenceReadiness {
  if (e.status === 'rejected') return 'rejected';
  if (e.status === 'expired') return 'expired';
  if (e.status !== 'admitted') return 'quarantined';
  if (e.expiresAt && new Date(String(e.expiresAt)) <= now) return 'stale';
  const sla = typeof e.freshnessSlaHours === 'number' ? e.freshnessSlaHours : null;
  if (sla === null) return e.freshnessStatus === 'stale' ? 'stale' : 'ready';
  const at = new Date(String(e.observedAt ?? e.retrievedAt)).getTime();
  return (now.getTime() - at) / 3_600_000 <= sla ? 'ready' : 'stale';
}

export const READINESS_LABEL: Record<EvidenceReadiness, string> = {
  ready: 'Ready',
  quarantined: 'Needs review',
  stale: 'Out of date',
  rejected: 'Rejected',
  expired: 'Expired',
};

/** Evidence rows carry `evidenceId`; most other records carry `id`. */
export const rowId = (r: Row): string => String(r.id ?? r.evidenceId ?? '');
