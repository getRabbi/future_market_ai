/**
 * Optional immediate trigger of a Northflank job run (D-016). Without credentials the cron
 * schedule of the job drains the queue on its own; this only reduces latency.
 */
export async function triggerNorthflankJob(cfg: { token?: string; projectId?: string; jobId?: string }, fetchImpl: typeof fetch = fetch): Promise<'triggered' | 'not_configured' | 'failed'> {
  if (!cfg.token || !cfg.projectId || !cfg.jobId) return 'not_configured';
  const res = await fetchImpl(`https://api.northflank.com/v1/projects/${encodeURIComponent(cfg.projectId)}/jobs/${encodeURIComponent(cfg.jobId)}/runs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
    body: '{}',
  }).catch(() => null);
  // 409 = a run is already in progress, which will pick the request up.
  return res && (res.ok || res.status === 409) ? 'triggered' : 'failed';
}
