/**
 * Shared vocabulary for the guided forms: option lists with plain-language labels, record
 * sources for pickers, and the ground-truth forms (evidence, facts, claims, brand rules) that
 * several screens reuse. Values are exactly what the API accepts; only the labels are friendly.
 */

import { shortId, statusLabel } from './format.js';
import { evidenceReadiness, type FormNotice, type FormSpec, type Option, opts, type RecordSource, type Row } from './forms.js';

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

export const COUNTRY_SUGGESTIONS = ['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'IN', 'BD', 'SG', 'AE'];
export const MARKET_PATTERN = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;
export const MARKET_HINT = 'use a country code such as US, GB or BD (a region like US-CA also works)';

export const CHANNEL_OPTIONS = opts(['email', 'Email'], ['facebook', 'Facebook'], ['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['youtube', 'YouTube'], ['search_ads', 'Search ads'], ['display', 'Display ads'], ['landing_page', 'Landing page']);

export const EVIDENCE_KIND_OPTIONS = opts(
  ['document', 'Document or report'],
  ['metric', 'Metric or number'],
  ['observation', 'Observation'],
  ['snapshot', 'Screenshot or snapshot'],
  ['experiment_result', 'Experiment result'],
  ['contract', 'Signed contract'],
  ['license', 'Licence'],
  ['consent', 'Customer consent or statement'],
);

export const SOURCE_TYPE_OPTIONS = opts(['primary', 'Our own data (first-party)'], ['internal', 'Internal team knowledge'], ['research', 'Third-party research'], ['secondary', 'Public or secondary source']);

export const RIGHTS_OPTIONS = opts(['first-party', 'We own it'], ['licensed', 'Licensed to us'], ['public', 'Publicly available; its terms allow our use'], ['', 'Not sure yet (it will wait for review)']);

export const PII_OPTIONS = opts(['none', 'No personal data'], ['pseudonymous', 'Only pseudonymous IDs'], ['personal', 'Personal data'], ['sensitive', 'Sensitive personal data'], ['children', "Children's data (always blocked)"]);

export const CONFIDENCE_OPTIONS = opts(['0.95', 'High: measured or verified'], ['0.75', 'Medium: reliable, not verified'], ['0.5', 'Low: indicative only'], ['', 'Not sure yet (it will wait for review)']);

export const FRESHNESS_OPTIONS = opts(['24', '1 day'], ['168', '1 week'], ['720', '30 days'], ['2160', '90 days'], ['8760', '1 year'], ['', 'It does not go out of date']);

export const USE_OPTIONS = opts(
  ['analytics', 'Analysis and reporting'],
  ['creative_generation', 'Writing copy and creative'],
  ['publishing', 'Public claims and posts'],
  ['messaging', 'Customer messages'],
  ['support', 'Support answers'],
  ['experimentation', 'Experiments'],
  ['forecasting', 'Forecasts'],
  ['personalization', 'Personalisation'],
  ['targeting', 'Ad targeting'],
  ['competitive_analysis', 'Competitor analysis'],
  ['causal_measurement', 'Causal measurement'],
  ['autonomous_execution', 'Automated actions'],
);

export const CLAIM_TYPE_OPTIONS = opts(
  ['product_capability', 'What the product does'],
  ['price', 'Price or discount'],
  ['availability', 'Availability'],
  ['statistic', 'A number or statistic'],
  ['comparative', 'Comparison with others', 'Regulated: needs a legal approver or the owner'],
  ['testimonial', 'Customer testimonial', 'Regulated: needs consented customer evidence'],
  ['health', 'Health', 'Regulated'],
  ['financial', 'Financial', 'Regulated'],
  ['environmental', 'Environmental', 'Regulated'],
  ['other', 'Something else'],
);

export const FACT_KIND_OPTIONS = opts(['product', 'Product'], ['feature', 'Feature'], ['plan', 'Plan'], ['price', 'Price'], ['policy', 'Policy'], ['faq', 'FAQ answer'], ['brand_guide', 'Brand guideline'], ['release', 'Release'], ['integration', 'Integration'], ['audience', 'Audience']);

export const BRAND_RULE_OPTIONS = opts(['banned_phrase', 'Never use a phrase'], ['required_phrase', 'Always include a phrase'], ['max_exclamations', 'Limit exclamation marks'], ['tone_note', 'Tone note for writers'], ['banned_regex', 'Block a text pattern (advanced)']);

export const ROLE_OPTIONS = opts(['owner', 'Owner'], ['admin', 'Admin'], ['growth_operator', 'Growth operator'], ['approver', 'Approver'], ['finance_approver', 'Finance approver'], ['legal_approver', 'Legal approver'], ['privacy_officer', 'Privacy officer'], ['analyst', 'Analyst'], ['viewer', 'Viewer']);

export const VISIBILITY_OPTIONS = opts(['public', 'Public: the website assistant may quote it'], ['internal', 'Internal: everyone in the team'], ['restricted', 'Restricted: only chosen roles']);

export const label = (options: Option[], value: unknown) => options.find((o) => o.value === value)?.label ?? statusLabel(value);

/* ------------------------------------------------------------------ */
/* Record sources                                                      */
/* ------------------------------------------------------------------ */

const PROVIDER_NAMES: Record<string, string> = { meta: 'Meta', google_ads: 'Google Ads', tiktok: 'TikTok', youtube: 'YouTube', shopify: 'Shopify', app_store_connect: 'App Store Connect', google_play: 'Google Play', resend: 'Resend', posthog: 'PostHog', chatwoot: 'Chatwoot', search_console: 'Search Console' };
export const providerName = (p: unknown) => PROVIDER_NAMES[String(p)] ?? statusLabel(p);
const day = (v: unknown) => (v ? new Date(String(v)).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '');

export const SOURCES = {
  connections: (providers?: string[]): RecordSource => ({
    list: '/v1/connections',
    label: (r) => String(r.displayName ?? providerName(r.provider)),
    detail: (r) => `${providerName(r.provider)} · ${statusLabel(r.healthStatus ?? r.status)}`,
    filter: (r) => r.status === 'active' && (!providers || providers.includes(String(r.provider))),
    empty: providers ? `No active ${providers.map(providerName).join(' or ')} connection yet.` : 'No active connection yet.',
    href: '/app/connections',
  }),
  approvedClaims: {
    list: '/v1/knowledge/claims?status=approved',
    label: (r) => String(r.text),
    detail: (r) => `${label(CLAIM_TYPE_OPTIONS, r.claimType)}${r.expiresAt ? ` · until ${day(r.expiresAt)}` : ''}`,
    filter: (r) => r.status === 'approved' && (!r.expiresAt || new Date(String(r.expiresAt)) > new Date()),
    empty: 'No approved claims yet. Propose one and have a colleague approve it.',
    href: '/app/knowledge?step=claims',
  } satisfies RecordSource,
  facts: {
    list: '/v1/knowledge/facts',
    label: (r) => String(r.name),
    detail: (r) => `${label(FACT_KIND_OPTIONS, r.kind)} · version ${r.version}`,
    empty: 'No facts recorded yet.',
    href: '/app/knowledge?step=facts',
  } satisfies RecordSource,
  sources: {
    list: '/v1/evidence/sources',
    label: (r) => String(r.name),
    detail: (r) => `${label(SOURCE_TYPE_OPTIONS, r.sourceType)} · ${statusLabel(r.status)}`,
    filter: (r) => r.status !== 'blocked',
    empty: 'No registered sources yet.',
    href: '/app/evidence',
  } satisfies RecordSource,
  competitors: { list: '/v1/competitors', label: (r) => String(r.name), detail: (r) => (Array.isArray(r.domains) ? r.domains.join(', ') : ''), empty: 'No competitors yet.', href: '/app/market' } satisfies RecordSource,
  ideas: {
    list: '/v1/ideas',
    label: (r) => String(r.title),
    detail: (r) => statusLabel(r.status),
    empty: 'No ideas yet. Generate some in Market & competitors.',
    href: '/app/market',
  } satisfies RecordSource,
  series: { list: '/v1/analytics/series', label: (r) => String(r.name), detail: (r) => `${r.key} · ${r.unit} per ${r.granularity}`, empty: 'No metric series yet.', href: '/app/analytics' } satisfies RecordSource,
  templates: { list: '/v1/lifecycle/templates', label: (r) => `${r.name} (v${r.version})`, detail: (r) => statusLabel(r.status), empty: 'No email templates yet.', href: '/app/lifecycle' } satisfies RecordSource,
  experiments: { list: '/v1/experiments', label: (r) => String(r.name), detail: (r) => statusLabel(r.status), empty: 'No experiments yet.', href: '/app/experiments' } satisfies RecordSource,
  assets: (eligibleOnly = false): RecordSource => ({
    list: '/v1/assets',
    label: (r) => String(r.title),
    detail: (r) => `${statusLabel(r.kind)} · ${r.publishEligible ? 'rights complete' : 'rights incomplete'}`,
    ...(eligibleOnly ? { filter: (r: Row) => r.publishEligible === true } : {}),
    empty: eligibleOnly ? 'No publish-eligible assets yet. Upload media and record its rights.' : 'No assets yet. Upload media first.',
    href: '/app/assets',
  }),
  personas: { list: '/v1/personas', label: (r) => String(r.name), detail: (r) => statusLabel(r.status), filter: (r) => r.status === 'approved', empty: 'No approved personas.', href: '/app/personas' } satisfies RecordSource,
  briefs: { list: '/v1/creative/briefs', label: (r) => String(r.title ?? r.objective), detail: (r) => `${statusLabel(r.channel)} · ${statusLabel(r.status)}`, empty: 'No briefs yet.', href: '/app/creative' } satisfies RecordSource,
  creators: { list: '/v1/creators', label: (r) => String(r.name), detail: (r) => statusLabel(r.status), empty: 'No creators yet.', href: '/app/creators' } satisfies RecordSource,
  contracts: {
    list: (v) => (v.creatorId ? `/v1/creators/${encodeURIComponent(String(v.creatorId))}` : null),
    pick: 'contracts',
    label: (r) => `${statusLabel(r.materialRelationship)} from ${day(r.startsAt)}`,
    detail: (r) => (Array.isArray(r.requiredDisclosures) ? `Disclosure: ${r.requiredDisclosures.join(', ')}` : ''),
    empty: 'This creator has no recorded contract yet.',
  } satisfies RecordSource,
  profiles: {
    list: '/v1/customers?limit=500',
    label: (r) => `Customer ${shortId(r.id)}`,
    detail: (r) => [r.country, r.locale, r.createdAt ? `since ${day(r.createdAt)}` : ''].filter(Boolean).join(' · '),
    filter: (r) => !r.deletedAt,
    empty: 'No customer profiles yet. They appear once your site or app sends events.',
    href: '/app/customers',
  } satisfies RecordSource,
};

/* ------------------------------------------------------------------ */
/* Ground-truth forms                                                  */
/* ------------------------------------------------------------------ */

const nowIso = () => new Date().toISOString();

/** Admit evidence (M01). Unknown rights, PII class or confidence are allowed: the server quarantines. */
export const EVIDENCE_FORM: FormSpec = {
  fields: [
    { key: 'summary', type: 'text', label: 'What is this evidence?', placeholder: 'Q3 customer retention report', required: true, maxLength: 4000, help: 'A short title your team will recognise.' },
    { key: 'kind', type: 'select', label: 'Type', options: EVIDENCE_KIND_OPTIONS, required: true, initial: 'document' },
    { key: 'content', type: 'textarea', label: 'Content or key facts', required: true, rows: 6, placeholder: 'Paste the relevant text or numbers…', help: 'A fingerprint is stored with it, so any later change is detectable.', fromFile: { accept: '.txt,.md,.csv,.json,.html,text/plain', nameTo: 'summary' } },
    { key: 'sourceUriOrObjectId', type: 'text', label: 'Where it comes from', required: true, placeholder: 'https://… or a report or file name', help: 'A link or reference someone else could use to find the original.' },
    { key: 'sourceOwner', type: 'text', label: 'Who owns the source', required: true, placeholder: 'Our company, a research firm…' },
    { key: 'sourceType', type: 'select', label: 'Source type', options: SOURCE_TYPE_OPTIONS, required: true, initial: 'primary' },
    { key: 'licenseOrUsageRights', type: 'select', label: 'May we use it?', options: RIGHTS_OPTIONS, initial: 'first-party', emptyAsNull: true },
    { key: 'piiClassification', type: 'select', label: 'Does it contain personal data?', options: PII_OPTIONS, initial: 'none', emptyAsNull: true },
    {
      key: 'lawfulBasisOrConsentId',
      type: 'text',
      label: 'Lawful basis or consent reference',
      required: true,
      showIf: { key: 'piiClassification', values: ['personal', 'sensitive'] },
      placeholder: 'Consent record ID, contract number…',
      help: 'Personal data without one is quarantined.',
    },
    { key: 'confidence', type: 'select', label: 'How reliable is it?', options: CONFIDENCE_OPTIONS, numeric: true, initial: '0.95', emptyAsNull: true },
    { key: 'freshnessSlaHours', type: 'select', label: 'How long does it stay accurate?', options: FRESHNESS_OPTIONS, numeric: true, initial: '2160', emptyAsNull: true, help: 'After this it is marked out of date and cannot back new claims until refreshed.' },
    { key: 'permittedUses', type: 'choices', label: 'It may be used for', options: USE_OPTIONS, initial: ['analytics', 'creative_generation', 'publishing'] },
    { key: 'observedAt', type: 'date', iso: 'start', label: 'Date the data describes', advanced: true, help: 'Leave empty when it describes today.' },
    { key: 'geography', type: 'text', label: 'Market it describes', advanced: true, placeholder: 'US', case: 'upper', pattern: MARKET_PATTERN, patternHint: `Use a country code: ${MARKET_HINT}.` },
    { key: 'sourceId', type: 'record', label: 'Registered source', advanced: true, source: SOURCES.sources, help: 'Its rights and defaults then apply; a source still under review quarantines the evidence.' },
    { key: 'externalPlatform', type: 'toggle', label: 'It comes from an external platform (Meta, Google…)', advanced: true },
    { key: 'platformTermsVersion', type: 'text', label: 'Platform terms version', required: true, showIf: { key: 'externalPlatform', values: [true] }, placeholder: 'Meta Platform Terms 2026-02' },
  ],
  fixed: { schemaVersion: '1', retrievedAt: nowIso },
};

/** Release quarantined evidence: only the answers still missing are asked for. */
export function releaseForm(row: Row): FormSpec {
  const reasons = Array.isArray(row.quarantineReasons) ? (row.quarantineReasons as string[]) : [];
  const has = (r: string) => reasons.includes(r);
  const needsBasis = has('personal data without lawful basis/consent reference');
  const fields: FormSpec['fields'] = [];
  if (has('license/usage rights unknown')) fields.push({ key: 'licenseOrUsageRights', type: 'select', label: 'May we use it?', required: true, options: RIGHTS_OPTIONS.filter((o) => o.value) });
  if (has('PII classification missing')) fields.push({ key: 'piiClassification', type: 'select', label: 'Does it contain personal data?', required: true, options: PII_OPTIONS.filter((o) => o.value !== 'children') });
  if (has('PII classification missing') || needsBasis) {
    fields.push({ key: 'lawfulBasisOrConsentId', type: 'text', label: 'Lawful basis or consent reference', required: true, placeholder: 'Consent record ID, contract number…', ...(needsBasis ? {} : { showIf: { key: 'piiClassification', values: ['personal', 'sensitive'] } }) });
  }
  if (has('confidence missing')) fields.push({ key: 'confidence', type: 'select', label: 'How reliable is it?', required: true, options: CONFIDENCE_OPTIONS.filter((o) => o.value), numeric: true });
  if (has('external platform terms version missing')) fields.push({ key: 'platformTermsVersion', type: 'text', label: 'Platform terms version', required: true });
  fields.push({ key: 'note', type: 'textarea', label: 'Review note', required: true, minLength: 3, maxLength: 2000, rows: 3, placeholder: 'Checked the licence and the numbers with finance.', help: 'Saved in the audit trail.' });
  return { fields };
}

/** A stable key from a name, so facts with the same name stay versions of one fact. */
export function factKey(kind: string, name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^[^a-z0-9]+|-+$/g, '');
  if (slug) return slug.slice(0, 200);
  let h = 0;
  for (const c of name) h = (Math.imul(h, 31) + (c.codePointAt(0) ?? 0)) >>> 0;
  return `${kind}-${h.toString(36)}`;
}

export const FACT_FORM: FormSpec = {
  fields: [
    { key: 'kind', type: 'select', label: 'What kind of fact?', options: FACT_KIND_OPTIONS, required: true, initial: 'product' },
    { key: 'name', type: 'text', label: 'Name', required: true, maxLength: 300, placeholder: 'Team plan' },
    { key: 'attributes', type: 'pairs', label: 'Details', keyLabel: 'Property', valueLabel: 'Value', keyPlaceholder: 'Price per month', valuePlaceholder: '$49', help: 'Anything worth knowing about it, one property per line.' },
    { key: 'evidenceId', type: 'evidence', label: 'Evidence that backs it', required: true },
    { key: 'key', type: 'text', label: 'Short ID', advanced: true, pattern: /^[a-z0-9][a-z0-9._:-]*$/, patternHint: 'Use lower-case letters, numbers, dots, colons or dashes.', help: 'Facts with the same type and ID are versions of one fact. Left empty, it is made from the name.' },
    { key: 'validTo', type: 'date', iso: 'end', label: 'True until', advanced: true, emptyAsNull: true },
  ],
  transform: (body) => ({ attributes: {}, ...body, key: body.key ?? factKey(String(body.kind), String(body.name ?? '')) }),
};

export const CLAIM_FORM: FormSpec = {
  fields: [
    { key: 'text', type: 'textarea', label: 'The claim, exactly as you would say it', required: true, minLength: 3, maxLength: 1000, rows: 3, placeholder: 'Imports up to 50,000 contacts per file.' },
    { key: 'claimType', type: 'select', label: 'Type of claim', options: CLAIM_TYPE_OPTIONS, required: true, initial: 'product_capability' },
    { key: 'evidenceIds', type: 'evidence', multiple: true, min: 1, label: 'Evidence that proves it', required: true, help: 'Only admitted, up-to-date evidence can back a claim.' },
    { key: 'jurisdictions', type: 'tags', label: 'Markets where you will say this', suggestions: COUNTRY_SUGGESTIONS, case: 'upper', itemPattern: MARKET_PATTERN, itemHint: MARKET_HINT },
    { key: 'entityIds', type: 'record', multiple: true, label: 'Related facts', source: SOURCES.facts, advanced: true, help: 'The claim expires automatically when one of these facts changes.' },
    { key: 'expiresAt', type: 'date', iso: 'end', label: 'Stop using it after', advanced: true, emptyAsNull: true },
  ],
};

export const BRAND_RULE_FORM: FormSpec = {
  fields: [
    { key: 'kind', type: 'select', label: 'Rule', options: BRAND_RULE_OPTIONS, required: true, initial: 'banned_phrase' },
    { key: 'pattern', type: 'text', label: 'Phrase to avoid', required: true, maxLength: 500, placeholder: 'world-class', showIf: { key: 'kind', values: ['banned_phrase'] } },
    { key: 'pattern', type: 'text', label: 'Phrase that must appear', required: true, maxLength: 500, placeholder: 'Terms apply', showIf: { key: 'kind', values: ['required_phrase'] } },
    { key: 'pattern', type: 'text', label: 'Most exclamation marks allowed', required: true, pattern: /^\d{1,2}$/, patternHint: 'Enter a whole number from 0 to 99.', placeholder: '1', showIf: { key: 'kind', values: ['max_exclamations'] } },
    { key: 'pattern', type: 'text', label: 'Tone in a few words', required: true, maxLength: 500, placeholder: 'Warm, plain English, no jargon', showIf: { key: 'kind', values: ['tone_note'] } },
    { key: 'pattern', type: 'text', label: 'Pattern (regular expression)', required: true, maxLength: 200, placeholder: '\\bguaranteed?\\b', showIf: { key: 'kind', values: ['banned_regex'] }, help: 'Case is ignored. Nested repeats such as (a+)+ are refused.' },
    { key: 'severity', type: 'select', label: 'When the rule is broken', options: opts(['block', 'Block publishing'], ['warn', 'Warn the writer']), required: true, initial: 'block' },
    { key: 'description', type: 'textarea', label: 'Why (shown to writers)', required: true, minLength: 3, maxLength: 1000, rows: 2, placeholder: 'Unsubstantiated superlative.' },
    { key: 'channels', type: 'choices', label: 'Only for these channels', options: CHANNEL_OPTIONS, help: 'Leave all unticked to apply everywhere.' },
  ],
};

export const LINT_FORM: FormSpec = {
  fields: [
    { key: 'text', type: 'textarea', label: 'Copy to check', required: true, maxLength: 20_000, rows: 7, placeholder: 'Paste an email, post, ad or landing-page text…', fromFile: { accept: '.txt,.md,.html,text/plain' } },
    { key: 'channel', type: 'select', label: 'Where it will run', options: CHANNEL_OPTIONS, help: 'Rules limited to a channel apply only there.' },
    { key: 'claimIds', type: 'record', multiple: true, label: 'Approved claims this copy relies on', source: SOURCES.approvedClaims, help: 'Numbers, comparisons, “best”, “guaranteed” and similar statements need a matching approved claim.' },
    { key: 'requiredDisclosure', type: 'text', label: 'Disclosure that must appear', maxLength: 300, emptyAsNull: true, placeholder: '#ad', advanced: true },
  ],
};

/** Lint findings explained: what it means and how to fix it. */
export const LINT_HELP: Record<string, { title: string; fix: string }> = {
  UNSUBSTANTIATED_SUPERLATIVE: { title: 'Unproven superlative', fix: 'Tick an approved claim that covers this sentence, or rephrase without “best”, “fastest”, “#1” and similar words.' },
  UNSUBSTANTIATED_ABSOLUTE: { title: 'Absolute promise', fix: 'Words like “guaranteed”, “100%” or “risk-free” need an approved claim; otherwise soften them.' },
  UNSUBSTANTIATED_STATISTIC: { title: 'Number without proof', fix: 'Tick the approved claim this number comes from, or remove the number.' },
  UNSUBSTANTIATED_COMPARATIVE: { title: 'Comparison without proof', fix: 'Comparisons with others are regulated: they need an approved comparative claim.' },
  UNSUBSTANTIATED_TESTIMONIAL: { title: 'Testimonial without proof', fix: 'Quote only genuine, consented customer statements that are approved as claims.' },
  UNSUBSTANTIATED_HEALTH: { title: 'Health claim', fix: 'Health claims are regulated and need an approved claim reviewed by legal.' },
  UNSUBSTANTIATED_ENVIRONMENTAL: { title: 'Environmental claim', fix: 'Words like “eco-friendly” or “carbon-neutral” need an approved environmental claim.' },
  UNSUBSTANTIATED_FINANCIAL: { title: 'Financial claim', fix: 'Earnings or returns promises need an approved financial claim reviewed by legal.' },
  UNSUBSTANTIATED_SCARCITY: { title: 'Urgency or scarcity', fix: 'Say “limited” or “ends today” only when it is true and backed by an approved claim.' },
  CLAIM_NOT_USABLE: { title: 'A ticked claim cannot be used', fix: 'Untick it: only approved, unexpired claims count.' },
  BRAND_BANNED_PHRASE: { title: 'Phrase your brand rules forbid', fix: 'Remove or reword it.' },
  BRAND_BANNED_PATTERN: { title: 'Text your brand rules forbid', fix: 'Remove or reword it.' },
  BRAND_REQUIRED_PHRASE_MISSING: { title: 'Required phrase missing', fix: 'Add the phrase exactly as written.' },
  BRAND_TOO_MANY_EXCLAMATIONS: { title: 'Too many exclamation marks', fix: 'Remove some exclamation marks.' },
  DISCLOSURE_MISSING: { title: 'Disclosure missing', fix: 'Add the disclosure text exactly as written.' },
};

/** Evidence summary line used by pickers and lists. */
export function evidenceLine(e: Row): string {
  const parts = [label(EVIDENCE_KIND_OPTIONS, e.kind), String(e.sourceOwner ?? ''), day(e.createdAt)].filter(Boolean);
  return parts.join(' · ');
}

export const QUARANTINE_HELP: Record<string, string> = {
  'license/usage rights unknown': 'Say whether you may use it.',
  'PII classification missing': 'Say whether it contains personal data.',
  'confidence missing': 'Say how reliable it is.',
  'personal data without lawful basis/consent reference': 'Add the lawful basis or consent reference for the personal data.',
  "children's data requires the COPPA policy path [BLOCK]": "Children's data cannot be released here.",
  'external platform terms version missing': 'Add the platform terms version.',
  'source pending review': 'The registered source must be approved first.',
  'stale at admission': 'It was already out of date when added; add fresh evidence instead.',
  stale: 'It is out of date; add fresh evidence instead.',
};

export function evidenceNotice(rec: Row, picked = false): FormNotice {
  const reasons = Array.isArray(rec.quarantineReasons) ? (rec.quarantineReasons as string[]) : [];
  if (rec.status === 'admitted' && evidenceReadiness(rec) === 'ready') return { tone: 'ok', title: picked ? 'Evidence admitted and chosen.' : 'Evidence admitted.', text: 'It is ready to back claims, facts and documents.' };
  if (rec.status === 'admitted') return { tone: 'warn', title: 'Evidence admitted, but it is already out of date.', text: 'Add fresher evidence, or a longer accuracy period, to back new claims.' };
  return { tone: 'warn', title: 'Saved, but it waits for review (quarantined).', text: 'It cannot back anything until a reviewer releases it in Evidence:', items: reasons.map((r) => QUARANTINE_HELP[r] ?? r) };
}
