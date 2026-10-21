import { createDb, probeDatabase } from '../client.js';
import { dbTlsFromEnv } from '../tls.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const handle = createDb({ connectionString: url, max: 1, applicationName: 'futuregrow-probe', ...dbTlsFromEnv() });
try {
  const caps = await probeDatabase(handle.db);
  const problems: string[] = [];
  if (!caps.tenantRoleExists) problems.push('fg_tenant role missing: RLS isolation unavailable (B-004)');
  else if (!caps.canSetTenantRole) problems.push(`current user ${caps.currentUser} cannot SET ROLE fg_tenant`);
  if (caps.bypassRls && !caps.isSuperuser) problems.push('connection role has BYPASSRLS');
  if (handle.tls.mode === 'verify-full' && !caps.ssl) problems.push('TLS was required but the session is not encrypted');
  console.log(JSON.stringify({ ...caps, tls: handle.tls, problems }, null, 2));
  process.exit(problems.length ? 1 : 0);
} finally {
  await handle.close();
}
