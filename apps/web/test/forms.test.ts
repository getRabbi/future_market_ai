import { describe, expect, it } from 'vitest';
import { BRAND_RULE_FORM, CLAIM_FORM, EVIDENCE_FORM, evidenceNotice, FACT_FORM, factKey, LINT_HELP, releaseForm } from '../src/lib/fieldsets.js';
import { formatValue, humanize, statusLabel } from '../src/lib/format.js';
import { buildBody, evidenceReadiness, type FormSpec, friendlyIssue, humanError, initialValues, mapIssues, resolvePath, rowId, validate } from '../src/lib/forms.js';

const SPEC: FormSpec = {
  fields: [
    { key: 'name', type: 'text', label: 'Name', required: true, minLength: 3 },
    { key: 'identifier.kind', type: 'select', label: 'Kind', options: [{ value: 'email', label: 'Email' }], required: true, initial: 'email' },
    { key: 'identifier.value', type: 'email', label: 'Email', required: true },
    { key: 'discount', type: 'number', label: 'Discount', unit: '%', scale: 0.01, min: 1, max: 99 },
    { key: 'priceMicros', type: 'number', label: 'Price', scale: 1_000_000 },
    {
      key: 'confidence',
      type: 'select',
      label: 'Reliability',
      numeric: true,
      options: [
        { value: '0.95', label: 'High' },
        { value: '', label: 'Unsure' },
      ],
      emptyAsNull: true,
      initial: '',
    },
    {
      key: 'kind',
      type: 'select',
      label: 'Kind',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      initial: 'a',
    },
    { key: 'onlyB', type: 'text', label: 'Only for B', required: true, showIf: { key: 'kind', values: ['b'] } },
    { key: 'attributes', type: 'pairs', label: 'Details', keyLabel: 'Property', valueLabel: 'Value' },
    { key: 'markets', type: 'tags', label: 'Markets', case: 'upper', itemPattern: /^[A-Z]{2}$/, itemHint: 'two letters' },
    { key: 'until', type: 'date', label: 'Until', iso: 'end', emptyAsNull: true },
    { key: 'steps', type: 'rows', label: 'Steps', addLabel: 'Add', min: 1, fields: [{ key: 'hours', type: 'number', label: 'Hours', required: true, min: 1 }] },
  ],
  fixed: { schemaVersion: '1', at: () => 'now' },
};

describe('guided form bodies', () => {
  it('builds nested, scaled and typed values; hidden and empty optional fields are left out', () => {
    const v = {
      ...initialValues(SPEC.fields),
      name: ' Acme ',
      'identifier.value': 'a@b.co',
      discount: '15',
      priceMicros: '49.99',
      attributes: [
        ['Plan', ' Team '],
        ['', 'ignored'],
      ],
      markets: ['us', 'GB'],
      steps: [{ hours: '48' }],
    };
    const body = buildBody(SPEC, v);
    expect(body).toEqual({
      name: 'Acme',
      identifier: { kind: 'email', value: 'a@b.co' },
      discount: 0.15,
      priceMicros: 49_990_000,
      confidence: null,
      kind: 'a',
      attributes: { Plan: 'Team' },
      markets: ['US', 'GB'],
      until: null,
      steps: [{ hours: 48 }],
      schemaVersion: '1',
      at: 'now',
    });
    expect(body).not.toHaveProperty('onlyB');
  });

  it('checks required fields, lengths, formats, ranges and rows before sending; hidden fields are not checked', () => {
    const v = { ...initialValues(SPEC.fields), name: 'Ac', 'identifier.value': 'nope', discount: '150', markets: ['USA'], steps: [{ hours: '' }] };
    const errors = validate(SPEC.fields, v);
    expect(errors).toEqual({
      name: 'Use at least 3 characters (now 2).',
      'identifier.value': 'Enter an email address like name@example.com',
      discount: 'Use 99 % or less.',
      markets: '“USA”: two letters.',
      steps: 'Entry 1: Hours: This is required.',
    });
    expect(validate(SPEC.fields, { ...v, kind: 'b' }).onlyB).toBe('This is required.');
  });

  it('substitutes path parameters from the body', () => {
    expect(resolvePath('/v1/ads/connections/:connectionId/reconcile', { connectionId: 'c 1', start: 'x' }, ['connectionId'])).toEqual({ path: '/v1/ads/connections/c%201/reconcile', body: { start: 'x' } });
  });
});

describe('server problems in plain language', () => {
  it('maps Zod issues onto the field whose key prefixes the issue path', () => {
    const details = [
      { code: 'too_small', origin: 'array', minimum: 1, path: ['evidenceIds'], message: 'Too small' },
      { code: 'invalid_format', format: 'uuid', path: ['evidenceIds', 0], message: 'Invalid UUID' },
      { code: 'invalid_type', expected: 'string', path: ['text'], message: 'Invalid input: expected string, received undefined' },
      { code: 'custom', path: [], message: 'exactly one control variant is required' },
    ];
    const mapped = mapIssues(CLAIM_FORM.fields, details);
    expect(mapped.fields).toEqual({ evidenceIds: 'Add at least one.', text: 'This is required.' });
    expect(mapped.other).toEqual(['exactly one control variant is required']);
    expect(friendlyIssue({ code: 'too_small', origin: 'string', minimum: 20 })).toBe('Use at least 20 characters.');
    expect(friendlyIssue({ code: 'invalid_value', values: ['a'] })).toBe('Choose one of the offered options.');
    // Fastify-style validation entries carry the issue in params.
    expect(friendlyIssue({ instancePath: '/x', params: { issue: { code: 'invalid_format', format: 'email' } } })).toBe('Enter a valid email address.');
  });

  it('rewrites known server messages and keeps field problems as a list', () => {
    expect(humanError({ status: 422, code: 'INVALID', message: 'evidence not admitted/current: 1234' })).toMatchObject({ title: 'Some of the chosen evidence cannot be used.' });
    expect(humanError({ status: 422, code: 'INVALID', message: 'claims must be approved by someone other than their author' }).title).toBe('You proposed this, so someone else has to approve it.');
    expect(humanError({ status: 403, code: 'FORBIDDEN', message: 'approving claims requires one of roles: approver, owner' })).toEqual({ title: 'Your role cannot do this.', hint: 'Ask someone with one of these roles: approver, owner.', items: [] });
    expect(humanError({ status: 403, message: 'changing the autonomy policy requires a multi-factor authenticated session', details: { code: 'MFA_REQUIRED' } }).title).toBe('This needs a two-factor session.');
    expect(humanError({ status: 401, message: 'sign in required' }).title).toBe('Your session has ended. Sign in again.');
    const v = humanError({ status: 422, code: 'VALIDATION_FAILED', message: 'request validation failed', details: [{ code: 'too_small', origin: 'string', minimum: 3, path: ['text'] }] }, CLAIM_FORM.fields);
    expect(v).toEqual({ title: 'Some fields need attention.', items: ['The claim, exactly as you would say it: Use at least 3 characters.'] });
  });
});

describe('ground-truth forms', () => {
  it('admitting evidence sends the facts the server needs, with unknowns as null so it quarantines', () => {
    const body = buildBody(EVIDENCE_FORM, { ...initialValues(EVIDENCE_FORM.fields), summary: 'Q3 report', content: 'Retention 41%', sourceUriOrObjectId: 'crm://q3', sourceOwner: 'Acme', licenseOrUsageRights: '' });
    expect(body).toMatchObject({ summary: 'Q3 report', kind: 'document', content: 'Retention 41%', sourceType: 'primary', licenseOrUsageRights: null, piiClassification: 'none', confidence: 0.95, freshnessSlaHours: 2160, schemaVersion: '1', permittedUses: ['analytics', 'creative_generation', 'publishing'] });
    expect(typeof body.retrievedAt).toBe('string');
    expect(body).not.toHaveProperty('lawfulBasisOrConsentId');
    // Personal data asks for a lawful basis.
    expect(validate(EVIDENCE_FORM.fields, { ...initialValues(EVIDENCE_FORM.fields), piiClassification: 'personal' }).lawfulBasisOrConsentId).toBe('This is required.');
  });

  it('claims need real evidence; facts get a stable key; brand rules ask for the right pattern', () => {
    expect(validate(CLAIM_FORM.fields, { ...initialValues(CLAIM_FORM.fields), text: 'Imports 50,000 contacts' }).evidenceIds).toBe('Choose the evidence that backs this.');
    const fact = buildBody(FACT_FORM, { ...initialValues(FACT_FORM.fields), kind: 'plan', name: 'Team Plan (2026)', evidenceId: 'e1', attributes: [['Price', '$49']] });
    expect(fact).toEqual({ kind: 'plan', name: 'Team Plan (2026)', evidenceId: 'e1', attributes: { Price: '$49' }, validTo: null, key: 'team-plan-2026' });
    expect(factKey('plan', 'টিম প্ল্যান')).toBe(factKey('plan', 'টিম প্ল্যান'));
    expect(factKey('plan', 'টিম প্ল্যান')).toMatch(/^plan-[a-z0-9]+$/);
    const rule = buildBody(BRAND_RULE_FORM, { ...initialValues(BRAND_RULE_FORM.fields), kind: 'max_exclamations', pattern: '1', description: 'Calm tone' });
    expect(rule).toEqual({ kind: 'max_exclamations', pattern: '1', severity: 'block', description: 'Calm tone' });
    expect(validate(BRAND_RULE_FORM.fields, { ...initialValues(BRAND_RULE_FORM.fields), kind: 'max_exclamations', pattern: 'many', description: 'Calm' }).pattern).toBe('Enter a whole number from 0 to 99.');
  });

  it('release asks only for what is missing', () => {
    const keys = (reasons: string[]) => releaseForm({ quarantineReasons: reasons }).fields.map((f) => f.key);
    expect(keys(['license/usage rights unknown'])).toEqual(['licenseOrUsageRights', 'note']);
    expect(keys(['personal data without lawful basis/consent reference'])).toEqual(['lawfulBasisOrConsentId', 'note']);
    expect(keys(['confidence missing', 'PII classification missing'])).toEqual(['piiClassification', 'lawfulBasisOrConsentId', 'confidence', 'note']);
  });

  it('evidence readiness mirrors the server rule (admitted and not stale)', () => {
    const now = new Date('2026-10-30T12:00:00Z');
    const base = { evidenceId: 'e1', status: 'admitted', freshnessStatus: 'current', retrievedAt: '2026-10-29T12:00:00Z', observedAt: null, expiresAt: null, freshnessSlaHours: 48 };
    expect(evidenceReadiness(base, now)).toBe('ready');
    expect(evidenceReadiness({ ...base, freshnessSlaHours: 12 }, now)).toBe('stale');
    expect(evidenceReadiness({ ...base, expiresAt: '2026-10-30T00:00:00Z' }, now)).toBe('stale');
    expect(evidenceReadiness({ ...base, status: 'quarantined' }, now)).toBe('quarantined');
    expect(evidenceReadiness({ ...base, freshnessSlaHours: null, freshnessStatus: 'stale' }, now)).toBe('stale');
    expect(rowId(base)).toBe('e1');
    expect(evidenceNotice({ status: 'quarantined', quarantineReasons: ['confidence missing'] })).toMatchObject({ tone: 'warn', items: ['Say how reliable it is.'] });
  });

  it('every copy-check finding has an explanation', () => {
    for (const code of ['SUPERLATIVE', 'ABSOLUTE', 'STATISTIC', 'COMPARATIVE', 'TESTIMONIAL', 'HEALTH', 'ENVIRONMENTAL', 'FINANCIAL', 'SCARCITY']) expect(LINT_HELP[`UNSUBSTANTIATED_${code}`], code).toBeDefined();
    for (const code of ['CLAIM_NOT_USABLE', 'BRAND_BANNED_PHRASE', 'BRAND_BANNED_PATTERN', 'BRAND_REQUIRED_PHRASE_MISSING', 'BRAND_TOO_MANY_EXCLAMATIONS', 'DISCLOSURE_MISSING']) expect(LINT_HELP[code], code).toBeDefined();
  });
});

describe('display formatting', () => {
  it('shows statuses, IDs and amounts as people read them', () => {
    expect(statusLabel('APPROVAL_REQUIRED')).toBe('Approval required');
    expect(statusLabel(true)).toBe('Yes');
    expect(formatValue('id', '3f2b8c1e-1111-4222-8333-444455556666')).toBe('3f2b8c1e…');
    expect(formatValue('maxDiscountFraction', 0.25)).toBe('25%');
    expect(formatValue('handles', { instagram: '@riley' })).toBe('Instagram: @riley');
    expect(humanize('freshnessSlaHours')).toBe('Stays accurate (hours)');
    expect(humanize('dailyBudgetMicros')).toBe('Daily budget');
  });
});
