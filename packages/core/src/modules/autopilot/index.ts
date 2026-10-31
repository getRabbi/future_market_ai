/**
 * Autopilot (M23 Agentic Orchestrator, D-033): persistent, tenant-scoped business goals pursued
 * by the worker in checkpointed cycles. Delegates to existing modules; every consequential write
 * still goes through the M23 gateway, its policy, approvals and independent verification.
 */
export * from './engine.js';
export * from './goals.js';
export { type Measurement, MIN_KPI_POINTS, measureGoal, SETTLED_ACTION_STATES } from './steps.js';
