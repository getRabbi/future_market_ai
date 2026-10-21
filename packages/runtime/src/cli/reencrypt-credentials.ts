/** Re-encrypt connection credentials with the current FG_SECRETS_KEY (RUNBOOK §8). */

import { buildCoreConfig, reencryptCredentials } from '@futuregrow/core';
import { createDb } from '@futuregrow/db';
import { loadEnv } from '../env.js';

const env = loadEnv();
const handle = createDb({ connectionString: env.DATABASE_URL, max: 1, applicationName: 'futuregrow-key-rotation', ssl: env.DATABASE_SSL, sslCa: env.DATABASE_SSL_CA, production: env.NODE_ENV === 'production' });
try {
  const result = await reencryptCredentials(handle.db, buildCoreConfig(env));
  console.log(JSON.stringify(result));
  if (result.remainingOnOldKeys > 0) process.exitCode = 1;
} finally {
  await handle.close();
}
