/**
 * Event taxonomy (docs/EVENT_TAXONOMY.md is generated from this list).
 * Naming: <module>.<aggregate>.<past_tense_verb>. Versions increase on breaking payload changes.
 */
export const EVENT_TYPES = {
  // M01
  'evidence.record.admitted': 1,
  'evidence.record.quarantined': 1,
  'evidence.record.released': 1,
  'evidence.record.expired': 1,
  // M02
  'customer.profile.merged': 1,
  'customer.event.ingested': 1,
  'customer.consent.changed': 1,
  'customer.suppression.added': 1,
  'customer.dsar.received': 1,
  'customer.dsar.completed': 1,
  // M03
  'knowledge.claim.approved': 1,
  'knowledge.claim.expired': 1,
  'knowledge.document.indexed': 1,
  // M04/M05/M06
  'market.trend.detected': 1,
  'competitor.snapshot.captured': 1,
  'competitor.observation.recorded': 1,
  'idea.growth_idea.ranked': 1,
  // M07
  'brain.decision.proposed': 1,
  'brain.decision.abstained': 1,
  // M08-M11
  'analytics.request.queued': 1,
  'analytics.request.completed': 1,
  'analytics.request.failed': 1,
  'experiment.experiment.started': 1,
  'experiment.result.computed': 1,
  // M13-M15
  'creative.brief.created': 1,
  'media.render.requested': 1,
  'media.render.completed': 1,
  'media.asset.eligibility_changed': 1,
  'persona.persona.approved': 1,
  // M16-M22
  'social.post.scheduled': 1,
  'social.interaction.received': 1,
  'ads.campaigns.synced': 1,
  'ads.spend.synced': 1,
  'seo.audit.completed': 1,
  'aso.listing.validated': 1,
  'app.install.recorded': 1,
  'lifecycle.journey.activated': 1,
  'lifecycle.enrollment.created': 1,
  'lifecycle.message.queued': 1,
  'lifecycle.message.status_changed': 1,
  'conversation.handoff.requested': 1,
  'creator.conversion.recorded': 1,
  'creator.content.submitted': 1,
  // M23/M24
  'action.request.proposed': 1,
  'action.request.transitioned': 1,
  'action.approval.recorded': 1,
  'action.execution.verified': 1,
  'action.execution.failed': 1,
  'action.execution.escalated': 1,
  'governance.kill_switch.engaged': 1,
  'governance.kill_switch.released': 1,
  'governance.incident.opened': 1,
  'governance.spend.discrepancy_detected': 1,
  'connector.webhook.received': 1,
  'connector.health.changed': 1,
} as const satisfies Record<string, number>;

export type EventType = keyof typeof EVENT_TYPES;

export function isKnownEventType(t: string): t is EventType {
  return Object.hasOwn(EVENT_TYPES, t);
}
