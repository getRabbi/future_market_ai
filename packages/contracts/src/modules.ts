/**
 * Canonical module registry (FG-P0-001). The product plan freezes exactly 24 modules; a unit
 * test asserts this list has 24 active entries with unique ids and resolvable dependencies.
 * `aliases` preserves names used by earlier drafts so references can be migrated.
 */
export interface ModuleDefinition {
  id: `M${string}`;
  key: string;
  name: string;
  purpose: string;
  apiPrefix: string;
  dependsOn: readonly `M${string}`[];
  aliases: readonly string[];
  active: true;
}

export const MODULES = [
  { id: 'M01', key: 'evidence', name: 'Evidence & Source Registry', purpose: 'Rights-aware, time-aware, versioned evidence gate for every fact.', apiPrefix: '/v1/evidence', dependsOn: ['M24'], aliases: ['evidence ledger'], active: true },
  { id: 'M02', key: 'customers', name: 'Data Fabric & Customer 360', purpose: 'Consent-aware customer state, identity resolution, DSAR.', apiPrefix: '/v1/customers', dependsOn: ['M01', 'M24'], aliases: ['cdp', 'customer 360'], active: true },
  { id: 'M03', key: 'knowledge', name: 'Brand & Product Knowledge Graph', purpose: 'Factual ground truth, claim registry, brand rules, retrieval.', apiPrefix: '/v1/knowledge', dependsOn: ['M01', 'M24'], aliases: ['brand graph'], active: true },
  { id: 'M04', key: 'market', name: 'Market & Trend Intelligence', purpose: 'Trend objects with baselines, change points and evidence.', apiPrefix: '/v1/market', dependsOn: ['M01', 'M02'], aliases: ['trend radar'], active: true },
  { id: 'M05', key: 'competitors', name: 'Competitor War Room', purpose: 'Evidence-backed competitive map from lawful sources only.', apiPrefix: '/v1/competitors', dependsOn: ['M01', 'M04', 'M06'], aliases: ['competitor intelligence'], active: true },
  { id: 'M06', key: 'ideas', name: 'Idea Lab & Opportunity Miner', purpose: 'Testable, ranked growth hypotheses with kill criteria.', apiPrefix: '/v1/ideas', dependsOn: ['M01', 'M02', 'M03', 'M04', 'M05'], aliases: ['opportunity miner'], active: true },
  { id: 'M07', key: 'brain', name: 'Predictive AI Growth Brain', purpose: 'Typed, auditable next-best-action decisions; no direct writes.', apiPrefix: '/v1/brain', dependsOn: ['M06', 'M08', 'M09', 'M10', 'M23', 'M24'], aliases: ['growth brain'], active: true },
  { id: 'M08', key: 'forecasting', name: 'Forecasting & Scenario Engine', purpose: 'Probabilistic KPI forecasts with backtests and calibration.', apiPrefix: '/v1/forecasts', dependsOn: ['M01', 'M02', 'M24'], aliases: ['scenario engine'], active: true },
  { id: 'M09', key: 'mmm', name: 'Causal Measurement & MMM', purpose: 'Bayesian media-mix and incrementality estimates with diagnostics.', apiPrefix: '/v1/mmm', dependsOn: ['M01', 'M02', 'M10'], aliases: ['causal engine'], active: true },
  { id: 'M10', key: 'experiments', name: 'Experimentation & Bayesian Bandits', purpose: 'Controlled learning with logged assignment/exposure and guardrails.', apiPrefix: '/v1/experiments', dependsOn: ['M02', 'M07', 'M24'], aliases: ['bandits'], active: true },
  { id: 'M11', key: 'audiences', name: 'Audience & Propensity Engine', purpose: 'Lawful, explainable segments and calibrated propensity scores.', apiPrefix: '/v1/audiences', dependsOn: ['M02', 'M07', 'M08', 'M10'], aliases: ['segmentation'], active: true },
  { id: 'M12', key: 'offers', name: 'Offer, Pricing & Conversion Optimizer', purpose: 'Guardrailed offers, pricing tests and CRO hypotheses.', apiPrefix: '/v1/offers', dependsOn: ['M03', 'M07', 'M10'], aliases: ['cro'], active: true },
  { id: 'M13', key: 'creative', name: 'Creative Intelligence & Brief Generator', purpose: 'Evidence-mapped creative briefs and experiment matrices.', apiPrefix: '/v1/creative', dependsOn: ['M01', 'M03', 'M04', 'M05', 'M07', 'M14'], aliases: ['brief generator'], active: true },
  { id: 'M14', key: 'assets', name: 'Generative UGC & Asset Studio', purpose: 'Reproducible, rights-manifested asset rendering and QA.', apiPrefix: '/v1/assets', dependsOn: ['M03', 'M13', 'M24'], aliases: ['ugc studio'], active: true },
  { id: 'M15', key: 'personas', name: 'Synthetic Creator & Influencer Studio', purpose: 'Disclosed virtual brand characters with likeness controls.', apiPrefix: '/v1/personas', dependsOn: ['M03', 'M13', 'M14', 'M16', 'M22'], aliases: ['virtual influencer'], active: true },
  { id: 'M16', key: 'social', name: 'Organic Social & Community Engine', purpose: 'Authorized publishing and genuine community interaction.', apiPrefix: '/v1/social', dependsOn: ['M13', 'M14', 'M15', 'M23', 'M24'], aliases: ['social engine'], active: true },
  { id: 'M17', key: 'paid', name: 'Paid Media Autopilot', purpose: 'Budget/bid/status changes inside explicit spend envelopes.', apiPrefix: '/v1/ads', dependsOn: ['M07', 'M08', 'M09', 'M10', 'M23', 'M24'], aliases: ['ads autopilot'], active: true },
  { id: 'M18', key: 'discovery', name: 'SEO, ASO & AI Discovery', purpose: 'Technical/content/store-metadata improvements without rank promises.', apiPrefix: '/v1/seo', dependsOn: ['M03', 'M04', 'M10', 'M23', 'M24'], aliases: ['seo', 'aso'], active: true },
  { id: 'M19', key: 'app-growth', name: 'App Growth & Attribution', purpose: 'Install-to-revenue journeys with labelled attribution methods.', apiPrefix: '/v1/app', dependsOn: ['M02', 'M09', 'M10', 'M17', 'M24'], aliases: ['mobile attribution'], active: true },
  { id: 'M20', key: 'lifecycle', name: 'Lifecycle CRM & Messaging', purpose: 'Consented journeys with suppression checked immediately before send.', apiPrefix: '/v1/lifecycle', dependsOn: ['M02', 'M07', 'M11', 'M12', 'M23', 'M24'], aliases: ['crm'], active: true },
  { id: 'M21', key: 'conversations', name: 'Conversational Sales & Support', purpose: 'Cited answers, qualification and human handoff with AI disclosure.', apiPrefix: '/v1/conversations', dependsOn: ['M02', 'M03', 'M07'], aliases: ['sales bot'], active: true },
  { id: 'M22', key: 'creators', name: 'Creator, Affiliate & Referral Operations', purpose: 'Real partners, contracts, disclosures and commission ledger.', apiPrefix: '/v1/creators', dependsOn: ['M13', 'M16', 'M17', 'M20', 'M24'], aliases: ['affiliates'], active: true },
  { id: 'M23', key: 'execution', name: 'Agentic Orchestrator & Execution Gateway', purpose: 'Only component allowed to invoke consequential write tools.', apiPrefix: '/v1/actions', dependsOn: ['M24'], aliases: ['execution gateway'], active: true },
  { id: 'M24', key: 'governance', name: 'Execution Verification, Governance & Growth Control Plane', purpose: 'Independent proof, audit, kill switches, registries, cost.', apiPrefix: '/v1/governance', dependsOn: [], aliases: ['control plane'], active: true },
] as const satisfies readonly ModuleDefinition[];

export type ModuleId = (typeof MODULES)[number]['id'];
