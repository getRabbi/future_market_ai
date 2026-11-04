import { useMemo, useState } from 'react';
import { DataTable, EmptyState, ErrorNotice, LoadingRows, useApi } from './ui.js';

export const APP_CONVERSION_CALLS = [
  { method: 'GET', path: '/v1/app/applications' },
  { method: 'GET', path: '/v1/app/campaigns' },
] as const;

interface Application {
  appId: string;
  platform: string;
}
interface CampaignReport {
  campaigns: {
    campaign: string | null;
    source: string | null;
    content: string | null;
    attributionMethod: string;
    metrics: { linkClicks: number | null; installs: number | null; firstOpens: number | null; activations: number | null; retainedWeek1: number | null };
    reconciledWindows: Record<'firstOpens7d' | 'activations7d' | 'retainedWeek1', { value: number | null; eligibleInstalls: number; reconciledInstalls: number }>;
  }[];
  notes: string[];
}

export function AppConversions() {
  const apps = useApi<Application[]>('/v1/app/applications');
  const [selection, setSelection] = useState('');
  const selected = apps.data?.find((a) => `${a.platform}:${a.appId}` === selection) ?? apps.data?.[0];
  return (
    <section className="card">
      <h2>Campaign conversion observations</h2>
      <p className="small muted">Counts reported by your application backend. Missing outcomes are unavailable; these observations do not establish causal impact.</p>
      <ErrorNotice error={apps.error} />
      {!apps.data && !apps.error ? <LoadingRows /> : null}
      {apps.data?.length ? (
        <>
          <label htmlFor="conversion-app">Application</label>
          <select id="conversion-app" value={selected ? `${selected.platform}:${selected.appId}` : ''} onChange={(event) => setSelection(event.target.value)}>
            {apps.data.map((app) => (
              <option key={`${app.platform}:${app.appId}`} value={`${app.platform}:${app.appId}`}>
                {app.appId} ({app.platform})
              </option>
            ))}
          </select>
          {selected ? <Campaigns key={`${selected.platform}:${selected.appId}`} app={selected} /> : null}
        </>
      ) : apps.data ? (
        <EmptyState title="Application conversions unavailable">Connect your application backend and send consented installs with an application ID to start observing campaigns.</EmptyState>
      ) : null}
    </section>
  );
}

function Campaigns({ app }: { app: Application }) {
  const query = useMemo(() => {
    const now = new Date();
    return new URLSearchParams({ appId: app.appId, platform: app.platform, from: new Date(now.getTime() - 90 * 86_400_000).toISOString(), to: now.toISOString() });
  }, [app.appId, app.platform]);
  const result = useApi<CampaignReport>(`/v1/app/campaigns?${query}`);
  if (result.error) return <ErrorNotice error={result.error} />;
  if (!result.data) return <LoadingRows />;
  const count = (value: number | null) => (value === null ? 'Unavailable' : value);
  const rows = result.data.campaigns.map((c) => ({
    campaign: c.campaign ?? 'Unattributed',
    source: c.source ?? 'Unavailable',
    content: c.content ?? 'Unavailable',
    method: c.attributionMethod,
    installs: count(c.metrics.installs),
    firstOpens: count(c.metrics.firstOpens),
    activations: count(c.metrics.activations),
    retainedWeek1: count(c.metrics.retainedWeek1),
    linkClicks: count(c.metrics.linkClicks),
  }));
  return (
    <>
      <p className="small muted">Installs in the last 90 days. Week-one retention uses only fully elapsed measurement windows.</p>
      <DataTable
        rows={rows}
        columns={['campaign', 'source', 'content', 'method', 'installs', 'firstOpens', 'activations', 'retainedWeek1', 'linkClicks']}
        labels={{ firstOpens: 'Observed first opens', activations: 'Observed activations', retainedWeek1: 'Observed week-one retention', installs: 'Observed installs', linkClicks: 'Link clicks' }}
        empty="No evidence-backed campaign observations in this interval."
      />
      <h3>Reconciled measurement windows</h3>
      <p className="small muted">A value, including zero, appears only when your backend's event declarations match stored observations for every mature installation in the campaign. These declarations do not verify device tracking or total store acquisitions.</p>
      <DataTable
        rows={result.data.campaigns.map((c) => ({
          campaign: c.campaign ?? 'Unattributed',
          source: c.source ?? 'Unavailable',
          content: c.content ?? 'Unavailable',
          method: c.attributionMethod,
          firstOpens7d: count(c.reconciledWindows.firstOpens7d.value),
          activations7d: count(c.reconciledWindows.activations7d.value),
          retainedWeek1: count(c.reconciledWindows.retainedWeek1.value),
          activationCoverage: `${c.reconciledWindows.activations7d.reconciledInstalls} / ${c.reconciledWindows.activations7d.eligibleInstalls} mature installs`,
        }))}
        columns={['campaign', 'source', 'content', 'method', 'firstOpens7d', 'activations7d', 'retainedWeek1', 'activationCoverage']}
        labels={{ firstOpens7d: 'First opens within 7 days', activations7d: 'Activations within 7 days', retainedWeek1: 'Retention at 7–14 days', activationCoverage: 'Activation coverage' }}
        empty="No reconciled measurement windows available."
      />
      <ul className="small muted">
        {result.data.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </>
  );
}
