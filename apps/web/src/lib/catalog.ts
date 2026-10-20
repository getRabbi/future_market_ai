/**
 * Control-plane catalog: every module (M01–M24) maps to a section with the API resources it
 * exposes. Generic sections render list tables, JSON create forms (validated server-side) and
 * per-row actions; governance-critical screens (approvals, kill switches, audit) are bespoke.
 */

export interface RowAction {
  label: string;
  /** Path with `:id` (row.id) substituted. */
  path: string;
  method?: 'POST' | 'PUT';
  /** Static body, or a prompt for one string field. */
  body?: Record<string, unknown>;
  prompt?: { field: string; label: string; json?: boolean };
  /** Show the action only when row[field] is one of values. */
  when?: { field: string; values: unknown[] };
  danger?: boolean;
}

export interface Resource {
  title: string;
  /** GET path returning an array, or an object holding one at `pick`. */
  list?: string;
  pick?: string;
  columns?: string[];
  /** Detail JSON for a row (`:id`). */
  detail?: string;
  create?: { label: string; method?: 'POST' | 'PUT'; path: string; example: unknown; note?: string };
  rowActions?: RowAction[];
  note?: string;
}

export interface Section {
  slug: string;
  title: string;
  modules: string[];
  summary: string;
  resources: Resource[];
  /** Bespoke component instead of / before resources. */
  custom?: 'overview' | 'approvals' | 'governance' | 'audit' | 'settings' | 'assets';
}

const iso = () => new Date().toISOString();
const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

export const SECTIONS: Section[] = [
  { slug: 'overview', title: 'Overview', modules: ['M23', 'M24'], summary: 'What needs a human now: approvals, alerts, incidents and engaged kill switches.', resources: [], custom: 'overview' },
  {
    slug: 'approvals',
    title: 'Actions & approvals',
    modules: ['M23'],
    summary: 'Every consequential write is an ActionRequest. Approvals bind to the exact action hash; success means VERIFIED, never a 200.',
    resources: [],
    custom: 'approvals',
  },
  {
    slug: 'evidence',
    title: 'Evidence',
    modules: ['M01'],
    summary: 'Rights-aware, time-aware evidence. Quarantined records cannot drive decisions until released.',
    resources: [
      {
        title: 'Evidence ledger',
        list: '/v1/evidence',
        columns: ['kind', 'status', 'sourceType', 'sourceOwner', 'confidence', 'freshnessSlaHours', 'createdAt'],
        detail: '/v1/evidence/:id',
        rowActions: [
          { label: 'Lineage', path: '/v1/evidence/:id/lineage' },
          { label: 'Release', path: '/v1/evidence/:id/release', prompt: { field: '*', label: '{ "note": "…", "licenseOrUsageRights": "…" }', json: true }, when: { field: 'status', values: ['quarantined'] } },
          { label: 'Reject', path: '/v1/evidence/:id/reject', prompt: { field: 'note', label: 'Reason' }, when: { field: 'status', values: ['quarantined'] }, danger: true },
        ],
        create: {
          label: 'Admit evidence',
          path: '/v1/evidence',
          example: {
            sourceType: 'primary',
            sourceOwner: 'acme',
            sourceUriOrObjectId: 'crm://reports/q3-retention',
            retrievedAt: iso(),
            licenseOrUsageRights: 'first-party',
            schemaVersion: '1',
            piiClassification: 'none',
            confidence: 0.9,
            freshnessSlaHours: 720,
            permittedUses: ['analytics'],
            kind: 'document',
            summary: 'Q3 retention report',
            content: { cohortRetentionW4: 0.41 },
          },
        },
      },
      { title: 'Register a source', create: { label: 'Register source', path: '/v1/evidence/sources', example: { name: 'Acme CRM', sourceType: 'primary', owner: 'acme', uri: 'crm://acme', licenseOrUsageRights: 'first-party', defaultPiiClass: 'pseudonymous', freshnessSlaHours: 24 } } },
    ],
  },
  {
    slug: 'customers',
    title: 'Customers & consent',
    modules: ['M02'],
    summary: 'Consent-aware Customer 360, suppressions and data-subject requests.',
    resources: [
      { title: 'Profiles', list: '/v1/customers', columns: ['id', 'country', 'locale', 'isChild', 'createdAt'], detail: '/v1/customers/:id' },
      {
        title: 'Record consent',
        create: { label: 'Record consent', path: '/v1/customers/consents', example: { profileId: '00000000-0000-4000-8000-000000000000', purpose: 'marketing_email', status: 'granted', lawfulBasis: 'consent', jurisdiction: 'US', source: 'preference_center', capturedAt: iso() } },
      },
      { title: 'Add suppression', create: { label: 'Suppress', path: '/v1/customers/suppressions', example: { channel: 'email', identifier: { kind: 'email', value: 'person@example.com' }, reason: 'manual' } } },
      {
        title: 'Data-subject requests',
        list: '/v1/customers/dsar',
        columns: ['kind', 'status', 'jurisdiction', 'receivedAt', 'dueAt'],
        create: { label: 'Log DSAR', path: '/v1/customers/dsar', example: { kind: 'access', identifier: { kind: 'email', value: 'person@example.com' }, jurisdiction: 'US-CA' } },
        rowActions: [
          { label: 'Verify identity', path: '/v1/customers/dsar/:id/verify', prompt: { field: 'method', label: 'Verification method' }, when: { field: 'status', values: ['received'] } },
          { label: 'Execute deletion', path: '/v1/customers/dsar/:id/execute-deletion', when: { field: 'kind', values: ['delete'] }, danger: true },
          { label: 'Execute opt-out', path: '/v1/customers/dsar/:id/execute-opt-out', when: { field: 'kind', values: ['opt_out_sale_share'] } },
        ],
      },
      {
        title: 'Retention policies',
        list: '/v1/customers/retention',
        columns: ['dataClass', 'retainDays', 'legalHold', 'updatedBy', 'updatedAt'],
        create: { label: 'Set retention', method: 'PUT', path: '/v1/customers/retention', example: { dataClass: 'customer_events', retainDays: 730, legalHold: false }, note: 'Durations are your decision; nothing is deleted until a policy exists. Applied daily at 03:53 UTC.' },
      },
      {
        title: 'Ingestion keys',
        list: '/v1/customers/ingestion-keys',
        columns: ['kind', 'keyPrefix', 'allowedOrigins', 'status', 'createdAt'],
        create: { label: 'Create key', path: '/v1/customers/ingestion-keys', example: { kind: 'browser', allowedOrigins: ['https://www.example.com'] }, note: 'The secret is shown once in the response.' },
        rowActions: [{ label: 'Revoke', path: '/v1/customers/ingestion-keys/:id/revoke', when: { field: 'status', values: ['active'] }, danger: true }],
      },
    ],
  },
  {
    slug: 'knowledge',
    title: 'Knowledge & claims',
    modules: ['M03'],
    summary: 'Ground-truth facts, the claim registry and brand rules that every piece of copy is linted against.',
    resources: [
      {
        title: 'Claims',
        list: '/v1/knowledge/claims',
        columns: ['text', 'status', 'regulated', 'expiresAt'],
        create: { label: 'Propose claim', path: '/v1/knowledge/claims', example: { text: 'Imports up to 50,000 contacts per file', claimType: 'product_capability', evidenceIds: ['00000000-0000-4000-8000-000000000000'], jurisdictions: ['US'] } },
        rowActions: [
          { label: 'Approve', path: '/v1/knowledge/claims/:id/review', body: { decision: 'approved' }, when: { field: 'status', values: ['proposed'] } },
          { label: 'Reject', path: '/v1/knowledge/claims/:id/review', body: { decision: 'rejected' }, when: { field: 'status', values: ['proposed'] }, danger: true },
        ],
      },
      {
        title: 'Facts',
        list: '/v1/knowledge/facts',
        columns: ['kind', 'name', 'status', 'evidenceId'],
        create: { label: 'Add fact', path: '/v1/knowledge/facts', example: { kind: 'product', key: 'acme-sync', name: 'Acme Sync', attributes: { plans: ['Starter', 'Team'] }, evidenceId: '00000000-0000-4000-8000-000000000000' } },
        rowActions: [{ label: 'Keep this version', path: '/v1/knowledge/facts/:id/resolve-conflict', when: { field: 'status', values: ['conflict'] } }],
      },
      { title: 'Index a document', create: { label: 'Ingest', path: '/v1/knowledge/documents', example: { title: 'Help: importing contacts', text: 'You can import contacts from a CSV file…', evidenceId: '00000000-0000-4000-8000-000000000000', visibility: 'public' } } },
      { title: 'Brand rule', create: { label: 'Add rule', path: '/v1/knowledge/brand-rules', example: { kind: 'banned_phrase', pattern: 'world-class', severity: 'block', description: 'Unsubstantiated superlative' } } },
      { title: 'Lint copy', create: { label: 'Lint', path: '/v1/knowledge/lint', example: { text: 'The fastest way to sync your CRM.', claimIds: [], channel: 'email' } } },
    ],
  },
  {
    slug: 'market',
    title: 'Market & competitors',
    modules: ['M04', 'M05', 'M06'],
    summary: 'Trends with baselines, lawful competitor monitoring and the ranked idea backlog.',
    resources: [
      { title: 'Trends', list: '/v1/market/trends', columns: ['seriesId', 'direction', 'magnitude', 'pValue', 'detectedAt'] },
      { title: 'Topics', list: '/v1/market/topics', columns: ['label', 'size', 'terms', 'createdAt'] },
      {
        title: 'Competitors',
        list: '/v1/competitors',
        columns: ['name', 'domains', 'createdAt'],
        create: { label: 'Add competitor', path: '/v1/competitors', example: { name: 'Rival Inc', domains: ['rival.example'] } },
      },
      {
        title: 'Competitor sources',
        create: {
          label: 'Propose source',
          path: '/v1/competitors/sources',
          example: { competitorId: '00000000-0000-4000-8000-000000000000', url: 'https://rival.example/pricing', kind: 'pricing', lawfulBasisNote: 'Public pricing page; robots.txt permits crawling.', crawlIntervalHours: 24 },
          note: 'Legal must approve sources (MFA) before crawling.',
        },
      },
      { title: 'Observations', list: '/v1/competitors/observations', columns: ['kind', 'summary', 'isInference', 'observedAt'] },
      { title: 'Feature gaps', list: '/v1/competitors/gaps' },
      {
        title: 'Ideas',
        list: '/v1/ideas',
        columns: ['title', 'status', 'evidenceStrength', 'score', 'createdAt'],
        create: { label: 'Generate ideas (AI)', path: '/v1/ideas/generate', example: { maxIdeas: 5 } },
        rowActions: [
          { label: 'Queue for test', path: '/v1/ideas/:id/status', body: { status: 'queued_for_test' } },
          { label: 'Reject', path: '/v1/ideas/:id/status', body: { status: 'rejected' }, danger: true },
        ],
      },
    ],
  },
  {
    slug: 'brain',
    title: 'Growth Brain',
    modules: ['M07'],
    summary: 'Typed decisions with uncertainty and abstention. Accepting a decision proposes actions; it never executes them.',
    resources: [
      {
        title: 'Decisions',
        list: '/v1/brain/decisions',
        columns: ['status', 'market', 'expectedValue', 'abstainReason', 'createdAt'],
        create: { label: 'Propose decision', path: '/v1/brain/decisions', example: { ideaId: '00000000-0000-4000-8000-000000000000', market: 'US', horizon: { value: 2, unit: 'week' } } },
        rowActions: [
          { label: 'Accept', path: '/v1/brain/decisions/:id/accept', when: { field: 'status', values: ['proposed'] } },
          { label: 'Reject', path: '/v1/brain/decisions/:id/reject', prompt: { field: 'reason', label: 'Reason' }, when: { field: 'status', values: ['proposed'] }, danger: true },
        ],
      },
      { title: 'Agent runs', list: '/v1/brain/runs', columns: ['kind', 'status', 'inputTokens', 'outputTokens', 'abstainReason', 'startedAt'], detail: '/v1/brain/runs/:id' },
    ],
  },
  {
    slug: 'analytics',
    title: 'Forecasts & MMM',
    modules: ['M08', 'M09'],
    summary: 'Probabilistic forecasts with backtests, and Bayesian media-mix models with convergence diagnostics.',
    resources: [
      {
        title: 'Metric series',
        list: '/v1/analytics/series',
        columns: ['key', 'name', 'unit', 'granularity', 'kind'],
        create: { label: 'Define series', path: '/v1/analytics/series', example: { key: 'kpi.signups', name: 'Signups', unit: 'count', granularity: 'day', kind: 'kpi', sourceEvidenceId: '00000000-0000-4000-8000-000000000000' } },
        rowActions: [{ label: 'Points', path: '/v1/analytics/series/:id/points' }],
      },
      {
        title: 'Analytics jobs',
        list: '/v1/analytics/requests',
        columns: ['kind', 'status', 'priority', 'createdAt', 'finishedAt'],
        detail: '/v1/analytics/requests/:id',
        create: { label: 'Queue job', path: '/v1/analytics/requests', example: { kind: 'forecast', params: { seriesId: '00000000-0000-4000-8000-000000000000', horizon: 28 }, priority: 100 }, note: 'Runs on the Northflank analytics job (Python).' },
      },
    ],
  },
  {
    slug: 'experiments',
    title: 'Experiments',
    modules: ['M10'],
    summary: 'Pre-registered experiments and bandits with logged assignment, exposure and SRM checks.',
    resources: [
      {
        title: 'Experiments',
        list: '/v1/experiments',
        columns: ['name', 'design', 'status', 'riskTier', 'createdAt'],
        detail: '/v1/experiments/:id',
        create: {
          label: 'Create experiment',
          path: '/v1/experiments',
          example: {
            name: 'Welcome subject line',
            hypothesis: 'A benefit-led subject increases 7-day activation',
            design: 'ab_fixed',
            unit: 'profile',
            targetMetric: 'activated_7d',
            metricType: 'binary',
            riskTier: 'low',
            variants: [
              { key: 'control', description: 'Current subject', isControl: true, weight: 1, config: {} },
              { key: 'benefit', description: 'Benefit-led subject', isControl: false, weight: 1, config: {} },
            ],
          },
        },
        rowActions: [
          { label: 'Propose start', path: '/v1/experiments/:id/propose-start', body: { evidenceIds: [] }, when: { field: 'status', values: ['draft', 'approved'] } },
          { label: 'Analyze', path: '/v1/experiments/:id/analyze', when: { field: 'status', values: ['running', 'stopped'] } },
          { label: 'Stop', path: '/v1/experiments/:id/stop', prompt: { field: 'reason', label: 'Reason' }, when: { field: 'status', values: ['running'] }, danger: true },
        ],
      },
    ],
  },
  {
    slug: 'audiences',
    title: 'Audiences',
    modules: ['M11'],
    summary: 'Explainable segments on lawful attributes; sensitive attributes are rejected.',
    resources: [
      {
        title: 'Segments',
        list: '/v1/audiences/segments',
        columns: ['name', 'purpose', 'status', 'createdAt'],
        create: {
          label: 'Define segment',
          path: '/v1/audiences/segments',
          example: {
            name: 'Trialists without integration',
            purpose: 'personalization',
            definition: {
              all: [
                { event: 'signup', windowDays: 14, op: 'gte', count: 1 },
                { event: 'integration_connected', windowDays: 14, op: 'eq', count: 0 },
              ],
            },
          },
        },
        rowActions: [
          { label: 'Snapshot', path: '/v1/audiences/segments/:id/snapshot' },
          { label: 'Snapshots', path: '/v1/audiences/segments/:id/snapshots' },
        ],
      },
    ],
  },
  {
    slug: 'offers',
    title: 'Offers & CRO',
    modules: ['M12'],
    summary: 'Margin-guardrailed offers and conversion hypotheses.',
    resources: [
      {
        title: 'Price guardrails',
        list: '/v1/offers/guardrails',
        columns: ['productRef', 'currency', 'listPriceMicros', 'minPriceMicros', 'maxDiscountFraction'],
        create: { label: 'Set guardrail', method: 'PUT', path: '/v1/offers/guardrails', example: { productRef: 'team-plan', currency: 'USD', listPriceMicros: 49_000_000, unitCostMicros: 9_000_000, minPriceMicros: 35_000_000, maxDiscountFraction: 0.25, minMarginFraction: 0.6 } },
      },
      {
        title: 'Offers',
        list: '/v1/offers',
        columns: ['name', 'status', 'discountFraction', 'productRef', 'createdAt'],
        create: { label: 'Draft offer', path: '/v1/offers', example: { name: 'Autumn annual', kind: 'percent_discount', productRefs: ['team-plan'], params: { percentage: 0.15, code: 'AUTUMN15' }, copy: '', startsAt: iso(), endsAt: null } },
        rowActions: [{ label: 'Approve', path: '/v1/offers/:id/approve', when: { field: 'status', values: ['draft'] } }],
      },
      {
        title: 'CRO hypotheses',
        list: '/v1/offers/cro',
        create: {
          label: 'Add hypothesis',
          path: '/v1/offers/cro',
          example: { pageUrl: 'https://www.example.com/pricing', hypothesis: 'Showing annual savings increases plan upgrades', changes: [{ element: 'billing toggle', change: 'Show annual savings next to the toggle' }], evidenceIds: ['00000000-0000-4000-8000-000000000000'] },
        },
      },
    ],
  },
  {
    slug: 'creative',
    title: 'Creative briefs',
    modules: ['M13'],
    summary: 'Evidence-mapped briefs; every claim in a brief must trace to an approved claim.',
    resources: [
      {
        title: 'Briefs',
        list: '/v1/creative/briefs',
        columns: ['objective', 'channel', 'status', 'createdAt'],
        create: { label: 'Generate brief (AI)', path: '/v1/creative/briefs/generate', example: { objective: 'Increase trial-to-paid', channel: 'instagram', audience: 'Ops managers in trial' } },
        rowActions: [{ label: 'Approve', path: '/v1/creative/briefs/:id/approve', when: { field: 'status', values: ['draft'] } }],
      },
    ],
  },
  {
    slug: 'assets',
    title: 'Asset studio',
    modules: ['M14'],
    summary: 'Uploads, rights manifests and Remotion renders. Only publish-eligible assets can be posted.',
    resources: [
      { title: 'Assets', list: '/v1/assets', columns: ['title', 'kind', 'origin', 'mime', 'publishEligible', 'createdAt'], detail: '/v1/assets/:id', rowActions: [{ label: 'Download URL', path: '/v1/assets/:id/download-url' }] },
      {
        title: 'Renders',
        list: '/v1/assets/renders',
        columns: ['composition', 'status', 'statusReason', 'createdAt'],
        create: { label: 'Request render', path: '/v1/assets/renders', example: { composition: 'product_showcase', inputAssetIds: ['00000000-0000-4000-8000-000000000000'], props: { headline: 'Import contacts in one step', captions: ['Connect your CRM'], cta: 'Start free' } } },
      },
      {
        title: 'Remotion licence attestation',
        create: {
          label: 'Record licence',
          method: 'PUT',
          path: '/v1/assets/remotion-license',
          example: { eligibility: 'free_license', basis: 'organization_up_to_3_people', teamSize: 2, attestation: 'We are a company of 2 people.' },
          note: 'B-014: companies above the free-licence threshold need a Remotion company licence.',
        },
      },
    ],
    custom: 'assets',
  },
  {
    slug: 'personas',
    title: 'Synthetic personas',
    modules: ['M15'],
    summary: 'Disclosed virtual brand characters; real-person likeness and first-person testimonials are blocked.',
    resources: [
      {
        title: 'Personas',
        list: '/v1/personas',
        columns: ['name', 'status', 'disclosureCopy', 'createdAt'],
        create: {
          label: 'Create persona',
          path: '/v1/personas',
          example: {
            name: 'Nova',
            personaBible: { backstory: 'Nova is an illustrated guide who shares practical Acme tips.', voiceTone: 'warm, concise', values: ['clarity'], topicsAllowed: ['product tips'], topicsForbidden: ['health', 'finance'] },
            visualIdentity: { referenceAssetIds: [], styleNotes: 'flat illustration' },
            voiceIdentity: { voiceArtifactLicenseId: null, notes: '' },
            disclosureCopy: 'Nova is an AI character created by Acme.',
            likeness: { origin: 'original_synthetic', attestation: 'Original character; not based on any real person.' },
          },
        },
        rowActions: [
          { label: 'Approve', path: '/v1/personas/:id/approve', when: { field: 'status', values: ['draft'] } },
          { label: 'Suspend', path: '/v1/personas/:id/suspend', prompt: { field: 'reason', label: 'Reason' }, when: { field: 'status', values: ['approved'] }, danger: true },
        ],
      },
      { title: 'Protected identities', create: { label: 'Protect identity', path: '/v1/personas/protected-identities', example: { name: 'Jane Celebrity', reason: 'Public figure; no likeness rights' } } },
    ],
  },
  {
    slug: 'social',
    title: 'Organic social',
    modules: ['M16'],
    summary: 'Scheduled posts publish only through M23 and count only after read-after-write verification. No automated engagement.',
    resources: [
      {
        title: 'Posts',
        list: '/v1/social/posts',
        columns: ['platform', 'status', 'caption', 'scheduledAt', 'externalUrl'],
        create: { label: 'Schedule post', path: '/v1/social/posts', example: { connectionId: '00000000-0000-4000-8000-000000000000', platform: 'facebook', caption: 'Our spring update is live.', scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), geographies: ['US'] } },
      },
      {
        title: 'Community inbox',
        list: '/v1/social/interactions',
        columns: ['platform', 'kind', 'text', 'replyStatus', 'receivedAt'],
        rowActions: [
          { label: 'Draft reply (AI)', path: '/v1/social/interactions/:id/draft-reply', when: { field: 'replyStatus', values: ['none'] } },
          { label: 'Send reply', path: '/v1/social/interactions/:id/reply', body: { geographies: ['US'] }, when: { field: 'replyStatus', values: ['drafted'] } },
        ],
      },
      { title: 'Publishing stats', list: '/v1/social/stats' },
    ],
  },
  {
    slug: 'ads',
    title: 'Paid media',
    modules: ['M17'],
    summary: 'Budget and status changes inside spend envelopes; spend is reconciled against verified budgets.',
    resources: [
      {
        title: 'Campaigns',
        list: '/v1/ads/campaigns',
        columns: ['platform', 'name', 'status', 'dailyBudgetMicros', 'currency', 'lastSyncedAt'],
        rowActions: [
          { label: 'Performance', path: '/v1/ads/campaigns/:id/performance' },
          { label: 'Propose budget', path: '/v1/ads/campaigns/:id/budget', prompt: { field: '*', label: 'Proposal JSON', json: true } },
          { label: 'Pause', path: '/v1/ads/campaigns/:id/status', prompt: { field: 'rationale', label: 'Rationale (min 10 chars)' }, body: { status: 'PAUSED', geographies: ['US'] }, danger: true },
        ],
      },
      { title: 'Spend reconciliations', list: '/v1/ads/reconciliations', columns: ['periodStart', 'periodEnd', 'status', 'authorizedMicros', 'reportedMicros', 'deltaMicros'] },
      { title: 'Reconcile', create: { label: 'Reconcile', path: '/v1/ads/connections/00000000-0000-4000-8000-000000000000/reconcile', example: { start: day(-10), end: day(-4), tolerance: 0.02 }, note: 'Replace the connection id in the path.' } },
    ],
  },
  {
    slug: 'discovery',
    title: 'SEO, ASO & AI discovery',
    modules: ['M18'],
    summary: 'Technical audits under robots.txt, query data and store-metadata validation. No ranking promises.',
    resources: [
      { title: 'Site audits', list: '/v1/seo/audits', columns: ['siteUrl', 'status', 'maxPages', 'finishedAt'], detail: '/v1/seo/audits/:id', create: { label: 'Audit a site', path: '/v1/seo/audits', example: { siteUrl: 'https://www.example.com', maxPages: 50 } } },
      { title: 'Query opportunities', list: '/v1/seo/opportunities', pick: 'rows', columns: ['query', 'page_url', 'impressions', 'clicks', 'position', 'ctr'] },
      { title: 'Validate store metadata', create: { label: 'Validate', path: '/v1/aso/validate', example: { store: 'app_store', fields: { name: 'Acme Sync', subtitle: 'Your data in one place', keywords: 'sync,csv,crm' } } } },
      {
        title: 'Store listings',
        list: '/v1/aso/listings',
        columns: ['store', 'appRef', 'locale', 'status', 'createdAt'],
        create: { label: 'Draft listing', path: '/v1/aso/listings', example: { store: 'app_store', appRef: 'com.acme.sync', locale: 'en-US', fields: { keywords: 'sync,csv,crm', promotionalText: 'Import contacts in one step.' } } },
        rowActions: [
          { label: 'Approve', path: '/v1/aso/listings/:id/approve', when: { field: 'status', values: ['draft'] } },
          { label: 'Push to App Store', path: '/v1/aso/listings/:id/push', prompt: { field: '*', label: '{ "connectionId": "…", "localizationId": "…", "geographies": ["US"] }', json: true }, when: { field: 'status', values: ['approved'] } },
        ],
      },
    ],
  },
  {
    slug: 'app',
    title: 'App growth',
    modules: ['M19'],
    summary: 'Installs with labelled attribution methods, cohorts and App Store reports. Attribution is not causation.',
    resources: [
      { title: 'Installs by method', list: '/v1/app/installs/stats' },
      { title: 'Cohorts (last 90 days)', list: `/v1/app/cohorts?from=${new Date(Date.now() - 90 * 86_400_000).toISOString()}&to=${iso()}&activationEvent=activated`, pick: 'cohorts' },
      { title: 'App Store reports', list: '/v1/app/store-reports', columns: ['reportType', 'period', 'rowCount', 'fetchedAt'], create: { label: 'Sync a day', path: '/v1/app/store-reports/sync', example: { connectionId: '00000000-0000-4000-8000-000000000000', reportDate: day(-2) } } },
    ],
  },
  {
    slug: 'lifecycle',
    title: 'Lifecycle messaging',
    modules: ['M20'],
    summary: 'Approved templates, triggered journeys, consent and suppression checked immediately before every send.',
    resources: [
      {
        title: 'Templates',
        list: '/v1/lifecycle/templates',
        columns: ['name', 'version', 'category', 'status', 'subject'],
        create: {
          label: 'New template',
          path: '/v1/lifecycle/templates',
          example: { name: 'welcome', category: 'commercial', subject: 'Welcome, {{first_name}}', bodyText: 'Thanks for joining {{company_name}}.', bodyHtml: null, claimIds: [] },
          note: 'Footer with postal address and unsubscribe link is added automatically.',
        },
        rowActions: [{ label: 'Approve', path: '/v1/lifecycle/templates/:id/approve', when: { field: 'status', values: ['draft'] } }],
      },
      {
        title: 'Journeys',
        list: '/v1/lifecycle/journeys',
        columns: ['name', 'triggerEvent', 'status', 'evidenceFreshnessHours', 'activatedAt'],
        create: {
          label: 'New journey',
          path: '/v1/lifecycle/journeys',
          example: {
            name: 'Onboarding',
            triggerEvent: 'signup',
            connectionId: '00000000-0000-4000-8000-000000000000',
            evidenceFreshnessHours: 168,
            steps: [
              { type: 'send_email', templateId: '00000000-0000-4000-8000-000000000000' },
              { type: 'wait', hours: 48 },
              { type: 'exit_if_event', eventName: 'integration_connected' },
            ],
          },
        },
        rowActions: [
          { label: 'Activate', path: '/v1/lifecycle/journeys/:id/activate', when: { field: 'status', values: ['draft', 'paused'] } },
          { label: 'Pause', path: '/v1/lifecycle/journeys/:id/pause', prompt: { field: 'reason', label: 'Reason' }, when: { field: 'status', values: ['active'] }, danger: true },
          { label: 'Stats', path: '/v1/lifecycle/journeys/:id/stats' },
        ],
      },
      { title: 'Messages', list: '/v1/lifecycle/messages', columns: ['category', 'status', 'statusReason', 'sentAt', 'createdAt'] },
      { title: 'Delivery report (30 days)', list: '/v1/lifecycle/report' },
    ],
  },
  {
    slug: 'conversations',
    title: 'Conversations',
    modules: ['M21'],
    summary: 'Cited answers from public knowledge; uncertainty hands off to a person. The assistant always discloses it is AI.',
    resources: [
      { title: 'Chat widgets', create: { label: 'Create widget', path: '/v1/conversations/widgets', example: { allowedOrigins: ['https://www.example.com'] } } },
      {
        title: 'Conversations',
        list: '/v1/conversations',
        columns: ['channel', 'status', 'assignedUserId', 'lastMessageAt'],
        detail: '/v1/conversations/:id',
        rowActions: [
          { label: 'Reply', path: '/v1/conversations/:id/reply', prompt: { field: 'text', label: 'Your reply' }, when: { field: 'status', values: ['open', 'handoff'] } },
          { label: 'Close', path: '/v1/conversations/:id/close', when: { field: 'status', values: ['open', 'handoff'] } },
        ],
      },
      { title: 'Tickets', list: '/v1/conversations/tickets', columns: ['subject', 'status', 'priority', 'createdAt'] },
      {
        title: 'Leads',
        list: '/v1/conversations/leads',
        columns: ['status', 'score', 'qualification', 'createdAt'],
        rowActions: [
          { label: 'Qualified', path: '/v1/conversations/leads/:id/status', body: { status: 'qualified' } },
          { label: 'Disqualify', path: '/v1/conversations/leads/:id/status', body: { status: 'disqualified' }, danger: true },
        ],
      },
    ],
  },
  {
    slug: 'creators',
    title: 'Creators & referrals',
    modules: ['M22'],
    summary: 'Real partners with signed contracts, mandatory disclosures and an append-only commission ledger. Payouts are blocked (B-015).',
    resources: [
      {
        title: 'Creators',
        list: '/v1/creators',
        columns: ['name', 'status', 'handles', 'createdAt'],
        detail: '/v1/creators/:id',
        create: { label: 'Add creator', path: '/v1/creators', example: { name: 'Riley', handles: { instagram: '@riley' }, contactEmail: null, contactConsentEvidenceId: null } },
        rowActions: [{ label: 'Propose payout', path: '/v1/creators/:id/payout' }],
      },
      {
        title: 'Contract',
        create: {
          label: 'Record contract',
          path: '/v1/creators/contracts',
          example: { creatorId: '00000000-0000-4000-8000-000000000000', materialRelationship: 'affiliate_commission', commissionFraction: 0.1, currency: 'USD', requiredDisclosures: ['#ad'], startsAt: iso(), signedEvidenceId: '00000000-0000-4000-8000-000000000000' },
        },
      },
      { title: 'Referral link', create: { label: 'Create link', path: '/v1/creators/links', example: { creatorId: '00000000-0000-4000-8000-000000000000', contractId: '00000000-0000-4000-8000-000000000000', destinationUrl: 'https://shop.example.com/' } } },
      { title: 'Content submission', create: { label: 'Submit', path: '/v1/creators/submissions', example: { creatorId: '00000000-0000-4000-8000-000000000000', contractId: '00000000-0000-4000-8000-000000000000', contentUrl: null, contentText: '#ad How I import my contacts in one step' } } },
      {
        title: 'Fraud flags',
        list: '/v1/creators/fraud-flags',
        columns: ['kind', 'status', 'details', 'createdAt'],
        rowActions: [
          { label: 'Confirm', path: '/v1/creators/fraud-flags/:id', body: { status: 'confirmed' }, danger: true },
          { label: 'Dismiss', path: '/v1/creators/fraud-flags/:id', body: { status: 'dismissed' } },
        ],
      },
    ],
  },
  {
    slug: 'connections',
    title: 'Connections',
    modules: ['M23'],
    summary: 'Authorized provider accounts. Credentials are encrypted and never returned.',
    resources: [
      {
        title: 'Connections',
        list: '/v1/connections',
        columns: ['provider', 'displayName', 'externalAccountId', 'status', 'healthStatus', 'lastHealthCheckAt'],
        create: { label: 'Connect', path: '/v1/connections', example: { provider: 'meta', externalAccountId: '1234567890', displayName: 'Acme Page', grantedScopes: ['pages_manage_posts', 'pages_read_engagement'], credentials: { accessToken: '…' } }, note: 'Requires an MFA-enrolled admin.' },
        rowActions: [
          { label: 'Health check', path: '/v1/connections/:id/health-check' },
          { label: 'Rotate credentials', path: '/v1/connections/:id/credentials', prompt: { field: '*', label: '{ "credentials": { … } }', json: true } },
          { label: 'Disable', path: '/v1/connections/:id/status', body: { status: 'disabled' }, danger: true },
        ],
      },
      { title: 'Action types (allowlist)', list: '/v1/action-types', pick: 'actionTypes', columns: ['type', 'provider', 'category', 'verification', 'rollback', 'supported', 'blockerRef'] },
    ],
  },
  { slug: 'governance', title: 'Governance', modules: ['M24'], summary: 'Autonomy policy, kill switches, sender identity, registries, incidents and cost.', resources: [], custom: 'governance' },
  { slug: 'audit', title: 'Audit trail', modules: ['M24'], summary: 'Hash-chained, append-only audit log with independent chain verification.', resources: [], custom: 'audit' },
  { slug: 'settings', title: 'Account & security', modules: [], summary: 'Two-factor authentication, organizations and session.', resources: [], custom: 'settings' },
];

export const SECTION_GROUPS: { title: string; slugs: string[] }[] = [
  { title: 'Control', slugs: ['overview', 'approvals', 'governance', 'audit', 'connections'] },
  { title: 'Foundation', slugs: ['evidence', 'customers', 'knowledge'] },
  { title: 'Intelligence', slugs: ['market', 'brain', 'analytics', 'experiments', 'audiences'] },
  { title: 'Creation', slugs: ['offers', 'creative', 'assets', 'personas'] },
  { title: 'Channels', slugs: ['social', 'ads', 'discovery', 'app', 'lifecycle', 'conversations', 'creators'] },
  { title: 'Account', slugs: ['settings'] },
];

export function sectionBySlug(slug: string): Section | undefined {
  return SECTIONS.find((s) => s.slug === slug);
}
