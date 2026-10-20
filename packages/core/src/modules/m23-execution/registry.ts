import type { ExecuteResult } from '@futuregrow/connectors';
import type { ExecutionProof, ExecutionReceipt } from '@futuregrow/contracts';
import type { actionRequests, Tx } from '@futuregrow/db';
import type { CoreDeps } from '../../deps.js';

export type ActionRow = typeof actionRequests.$inferSelect;

/**
 * Extension points used by modules. The gateway owns the state machine; modules only provide
 * (a) parameter resolution at the execution boundary, (b) internal executors for actions that
 * change FUTUREGROW's own state, and (c) side effects on verification/failure (e.g. marking a
 * social post as published_verified).
 */

/** Resolve stored action params into the exact connector input (e.g. render an email). */
export type ParamResolver = (deps: CoreDeps, tx: Tx, action: ActionRow) => Promise<Record<string, unknown>>;

export interface InternalExecutor {
  execute(deps: CoreDeps, action: ActionRow): Promise<ExecuteResult>;
  verify(deps: CoreDeps, action: ActionRow, receipt: ExecutionReceipt): Promise<ExecutionProof>;
}

export interface ActionHooks {
  /** Inside the VERIFIED transaction. */
  onVerified?(tx: Tx, action: ActionRow, receipt: ExecutionReceipt, proof: ExecutionProof): Promise<void>;
  /** Inside the FAILED / ROLLED_BACK / CANCELLED / DENIED / REJECTED transaction. */
  onTerminalFailure?(tx: Tx, action: ActionRow, status: string, reason: string, proof: ExecutionProof | null): Promise<void>;
  /** Extra facts for messaging actions etc. */
  onSubmitted?(tx: Tx, action: ActionRow): Promise<void>;
}

const resolvers = new Map<string, ParamResolver>();
const internal = new Map<string, InternalExecutor>();
const hooks = new Map<string, ActionHooks[]>();

export function registerResolver(actionType: string, r: ParamResolver): void {
  resolvers.set(actionType, r);
}
export function registerInternalExecutor(actionType: string, e: InternalExecutor): void {
  internal.set(actionType, e);
}
export function registerHooks(actionType: string, h: ActionHooks): void {
  hooks.set(actionType, [...(hooks.get(actionType) ?? []), h]);
}

export const getResolver = (t: string) => resolvers.get(t);
export const getInternalExecutor = (t: string) => internal.get(t);
export const getHooks = (t: string) => hooks.get(t) ?? [];
