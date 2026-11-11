# Growth Warfare OS (F1–F6, D-054)

One policy-bounded growth layer over the existing modules. It adds no second Growth Brain, execution
gateway or website. Every feature and every external or paid operation **starts OFF**.

```
Market signals (M04 trends, M05 competitor observations, M18 Search Console, M02 inquiries/telemetry)
 → F1 opportunity (scored, deduplicated, evidence + expiry, review queue)
 → F2 conquest package / F3 blitz package / F4 tool or content / F5 rescue or referral campaign
 → approval (a different person, two-factor)            ← campaign package only, never publishes
 → channel task submitted by a person → M16 / M20 / M22 / human task → M23 policy, approval, verification
 → first-party outcomes (M02 events with the campaign code, M22 referrals, M16 post verification)
 → F6 experiment (M10, randomized) → strategy memory → Autopilot research/ideas/decide steps
```

## What each feature does

| | Feature | Built on | What it really does | Never does |
| --- | --- | --- | --- | --- |
| F1 | Market Signal Hunter | M04, M05, M18, M02, M01 | Reads stored evidence only: primary (`P`) competitor observations of the brand's competitors, rising/falling trends that match brand keywords, Search Console / uploaded queries with commercial, switching or need intent (≥ 20 impressions), customer inquiries and consented app searches aggregated to ≥ 5 distinct people. Each signal keeps its source table + row, evidence ids, source numbers, confidence and an expiry; it is deduplicated per brand. A score from 8 inspectable components (unknown ones, e.g. competition, stay unknown) becomes an opportunity above the aggression threshold, with a reason and next action. Stale/rejected evidence rejects the signal and expires its opportunity. High-urgency opportunities raise an info alert and nudge the worker. | Fetch new sources, estimate volumes or conversion probabilities, treat an inference (`I`) as a change. |
| F2 | Competitor Conquest Forge | M03 claims + lint, M05, M12, M23 | One campaign per opportunity (unique index): approved, unexpired brand claims; verified competitor facts with dates; differentiation pairs; switching concepts; alternative positioning; landing page; factual comparison page (methodology, as-of date, trademark disclaimer); switching guide from capability claims only; competitor-keyword ad proposal (no competitor name in ad text, trademark review, zero budget); cost-saving calculator spec that lists missing inputs; conversion goals; channel readiness; approval requirements. Copy passes M03 lint plus a conquest guard (impersonation, disparagement, unbacked offers or comparatives). Approval re-checks evidence and claims and needs a different person with MFA (and the legal acknowledgement when a competitor is named). | Invent weaknesses, discounts or prices, create ads or spend. |
| F3 | Growth Blitz & Distribution Mesh | M16, M20, M22, studio communities, M23 | Time-boxed blitz per opportunity; one task per channel (deduplicated by content); real readiness per brand (bound, active connectors only). Submitting a task (a person, external operations on, campaign approved, quota left, no identical content on the channel in 7 days): Facebook/Instagram → M16 scheduled post (lint, anti-spam) → M23; e-mail → M20 template draft (approval, then a consented journey); referral/creator → M22 referral link; owned site / partner / community → a person publishes and records the link. Disclosed community replies honour group rules (no link where promotion is forbidden; one share per group per week). Creator briefs, selection, comparison and duplicate-customer fraud flags. Outcomes from post verification, templates, referral clicks/conversions and campaign-coded events (observational). | Mass DMs, group joining, fake accounts, hidden ads, payouts, paid campaign creation. |
| F4 | Search & Utility Capture Engine | M02, M10, studio curriculum, M01 | Six tool templates with real calculations: courier comparison (operator rate cards with source + verification date; missing brackets stay "not published"), COD reconciliation, seller cost calculator, vocabulary assessment and practice quiz from the verified EPS lesson bank, readiness assessment. Public page `/t/?id=…` on the existing web app; analytics only with the visitor's choice; leads only with the consent box (marketing_email consent with evidence, no duplicate leads); A/B via an M10 experiment. AI-search visibility from audited manual imports (evidence first), with coverage, gaps and recommendations (content, FAQ, comparison page, FAQPage JSON-LD, tool idea, measurement plan) plus Search Console question queries. | Automate consumer AI assistants, promise rankings, invent courier prices. |
| F5 | Conversion Rescue & Viral Loops | M02, M20, M22, M10 | Brand funnel from first-party events (ordered stages, Wilson intervals, bottleneck only where ≥ 30 people enter a step), stalled people and how many are contactable (current marketing_email consent, not suppressed), recovery options (M20 journey, onboarding next step, friction experiment). Rescue campaign once per bottleneck. Referral loop (invites per inviter × conversion, first sign-up per invitee, self-referrals excluded via the peppered id hash), reward eligibility (refund window, fraud flags, double counting) without payouts, referral campaign templates whose rewards are only approved offers. | Target without consent, pay rewards, claim causality from pre/post. |
| F6 | Campaign Darwin Engine | M10, M07 via Autopilot, M23 | Plans with hypothesis, control, variant, KPI, guardrails, eligibility, assignment, sample sufficiency (measured baseline + 28-day traffic), stop conditions, measurement plan, prior findings. Approval (admin + MFA, not the author, within the aggression's parallel limit) creates an M10 experiment; start is the M23 `experiment.start` action. Finished results become memory; only randomized, SRM-clean `ship_candidate` / `stop_rollback` results are wins/losses (a database check forbids observational wins). Tactic priorities (Beta mean) from randomized tests only; declining tactics flagged; follow-up recommendations cite memory, experiment and result ids. | Interpret attribution as lift, raise budgets. |

## Control Room (`/app/growth-warfare`)

Brand selector; sections Growth Overview, Market Opportunities, Competitor Conquest, Growth Blitz,
Search & Acquisition Tools, Conversion Rescue, Campaign Experiments, Strategy Learning, Growth
Settings, Execution History. It is in Goals under "More" so the approved sidebar (D-048) is
unchanged; All tools and search list it.

**Switches.** F1–F6 per tenant (per-brand overrides can only switch off). OFF is enforced in every
service entry point (`requireFeature`, 409 `FEATURE_OFF`) and in the scheduled tick.

**Aggression.** `balanced` (1 parallel experiment, 2 campaigns, ≥ 24 h monitoring, threshold 0.6,
channel quotas ≤ 1), `aggressive` (3, 5, ≥ 6 h, 0.5, ≤ 3), `maximum_authorized` (5, 10, ≥ 1 h, 0.4,
≤ 10). Levels cap capacity; explicit controls still apply (`min`), and no level skips consent,
roles, MFA, budgets or approvals.

**Controls.** brands, acquisition goal, maximum concurrent campaigns, monitoring hours, Growth
Warfare daily/monthly AI budgets (0 = no model calls), advertising limit (0 = no paid proposals),
per-channel daily quotas, approval preference (`always_human` = a person submits every task),
`externalOperations`, `paidOperations`. Saved with `expectedVersion` (409 on a stale write). Widening
anything (a feature on, higher aggression or limits, external/paid on, policy approvals) needs
owner/admin **and** MFA; switching off needs no MFA.

**Emergency stop.** Any operator can stop (no MFA): settings flag + M24 agent kill switch
`growth-warfare` + cancellation of queued tasks, scheduled posts and their pre-execution M23 actions.
Release: admin with MFA.

## Autopilot integration

No new task kind. In the existing cycle: **research** adds, for the goal's brand (its Page's brand, or
the only active brand), open F1 opportunities and F6 findings when those features are on; **ideas**
and **decide** append them to the Idea Lab / Growth Brain constraints (labelled validated vs
observational, "not a guarantee"); **learn** refreshes F6 memory and prepares (never submits) the
F2/F3 package for the top accepted opportunity. With everything OFF the cycle is byte-for-byte as
before.

## AI budget hardening

`guardAiCall` now reserves in `ai_spend_reservations` inside a transaction holding
`pg_advisory_xact_lock(0x46470002, hashtext(tenant))`, so api, worker and job processes share one
in-flight total; the attempt's row is deleted after its real cost is in the cost ledger
(`afterCall` is now awaited); rows left by a crashed process stop counting after 15 minutes and are
purged after a day. Tested with two separate connection pools racing six calls against a $1 limit
(exactly two succeed). No new infrastructure.

## Data model (migration `0030_growth_warfare`, additive)

`ai_spend_reservations`, `growth_warfare_settings`, `growth_brand_configs`, `growth_signals`,
`growth_opportunities`, `growth_campaigns`, `growth_channel_tasks`, `acquisition_tools`,
`search_visibility_observations`, `growth_experiment_plans`, `growth_strategy_memory`,
`growth_operations`. Only `CREATE TABLE`, `CREATE INDEX` and foreign keys to `brands` /
each other; RLS is applied automatically (`fg_apply_security`, `tenant_id`). Existing concepts are
reused: evidence, claims, competitor observations, trends, keyword metrics, customer events,
consent, leads, referral links/conversions, fraud flags, M10 experiments/results, social posts,
message templates, M23 actions, audit, cost ledger.

**Numbering.** PR #33 owns `0028_video_mode_switchboard` and `0029_video_automation`, so this is
`0030` (journal `when` 1794425286527, later than 0029). Drizzle applies a migration only if its
`when` is later than the last applied one: **merge PR #33 (or apply 0028/0029) before 0030 reaches
any database**, or regenerate the video migrations with newer timestamps. On merge, keep the journal
in order 0028, 0029, 0030 (`idx` 28, 29, 30).

Rollback: the previous binary ignores the new tables; no down-migration is needed. To remove the
feature entirely, drop the twelve tables (only after a backup; they hold no data the rest of the
product reads).

## API (all under `/v1/growth-warfare`, tag `growth-warfare`; mutations need `Idempotency-Key`)

`GET overview|settings|history|opportunities|campaigns|campaigns/:id|tools|tool-templates|visibility|funnel|referrals|referrals/conversions/:id/eligibility|experiments|learning|brands/:id/config`;
`PUT settings|brands/:id/config|tools/:id`;
`POST emergency-stop|emergency-stop/release|scan|opportunities/:id/review|opportunities/:id/conquest|opportunities/:id/blitz|campaigns/:id/approve|campaigns/:id/tasks|campaigns/:id/sync|campaigns/:id/copy-variants|campaigns/:id/community-replies|campaigns/:id/creators|tasks/:id/submit|tasks/:id/done|tools|tools/:id/publish|tools/:id/retire|tools/:id/preview|visibility/import|rescue|referrals|experiments|experiments/:id/approve|experiments/:id/start|experiments/:id/reject|learning/sync`.
Public (no session, rate-limited): `GET /v1/public/tools/:publicId`, `POST …/evaluate`, `…/events`, `…/lead`.

Worker: `growth_warfare_tick` every 15 minutes (`*/15 * * * *`) and `growth_warfare_tenant` on a
high-urgency `growth.opportunity.detected` event. Both do nothing while every feature is OFF.
Events added: `growth.opportunity.detected`, `growth.campaign.prepared`, `growth.campaign.approved`,
`growth.task.submitted`, `growth.experiment.proposed`, `growth.learning.recorded`.

## Status

| Status | What |
| --- | --- |
| Implemented and tested (fixture/integration) | F1–F6 services, settings/switches/aggression/emergency stop, durable AI reservations, Autopilot hand-off, API (incl. public tool runtime), worker tick, Control Room and public tool page (type-checked, unit-tested catalog). |
| Fixture-tested only | Everything above runs against a real PostgreSQL in tests; no live provider was called. |
| Live verified | Nothing (not deployed; production untouched). |
| Externally blocked | AI-visibility provider API (none approved → manual imports); paid campaign creation (B-026); e-mail sending needs Resend + sender identity in the tenant; Instagram needs `instagram_content_publish`; real outcomes need real traffic. See B-028. |
| Not implemented | Automatic copy generation by default (the optional model step needs Growth Warfare AI budgets > 0 and an approved model); automatic M20 journey creation (a person creates the journey from the approved template); iframe embedding on brand sites (the web app's CSP frame policy is unchanged — link to `/t/?id=…` instead). |

## Deployment (one coordinated release; owner-authorized only)

1. Merge PR #33 into `feat/remaining-development` first (migration order), or regenerate its migrations.
2. Merge this PR into `feat/remaining-development`; full CI (typecheck, lint, docs check, vitest, py, E2E, images) must be green.
3. Merge `feat/remaining-development` → `main` only with the owner's go-ahead (PR #32 path).
4. Before the push to `main` (it auto-deploys api/worker on Northflank): take and verify a backup (`analytics-job` backup run + RUNBOOK §9 restore drill), confirm the production schema version is ≤ 0027, and that no paid operation can start: Growth Warfare settings rows do not exist in production, so every feature reads OFF.
5. After deploy: `/statusz`, `/v1/system/status`, api migrate log `{ok:true}`, `GET /v1/growth-warfare/settings` → all OFF, worker log shows `growth_warfare_tick` with no work, `ai_spend_reservations` empty after AI calls, Pages deploy for `/app/growth-warfare` and `/t/`.
6. Rollback: api/worker/jobs to the previous commit (no schema change needed), Pages to the previous deployment.

Nothing paid, no outreach and no video feature is activated by this release.
