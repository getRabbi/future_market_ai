/**
 * Control-plane catalog: every module (M01–M24) maps to a section with the API resources it
 * exposes. Generic sections render list tables, guided create forms (field descriptions, never
 * raw request bodies; the server validates every submission) and per-row actions;
 * governance-critical screens (approvals, kill switches, audit) and the ground-truth workflow
 * are bespoke.
 */

import { BRAND_RULE_FORM, CHANNEL_OPTIONS, CLAIM_FORM, COUNTRY_SUGGESTIONS, EVIDENCE_FORM, evidenceNotice, FACT_FORM, FRESHNESS_OPTIONS, factKey, MARKET_HINT, MARKET_PATTERN, PII_OPTIONS, providerName, RIGHTS_OPTIONS, releaseForm, SOURCE_TYPE_OPTIONS, SOURCES, USE_OPTIONS } from './fieldsets.js';
import { evidenceReadiness, type Field, type FormNotice, type FormSpec, opts, READINESS_LABEL, type Row } from './forms.js';
import { DAILY_SECTIONS, STAGES } from './journey.js';

export interface RowAction {
  label: string;
  /** Path with `:id` (the row's id) substituted. */
  path: string;
  method?: 'GET' | 'POST' | 'PUT';
  /** Fixed body values, merged under the form's. */
  body?: Row;
  /** Ask for input first. */
  form?: FormSpec | ((row: Row) => FormSpec);
  intro?: string | ((row: Row) => string);
  /** Show the action only when row[field] is one of values. */
  when?: { field: string; values: unknown[] };
  danger?: boolean;
  /** Ask for confirmation first (actions without a form). */
  confirm?: string;
  /** Hidden on rows the signed-in user created (four-eyes rules); the note is shown instead. */
  notMine?: { field: string; note: string };
  /** Show what the server returned, instead of a short confirmation. */
  showResult?: boolean;
  /** Confirmation shown after success. */
  done?: string;
}

export interface CreateSpec {
  /** Button that opens the form. */
  label: string;
  submitLabel?: string;
  method?: 'POST' | 'PUT';
  path: string;
  form: FormSpec;
  intro?: string;
  success?: (result: Row) => FormNotice;
}

export interface Resource {
  title: string;
  description?: string;
  /** GET path returning an array, or an object holding one at `pick`. */
  list?: string;
  pick?: string;
  /** Reshape the list response into rows (e.g. flatten nested records). */
  rows?: (data: unknown) => Row[];
  columns?: string[];
  labels?: Record<string, string>;
  /** Detail for a row (`:id`). */
  detail?: string;
  create?: CreateSpec;
  rowActions?: RowAction[];
  /** Empty-state text. */
  empty?: string;
}

export interface Section {
  slug: string;
  title: string;
  modules: string[];
  summary: string;
  resources: Resource[];
  /** Bespoke component instead of / before resources. */
  custom?: 'overview' | 'approvals' | 'governance' | 'audit' | 'settings' | 'assets' | 'connections' | 'knowledge';
}

const iso = () => new Date().toISOString();
/** A `datetime-local` value, `hours` from now. */
const localIn = (hours = 0) => {
  const d = new Date(Date.now() + hours * 3_600_000);
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const reason = (label = 'Reason', placeholder = ''): Field => ({ key: 'reason', type: 'textarea', label, required: true, minLength: 3, rows: 2, placeholder });
const geos = (required = false): Field => ({ key: 'geographies', type: 'tags', label: 'Markets affected', suggestions: COUNTRY_SUGGESTIONS, case: 'upper', itemPattern: MARKET_PATTERN, itemHint: MARKET_HINT, ...(required ? { required: true, min: 1 } : {}) });
const money = (key: string, label: string, extra: Partial<Field> = {}): Field => ({ key, type: 'number', label, min: 0, scale: 1_000_000, ...extra }) as Field;
const percent = (key: string, label: string, extra: Partial<Field> = {}): Field => ({ key, type: 'number', label, unit: '%', scale: 0.01, min: 0, max: 100, ...extra }) as Field;
const ok = (title: string, text?: string): FormNotice => ({ tone: 'ok', title, ...(text ? { text } : {}) });

const CONSENT_PURPOSES = opts(
  ['marketing_email', 'Marketing emails'],
  ['marketing_sms', 'Marketing SMS'],
  ['marketing_push', 'Marketing push notifications'],
  ['analytics', 'Analytics'],
  ['personalization', 'Personalisation'],
  ['ads_customer_match', 'Ad audiences (customer match)'],
  ['sale_or_share', 'Sale or sharing of data'],
  ['profiling', 'Profiling'],
);
const LAWFUL_BASES = opts(['consent', 'Consent'], ['contract', 'Contract'], ['legitimate_interest', 'Legitimate interest'], ['legal_obligation', 'Legal obligation'], ['vital_interest', 'Vital interest'], ['public_task', 'Public task']);
const STORE_OPTIONS = opts(['app_store', 'Apple App Store'], ['google_play', 'Google Play']);
const STORE_FIELDS = opts(
  ['name', 'App Store: name (30)'],
  ['subtitle', 'App Store: subtitle (30)'],
  ['keywords', 'App Store: keywords (100 bytes)'],
  ['promotionalText', 'App Store: promotional text (170)'],
  ['description', 'App Store: description (4000)'],
  ['whatsNew', "App Store: what's new (4000)"],
  ['title', 'Google Play: title (30)'],
  ['shortDescription', 'Google Play: short description (80)'],
  ['fullDescription', 'Google Play: full description (4000)'],
);
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i;
const ORIGIN_HINT = 'enter just the site address, like https://www.example.com (no path)';

export const SECTIONS: Section[] = [
  { slug: 'overview', title: 'Overview', modules: ['M23', 'M24'], summary: 'What needs a person now: approvals, alerts, incidents and emergency stops.', resources: [], custom: 'overview' },
  {
    slug: 'approvals',
    title: 'Actions & approvals',
    modules: ['M23'],
    summary: 'Everything that changes the outside world waits here for a second person. Approving signs off the exact action; it only counts as done once an independent check confirms it.',
    resources: [],
    custom: 'approvals',
  },
  {
    slug: 'evidence',
    title: 'Evidence',
    modules: ['M01'],
    summary: 'The reports, data and documents your claims and decisions stand on, with who owns them, whether you may use them and how long they stay accurate.',
    resources: [
      {
        title: 'Evidence',
        description: 'Evidence marked “Ready” can back claims, facts and documents. Anything with unknown rights, personal data or reliability waits for review.',
        list: '/v1/evidence?limit=300',
        rows: (data) => (Array.isArray(data) ? (data as Row[]).map((e) => ({ ...e, readiness: READINESS_LABEL[evidenceReadiness(e)] })) : []),
        columns: ['summary', 'kind', 'readiness', 'sourceOwner', 'licenseOrUsageRights', 'createdAt'],
        labels: { summary: 'Evidence', readiness: 'Status' },
        detail: '/v1/evidence/:id',
        empty: 'No evidence yet. Add the first report, data export or document your marketing relies on.',
        rowActions: [
          {
            label: 'Review and release',
            path: '/v1/evidence/:id/release',
            form: releaseForm,
            intro: (r) => `Waiting because: ${(Array.isArray(r.quarantineReasons) ? (r.quarantineReasons as string[]) : []).join('; ') || 'review needed'}. Answer what is missing; anything still unknown keeps it waiting.`,
            when: { field: 'status', values: ['quarantined'] },
            done: 'Review saved.',
          },
          { label: 'Reject', path: '/v1/evidence/:id/reject', form: { fields: [{ key: 'note', type: 'textarea', label: 'Why is it rejected?', required: true, minLength: 3, rows: 2 }] }, when: { field: 'status', values: ['quarantined'] }, danger: true, done: 'Evidence rejected.' },
          { label: 'Where it came from', path: '/v1/evidence/:id/lineage', method: 'GET', showResult: true },
        ],
        create: { label: 'Add evidence', path: '/v1/evidence', form: EVIDENCE_FORM, success: (r) => evidenceNotice(r) },
      },
      {
        title: 'Registered sources',
        description: 'Recurring sources (a CRM, an analytics export, a research provider) with their default rights. A reviewer approves each source once.',
        list: '/v1/evidence/sources',
        columns: ['name', 'sourceType', 'owner', 'licenseOrUsageRights', 'status', 'createdAt'],
        empty: 'No sources registered. Optional: register one when the same source feeds evidence again and again.',
        create: {
          label: 'Register a source',
          path: '/v1/evidence/sources',
          form: {
            fields: [
              { key: 'name', type: 'text', label: 'Name', required: true, maxLength: 200, placeholder: 'Company CRM' },
              { key: 'sourceType', type: 'select', label: 'Source type', options: SOURCE_TYPE_OPTIONS, required: true, initial: 'primary' },
              { key: 'owner', type: 'text', label: 'Owner', required: true, placeholder: 'Our company' },
              { key: 'uri', type: 'text', label: 'Address or reference', required: true, maxLength: 2000, placeholder: 'https://… or crm://reports' },
              { key: 'licenseOrUsageRights', type: 'select', label: 'May we use it?', options: RIGHTS_OPTIONS, initial: 'first-party', emptyAsNull: true },
              { key: 'defaultPiiClass', type: 'select', label: 'Personal data it usually contains', options: PII_OPTIONS.filter((o) => o.value !== 'children'), emptyAsNull: true },
              { key: 'freshnessSlaHours', type: 'select', label: 'How long its data stays accurate', options: FRESHNESS_OPTIONS, numeric: true, emptyAsNull: true },
              { key: 'permittedUses', type: 'choices', label: 'It may be used for', options: USE_OPTIONS },
              { key: 'prohibitedUses', type: 'choices', label: 'It must never be used for', options: USE_OPTIONS, advanced: true },
              { key: 'termsVersion', type: 'text', label: 'Terms version', advanced: true, emptyAsNull: true },
            ],
          },
          success: () => ok('Source registered.', 'A reviewer approves it below before its evidence can be admitted.'),
        },
        rowActions: [
          { label: 'Approve', path: '/v1/evidence/sources/:id/review', body: { decision: 'approved' }, when: { field: 'status', values: ['pending_review'] }, done: 'Source approved.' },
          { label: 'Block', path: '/v1/evidence/sources/:id/review', body: { decision: 'blocked' }, when: { field: 'status', values: ['pending_review', 'approved'] }, danger: true, confirm: 'Block this source? Evidence from it can no longer be admitted.', done: 'Source blocked.' },
        ],
      },
    ],
  },
  {
    slug: 'customers',
    title: 'Customers & consent',
    modules: ['M02'],
    summary: 'Customer profiles built from your own site and app, what each person agreed to, who must not be contacted, and privacy requests.',
    resources: [
      {
        title: 'Collect customer data',
        description: 'Create a key for your website or server; events it sends build consent-aware profiles. The secret is shown once.',
        list: '/v1/customers/ingestion-keys',
        columns: ['kind', 'keyPrefix', 'allowedOrigins', 'status', 'createdAt'],
        empty: 'No keys yet. Create one to start sending events from your site or app.',
        create: {
          label: 'Create a key',
          path: '/v1/customers/ingestion-keys',
          form: {
            fields: [
              { key: 'kind', type: 'select', label: 'Where will events come from?', options: opts(['browser', 'My website (browser)'], ['server', 'My server or backend']), required: true, initial: 'browser' },
              { key: 'allowedOrigins', type: 'tags', label: 'Websites allowed to send', required: true, min: 1, itemPattern: ORIGIN, itemHint: ORIGIN_HINT, placeholder: 'https://www.example.com', showIf: { key: 'kind', values: ['browser'] } },
            ],
          },
          success: (r) => ({ tone: 'ok', title: 'Key created.', text: 'Copy the secret now: it is never shown again.', secret: { label: 'Secret key', value: String(r.key ?? '') } }),
        },
        rowActions: [{ label: 'Revoke', path: '/v1/customers/ingestion-keys/:id/revoke', when: { field: 'status', values: ['active'] }, danger: true, confirm: 'Revoke this key? Anything still using it stops sending events.', done: 'Key revoked.' }],
      },
      { title: 'Profiles', list: '/v1/customers', columns: ['id', 'country', 'locale', 'isChild', 'createdAt'], labels: { id: 'Customer' }, detail: '/v1/customers/:id', empty: 'No profiles yet. They appear once events arrive.' },
      {
        title: 'Record consent',
        description: 'What a customer agreed to (or refused), and where it was captured. Marketing always needs consent.',
        create: {
          label: 'Record consent',
          path: '/v1/customers/consents',
          form: {
            fields: [
              { key: 'profileId', type: 'record', label: 'Customer', required: true, source: SOURCES.profiles },
              { key: 'purpose', type: 'select', label: 'For', options: CONSENT_PURPOSES, required: true, initial: 'marketing_email' },
              { key: 'status', type: 'select', label: 'Decision', options: opts(['granted', 'Agreed'], ['denied', 'Refused'], ['withdrawn', 'Withdrew']), required: true, initial: 'granted' },
              { key: 'lawfulBasis', type: 'select', label: 'Lawful basis', options: LAWFUL_BASES, required: true, initial: 'consent' },
              {
                key: 'source',
                type: 'select',
                label: 'Captured in',
                options: opts(['preference_center', 'Preference centre'], ['signup_form', 'Sign-up form'], ['checkout', 'Checkout'], ['support', 'Support conversation'], ['import', 'Import'], ['other', 'Somewhere else']),
                required: true,
                initial: 'preference_center',
              },
              { key: 'capturedAt', type: 'datetime', label: 'Captured at', required: true, initial: () => localIn(0) },
              { key: 'jurisdiction', type: 'text', label: 'Jurisdiction', case: 'upper', pattern: MARKET_PATTERN, patternHint: `Use a country code: ${MARKET_HINT}.`, emptyAsNull: true, placeholder: 'US-CA' },
              { key: 'evidenceId', type: 'evidence', label: 'Proof of consent', kinds: ['consent'], emptyAsNull: true, advanced: true },
              { key: 'expiresAt', type: 'date', iso: 'end', label: 'Expires', emptyAsNull: true, advanced: true },
            ],
          },
          success: () => ok('Consent recorded.'),
        },
      },
      {
        title: 'Stop contacting someone',
        description: 'Suppressions are checked immediately before every message and ad audience.',
        create: {
          label: 'Add to the do-not-contact list',
          path: '/v1/customers/suppressions',
          form: {
            fields: [
              { key: 'identifier.kind', type: 'select', label: 'Identify them by', options: opts(['email', 'Email address'], ['phone', 'Phone number']), required: true, initial: 'email' },
              { key: 'identifier.value', type: 'text', label: 'Email or phone', required: true, minLength: 3, placeholder: 'person@example.com' },
              { key: 'channel', type: 'select', label: 'Stop', options: opts(['all', 'Everything'], ['email', 'Email'], ['sms', 'SMS'], ['push', 'Push notifications'], ['whatsapp', 'WhatsApp'], ['ads', 'Ad audiences']), required: true, initial: 'all' },
              { key: 'reason', type: 'select', label: 'Reason', options: opts(['manual', 'Asked us directly'], ['unsubscribe', 'Unsubscribed'], ['complaint', 'Complained'], ['bounce', 'Address bounces'], ['legal', 'Legal requirement']), required: true, initial: 'manual' },
            ],
          },
          success: () => ok('Added to the do-not-contact list.'),
        },
      },
      {
        title: 'Privacy requests',
        description: 'Access, deletion, correction and opt-out requests, with their legal due dates.',
        list: '/v1/customers/dsar',
        columns: ['kind', 'status', 'jurisdiction', 'receivedAt', 'dueAt'],
        empty: 'No privacy requests.',
        create: {
          label: 'Log a request',
          path: '/v1/customers/dsar',
          form: {
            fields: [
              { key: 'kind', type: 'select', label: 'They asked to', options: opts(['access', 'See their data'], ['delete', 'Delete their data'], ['correct', 'Correct their data'], ['opt_out_sale_share', 'Opt out of sale or sharing']), required: true, initial: 'access' },
              { key: 'identifier.kind', type: 'select', label: 'Identify them by', options: opts(['email', 'Email address'], ['phone', 'Phone number'], ['user_id', 'User ID in your product']), required: true, initial: 'email' },
              { key: 'identifier.value', type: 'text', label: 'Email, phone or user ID', required: true, minLength: 3 },
              { key: 'jurisdiction', type: 'text', label: 'Jurisdiction', case: 'upper', pattern: MARKET_PATTERN, patternHint: `Use a country code: ${MARKET_HINT}.`, emptyAsNull: true, placeholder: 'US-CA', help: 'Sets the legal deadline.' },
              { key: 'dueAt', type: 'date', iso: 'end', label: 'Due date', emptyAsNull: true, advanced: true, help: 'Leave empty to use the legal deadline for the jurisdiction.' },
            ],
          },
          success: () => ok('Request logged.', 'Verify the person’s identity next.'),
        },
        rowActions: [
          {
            label: 'Verify identity',
            path: '/v1/customers/dsar/:id/verify',
            form: { fields: [{ key: 'method', type: 'text', label: 'How was their identity verified?', required: true, minLength: 3, placeholder: 'Signed-in account email confirmed' }] },
            when: { field: 'status', values: ['received'] },
            done: 'Identity verified.',
          },
          { label: 'Delete their data', path: '/v1/customers/dsar/:id/execute-deletion', when: { field: 'kind', values: ['delete'] }, danger: true, confirm: 'Delete this person’s data everywhere it is held? This cannot be undone.', done: 'Deletion carried out.' },
          { label: 'Apply the opt-out', path: '/v1/customers/dsar/:id/execute-opt-out', when: { field: 'kind', values: ['opt_out_sale_share'] }, confirm: 'Apply the opt-out of sale and sharing for this person?', done: 'Opt-out applied.' },
        ],
      },
      {
        title: 'How long data is kept',
        description: 'Nothing is deleted until you set a period. Policies apply daily at 03:53 UTC.',
        list: '/v1/customers/retention',
        columns: ['dataClass', 'retainDays', 'legalHold', 'updatedAt'],
        empty: 'No retention periods set, so nothing is deleted automatically.',
        create: {
          label: 'Set a retention period',
          method: 'PUT',
          path: '/v1/customers/retention',
          form: {
            fields: [
              {
                key: 'dataClass',
                type: 'select',
                label: 'Data',
                options: opts(['customer_events', 'Customer events'], ['conversations', 'Conversations'], ['messages', 'Messages sent'], ['evidence_snapshots', 'Evidence snapshots'], ['webhook_payloads', 'Webhook payloads'], ['referral_clicks', 'Referral clicks']),
                required: true,
              },
              { key: 'retainDays', type: 'number', label: 'Keep for', unit: 'days', integer: true, min: 1, max: 3650, emptyAsNull: true, help: 'Leave empty to keep it indefinitely.' },
              { key: 'legalHold', type: 'toggle', label: 'Legal hold: keep everything regardless of the period' },
            ],
          },
          success: () => ok('Retention period saved.'),
        },
      },
    ],
  },
  {
    slug: 'knowledge',
    title: 'Knowledge & claims',
    modules: ['M03'],
    summary: 'Turn evidence into approved claims, product facts and brand rules, then check any copy against them before it ships.',
    custom: 'knowledge',
    resources: [
      {
        title: 'Claims',
        description: 'Statements you may make in marketing, each backed by evidence and approved by someone other than its author.',
        list: '/v1/knowledge/claims',
        columns: ['text', 'claimType', 'status', 'regulated', 'jurisdictions', 'expiresAt'],
        labels: { text: 'Claim', regulated: 'Regulated' },
        empty: 'No claims yet. Propose the first statement you want to use in marketing.',
        create: { label: 'Propose a claim', path: '/v1/knowledge/claims', form: CLAIM_FORM, success: (r) => ok('Claim proposed.', r.regulated ? 'It is regulated, so a legal approver or the owner must approve it.' : 'Ask a colleague with the approver role to approve it.') },
        rowActions: [
          { label: 'Approve', path: '/v1/knowledge/claims/:id/review', body: { decision: 'approved' }, when: { field: 'status', values: ['pending_review'] }, notMine: { field: 'createdBy', note: 'Waiting for another reviewer' }, done: 'Claim approved.' },
          { label: 'Reject', path: '/v1/knowledge/claims/:id/review', body: { decision: 'rejected' }, when: { field: 'status', values: ['pending_review'] }, notMine: { field: 'createdBy', note: '' }, danger: true, confirm: 'Reject this claim? It can no longer be used in copy.', done: 'Claim rejected.' },
        ],
      },
      {
        title: 'Facts',
        description: 'What is true about your products, plans and policies. A newer source updates a fact; an older, contradicting one raises a conflict.',
        list: '/v1/knowledge/facts',
        columns: ['name', 'kind', 'attributes', 'version', 'status', 'validFrom'],
        empty: 'No facts yet. Record products, plans, prices or policies with their evidence.',
        create: {
          label: 'Add a fact',
          path: '/v1/knowledge/facts',
          form: FACT_FORM,
          success: (r) => (r.status === 'conflict' ? { tone: 'warn', title: 'Saved as a conflict.', text: 'An existing version from a newer or equal source says something else. Choose which version to keep.' } : ok(`Fact saved (version ${r.version}).`)),
        },
        rowActions: [{ label: 'Keep this version', path: '/v1/knowledge/facts/:id/resolve-conflict', when: { field: 'status', values: ['conflict'] }, confirm: 'Keep this version and retire the conflicting one?', done: 'Conflict resolved.' }],
      },
      {
        title: 'Documents',
        description: 'Help articles, policies and guides the assistant and the AI agents may quote, each tied to its evidence.',
        list: '/v1/knowledge/documents',
        columns: ['title', 'visibility', 'chunkCount', 'createdAt'],
        empty: 'No documents yet.',
      },
      {
        title: 'Brand rules',
        description: 'Words to avoid, phrases that must appear and tone guidance. Every piece of copy is checked against them.',
        list: '/v1/knowledge/brand-rules',
        columns: ['kind', 'pattern', 'severity', 'description', 'channels'],
        labels: { kind: 'Rule', pattern: 'Phrase or limit', severity: 'When broken' },
        empty: 'No brand rules yet.',
        create: { label: 'Add a brand rule', path: '/v1/knowledge/brand-rules', form: BRAND_RULE_FORM, success: () => ok('Brand rule added.', 'It applies to every copy check from now on.') },
      },
    ],
  },
  {
    slug: 'market',
    title: 'Market & competitors',
    modules: ['M04', 'M05', 'M06'],
    summary: 'Trends against their baselines, lawful competitor monitoring and a ranked backlog of growth ideas.',
    resources: [
      {
        title: 'Ideas',
        list: '/v1/ideas',
        columns: ['title', 'status', 'evidenceStrength', 'score', 'createdAt'],
        empty: 'No ideas yet. Let the AI propose some from your evidence, or wait until more evidence is in.',
        create: {
          label: 'Generate ideas with AI',
          path: '/v1/ideas/generate',
          intro: 'The AI reads your admitted evidence and proposes ranked ideas. It abstains when the evidence is too thin.',
          form: { fields: [{ key: 'maxIdeas', type: 'select', label: 'How many ideas', options: opts(['3', 'Up to 3'], ['5', 'Up to 5'], ['8', 'Up to 8']), numeric: true, required: true, initial: '5' }] },
          success: () => ok('Idea generation started.', 'New ideas appear in the list within a minute. Refresh to see them.'),
        },
        rowActions: [
          { label: 'Queue for testing', path: '/v1/ideas/:id/status', body: { status: 'queued_for_test' }, when: { field: 'status', values: ['candidate'] }, done: 'Queued for testing.' },
          { label: 'Reject', path: '/v1/ideas/:id/status', body: { status: 'rejected' }, danger: true, confirm: 'Reject this idea?', done: 'Idea rejected.' },
        ],
      },
      {
        title: 'Competitors',
        list: '/v1/competitors',
        columns: ['name', 'domains', 'createdAt'],
        empty: 'No competitors tracked yet.',
        create: {
          label: 'Add a competitor',
          path: '/v1/competitors',
          form: {
            fields: [
              { key: 'name', type: 'text', label: 'Name', required: true, maxLength: 200, placeholder: 'Rival Inc' },
              { key: 'domains', type: 'tags', label: 'Websites', required: true, min: 1, max: 20, case: 'lower', placeholder: 'rival.example', itemPattern: /^[a-z0-9.-]+\.[a-z]{2,}$/, itemHint: 'enter a domain like rival.example (no https://)' },
              { key: 'notes', type: 'textarea', label: 'Notes', maxLength: 2000, rows: 2 },
            ],
          },
          success: () => ok('Competitor added.'),
        },
      },
      {
        title: 'Pages we monitor',
        description: 'Public pages watched for changes. Legal approves each one (with two-factor) before anything is collected.',
        list: '/v1/competitors',
        rows: (data) => (Array.isArray(data) ? (data as Row[]).flatMap((c) => ((c.sources as Row[] | undefined) ?? []).map((s) => ({ ...s, competitor: c.name }))) : []),
        columns: ['competitor', 'url', 'kind', 'status', 'crawlIntervalHours'],
        labels: { crawlIntervalHours: 'Check every (hours)' },
        empty: 'No monitored pages yet.',
        create: {
          label: 'Propose a page to monitor',
          path: '/v1/competitors/sources',
          form: {
            fields: [
              { key: 'competitorId', type: 'record', label: 'Competitor', required: true, source: SOURCES.competitors },
              { key: 'url', type: 'url', label: 'Page address', required: true, placeholder: 'https://rival.example/pricing' },
              {
                key: 'kind',
                type: 'select',
                label: 'What is on the page',
                options: opts(['pricing', 'Pricing'], ['features', 'Features'], ['changelog', 'Changelog'], ['docs', 'Documentation'], ['app_listing', 'App store listing'], ['ad_library', 'Ad library'], ['press', 'Press'], ['other', 'Other']),
                required: true,
                initial: 'pricing',
              },
              { key: 'lawfulBasisNote', type: 'textarea', label: 'Why collecting it is allowed', required: true, minLength: 10, maxLength: 2000, rows: 2, placeholder: 'Public pricing page; robots.txt allows crawling.' },
              { key: 'crawlIntervalHours', type: 'select', label: 'Check every', options: opts(['6', '6 hours'], ['12', '12 hours'], ['24', 'Day'], ['72', '3 days'], ['168', 'Week'], ['720', 'Month']), numeric: true, initial: '24' },
            ],
          },
          success: () => ok('Page proposed.', 'Legal approves it before monitoring starts.'),
        },
        rowActions: [
          { label: 'Approve (legal)', path: '/v1/competitors/sources/:id/review', body: { decision: 'approved' }, when: { field: 'status', values: ['pending'] }, done: 'Monitoring approved.' },
          { label: 'Check now', path: '/v1/competitors/sources/:id/crawl', when: { field: 'status', values: ['approved'] }, showResult: true },
          { label: 'Stop monitoring', path: '/v1/competitors/sources/:id/review', body: { decision: 'revoked' }, when: { field: 'status', values: ['approved', 'pending'] }, danger: true, confirm: 'Stop monitoring this page?', done: 'Monitoring stopped.' },
        ],
      },
      { title: 'Competitor observations', list: '/v1/competitors/observations', columns: ['kind', 'summary', 'isInference', 'observedAt'], empty: 'Nothing observed yet.' },
      { title: 'Feature gaps', list: '/v1/competitors/gaps', empty: 'No feature gaps found yet.' },
      { title: 'Trends', list: '/v1/market/trends', columns: ['direction', 'magnitude', 'pValue', 'detectedAt'], empty: 'No trends detected yet. They appear once metric series have enough history.' },
      { title: 'Topics', list: '/v1/market/topics', columns: ['label', 'size', 'terms', 'createdAt'], empty: 'No topics yet.' },
    ],
  },
  {
    slug: 'brain',
    title: 'Growth Brain',
    modules: ['M07'],
    summary: 'Decisions with their expected value and uncertainty; the AI abstains when unsure. Accepting a decision only proposes actions; nothing runs by itself.',
    resources: [
      {
        title: 'Decisions',
        list: '/v1/brain/decisions',
        columns: ['status', 'market', 'expectedValue', 'abstainReason', 'createdAt'],
        empty: 'No decisions yet. Start from an idea queued for testing.',
        create: {
          label: 'Propose a decision',
          path: '/v1/brain/decisions',
          form: {
            fields: [
              { key: 'ideaId', type: 'record', label: 'Idea', required: true, source: SOURCES.ideas },
              { key: 'market', type: 'text', label: 'Market', required: true, case: 'upper', pattern: MARKET_PATTERN, patternHint: `Use a country code: ${MARKET_HINT}.`, initial: 'US' },
              { key: 'horizon.value', type: 'number', label: 'Time to judge it', required: true, integer: true, min: 1, max: 52, initial: '2' },
              { key: 'horizon.unit', type: 'select', label: 'Unit', options: opts(['day', 'Days'], ['week', 'Weeks'], ['month', 'Months']), required: true, initial: 'week' },
              { key: 'objective', type: 'textarea', label: 'Objective', maxLength: 500, rows: 2 },
              { key: 'seriesId', type: 'record', label: 'Metric to move', source: SOURCES.series, advanced: true },
            ],
          },
          success: () => ok('The AI is working on it.', 'The decision appears in the list shortly. Refresh to see it.'),
        },
        rowActions: [
          { label: 'Accept', path: '/v1/brain/decisions/:id/accept', when: { field: 'status', values: ['PROPOSED'] }, confirm: 'Accept this decision? Its actions are proposed for approval; nothing runs by itself.', done: 'Accepted. Its actions are waiting in Actions & approvals.' },
          { label: 'Reject', path: '/v1/brain/decisions/:id/reject', form: { fields: [reason('Why not?')] }, when: { field: 'status', values: ['PROPOSED'] }, danger: true, done: 'Decision rejected.' },
        ],
      },
      { title: 'AI runs', list: '/v1/brain/runs', columns: ['kind', 'status', 'inputTokens', 'outputTokens', 'abstainReason', 'startedAt'], detail: '/v1/brain/runs/:id', empty: 'No AI runs yet.' },
    ],
  },
  {
    slug: 'analytics',
    title: 'Forecasts & MMM',
    modules: ['M08', 'M09'],
    summary: 'Forecasts with honest ranges and backtests, and media-mix models that show which channels drive results.',
    resources: [
      {
        title: 'Metrics',
        list: '/v1/analytics/series',
        columns: ['name', 'key', 'unit', 'granularity', 'kind'],
        empty: 'No metrics yet. Define the KPIs you want to forecast and move.',
        create: {
          label: 'Define a metric',
          path: '/v1/analytics/series',
          form: {
            fields: [
              { key: 'name', type: 'text', label: 'Name', required: true, maxLength: 300, placeholder: 'Sign-ups' },
              { key: 'kind', type: 'select', label: 'What it measures', options: opts(['kpi', 'A goal (KPI)'], ['spend', 'Spend'], ['exposure', 'Exposure (impressions, sends)'], ['signal', 'A leading signal'], ['control', 'A control variable']), required: true, initial: 'kpi' },
              { key: 'unit', type: 'text', label: 'Unit', required: true, maxLength: 50, placeholder: 'count, USD, %' },
              { key: 'granularity', type: 'select', label: 'Measured per', options: opts(['hour', 'Hour'], ['day', 'Day'], ['week', 'Week'], ['month', 'Month']), required: true, initial: 'day' },
              { key: 'sourceEvidenceId', type: 'evidence', label: 'Where the numbers come from', required: true },
              { key: 'channel', type: 'text', label: 'Channel', maxLength: 100, emptyAsNull: true, advanced: true },
              { key: 'geography', type: 'text', label: 'Market', case: 'upper', pattern: MARKET_PATTERN, patternHint: `Use a country code: ${MARKET_HINT}.`, emptyAsNull: true, advanced: true },
              { key: 'key', type: 'text', label: 'Short ID', advanced: true, pattern: /^[a-z0-9][a-z0-9._:-]*$/, patternHint: 'Use lower-case letters, numbers, dots, colons or dashes.', help: 'Left empty, it is made from the name.' },
            ],
            transform: (b) => ({ ...b, key: b.key ?? `${b.kind}.${factKey(String(b.kind), String(b.name ?? ''))}` }),
          },
          success: () => ok('Metric defined.'),
        },
        rowActions: [{ label: 'Data points', path: '/v1/analytics/series/:id/points', method: 'GET', showResult: true }],
      },
      {
        title: 'Analyses',
        list: '/v1/analytics/requests',
        columns: ['kind', 'status', 'createdAt', 'finishedAt'],
        detail: '/v1/analytics/requests/:id',
        empty: 'No analyses yet.',
        create: {
          label: 'Run an analysis',
          path: '/v1/analytics/requests',
          intro: 'Analyses run on the analytics job within about 15 minutes; results appear in this list.',
          form: {
            fields: [
              {
                key: 'kind',
                type: 'select',
                label: 'Analysis',
                options: opts(['forecast', 'Forecast a metric'], ['trend_detection', 'Detect trends'], ['anomaly_scan', 'Find anomalies'], ['mmm', 'Media-mix model'], ['topic_clustering', 'Group topics'], ['propensity_training', 'Train a propensity model'], ['experiment_analysis', 'Analyse an experiment']),
                required: true,
                initial: 'forecast',
              },
              { key: 'params.seriesId', type: 'record', label: 'Metric', required: true, source: SOURCES.series, showIf: { key: 'kind', values: ['forecast', 'trend_detection', 'anomaly_scan'] } },
              { key: 'params.horizon', type: 'number', label: 'Forecast ahead', unit: 'periods', integer: true, min: 1, max: 365, initial: '28', required: true, showIf: { key: 'kind', values: ['forecast'] } },
              { key: 'params.experimentId', type: 'record', label: 'Experiment', required: true, source: SOURCES.experiments, showIf: { key: 'kind', values: ['experiment_analysis'] } },
              { key: 'priority', type: 'number', label: 'Priority (1 runs first)', integer: true, min: 1, max: 1000, initial: '100', advanced: true },
            ],
            transform: (b) => ({ params: {}, ...b }),
          },
          success: () => ok('Analysis queued.'),
        },
      },
    ],
  },
  {
    slug: 'experiments',
    title: 'Experiments',
    modules: ['M10'],
    summary: 'Tests planned before they start, with logged assignment and checks that the traffic split is healthy.',
    resources: [
      {
        title: 'Experiments',
        list: '/v1/experiments',
        columns: ['name', 'design', 'status', 'riskTier', 'createdAt'],
        detail: '/v1/experiments/:id',
        empty: 'No experiments yet. Design one around a single, measurable change.',
        create: {
          label: 'Design an experiment',
          path: '/v1/experiments',
          form: {
            fields: [
              { key: 'name', type: 'text', label: 'Name', required: true, minLength: 3, maxLength: 200, placeholder: 'Welcome email subject line' },
              { key: 'hypothesis', type: 'textarea', label: 'What you expect, and why', required: true, minLength: 10, maxLength: 4000, rows: 2, placeholder: 'A benefit-led subject line increases 7-day activation.' },
              { key: 'targetMetric', type: 'text', label: 'Success metric', required: true, maxLength: 100, placeholder: 'activated_7d' },
              { key: 'metricType', type: 'select', label: 'The metric is', options: opts(['binary', 'Yes or no (a conversion)'], ['continuous', 'An amount (revenue, time…)']), required: true, initial: 'binary' },
              { key: 'design', type: 'select', label: 'Design', options: opts(['ab_fixed', 'A/B test with a fixed split'], ['bandit_thompson', 'Adaptive test (shifts traffic to the winner)']), required: true, initial: 'ab_fixed' },
              { key: 'unit', type: 'select', label: 'Who is randomised', options: opts(['profile', 'Each customer'], ['anonymous_id', 'Each visitor'], ['session', 'Each session'], ['geo', 'Each region']), required: true, initial: 'profile' },
              { key: 'riskTier', type: 'select', label: 'Risk', options: opts(['low', 'Low'], ['medium', 'Medium'], ['high', 'High']), required: true, initial: 'low' },
              {
                key: 'variants',
                type: 'rows',
                label: 'Variants',
                addLabel: 'Add a variant',
                itemLabel: 'Variant',
                min: 2,
                max: 10,
                help: 'Exactly one variant is the control (what you do today).',
                initial: [
                  { key: 'control', description: 'Current version', isControl: true, weight: '1' },
                  { key: 'variant-b', description: '', isControl: false, weight: '1' },
                ],
                fields: [
                  { key: 'key', type: 'text', label: 'Short name', required: true, case: 'lower', pattern: /^[a-z0-9_-]{1,40}$/, patternHint: 'Use lower-case letters, numbers, - or _ (up to 40).' },
                  { key: 'description', type: 'text', label: 'What is different', required: true, maxLength: 1000 },
                  { key: 'weight', type: 'number', label: 'Traffic weight', min: 0.01, initial: '1' },
                  { key: 'isControl', type: 'toggle', label: 'This is the control' },
                ],
              },
              { key: 'ideaId', type: 'record', label: 'Idea it tests', source: SOURCES.ideas, emptyAsNull: true, advanced: true },
              { key: 'plannedSamplePerVariant', type: 'number', label: 'Planned sample per variant', integer: true, min: 1, emptyAsNull: true, advanced: true },
              percent('holdoutFraction', 'Hold-out share', { max: 50, advanced: true } as Partial<Field>),
            ],
          },
          success: () => ok('Experiment created.', 'Propose to start it; the start goes through approval.'),
        },
        rowActions: [
          { label: 'Propose start', path: '/v1/experiments/:id/propose-start', form: { fields: [{ key: 'evidenceIds', type: 'evidence', multiple: true, label: 'Supporting evidence' }] }, when: { field: 'status', values: ['draft', 'approved'] }, done: 'Start proposed. Approve it in Actions & approvals.' },
          { label: 'Analyse', path: '/v1/experiments/:id/analyze', when: { field: 'status', values: ['running', 'stopped'] }, done: 'Analysis queued.' },
          { label: 'Stop', path: '/v1/experiments/:id/stop', form: { fields: [reason('Why stop it?')] }, when: { field: 'status', values: ['running'] }, danger: true, done: 'Experiment stopped.' },
        ],
      },
    ],
  },
  {
    slug: 'audiences',
    title: 'Audiences',
    modules: ['M11'],
    summary: 'Explainable segments built on lawful attributes. Sensitive attributes are refused.',
    resources: [
      {
        title: 'Segments',
        list: '/v1/audiences/segments',
        columns: ['name', 'purpose', 'status', 'createdAt'],
        empty: 'No segments yet.',
        create: {
          label: 'Define a segment',
          path: '/v1/audiences/segments',
          form: {
            fields: [
              { key: 'name', type: 'text', label: 'Name', required: true, minLength: 2, maxLength: 200, placeholder: 'Trial users without an integration' },
              {
                key: 'purpose',
                type: 'select',
                label: 'Used for',
                options: opts(['marketing_email', 'Marketing emails'], ['ads_customer_match', 'Ad audiences'], ['personalization', 'Personalisation'], ['analytics', 'Analysis only']),
                required: true,
                initial: 'marketing_email',
                help: 'Only people with the matching consent are included.',
              },
              { key: 'match', type: 'select', label: 'People must match', options: opts(['all', 'All the rules'], ['any', 'Any rule']), required: true, initial: 'all' },
              {
                key: 'rules',
                type: 'rows',
                label: 'Rules',
                addLabel: 'Add a rule',
                itemLabel: 'Rule',
                min: 1,
                max: 20,
                initial: [{ ruleType: 'event', event: 'signup', op: 'gte', count: '1', windowDays: '14' }],
                fields: [
                  { key: 'ruleType', type: 'select', label: 'Based on', options: opts(['event', 'Something they did'], ['place', 'Where they are'], ['trait', 'A profile attribute']), required: true, initial: 'event' },
                  { key: 'event', type: 'text', label: 'Event name', required: true, placeholder: 'signup', showIf: { key: 'ruleType', values: ['event'] } },
                  { key: 'op', type: 'select', label: 'How often', options: opts(['gte', 'At least'], ['lte', 'At most'], ['eq', 'Exactly']), required: true, initial: 'gte', showIf: { key: 'ruleType', values: ['event'] } },
                  { key: 'count', type: 'number', label: 'Times', integer: true, min: 0, required: true, showIf: { key: 'ruleType', values: ['event'] } },
                  { key: 'windowDays', type: 'number', label: 'In the last', unit: 'days', integer: true, min: 1, max: 730, required: true, showIf: { key: 'ruleType', values: ['event'] } },
                  { key: 'field', type: 'select', label: 'Attribute', options: opts(['country', 'Country'], ['locale', 'Language'], ['timezone', 'Time zone']), required: true, initial: 'country', showIf: { key: 'ruleType', values: ['place'] } },
                  { key: 'placeOp', type: 'select', label: 'Is', options: opts(['in', 'One of'], ['eq', 'Exactly'], ['neq', 'Not']), required: true, initial: 'in', showIf: { key: 'ruleType', values: ['place'] } },
                  { key: 'placeValue', type: 'text', label: 'Values (comma separated)', required: true, placeholder: 'US, CA', showIf: { key: 'ruleType', values: ['place'] } },
                  { key: 'trait', type: 'text', label: 'Attribute name', required: true, pattern: /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/, patternHint: 'Letters, numbers and _ only, starting with a letter.', showIf: { key: 'ruleType', values: ['trait'] } },
                  { key: 'traitOp', type: 'select', label: 'Condition', options: opts(['eq', 'Equals'], ['neq', 'Does not equal'], ['gt', 'Greater than'], ['lt', 'Less than'], ['exists', 'Is set']), required: true, initial: 'eq', showIf: { key: 'ruleType', values: ['trait'] } },
                  { key: 'traitValue', type: 'text', label: 'Value', showIf: { key: 'ruleType', values: ['trait'] } },
                ],
              },
              { key: 'description', type: 'textarea', label: 'Description', maxLength: 2000, rows: 2, advanced: true },
            ],
            transform: (b) => {
              const rules = ((b.rules as Row[]) ?? []).map((r) => {
                if (r.ruleType === 'place') {
                  const vals = String(r.placeValue ?? '')
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                  return { field: r.field, op: r.placeOp, value: r.placeOp === 'in' ? vals : (vals[0] ?? '') };
                }
                if (r.ruleType === 'trait') {
                  const raw = r.traitValue as string | undefined;
                  const value = raw === undefined ? undefined : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw === 'true' ? true : raw === 'false' ? false : raw;
                  return { trait: r.trait, op: r.traitOp, ...(value === undefined || r.traitOp === 'exists' ? {} : { value }) };
                }
                return { event: r.event, op: r.op, count: r.count, windowDays: r.windowDays };
              });
              const { rules: _r, match, ...rest } = b;
              return { ...rest, definition: { all: match === 'any' ? [] : rules, any: match === 'any' ? rules : [] } };
            },
          },
          success: () => ok('Segment defined.', 'Take a snapshot to see who is in it.'),
        },
        rowActions: [
          { label: 'Take a snapshot', path: '/v1/audiences/segments/:id/snapshot', showResult: true },
          { label: 'Snapshots', path: '/v1/audiences/segments/:id/snapshots', method: 'GET', showResult: true },
        ],
      },
    ],
  },
  {
    slug: 'offers',
    title: 'Offers & CRO',
    modules: ['M12'],
    summary: 'Discounts that stay inside price and margin guardrails, and conversion ideas for your pages.',
    resources: [
      {
        title: 'Price guardrails',
        description: 'Set by a finance approver with two-factor. Offers outside them are refused.',
        list: '/v1/offers/guardrails',
        columns: ['productRef', 'currency', 'listPriceMicros', 'minPriceMicros', 'maxDiscountFraction'],
        empty: 'No guardrails yet. Offers need one for each product they discount.',
        create: {
          label: 'Set a guardrail',
          method: 'PUT',
          path: '/v1/offers/guardrails',
          form: {
            fields: [
              { key: 'productRef', type: 'text', label: 'Product or plan ID', required: true, maxLength: 200, placeholder: 'team-plan' },
              { key: 'currency', type: 'text', label: 'Currency', required: true, case: 'upper', pattern: /^[A-Z]{3}$/, patternHint: 'Use a 3-letter code such as USD or BDT.', initial: 'USD' },
              money('listPriceMicros', 'List price', { required: true, min: 0.01 } as Partial<Field>),
              money('unitCostMicros', 'Cost per unit', { required: true } as Partial<Field>),
              money('minPriceMicros', 'Lowest price allowed', { required: true } as Partial<Field>),
              percent('maxDiscountFraction', 'Largest discount allowed', { required: true, max: 99 } as Partial<Field>),
              percent('minMarginFraction', 'Smallest margin allowed', { required: true, min: -99, max: 99 } as Partial<Field>),
              { key: 'inventoryAvailable', type: 'number', label: 'Units in stock', integer: true, min: 0, emptyAsNull: true, advanced: true },
            ],
          },
          success: () => ok('Guardrail saved.'),
        },
      },
      {
        title: 'Offers',
        list: '/v1/offers',
        columns: ['name', 'status', 'discountFraction', 'productRef', 'createdAt'],
        empty: 'No offers yet.',
        create: {
          label: 'Draft an offer',
          path: '/v1/offers',
          form: {
            fields: [
              { key: 'name', type: 'text', label: 'Name', required: true, minLength: 3, maxLength: 200, placeholder: 'Autumn annual discount' },
              { key: 'kind', type: 'select', label: 'Offer type', options: opts(['percent_discount', 'Percentage off'], ['fixed_discount', 'Amount off'], ['bundle', 'Bundle price'], ['trial_extension', 'Longer trial'], ['free_shipping', 'Free shipping']), required: true, initial: 'percent_discount' },
              { key: 'productRefs', type: 'tags', label: 'Products or plans', required: true, min: 1, max: 50, placeholder: 'team-plan' },
              percent('params.percentage', 'Discount', { required: true, min: 1, max: 99, showIf: { key: 'kind', values: ['percent_discount'] } } as Partial<Field>),
              money('params.amountMicros', 'Amount off', { required: true, min: 0.01, showIf: { key: 'kind', values: ['fixed_discount'] } } as Partial<Field>),
              money('params.bundlePriceMicros', 'Bundle price', { required: true, min: 0.01, showIf: { key: 'kind', values: ['bundle'] } } as Partial<Field>),
              { key: 'params.extraTrialDays', type: 'number', label: 'Extra trial days', required: true, integer: true, min: 1, max: 365, showIf: { key: 'kind', values: ['trial_extension'] } },
              { key: 'params.code', type: 'text', label: 'Discount code', case: 'upper', pattern: /^[A-Z0-9_-]{4,40}$/, patternHint: '4–40 capital letters, numbers, - or _.', placeholder: 'AUTUMN15' },
              { key: 'startsAt', type: 'datetime', label: 'Starts', required: true, initial: () => localIn(1) },
              { key: 'endsAt', type: 'datetime', label: 'Ends', emptyAsNull: true },
              { key: 'copy', type: 'textarea', label: 'Offer copy', maxLength: 2000, rows: 2 },
              { key: 'claimIds', type: 'record', multiple: true, label: 'Approved claims the copy uses', source: SOURCES.approvedClaims },
              { key: 'params.usageLimit', type: 'number', label: 'Maximum uses', integer: true, min: 1, advanced: true },
              { key: 'scarcityClaim', type: 'text', label: 'Scarcity statement', maxLength: 300, emptyAsNull: true, advanced: true, help: 'Only with evidence that it is true (no fake urgency).' },
              { key: 'scarcityEvidenceId', type: 'evidence', label: 'Evidence for the scarcity statement', emptyAsNull: true, advanced: true },
            ],
            transform: (b) => ({ params: {}, ...b }),
          },
          success: () => ok('Offer drafted.', 'A finance approver approves it next.'),
        },
        rowActions: [{ label: 'Approve', path: '/v1/offers/:id/approve', when: { field: 'status', values: ['draft'] }, done: 'Offer approved.' }],
      },
      {
        title: 'Conversion ideas (CRO)',
        list: '/v1/offers/cro',
        columns: ['pageUrl', 'hypothesis', 'status', 'createdAt'],
        empty: 'No conversion ideas yet.',
        create: {
          label: 'Add a conversion idea',
          path: '/v1/offers/cro',
          form: {
            fields: [
              { key: 'pageUrl', type: 'url', label: 'Page', required: true, placeholder: 'https://www.example.com/pricing' },
              { key: 'hypothesis', type: 'textarea', label: 'What you expect, and why', required: true, minLength: 10, maxLength: 2000, rows: 2 },
              {
                key: 'changes',
                type: 'rows',
                label: 'Changes',
                addLabel: 'Add a change',
                itemLabel: 'Change',
                min: 1,
                max: 20,
                fields: [
                  { key: 'element', type: 'text', label: 'Element', required: true, maxLength: 200, placeholder: 'Billing toggle' },
                  { key: 'change', type: 'text', label: 'Change', required: true, minLength: 3, maxLength: 1000, placeholder: 'Show annual savings next to it' },
                ],
              },
              { key: 'evidenceIds', type: 'evidence', multiple: true, min: 1, label: 'Evidence behind it', required: true },
            ],
          },
          success: () => ok('Conversion idea added.'),
        },
      },
    ],
  },
  {
    slug: 'creative',
    title: 'Creative briefs',
    modules: ['M13'],
    summary: 'Briefs where every message maps to an approved claim, so creative stays truthful.',
    resources: [
      {
        title: 'Briefs',
        list: '/v1/creative/briefs',
        columns: ['title', 'objective', 'channel', 'status', 'createdAt'],
        empty: 'No briefs yet. Approve some claims first, then let the AI draft a brief.',
        create: {
          label: 'Draft a brief with AI',
          path: '/v1/creative/briefs/generate',
          form: {
            fields: [
              { key: 'objective', type: 'text', label: 'Goal', required: true, minLength: 3, placeholder: 'More trials turning into paid plans' },
              { key: 'channel', type: 'select', label: 'Channel', options: CHANNEL_OPTIONS, required: true, initial: 'instagram' },
              { key: 'audience', type: 'text', label: 'Audience', required: true, minLength: 3, placeholder: 'Operations managers on a trial' },
              { key: 'ideaId', type: 'record', label: 'Based on idea', source: SOURCES.ideas, advanced: true },
            ],
          },
          success: () => ok('The AI is drafting the brief.', 'It appears in the list shortly. Refresh to see it.'),
        },
        rowActions: [{ label: 'Approve', path: '/v1/creative/briefs/:id/approve', when: { field: 'status', values: ['draft'] }, done: 'Brief approved.' }],
      },
    ],
  },
  {
    slug: 'assets',
    title: 'Asset studio',
    modules: ['M14'],
    summary: 'Uploads, their rights and video renders. Only assets with complete rights can be posted.',
    resources: [
      { title: 'Assets', list: '/v1/assets', columns: ['title', 'kind', 'origin', 'publishEligible', 'createdAt'], detail: '/v1/assets/:id', empty: 'No assets yet. Upload source media above.', rowActions: [{ label: 'Download link', path: '/v1/assets/:id/download-url', method: 'GET', showResult: true }] },
      {
        title: 'Video renders',
        list: '/v1/assets/renders',
        columns: ['composition', 'status', 'statusReason', 'createdAt'],
        empty: 'No renders yet.',
        create: {
          label: 'Render a video',
          path: '/v1/assets/renders',
          form: {
            fields: [
              { key: 'composition', type: 'select', label: 'Template', options: opts(['product_showcase', 'Product showcase (vertical, 15 s)'], ['ugc_captioned', 'Captioned clip (vertical, 20 s)'], ['persona_story', 'Persona story (vertical, 20 s)']), required: true, initial: 'product_showcase' },
              { key: 'inputAssetIds', type: 'record', multiple: true, min: 1, label: 'Source media', required: true, source: SOURCES.assets() },
              { key: 'props.headline', type: 'text', label: 'Headline', maxLength: 120 },
              { key: 'props.captions', type: 'tags', label: 'Captions', max: 20, placeholder: 'Type a caption and press Enter' },
              { key: 'props.cta', type: 'text', label: 'Call to action', maxLength: 60, placeholder: 'Start free' },
              { key: 'props.brandColor', type: 'text', label: 'Brand colour', pattern: /^#[0-9a-fA-F]{6}$/, patternHint: 'Use a hex colour like #17694C.', initial: '#17694C' },
              { key: 'props.disclosureText', type: 'text', label: 'Disclosure text', maxLength: 120 },
              { key: 'claimIds', type: 'record', multiple: true, label: 'Approved claims shown in it', source: SOURCES.approvedClaims },
              { key: 'briefId', type: 'record', label: 'Brief', source: SOURCES.briefs, emptyAsNull: true, advanced: true },
              { key: 'personaId', type: 'record', label: 'Persona', source: SOURCES.personas, emptyAsNull: true, advanced: true },
            ],
            transform: (b) => ({ props: {}, ...b }),
          },
          success: () => ok('Render queued.', 'It runs on the media job within about 10 minutes.'),
        },
      },
      {
        title: 'Video licence (Remotion)',
        description: 'Automated rendering stays off until the owner records the organisation’s licence (two-factor needed).',
        create: {
          label: 'Record the licence',
          method: 'PUT',
          path: '/v1/assets/remotion-license',
          form: {
            fields: [
              { key: 'eligibility', type: 'select', label: 'Licence', options: opts(['free_license', 'Free licence'], ['company_license', 'Company licence']), required: true, initial: 'free_license' },
              {
                key: 'basis',
                type: 'select',
                label: 'Why the free licence applies',
                options: opts(['organization_up_to_3_people', 'Organisation of up to 3 people'], ['individual', 'Individual'], ['non_profit', 'Non-profit']),
                required: true,
                initial: 'organization_up_to_3_people',
                showIf: { key: 'eligibility', values: ['free_license'] },
              },
              { key: 'teamSize', type: 'number', label: 'People in the organisation', integer: true, min: 1, max: 3, showIf: { key: 'eligibility', values: ['free_license'] } },
              { key: 'licenseRef', type: 'text', label: 'Licence reference', required: true, minLength: 3, showIf: { key: 'eligibility', values: ['company_license'] } },
              { key: 'attestation', type: 'textarea', label: 'Statement', required: true, minLength: 20, rows: 2, placeholder: 'We are a company of 2 people and qualify for the free licence.' },
            ],
          },
          success: () => ok('Licence recorded.'),
        },
      },
    ],
    custom: 'assets',
  },
  {
    slug: 'personas',
    title: 'Synthetic personas',
    modules: ['M15'],
    summary: 'Clearly disclosed virtual brand characters. Real-person likeness and first-person testimonials are blocked.',
    resources: [
      {
        title: 'Personas',
        list: '/v1/personas',
        columns: ['name', 'status', 'disclosureCopy', 'createdAt'],
        empty: 'No personas yet.',
        create: {
          label: 'Create a persona',
          path: '/v1/personas',
          form: {
            fields: [
              { key: 'name', type: 'text', label: 'Name', required: true, minLength: 2, maxLength: 100, placeholder: 'Nova' },
              { key: 'personaBible.backstory', type: 'textarea', label: 'Backstory', required: true, minLength: 20, maxLength: 4000, rows: 3, placeholder: 'Nova is a fictional, AI-generated guide who shares practical product tips.', help: 'Must say the character is fictional or AI-generated.' },
              { key: 'personaBible.voiceTone', type: 'text', label: 'Voice and tone', required: true, minLength: 3, maxLength: 500, placeholder: 'Warm, concise' },
              { key: 'disclosureCopy', type: 'text', label: 'Disclosure shown with every post', required: true, minLength: 10, maxLength: 300, placeholder: 'Nova is an AI character created by Acme.', help: 'Must clearly say the character is AI-generated or virtual.' },
              { key: 'personaBible.topicsAllowed', type: 'tags', label: 'Topics it may cover', max: 30 },
              { key: 'personaBible.topicsForbidden', type: 'tags', label: 'Topics it must avoid', max: 30, initial: ['health', 'finance'] },
              { key: 'likeness.origin', type: 'select', label: 'Appearance', options: opts(['original_synthetic', 'Original character (not based on a real person)'], ['licensed_likeness', 'Licensed likeness of a real person']), required: true, initial: 'original_synthetic' },
              { key: 'likeness.rightsHolder', type: 'text', label: 'Person who licensed their likeness', required: true, minLength: 2, showIf: { key: 'likeness.origin', values: ['licensed_likeness'] } },
              { key: 'likeness.consentEvidenceId', type: 'evidence', label: 'Their signed consent', required: true, kinds: ['consent', 'contract'], showIf: { key: 'likeness.origin', values: ['licensed_likeness'] } },
              { key: 'likeness.attestation', type: 'textarea', label: 'Statement about the appearance', required: true, minLength: 20, maxLength: 2000, rows: 2, initial: 'Original character; not based on any real person.' },
              { key: 'personaBible.values', type: 'tags', label: 'Values', max: 10, advanced: true },
              { key: 'visualIdentity.styleNotes', type: 'textarea', label: 'Visual style', maxLength: 1000, rows: 2, advanced: true },
              { key: 'visualIdentity.referenceAssetIds', type: 'record', multiple: true, label: 'Reference images', source: SOURCES.assets(), advanced: true },
              { key: 'voiceIdentity.notes', type: 'textarea', label: 'Voice notes', maxLength: 1000, rows: 2, advanced: true },
              { key: 'contentRules.extra', type: 'tags', label: 'Extra content rules', max: 20, advanced: true },
            ],
            transform: (b) => ({ visualIdentity: {}, voiceIdentity: {}, ...b }),
          },
          success: () => ok('Persona created.', 'Someone else approves it before it can be used.'),
        },
        rowActions: [
          { label: 'Approve', path: '/v1/personas/:id/approve', when: { field: 'status', values: ['draft'] }, done: 'Persona approved.' },
          { label: 'Suspend', path: '/v1/personas/:id/suspend', form: { fields: [reason('Why suspend it?')] }, when: { field: 'status', values: ['approved'] }, danger: true, done: 'Persona suspended.' },
        ],
      },
      {
        title: 'Protected identities',
        description: 'Real people whose name or likeness must never be used for a persona.',
        create: {
          label: 'Protect an identity',
          path: '/v1/personas/protected-identities',
          form: {
            fields: [
              { key: 'name', type: 'text', label: 'Name', required: true, minLength: 2, placeholder: 'Jane Celebrity' },
              { key: 'reason', type: 'text', label: 'Reason', required: true, minLength: 3, placeholder: 'Public figure; no likeness rights' },
            ],
          },
          success: () => ok('Identity protected.'),
        },
      },
    ],
  },
  {
    slug: 'social',
    title: 'Organic social',
    modules: ['M16'],
    summary: 'Scheduled posts go out only after approval and count only once a read-back confirms they are live. No automated likes or follows.',
    resources: [
      {
        title: 'Posts',
        list: '/v1/social/posts',
        columns: ['platform', 'status', 'caption', 'scheduledAt', 'externalUrl'],
        empty: 'No posts yet.',
        create: {
          label: 'Schedule a post',
          path: '/v1/social/posts',
          form: {
            fields: [
              { key: 'connectionId', type: 'record', label: 'Account', required: true, source: SOURCES.connections(['meta', 'tiktok', 'youtube']) },
              { key: 'platform', type: 'select', label: 'Post on', options: opts(['facebook', 'Facebook'], ['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['youtube', 'YouTube']), required: true, initial: 'facebook' },
              { key: 'caption', type: 'textarea', label: 'Caption', required: true, maxLength: 5000, rows: 4 },
              { key: 'scheduledAt', type: 'datetime', label: 'Publish at', required: true, initial: () => localIn(2), help: 'It still needs approval before this time.' },
              { key: 'assetIds', type: 'record', multiple: true, label: 'Media', source: SOURCES.assets(true) },
              { key: 'link', type: 'url', label: 'Link', emptyAsNull: true },
              { key: 'claimIds', type: 'record', multiple: true, label: 'Approved claims in the caption', source: SOURCES.approvedClaims },
              geos(),
              { key: 'disclosure.isAiGenerated', type: 'toggle', label: 'Made with AI (labelled as such)' },
              { key: 'disclosure.paidPartnership', type: 'toggle', label: 'Paid partnership' },
              { key: 'disclosure.disclosureText', type: 'text', label: 'Disclosure text', maxLength: 300, emptyAsNull: true, advanced: true },
              { key: 'personaId', type: 'record', label: 'Persona', source: SOURCES.personas, emptyAsNull: true, advanced: true },
              { key: 'options.tiktokPrivacy', type: 'select', label: 'TikTok visibility', options: opts(['SELF_ONLY', 'Only me'], ['FOLLOWER_OF_CREATOR', 'Followers'], ['MUTUAL_FOLLOW_FRIENDS', 'Friends'], ['PUBLIC_TO_EVERYONE', 'Everyone']), initial: 'SELF_ONLY', showIf: { key: 'platform', values: ['tiktok'] } },
              { key: 'options.youtubeTitle', type: 'text', label: 'YouTube title', maxLength: 100, showIf: { key: 'platform', values: ['youtube'] } },
              { key: 'options.youtubePrivacy', type: 'select', label: 'YouTube visibility', options: opts(['private', 'Private'], ['unlisted', 'Unlisted'], ['public', 'Public']), initial: 'private', showIf: { key: 'platform', values: ['youtube'] } },
            ],
          },
          success: () => ok('Post scheduled.', 'Approve it in Actions & approvals before the publish time.'),
        },
      },
      {
        title: 'Community inbox',
        list: '/v1/social/interactions',
        columns: ['platform', 'kind', 'text', 'replyStatus', 'receivedAt'],
        empty: 'No comments yet.',
        rowActions: [
          { label: 'Draft a reply with AI', path: '/v1/social/interactions/:id/draft-reply', when: { field: 'replyStatus', values: ['none'] }, done: 'Drafting… refresh in a moment to see it.' },
          {
            label: 'Send reply',
            path: '/v1/social/interactions/:id/reply',
            form: { fields: [{ key: 'message', type: 'textarea', label: 'Reply', maxLength: 8000, rows: 3, help: 'Leave empty to send the AI draft as is.' }, geos()] },
            when: { field: 'replyStatus', values: ['drafted'] },
            done: 'Reply proposed. Approve it in Actions & approvals.',
          },
        ],
      },
      { title: 'Publishing stats', list: '/v1/social/stats', empty: 'Nothing published yet.' },
    ],
  },
  {
    slug: 'ads',
    title: 'Paid media',
    modules: ['M17'],
    summary: 'Budget and status changes inside agreed spend limits, with reported spend reconciled against what was approved.',
    resources: [
      {
        title: 'Campaigns',
        list: '/v1/ads/campaigns',
        columns: ['platform', 'name', 'status', 'dailyBudgetMicros', 'currency', 'lastSyncedAt'],
        empty: 'No campaigns yet. They sync in once an ad account is connected.',
        rowActions: [
          { label: 'Performance', path: '/v1/ads/campaigns/:id/performance', method: 'GET', showResult: true },
          {
            label: 'Change budget',
            path: '/v1/ads/campaigns/:id/budget',
            form: {
              fields: [
                money('newDailyBudgetMicros', 'New daily budget (in the campaign’s currency)', { required: true, min: 0.01 } as Partial<Field>),
                { key: 'rationale', type: 'textarea', label: 'Why', required: true, minLength: 10, maxLength: 2000, rows: 2 },
                geos(),
                { key: 'evidenceIds', type: 'evidence', multiple: true, label: 'Supporting evidence' },
              ],
            },
            done: 'Budget change proposed. Approve it in Actions & approvals.',
          },
          {
            label: 'Pause',
            path: '/v1/ads/campaigns/:id/status',
            body: { status: 'PAUSED' },
            form: { fields: [{ key: 'rationale', type: 'textarea', label: 'Why pause it?', required: true, minLength: 10, maxLength: 2000, rows: 2 }, geos()] },
            when: { field: 'status', values: ['ACTIVE', 'active', 'ENABLED'] },
            danger: true,
            done: 'Pause proposed. Approve it in Actions & approvals.',
          },
          {
            label: 'Resume',
            path: '/v1/ads/campaigns/:id/status',
            body: { status: 'ACTIVE' },
            form: { fields: [{ key: 'rationale', type: 'textarea', label: 'Why resume it?', required: true, minLength: 10, maxLength: 2000, rows: 2 }, geos()] },
            when: { field: 'status', values: ['PAUSED', 'paused'] },
            done: 'Resume proposed. Approve it in Actions & approvals.',
          },
        ],
      },
      {
        title: 'Spend checks',
        description: 'Reported spend compared with the budgets that were approved and verified.',
        list: '/v1/ads/reconciliations',
        columns: ['periodStart', 'periodEnd', 'status', 'authorizedMicros', 'reportedMicros', 'deltaMicros'],
        empty: 'No spend checks yet.',
        create: {
          label: 'Check spend',
          path: '/v1/ads/connections/:connectionId/reconcile',
          form: {
            fields: [
              { key: 'connectionId', type: 'record', label: 'Ad account', required: true, source: SOURCES.connections(['meta', 'google_ads', 'tiktok']) },
              { key: 'start', type: 'date', label: 'From', required: true, initial: () => daysAgo(10) },
              { key: 'end', type: 'date', label: 'To', required: true, initial: () => daysAgo(4), help: 'Use settled days (a few days back).' },
              percent('tolerance', 'Allowed difference', { initial: '2', max: 50 } as Partial<Field>),
            ],
            pathParams: ['connectionId'],
          },
          success: () => ok('Spend check finished.'),
        },
      },
    ],
  },
  {
    slug: 'discovery',
    title: 'SEO, ASO & AI discovery',
    modules: ['M18'],
    summary: 'Technical site audits that respect robots.txt, search query opportunities and app store listings. No ranking promises.',
    resources: [
      {
        title: 'Site audits',
        list: '/v1/seo/audits',
        columns: ['siteUrl', 'status', 'maxPages', 'finishedAt'],
        detail: '/v1/seo/audits/:id',
        empty: 'No audits yet.',
        create: {
          label: 'Audit a site',
          path: '/v1/seo/audits',
          form: {
            fields: [
              { key: 'siteUrl', type: 'url', label: 'Website', required: true, placeholder: 'https://www.example.com' },
              { key: 'maxPages', type: 'number', label: 'Pages to check', integer: true, min: 1, max: 200, initial: '50' },
            ],
          },
          success: () => ok('Audit started.', 'Results appear in the list when it finishes.'),
        },
      },
      { title: 'Search opportunities', list: '/v1/seo/opportunities', pick: 'rows', columns: ['query', 'page_url', 'impressions', 'clicks', 'position', 'ctr'], empty: 'No search data yet. Connect Search Console or upload keyword data.' },
      {
        title: 'Check store text',
        description: 'Checks length limits and store rules before you draft a listing.',
        create: {
          label: 'Check',
          path: '/v1/aso/validate',
          form: {
            fields: [
              { key: 'store', type: 'select', label: 'Store', options: STORE_OPTIONS, required: true, initial: 'app_store' },
              { key: 'fields', type: 'pairs', label: 'Listing text', keyLabel: 'Field', valueLabel: 'Text', keyOptions: STORE_FIELDS, required: true },
            ],
          },
          success: (r) => {
            const checks = (Array.isArray(r.checks) ? r.checks : []) as Row[];
            return checks.length ? { tone: 'warn', title: `${checks.length} problem${checks.length === 1 ? '' : 's'} found.`, items: checks.map((c) => `${c.field}: ${c.detail}`) } : ok('No problems found.');
          },
        },
      },
      {
        title: 'Store listings',
        list: '/v1/aso/listings',
        columns: ['store', 'appRef', 'locale', 'status', 'createdAt'],
        empty: 'No listings drafted yet.',
        create: {
          label: 'Draft a listing',
          path: '/v1/aso/listings',
          form: {
            fields: [
              { key: 'store', type: 'select', label: 'Store', options: STORE_OPTIONS, required: true, initial: 'app_store' },
              { key: 'appRef', type: 'text', label: 'App ID or bundle ID', required: true, maxLength: 200, placeholder: 'com.acme.app' },
              { key: 'locale', type: 'text', label: 'Language', required: true, minLength: 2, maxLength: 10, initial: 'en-US' },
              { key: 'fields', type: 'pairs', label: 'Listing text', keyLabel: 'Field', valueLabel: 'Text', keyOptions: STORE_FIELDS, required: true },
              { key: 'claimIds', type: 'record', multiple: true, label: 'Approved claims used', source: SOURCES.approvedClaims },
            ],
          },
          success: () => ok('Listing drafted.', 'Approve it, then push it to the store.'),
        },
        rowActions: [
          { label: 'Approve', path: '/v1/aso/listings/:id/approve', when: { field: 'status', values: ['draft'] }, done: 'Listing approved.' },
          {
            label: 'Push to the App Store',
            path: '/v1/aso/listings/:id/push',
            form: {
              fields: [
                { key: 'connectionId', type: 'record', label: 'App Store Connect account', required: true, source: SOURCES.connections(['app_store_connect']) },
                { key: 'localizationId', type: 'text', label: 'App Store localisation ID', required: true, help: 'Found in App Store Connect for this language version.' },
                geos(),
                { key: 'evidenceIds', type: 'evidence', multiple: true, label: 'Supporting evidence' },
              ],
            },
            when: { field: 'status', values: ['approved'] },
            done: 'Push proposed. Approve it in Actions & approvals.',
          },
        ],
      },
    ],
  },
  {
    slug: 'app',
    title: 'App growth',
    modules: ['M19'],
    summary: 'Installs by attribution method, cohorts and App Store reports. Attribution shows association, not cause.',
    resources: [
      { title: 'Installs by method', list: '/v1/app/installs/stats', empty: 'No installs recorded yet.' },
      { title: 'Cohorts (last 90 days)', list: `/v1/app/cohorts?from=${new Date(Date.now() - 90 * 86_400_000).toISOString()}&to=${iso()}&activationEvent=activated`, pick: 'cohorts', empty: 'No cohorts yet.' },
      {
        title: 'App Store reports',
        list: '/v1/app/store-reports',
        columns: ['reportType', 'period', 'rowCount', 'fetchedAt'],
        empty: 'No reports yet.',
        create: {
          label: 'Fetch a day',
          path: '/v1/app/store-reports/sync',
          form: {
            fields: [
              { key: 'connectionId', type: 'record', label: 'App Store Connect account', required: true, source: SOURCES.connections(['app_store_connect']) },
              { key: 'reportDate', type: 'date', label: 'Day', required: true, initial: () => daysAgo(2), help: 'Apple publishes each day’s report about a day later.' },
            ],
          },
          success: () => ok('Report fetched.'),
        },
      },
    ],
  },
  {
    slug: 'lifecycle',
    title: 'Lifecycle messaging',
    modules: ['M20'],
    summary: 'Approved email templates and triggered journeys. Consent and do-not-contact lists are checked right before every send.',
    resources: [
      {
        title: 'Email templates',
        list: '/v1/lifecycle/templates',
        columns: ['name', 'version', 'category', 'status', 'subject'],
        empty: 'No templates yet.',
        create: {
          label: 'New template',
          path: '/v1/lifecycle/templates',
          intro: 'The footer with your postal address and an unsubscribe link is added automatically.',
          form: {
            fields: [
              { key: 'name', type: 'text', label: 'Name', required: true, minLength: 2, maxLength: 200, placeholder: 'Welcome' },
              { key: 'category', type: 'select', label: 'Type', options: opts(['commercial', 'Marketing'], ['transactional', 'Transactional (receipts, account)']), required: true, initial: 'commercial' },
              { key: 'subject', type: 'text', label: 'Subject', required: true, maxLength: 200, placeholder: 'Welcome, {{first_name}}' },
              { key: 'bodyText', type: 'textarea', label: 'Message', required: true, maxLength: 50_000, rows: 6, help: 'Personalise with {{first_name}}, {{display_name}} or {{company_name}}.' },
              { key: 'claimIds', type: 'record', multiple: true, label: 'Approved claims used', source: SOURCES.approvedClaims },
              { key: 'bodyHtml', type: 'textarea', label: 'HTML version', maxLength: 200_000, rows: 6, emptyAsNull: true, advanced: true },
            ],
          },
          success: () => ok('Template saved.', 'Two other people approve it before it can be sent.'),
        },
        rowActions: [{ label: 'Approve', path: '/v1/lifecycle/templates/:id/approve', when: { field: 'status', values: ['draft'] }, done: 'Approval recorded.' }],
      },
      {
        title: 'Journeys',
        list: '/v1/lifecycle/journeys',
        columns: ['name', 'triggerEvent', 'status', 'evidenceFreshnessHours', 'activatedAt'],
        empty: 'No journeys yet.',
        create: {
          label: 'New journey',
          path: '/v1/lifecycle/journeys',
          form: {
            fields: [
              { key: 'name', type: 'text', label: 'Name', required: true, minLength: 2, maxLength: 200, placeholder: 'Onboarding' },
              { key: 'triggerEvent', type: 'text', label: 'Starts when this event happens', required: true, maxLength: 200, pattern: /^[A-Za-z0-9_.:\- ]+$/, patternHint: 'Letters, numbers, spaces and _ . : - only.', placeholder: 'signup' },
              { key: 'connectionId', type: 'record', label: 'Sending account', required: true, source: SOURCES.connections(['resend']) },
              {
                key: 'steps',
                type: 'rows',
                label: 'Steps',
                addLabel: 'Add a step',
                itemLabel: 'Step',
                min: 1,
                max: 30,
                initial: [{ type: 'send_email' }, { type: 'wait', hours: '48' }],
                fields: [
                  { key: 'type', type: 'select', label: 'Step', options: opts(['send_email', 'Send an email'], ['wait', 'Wait'], ['exit_if_event', 'Stop if they did something'], ['send_experiment', 'Send the email an experiment picks']), required: true, initial: 'send_email' },
                  { key: 'templateId', type: 'record', label: 'Template', required: true, source: SOURCES.templates, showIf: { key: 'type', values: ['send_email'] } },
                  { key: 'hours', type: 'number', label: 'Wait for', unit: 'hours', min: 1, max: 2160, required: true, showIf: { key: 'type', values: ['wait'] } },
                  { key: 'eventName', type: 'text', label: 'Event', required: true, placeholder: 'integration_connected', showIf: { key: 'type', values: ['exit_if_event'] } },
                  { key: 'experimentId', type: 'record', label: 'Experiment', required: true, source: SOURCES.experiments, showIf: { key: 'type', values: ['send_experiment'] } },
                ],
              },
              { key: 'evidenceFreshnessHours', type: 'select', label: 'Use customer data no older than', options: opts(['24', '1 day'], ['72', '3 days'], ['168', '1 week'], ['336', '2 weeks'], ['720', '30 days']), numeric: true, initial: '168', advanced: true },
            ],
          },
          success: () => ok('Journey created.', 'Activate it when you are ready.'),
        },
        rowActions: [
          { label: 'Activate', path: '/v1/lifecycle/journeys/:id/activate', when: { field: 'status', values: ['draft', 'paused'] }, confirm: 'Activate this journey? Messages start going to people who trigger it.', done: 'Journey active.' },
          { label: 'Pause', path: '/v1/lifecycle/journeys/:id/pause', form: { fields: [reason('Why pause it?')] }, when: { field: 'status', values: ['active'] }, danger: true, done: 'Journey paused.' },
          { label: 'Stats', path: '/v1/lifecycle/journeys/:id/stats', method: 'GET', showResult: true },
        ],
      },
      { title: 'Messages', list: '/v1/lifecycle/messages', columns: ['category', 'status', 'statusReason', 'sentAt', 'createdAt'], empty: 'No messages sent yet.' },
      { title: 'Delivery report (30 days)', list: '/v1/lifecycle/report', empty: 'Nothing delivered in the last 30 days.' },
    ],
  },
  {
    slug: 'conversations',
    title: 'Conversations',
    modules: ['M21'],
    summary: 'A website assistant that answers from your public documents with sources, always says it is AI, and hands over to a person when unsure.',
    resources: [
      {
        title: 'Website chat',
        description: 'Create a chat widget for your website. Index public documents in Knowledge first so it has something to answer from.',
        create: {
          label: 'Create a chat widget',
          path: '/v1/conversations/widgets',
          form: {
            fields: [
              { key: 'allowedOrigins', type: 'tags', label: 'Websites it runs on', required: true, min: 1, max: 20, itemPattern: ORIGIN, itemHint: ORIGIN_HINT, placeholder: 'https://www.example.com' },
              { key: 'disclosureText', type: 'text', label: 'AI disclosure', minLength: 10, maxLength: 300, placeholder: "You're chatting with an AI assistant. A human can take over at any time.", help: 'Leave empty for the standard text.' },
            ],
          },
          success: (r) => ({ tone: 'ok', title: 'Widget created.', text: 'Use this public key in the widget snippet on your site.', secret: { label: 'Public key', value: String(r.publicKey ?? '') } }),
        },
      },
      {
        title: 'Conversations',
        list: '/v1/conversations',
        columns: ['channel', 'status', 'lastMessageAt'],
        detail: '/v1/conversations/:id',
        empty: 'No conversations yet.',
        rowActions: [
          { label: 'Reply', path: '/v1/conversations/:id/reply', form: { fields: [{ key: 'text', type: 'textarea', label: 'Your reply', required: true, maxLength: 4000, rows: 3 }] }, when: { field: 'status', values: ['open', 'handoff'] }, done: 'Reply sent.' },
          { label: 'Close', path: '/v1/conversations/:id/close', when: { field: 'status', values: ['open', 'handoff'] }, confirm: 'Close this conversation?', done: 'Conversation closed.' },
        ],
      },
      { title: 'Tickets', list: '/v1/conversations/tickets', columns: ['subject', 'status', 'priority', 'createdAt'], empty: 'No tickets.' },
      {
        title: 'Leads',
        list: '/v1/conversations/leads',
        columns: ['status', 'score', 'qualification', 'createdAt'],
        empty: 'No leads yet.',
        rowActions: [
          { label: 'Qualified', path: '/v1/conversations/leads/:id/status', body: { status: 'qualified' }, done: 'Marked as qualified.' },
          { label: 'Not a fit', path: '/v1/conversations/leads/:id/status', body: { status: 'disqualified' }, danger: true, confirm: 'Mark this lead as not a fit?', done: 'Marked as not a fit.' },
        ],
      },
    ],
  },
  {
    slug: 'creators',
    title: 'Creators & referrals',
    modules: ['M22'],
    summary: 'Real partners with signed contracts, required disclosures and a commission ledger. Payouts stay blocked until a payout provider is chosen.',
    resources: [
      {
        title: 'Creators',
        list: '/v1/creators',
        columns: ['name', 'status', 'handles', 'createdAt'],
        detail: '/v1/creators/:id',
        empty: 'No creators yet.',
        create: {
          label: 'Add a creator',
          path: '/v1/creators',
          form: {
            fields: [
              { key: 'name', type: 'text', label: 'Name', required: true, maxLength: 200 },
              { key: 'handles', type: 'pairs', label: 'Social accounts', keyLabel: 'Platform', valueLabel: 'Handle', keyOptions: opts(['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['youtube', 'YouTube'], ['facebook', 'Facebook'], ['x', 'X']), valuePlaceholder: '@handle' },
              { key: 'contactEmail', type: 'email', label: 'Contact email', emptyAsNull: true, help: 'Stored only with their consent or contract as evidence.' },
              { key: 'contactConsentEvidenceId', type: 'evidence', label: 'Consent or contract for the email', kinds: ['consent', 'contract'], emptyAsNull: true },
            ],
          },
          success: () => ok('Creator added.', 'Record their signed contract next.'),
        },
        rowActions: [{ label: 'Propose payout', path: '/v1/creators/:id/payout', confirm: 'Propose paying this creator’s earned commission? Payouts are blocked until a payout provider is set up.', done: 'Payout proposed.' }],
      },
      {
        title: 'Contracts',
        create: {
          label: 'Record a contract',
          path: '/v1/creators/contracts',
          form: {
            fields: [
              { key: 'creatorId', type: 'record', label: 'Creator', required: true, source: SOURCES.creators },
              {
                key: 'materialRelationship',
                type: 'select',
                label: 'Relationship',
                options: opts(['affiliate_commission', 'Paid by commission'], ['paid', 'Paid a fee'], ['free_product', 'Received free product'], ['employee', 'Employee'], ['family_or_friend', 'Family or friend'], ['other', 'Other']),
                required: true,
                initial: 'affiliate_commission',
              },
              percent('commissionFraction', 'Commission', { initial: '10' } as Partial<Field>),
              money('flatFeeMicros', 'Flat fee'),
              { key: 'currency', type: 'text', label: 'Currency', required: true, case: 'upper', pattern: /^[A-Z]{3}$/, patternHint: 'Use a 3-letter code such as USD.', initial: 'USD' },
              { key: 'requiredDisclosures', type: 'tags', label: 'Disclosure they must use', required: true, min: 1, max: 5, suggestions: ['#ad', '#sponsored', 'Paid partnership'], initial: ['#ad'] },
              { key: 'startsAt', type: 'datetime', label: 'Starts', required: true, initial: () => localIn(0) },
              { key: 'endsAt', type: 'datetime', label: 'Ends', emptyAsNull: true },
              { key: 'signedEvidenceId', type: 'evidence', label: 'The signed contract', required: true, kinds: ['contract'] },
              { key: 'terms', type: 'textarea', label: 'Terms', maxLength: 10_000, rows: 3, advanced: true, help: 'Pay may never depend on positive reviews.' },
            ],
          },
          success: () => ok('Contract recorded.'),
        },
      },
      {
        title: 'Referral links',
        create: {
          label: 'Create a referral link',
          path: '/v1/creators/links',
          form: {
            fields: [
              { key: 'creatorId', type: 'record', label: 'Creator', required: true, source: SOURCES.creators },
              { key: 'contractId', type: 'record', label: 'Contract', required: true, source: SOURCES.contracts },
              { key: 'destinationUrl', type: 'url', label: 'Where the link goes', required: true, placeholder: 'https://shop.example.com/' },
            ],
          },
          success: (r) => ({ tone: 'ok', title: 'Referral link created.', ...(r.code || r.url ? { secret: { label: 'Link code', value: String(r.url ?? r.code) } } : {}) }),
        },
      },
      {
        title: 'Content submissions',
        create: {
          label: 'Submit content for review',
          path: '/v1/creators/submissions',
          form: {
            fields: [
              { key: 'creatorId', type: 'record', label: 'Creator', required: true, source: SOURCES.creators },
              { key: 'contractId', type: 'record', label: 'Contract', required: true, source: SOURCES.contracts },
              { key: 'contentText', type: 'textarea', label: 'Post text', required: true, maxLength: 20_000, rows: 3, help: 'It is checked for the required disclosure.' },
              { key: 'contentUrl', type: 'url', label: 'Link to the post', emptyAsNull: true },
            ],
          },
          success: (r) => (r.status === 'rejected_missing_disclosure' ? { tone: 'warn', title: 'Submitted, but the disclosure is missing.', text: 'The post must include the disclosure from the contract.' } : ok('Content submitted for review.')),
        },
      },
      {
        title: 'Fraud flags',
        list: '/v1/creators/fraud-flags',
        columns: ['kind', 'status', 'details', 'createdAt'],
        empty: 'No open fraud flags.',
        rowActions: [
          { label: 'Confirm fraud', path: '/v1/creators/fraud-flags/:id', body: { status: 'confirmed' }, danger: true, confirm: 'Confirm this as fraud? Related commission is clawed back.', done: 'Fraud confirmed.' },
          { label: 'Dismiss', path: '/v1/creators/fraud-flags/:id', body: { status: 'dismissed' }, done: 'Flag dismissed.' },
        ],
      },
    ],
  },
  {
    slug: 'connections',
    title: 'Connections',
    modules: ['M23'],
    summary: 'The accounts FUTUREGROW works with. Test the details before saving; they are stored encrypted and never shown again.',
    custom: 'connections',
    resources: [
      {
        title: 'What each connection allows',
        description: 'Every kind of change FUTUREGROW can make, how it is checked afterwards and how it is undone.',
        list: '/v1/action-types',
        pick: 'actionTypes',
        rows: (data) => ((data as { actionTypes?: Row[] } | null)?.actionTypes ?? []).map((a) => ({ ...a, provider: providerName(a.provider) })),
        columns: ['type', 'provider', 'category', 'verification', 'rollback', 'supported', 'blockerRef'],
        labels: { type: 'Action', blockerRef: 'Waiting on' },
      },
    ],
  },
  { slug: 'governance', title: 'Governance', modules: ['M24'], summary: 'What may run on its own, spending limits, emergency stops, sender identity, registries and incidents.', resources: [], custom: 'governance' },
  { slug: 'audit', title: 'Audit trail', modules: ['M24'], summary: 'A tamper-evident record of every change. Verify the chain at any time.', resources: [], custom: 'audit' },
  { slug: 'settings', title: 'Account & security', modules: [], summary: 'Two-factor sign-in, your password, your team and organisations.', resources: [], custom: 'settings' },
];

/** Navigation follows the growth journey: daily screens first, then one group per stage. */
export const SECTION_GROUPS: { title: string; slugs: string[]; stage?: number }[] = [{ title: 'Today', slugs: DAILY_SECTIONS }, ...STAGES.map((s) => ({ title: s.title, slugs: s.sections, stage: s.n }))];

export function sectionBySlug(slug: string): Section | undefined {
  return SECTIONS.find((s) => s.slug === slug);
}

/** Every create form and row-action form in the catalog (for checks and tests). */
export function allForms(sections: { resources: Resource[] }[] = SECTIONS): { where: string; spec: FormSpec }[] {
  const out: { where: string; spec: FormSpec }[] = [];
  for (const s of sections)
    for (const r of s.resources) {
      if (r.create) out.push({ where: `${r.title} › ${r.create.label}`, spec: r.create.form });
      for (const a of r.rowActions ?? []) if (a.form && typeof a.form !== 'function') out.push({ where: `${r.title} › ${a.label}`, spec: a.form });
    }
  return out;
}
