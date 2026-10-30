import { useEffect, useMemo, useState } from 'react';
import { api, CHANGED_EVENT } from '../lib/api.js';
import { type Resource, sectionBySlug } from '../lib/catalog.js';
import { CONFIDENCE_OPTIONS, evidenceLine, evidenceNotice, FRESHNESS_OPTIONS, LINT_FORM, LINT_HELP, label, PII_OPTIONS, RIGHTS_OPTIONS, ROLE_OPTIONS, SOURCE_TYPE_OPTIONS, VISIBILITY_OPTIONS } from '../lib/fieldsets.js';
import { evidenceReadiness, type FormSpec, type Row, rowId } from '../lib/forms.js';
import { EvidencePicker, GuidedForm, Notice } from './Form.js';
import { Icon } from './Journey.js';
import { ResourcePanel } from './ResourcePanel.js';
import { Badge, ErrorNotice, useApi } from './ui.js';

/** Every API call this screen makes beyond its catalog resources (checked against the API routes in apps/web/test). */
export const GROUND_TRUTH_CALLS = [
  { method: 'GET', path: '/v1/evidence' },
  { method: 'POST', path: '/v1/evidence' },
  { method: 'GET', path: '/v1/knowledge/claims' },
  { method: 'GET', path: '/v1/knowledge/facts' },
  { method: 'GET', path: '/v1/knowledge/documents' },
  { method: 'GET', path: '/v1/knowledge/brand-rules' },
  { method: 'POST', path: '/v1/knowledge/documents' },
  { method: 'POST', path: '/v1/knowledge/lint' },
] as const;

type StepId = 'evidence' | 'documents' | 'facts' | 'claims' | 'rules' | 'check';

const STEPS: { id: StepId; title: string; optional?: boolean; why: string }[] = [
  { id: 'evidence', title: 'Evidence', why: 'Start with what proves things: reports, data exports, documents. Everything later points back to it.' },
  { id: 'documents', title: 'Documents', optional: true, why: 'Help articles, policies and guides that the website assistant and the AI may quote.' },
  { id: 'facts', title: 'Facts', optional: true, why: 'What is true about your products, plans and prices, kept up to date as sources change.' },
  { id: 'claims', title: 'Claims', why: 'The statements you may use in marketing, each backed by evidence and approved by a colleague.' },
  { id: 'rules', title: 'Brand rules', optional: true, why: 'Words to avoid, phrases that must appear and tone guidance.' },
  { id: 'check', title: 'Check copy', why: 'Paste any copy and see exactly what must change before it can ship.' },
];

const resource = (title: string): Resource => sectionBySlug('knowledge')!.resources.find((r) => r.title === title)!;
const EVIDENCE = () => sectionBySlug('evidence')!.resources[0]!;

/** Lists behind the step statuses; re-read after any change anywhere on the page. */
function useGroundTruth() {
  const evidence = useApi<Row[]>('/v1/evidence?limit=300');
  const documents = useApi<Row[]>('/v1/knowledge/documents');
  const facts = useApi<Row[]>('/v1/knowledge/facts');
  const claims = useApi<Row[]>('/v1/knowledge/claims');
  const rules = useApi<Row[]>('/v1/knowledge/brand-rules');
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void evidence.reload();
        void documents.reload();
        void facts.reload();
        void claims.reload();
        void rules.reload();
      }, 150);
    };
    window.addEventListener(CHANGED_EVENT, onChange);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(CHANGED_EVENT, onChange);
    };
  }, [evidence.reload, documents.reload, facts.reload, claims.reload, rules.reload]);
  const ready = (evidence.data ?? []).filter((e) => evidenceReadiness(e) === 'ready').length;
  const waiting = (evidence.data ?? []).filter((e) => e.status === 'quarantined').length;
  const approved = (claims.data ?? []).filter((c) => c.status === 'approved').length;
  const proposed = (claims.data ?? []).filter((c) => c.status === 'pending_review').length;
  const status: Record<StepId, { done: boolean; text: string } | null> = {
    evidence: evidence.data ? { done: ready > 0, text: ready ? `${ready} ready${waiting ? ` · ${waiting} waiting` : ''}` : waiting ? `${waiting} waiting for review` : 'None yet' } : null,
    documents: documents.data ? { done: documents.data.length > 0, text: documents.data.length ? `${documents.data.length} indexed` : 'Optional' } : null,
    facts: facts.data ? { done: facts.data.length > 0, text: facts.data.length ? `${facts.data.length} recorded` : 'Optional' } : null,
    claims: claims.data ? { done: approved > 0, text: approved || proposed ? [approved ? `${approved} approved` : '', proposed ? `${proposed} waiting` : ''].filter(Boolean).join(' · ') : 'None yet' } : null,
    rules: rules.data ? { done: rules.data.length > 0, text: rules.data.length ? `${rules.data.length} active` : 'Optional' } : null,
    check: null,
  };
  return { status, documentsReload: documents.reload };
}

/**
 * Stage 4, "Build your ground truth": a guided path from evidence to claims a marketer can use,
 * one step at a time. Each step reuses the catalog resource (same API calls, same server checks).
 */
export function GroundTruth() {
  const initial = (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('step') : null) as StepId | null;
  const [step, setStep] = useState<StepId>(STEPS.some((s) => s.id === initial) ? initial! : 'evidence');
  const gt = useGroundTruth();
  const i = STEPS.findIndex((s) => s.id === step);
  const current = STEPS[i]!;

  // On narrow screens the steps scroll sideways: keep the current one in view.
  useEffect(() => {
    const nav = document.getElementById('gt-steps');
    const li = nav?.querySelectorAll('li')[i];
    if (nav && li) nav.scrollLeft = li.offsetLeft - (nav.clientWidth - li.offsetWidth) / 2;
  }, [i]);

  const go = (id: StepId) => {
    setStep(id);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('step', id);
      window.history.replaceState(null, '', url);
    } catch {
      /* history unavailable: the step still changes */
    }
    document.getElementById('gt-panel')?.focus({ preventScroll: true });
    document.getElementById('gt-steps')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  return (
    <div className="ground-truth">
      <nav className="stepper" id="gt-steps" aria-label="Ground-truth steps">
        <ol>
          {STEPS.map((s, n) => {
            const st = gt.status[s.id];
            return (
              <li key={s.id} className={`step${s.id === step ? ' active' : ''}${st?.done ? ' done' : ''}`}>
                <button type="button" onClick={() => go(s.id)} aria-current={s.id === step ? 'step' : undefined}>
                  <span className="step-n" aria-hidden="true">
                    {st?.done ? <Icon name="check" size={13} /> : n + 1}
                  </span>
                  <span className="step-text">
                    <span className="step-title">
                      <span className="sr-only">Step {n + 1}: </span>
                      {s.title}
                      {st?.done ? <span className="sr-only"> (done)</span> : null}
                    </span>
                    <span className="step-status">{st ? st.text : s.optional ? 'Optional' : ' '}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <section className="gt-panel" id="gt-panel" tabIndex={-1} aria-labelledby="gt-title">
        <div className="gt-head">
          <div className="eyebrow">
            Step {i + 1} of {STEPS.length}
            {current.optional ? <span className="pill">optional</span> : null}
          </div>
          <h2 id="gt-title">{current.title}</h2>
          <p className="muted gt-why">{current.why}</p>
        </div>
        {step === 'evidence' ? <ResourcePanel key="ev" resource={EVIDENCE()} headingLevel={3} /> : null}
        {step === 'documents' ? <Documents onIndexed={() => void gt.documentsReload()} /> : null}
        {step === 'facts' ? <ResourcePanel key="facts" resource={resource('Facts')} headingLevel={3} /> : null}
        {step === 'claims' ? <ResourcePanel key="claims" resource={resource('Claims')} headingLevel={3} /> : null}
        {step === 'rules' ? <ResourcePanel key="rules" resource={resource('Brand rules')} headingLevel={3} /> : null}
        {step === 'check' ? <CopyCheck /> : null}
      </section>

      <div className="pager step-pager">
        {i > 0 ? (
          <button type="button" className="pager-link" onClick={() => go(STEPS[i - 1]!.id)}>
            <span className="small muted">Previous step</span>
            <span className="pager-title">← {STEPS[i - 1]!.title}</span>
          </button>
        ) : (
          <span />
        )}
        {i < STEPS.length - 1 ? (
          <button type="button" className="pager-link next" onClick={() => go(STEPS[i + 1]!.id)}>
            <span className="small muted">Next step</span>
            <span className="pager-title">{STEPS[i + 1]!.title} →</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Documents: a four-step wizard                                       */
/* ------------------------------------------------------------------ */

async function sha256Text(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const DOC_STEPS = ['Text', 'Evidence', 'Who can read it', 'Review'] as const;

function Documents({ onIndexed }: { onIndexed: () => void }) {
  const [wizard, setWizard] = useState(0);
  const [list, setList] = useState(0);
  return (
    <>
      <DocumentWizard
        key={wizard}
        onIndexed={() => {
          onIndexed();
          setList((v) => v + 1);
        }}
        onAnother={() => setWizard((v) => v + 1)}
      />
      <ResourcePanel key={`docs-${list}`} resource={resource('Documents')} headingLevel={3} />
    </>
  );
}

function DocumentWizard({ onIndexed, onAnother }: { onIndexed: () => void; onAnother: () => void }) {
  const [n, setN] = useState(0);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [origin, setOrigin] = useState('');
  const [evidenceMode, setEvidenceMode] = useState<'new' | 'existing'>('new');
  const [evidence, setEvidence] = useState<Row | null>(null);
  const [existingId, setExistingId] = useState('');
  const [visibility, setVisibility] = useState('internal');
  const [roles, setRoles] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Row | null>(null);
  const evidenceList = useApi<Row[]>(n >= 1 ? '/v1/evidence?limit=300' : null);

  const chosenEvidence = evidenceMode === 'existing' ? ((evidenceList.data ?? []).find((e) => rowId(e) === existingId) ?? null) : evidence;
  const passages = Math.max(1, Math.ceil(text.length / 900));

  // New evidence for this document: the record attests the document's SHA-256 fingerprint.
  const evidenceSpec: FormSpec = useMemo(
    () => ({
      fields: [
        { key: 'sourceUriOrObjectId', type: 'text', label: 'Where the document comes from', required: true, initial: origin, placeholder: 'https://help.example.com/import or file name' },
        { key: 'sourceOwner', type: 'text', label: 'Who owns it', required: true, placeholder: 'Our company' },
        { key: 'sourceType', type: 'select', label: 'Source type', options: SOURCE_TYPE_OPTIONS, required: true, initial: 'primary' },
        { key: 'licenseOrUsageRights', type: 'select', label: 'May we use it?', options: RIGHTS_OPTIONS, initial: 'first-party', emptyAsNull: true },
        { key: 'piiClassification', type: 'select', label: 'Does it contain personal data?', options: PII_OPTIONS, initial: 'none', emptyAsNull: true },
        { key: 'lawfulBasisOrConsentId', type: 'text', label: 'Lawful basis or consent reference', required: true, showIf: { key: 'piiClassification', values: ['personal', 'sensitive'] } },
        { key: 'confidence', type: 'select', label: 'How reliable is it?', options: CONFIDENCE_OPTIONS, numeric: true, initial: '0.95', emptyAsNull: true },
        { key: 'freshnessSlaHours', type: 'select', label: 'Review it again after', options: FRESHNESS_OPTIONS, numeric: true, initial: '8760', emptyAsNull: true },
      ],
      fixed: { kind: 'document', schemaVersion: '1', retrievedAt: () => new Date().toISOString(), permittedUses: ['support', 'creative_generation', 'publishing', 'analytics'] },
    }),
    [origin],
  );

  const next = () => {
    setProblem(null);
    if (n === 0) {
      if (!title.trim()) return setProblem('Give the document a title.');
      if (!text.trim()) return setProblem('Add the document text: load a file or paste it.');
      if (text.length > 2_000_000) return setProblem('The text is longer than 2,000,000 characters. Split it into several documents.');
    }
    if (n === 1 && !(chosenEvidence && evidenceReadiness(chosenEvidence) === 'ready')) return setProblem('Choose or add evidence that is ready to use.');
    if (n === 2 && visibility === 'restricted' && roles.length === 0) return setProblem('Choose at least one role that may read it.');
    setN(n + 1);
  };

  const index = async () => {
    setBusy(true);
    setError(null);
    try {
      const doc = await api<Row>('POST', '/v1/knowledge/documents', { title: title.trim(), text, evidenceId: rowId(chosenEvidence!), visibility, allowedRoles: visibility === 'restricted' ? roles : [] });
      setDone(doc);
      onIndexed();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="card create-card">
        <Notice notice={{ tone: 'ok', title: `“${String(done.title)}” is indexed.`, text: `${done.chunkCount} passage${done.chunkCount === 1 ? '' : 's'} can now be quoted${done.visibility === 'public' ? ' by the website assistant and' : ''} by the AI, with this document as the source.` }} />
        <button type="button" className="primary" onClick={onAnother}>
          + Add another document
        </button>
      </div>
    );
  }

  return (
    <div className="card create-card wizard">
      <h3>Add a document</h3>
      <ol className="wizard-steps" aria-label="Progress">
        {DOC_STEPS.map((s, k) => (
          <li key={s} className={`wizard-step${k === n ? ' active' : k < n ? ' done' : ''}`} aria-current={k === n ? 'step' : undefined}>
            <span className="step-n">{k < n ? <Icon name="check" size={12} /> : k + 1}</span>
            {s}
          </li>
        ))}
      </ol>

      {n === 0 ? (
        <div className="form-grid">
          <div className="field wide">
            <label htmlFor="doc-title">
              Title <span className="req">*</span>
            </label>
            <input id="doc-title" value={title} maxLength={300} placeholder="Help: importing contacts" onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field wide">
            <label htmlFor="doc-text">
              Document text <span className="req">*</span>
            </label>
            <textarea id="doc-text" className="prose" rows={9} value={text} placeholder="Paste the article or policy text here…" onChange={(e) => setText(e.target.value)} />
            <div className="row between">
              <label className="link file-pick">
                Load from a file (.txt, .md, .html, .csv)…
                <input
                  type="file"
                  accept=".txt,.md,.markdown,.html,.htm,.csv,text/plain"
                  hidden
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (!f) return;
                    if (f.size > 2_000_000) return setProblem('That file is larger than 2 MB. Split it into several documents.');
                    setText(await f.text());
                    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ''));
                    if (!origin) setOrigin(f.name);
                  }}
                />
              </label>
              <span className="counter">{text.length ? `${text.length.toLocaleString()} characters · about ${passages} passage${passages === 1 ? '' : 's'}` : ''}</span>
            </div>
          </div>
        </div>
      ) : null}

      {n === 1 ? (
        <div className="stack">
          <p className="small">Every document must be backed by evidence, so anything quoted from it can be traced back and re-checked.</p>
          <div className="seg" role="radiogroup" aria-label="Evidence for this document">
            <label className={evidenceMode === 'new' ? 'on' : ''}>
              <input type="radio" name="doc-ev-mode" checked={evidenceMode === 'new'} onChange={() => setEvidenceMode('new')} /> Record this document as new evidence
            </label>
            <label className={evidenceMode === 'existing' ? 'on' : ''}>
              <input type="radio" name="doc-ev-mode" checked={evidenceMode === 'existing'} onChange={() => setEvidenceMode('existing')} /> Use evidence I already added
            </label>
          </div>
          {evidenceMode === 'new' ? (
            evidence ? (
              <div className="stack">
                <Notice notice={evidenceNotice(evidence)} />
                {evidenceReadiness(evidence) !== 'ready' ? (
                  <button type="button" onClick={() => setEvidence(null)}>
                    Record it again with the missing answers
                  </button>
                ) : null}
              </div>
            ) : (
              <GuidedForm
                spec={evidenceSpec}
                submitLabel="Record as evidence"
                allowJson={false}
                onSubmit={async (body) => {
                  const sha256 = await sha256Text(text);
                  return api('POST', '/v1/evidence', { ...body, summary: title.trim(), content: { document: title.trim(), sha256, characters: text.length } });
                }}
                success={(r) => evidenceNotice(r as Row)}
                onDone={(r) => setEvidence(r as Row)}
              />
            )
          ) : (
            <EvidencePicker field={{ label: 'Evidence', multiple: false }} id="doc-evidence" value={existingId} onChange={(v) => setExistingId(String(v ?? ''))} />
          )}
          {chosenEvidence ? (
            <p className="small">
              Backed by: <strong>{String(chosenEvidence.summary ?? '')}</strong> <span className="muted">({evidenceLine(chosenEvidence)})</span>
            </p>
          ) : null}
        </div>
      ) : null}

      {n === 2 ? (
        <div className="stack">
          <div className="choice-cards" role="radiogroup" aria-label="Who can read it">
            {VISIBILITY_OPTIONS.map((o) => (
              <label key={o.value} className={`choice-card${visibility === o.value ? ' on' : ''}`}>
                <input type="radio" name="doc-visibility" checked={visibility === o.value} onChange={() => setVisibility(o.value)} />
                <span>{o.label}</span>
              </label>
            ))}
          </div>
          {visibility === 'restricted' ? (
            <fieldset className="field group">
              <legend>
                Roles that may read it <span className="req">*</span>
              </legend>
              <div className="choice-chips">
                {ROLE_OPTIONS.map((o) => (
                  <label key={o.value} className={`chip-check${roles.includes(o.value) ? ' on' : ''}`}>
                    <input type="checkbox" checked={roles.includes(o.value)} onChange={(e) => setRoles(e.target.checked ? [...roles, o.value] : roles.filter((r) => r !== o.value))} />
                    {o.label}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
        </div>
      ) : null}

      {n === 3 ? (
        <dl className="kv review">
          <div className="kv-row">
            <dt>Title</dt>
            <dd>{title}</dd>
          </div>
          <div className="kv-row">
            <dt>Size</dt>
            <dd>
              {text.length.toLocaleString()} characters (about {passages} passage{passages === 1 ? '' : 's'})
            </dd>
          </div>
          <div className="kv-row">
            <dt>Evidence</dt>
            <dd>{String(chosenEvidence?.summary ?? '')}</dd>
          </div>
          <div className="kv-row">
            <dt>Who can read it</dt>
            <dd>
              {label(VISIBILITY_OPTIONS, visibility)}
              {visibility === 'restricted' ? ` (${roles.map((r) => label(ROLE_OPTIONS, r)).join(', ')})` : ''}
            </dd>
          </div>
        </dl>
      ) : null}

      {problem ? (
        <div className="notice error" role="alert">
          {problem}
        </div>
      ) : null}
      <ErrorNotice error={error} />
      <div className="form-actions">
        {n > 0 ? (
          <button
            type="button"
            onClick={() => {
              setProblem(null);
              setN(n - 1);
            }}
            disabled={busy}
          >
            ← Back
          </button>
        ) : null}
        {n < 3 ? (
          <button type="button" className="primary" onClick={next}>
            Continue
          </button>
        ) : (
          <button type="button" className="primary" onClick={() => void index()} disabled={busy}>
            {busy ? 'Indexing…' : 'Index document'}
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Check copy                                                          */
/* ------------------------------------------------------------------ */

interface LintResult {
  passed: boolean;
  violations: { code: string; severity: 'block' | 'warn'; message: string; excerpt: string }[];
  claimsChecked: string[];
}

function CopyCheck() {
  const [result, setResult] = useState<LintResult | null>(null);
  return (
    <div className="card create-card">
      <h3>Check copy before it ships</h3>
      <GuidedForm spec={LINT_FORM} submitLabel="Check copy" resetOnSuccess={false} onSubmit={(body) => api('POST', '/v1/knowledge/lint', body)} success={() => null} onDone={(r) => setResult(r as LintResult)} />
      {result ? <LintReport result={result} /> : null}
    </div>
  );
}

function LintReport({ result }: { result: LintResult }) {
  const blocks = result.violations.filter((v) => v.severity === 'block');
  const warns = result.violations.filter((v) => v.severity === 'warn');
  return (
    <div className="lint-report" aria-live="polite">
      <div className={`notice ${result.passed ? 'ok' : 'error'}`} role="status">
        <strong>{result.passed ? (warns.length ? 'Ready to use, with suggestions.' : 'Ready to use. Nothing to fix.') : `${blocks.length} problem${blocks.length === 1 ? '' : 's'} must be fixed before this copy can be used.`}</strong>
        <div className="small">Checked against {result.claimsChecked.length ? `${result.claimsChecked.length} approved claim${result.claimsChecked.length === 1 ? '' : 's'}` : 'no claims (tick the claims your copy relies on)'} and your brand rules.</div>
      </div>
      {result.violations.length ? (
        <ul className="findings">
          {result.violations.map((v, k) => {
            const help = LINT_HELP[v.code];
            const status = v.code === 'CLAIM_NOT_USABLE' ? / is (\w+)$/.exec(v.message)?.[1] : null;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: findings have no identity
              <li key={k} className={`finding ${v.severity}`}>
                <div className="row between">
                  <strong>{help?.title ?? v.message}</strong>
                  <Badge value={v.severity === 'block' ? 'Must fix' : 'Suggestion'} />
                </div>
                {v.excerpt ? <blockquote>“{v.excerpt}”</blockquote> : null}
                <p className="small finding-fix">
                  {v.code.startsWith('BRAND_') && v.message ? `${v.message}. ` : ''}
                  {status ? `This claim is ${status.replace(/_/g, ' ')}. ` : ''}
                  {help?.fix ?? ''}
                </p>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
