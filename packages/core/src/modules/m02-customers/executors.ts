import { eq } from 'drizzle-orm';
import { canonicalJson } from '@futuregrow/contracts';
import { dsarRequests, withTenant } from '@futuregrow/db';
import { sha256Hex } from '@futuregrow/observability';
import { tenantKey } from '@futuregrow/storage';
import { proof } from '@futuregrow/connectors';
import { actorRef, systemActor } from '../../deps.js';
import { record } from '../../util.js';
import { registerHooks, registerInternalExecutor } from '../m23-execution/registry.js';
import { buildCustomerExport } from './index.js';

const actor = systemActor('dsar-export');

/**
 * data.export_customer_data: personal-data exports are consequential (DATA_EXPORT category) and
 * therefore go through M23 policy/approval and independent verification of the stored object.
 */
registerInternalExecutor('data.export_customer_data', {
  async execute(deps, action) {
    const params = action.params as { dsarId: string | null; profileIds: string[]; purpose: string };
    const data = await withTenant(deps.db, { tenantId: action.tenantId, actor: actorRef(actor) }, (tx) => buildCustomerExport(tx, params.profileIds));
    const body = canonicalJson({ generatedAt: deps.clock.now().toISOString(), purpose: params.purpose, dsarId: params.dsarId, data });
    const key = tenantKey(action.tenantId, 'exports', `${action.id}.json`);
    const put = await deps.store.put(key, body, 'application/json');
    return {
      receipt: {
        providerRequestId: null,
        providerObjectId: key,
        httpStatus: null,
        responseSha256: put.sha256,
        observedAt: deps.clock.now().toISOString(),
        details: { bytes: put.bytes, profiles: data.profiles.length, events: data.events.length },
      },
      beforeState: null,
      rawResponse: { key, sha256: put.sha256 },
    };
  },
  async verify(deps, _action, receipt) {
    const bytes = receipt.providerObjectId ? await deps.store.get(receipt.providerObjectId) : null;
    if (!bytes) return proof('MISMATCH', 'database_readback', { exists: true }, { exists: false }, deps.clock.now());
    const sha = sha256Hex(bytes);
    return proof(sha === receipt.responseSha256 ? 'VERIFIED' : 'MISMATCH', 'database_readback', { sha256: receipt.responseSha256 }, { sha256: sha }, deps.clock.now());
  },
});

registerHooks('data.export_customer_data', {
  async onVerified(tx, action, receipt) {
    const dsarId = (action.params as { dsarId: string | null }).dsarId;
    if (!dsarId) return;
    await tx
      .update(dsarRequests)
      .set({ status: 'completed', completedAt: new Date(), resultObjectKey: receipt.providerObjectId, propagation: { export: receipt.details } })
      .where(eq(dsarRequests.id, dsarId));
    await record(tx, action.tenantId, actor, 'customer.dsar.completed', { type: 'dsar', id: dsarId }, { kind: 'access', objectKey: receipt.providerObjectId });
  },
});
