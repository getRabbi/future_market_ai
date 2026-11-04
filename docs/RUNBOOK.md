# FUTUREGROW AI — Operations runbook

Procedures for the controlled beta (Northflank Sandbox + Cloudflare). Every operator action through the API is audited; never edit tenant data directly in SQL except during an incident with a recorded incident id.

## 1. Daily checks (5 minutes)

1. Control plane → **Overview**: approvals waiting, escalated actions, open incidents, engaged kill switches, unacknowledged alerts.
2. **Governance → Alerts**: `governance.spend.discrepancy` (critical), `ads.spend.restated`, `ads.budget.external_change`, `connector.reauth_required`, `knowledge.injection_detected`, `analytics.anomaly`.
3. Northflank → jobs: the last `analytics-job` run exited 0 (its log ends with the backup/verification JSON); `media-job` runs are not failing repeatedly.
4. `select kind, status, finished_at from backup_runs order by finished_at desc limit 5;` — a `backup` and a `verification` row with `succeeded` within the last 24 h.
5. `GET /statusz` returns 200 with every component `ok`. The alert channel (`ALERT_WEBHOOK_URL`) has no unresolved problem announcements (§12).
6. Governance → *AI spending this month* and *Provider API lifecycle*: no tenant near its limit, no API version or model in `critical` or `sunset` (§13).

## 2. Stopping things (kill switches)

| Situation | Action |
|---|---|
| A connector misbehaves (wrong posts, rate-limit storm) | Governance → Kill switches → scope `connector`, target = connection id (or provider). |
| One campaign/post/journey is wrong | scope `object`, target = the object id (campaign id, post id, journey id). |
| A model or an agent produces bad proposals | scope `model` (model id) or `agent` (agent id, e.g. `community-assistant`). |
| Everything in a tenant must stop | scope `tenant`. |
| Platform-wide emergency | Platform admin: `POST /v1/platform/system-halt {"engaged": true, "reason": "…"}`. |

Engaging a switch cancels queued actions in scope; in-flight calls are blocked by the immediate pre-send check. Release only after the cause is fixed; releasing does not re-run cancelled actions (re-propose them).

## 3. Escalated / ambiguous executions

An action in `ESCALATED` means the provider call may or may not have been applied (timeout, 5xx after send). An incident is opened automatically.

1. Open the action (Actions & approvals → Escalated). Read the execution error and receipt.
2. The worker keeps verifying: if read-back proves the change, the action becomes `VERIFIED`; if it proves absence, `FAILED`.
3. If verification cannot decide, check the provider UI manually, record the finding in the incident, and resolve: re-propose only if you confirmed nothing was applied. **Never re-execute an ambiguous action blindly.**

`ROLLBACK_REQUIRED` (verification mismatch) is followed automatically by a compensating action where the connector supports rollback; otherwise it escalates for manual rollback.

## 4. Connector re-authorisation

`connector.reauth_required` means credentials expired or were rejected. Queued actions are preserved (rescheduled hourly). Rotate credentials: Connections → *Rotate credentials* (MFA admin). Health check afterwards. Revoked app access at the provider → set the connection to `revoked`.

## 5. Spend discrepancies (M17/M24)

`governance.spend.discrepancy` = reported spend on settled days exceeds the authorized envelope (daily budget history) beyond tolerance, a day exceeded 2× budget, or currencies disagree.

1. Engage an `object` kill switch on the campaign (or `connector` for the ad account) if spend is still running.
2. Compare `ad_budget_history` (sources: `sync`, `verified_action`, `external_change`) with the provider's change history. External changes mean someone edited the campaign outside FUTUREGROW.
3. Record findings in an incident; finance decides on refunds/credits with the platform.
`insufficient_data` means budgets were unknown for some spend days (e.g. before the first sync) — not an all-clear.

## 6. Messaging (M20)

* Complaints/bounces suppress addresses automatically (Resend webhook). Unsubscribes are honoured immediately (one-click POST) and withdraw marketing consent.
* A journey sending wrong content: Lifecycle → Journeys → **Pause** (enrolments wait), or an `object` kill switch with the journey id.
* `FREQUENCY_CAP_UNCONFIGURED` / `SENDER_IDENTITY_INCOMPLETE` denials: configure `messaging` in the autonomy policy and the sender identity (CAN-SPAM postal address).

## 7. Data-subject requests (M02)

1. Customers & consent → DSAR → *Log DSAR* (kind, identifier, jurisdiction, due date).
2. Verify identity (records the method), then execute: access exports go through M23 (`data.export_customer_data`); deletion and opt-out run directly with propagation counts recorded on the request.
3. Exemptions (kept by design): consent history, suppressions, pseudonymous experiment assignments, audit log (no personal data).

## 8. Secrets rotation

| Secret | Procedure |
|---|---|
| `FG_SECRETS_KEY` (credential encryption) | Set the new key as `FG_SECRETS_KEY`, the old one as `FG_SECRETS_KEY_PREVIOUS`, bump `FG_SECRETS_KEY_VERSION`; restart api + worker. Run `node reencrypt-credentials.mjs` in the api image (exit 0 = nothing left on old keys), then remove `FG_SECRETS_KEY_PREVIOUS` and restart. |
| `BETTER_AUTH_SECRET` | Rotating signs everyone out. Schedule, then restart api. |
| `FG_IDENTIFIER_PEPPER` | **Do not rotate casually**: suppression matching and identity resolution depend on it. Requires a re-hash migration. |
| `FG_BACKUP_KEY` | Keep old keys to read old backups. Set the new key; the next run writes with it. Store all keys outside Northflank (password manager / KMS). |
| Provider webhook secrets | Update at the provider and in the secret group at the same time; mismatched deliveries are stored as `rejected_signature`, never processed. |

## 9. Backups and restore (D-030)

* The analytics job writes an encrypted logical backup to R2 every 24 h (`FG_BACKUP_INTERVAL_HOURS`) and verifies it (hashes, decrypt, row counts).
* Manual backup: run the analytics-job image with command `python -m futuregrow_analytics.backup create`.
* **Restore drill (monthly):** create an empty database, run migrations with the same release (`node migrate.mjs` in the api image with `DATABASE_URL` pointing at it), then
  `python -m futuregrow_analytics.backup verify --restore-into <empty-db-url>` — counts must match and the run is recorded as `restore_drill`.
* **Real restore:** stop api/worker (scale to 0), restore into a fresh migrated database with `python -m futuregrow_analytics.backup restore --into <url>`, verify audit chains (`GET /v1/governance/audit/verify` per tenant after pointing the api at it), then switch `DATABASE_URL` and start services. Graphile queue state is not restored; the watchdog re-enqueues approved/unverified actions and pending webhooks.
* Managed addon backups (when the plan provides them) are the primary point-in-time mechanism; logical backups are the provider-independent copy.

## 10. Incidents

Severity guide: sev1 = data exposure or uncontrolled spend/publishing; sev2 = ambiguous public/spend execution, reconciliation discrepancy; sev3 = degraded connector or job; sev4 = cosmetic. For sev1/sev2: engage the narrowest effective kill switch first, then investigate. Resolve incidents with a written resolution (audited).

## 11. Deploying a new release

CI must be green (tests, lint, generated docs current, SBOM policy, image builds). Northflank rebuilds api, worker and both jobs from the branch; the api applies migrations on start. Concurrent migrators are serialised by a PostgreSQL advisory lock, so a second instance waits instead of racing; on the Sandbox keep `instances: 1`. Migrations are forward-only; a rollback means deploying the previous image **only if** no new migration ran, otherwise restore from backup.

## 12. Operator alerts and uptime

Alerts go to one webhook (`ALERT_WEBHOOK_URL`; DEPLOYMENT §9). Component problems are repeated every 6 h while they last and their recovery is announced once; other alerts are sent once.

| Alert | First steps |
|---|---|
| Component stale/failing (`database`, `worker`, `backups`, `analytics`/`media` queues) | `GET /statusz` for the component detail; Northflank → service or job logs. A stale worker means no cron or queue processing: restart `worker`. Backups: RUNBOOK §9. |
| Uptime probe: web, proxy or API down (Cloudflare Worker `futuregrow-uptime`) | Fires after 2 consecutive failed probes. Web/proxy only → Cloudflare Pages; API too → Northflank `api` status and logs. |
| Critical tenant alert, sev1/sev2 incident | Handle as §10; the control plane has the detail. |
| Graphile job exhausted its retries | Worker logs for the task; fix the cause, then re-propose or re-run (the watchdog re-enqueues approved/unverified actions). |
| API 5xx or process crash | Request id in the alert → api logs. A crash exits non-zero and Northflank restarts the container. |

## 13. AI spend limits and provider API lifecycle (FG-P2-001)

* **`BUDGET_EXCEEDED`:** a tenant's month-to-date model spend plus in-flight calls would pass its limit; agents abstain until the next month (UTC) or until the limit is raised in the autonomy policy (`aiSpend`). Raise it only after checking the cost ledger for a runaway agent; engage an `agent` kill switch if one is looping.
* **`BUDGET_UNMEASURABLE`:** a limit applies but a model has no registry price, so calls are refused. Record the model's prices in the model registry rather than removing the limit.
* **API version approaching sunset (90/30/7 days):** upgrade the connector's configured version (`META_GRAPH_API_VERSION`, `GOOGLE_ADS_API_VERSION`, `SHOPIFY_API_VERSION`, …) together with its capability records, test against the provider, redeploy. Past the sunset, policy denies actions on that provider with `API_VERSION_SUNSET`.
* **Version unverified:** no sunset date is known yet (Meta Graph until Meta publishes one; a Google Ads version missing from `GOOGLE_ADS_SUNSET_MONTHS`). A platform admin records the published date with `PUT /v1/platform/api-lifecycle` (DEPLOYMENT §9); a recorded date takes precedence over the built-in rule.
* **Deprecation signal observed:** a live response carried `Deprecation`/`Sunset` headers, a provider deprecation warning, or the provider served a newer version than requested. Treat it as an early sunset warning for that endpoint.
* **Model end of life:** approve the replacement model (`POST /v1/platform/models/approve`) before the date.

## 14. Autopilot (D-033)

* **Stop everything now:** engage a kill switch with scope `agent` and target `autopilot` (or a tenant kill switch, or the system halt). Every goal stops before its next step; M23 still refuses actions under its own kill switches.
* **One goal:** Autopilot → Growth goals → Pause (resume continues where it stopped) or Cancel goal (ends the running cycle). "Run now" brings the next cycle forward but daily caps still apply.
* **Platform:** `FG_AUTOPILOT=off` on api and worker (DEPLOYMENT §10).
* **A goal does not move:** AI activity shows each step's state. *Waiting* steps name what they wait for (analytics job, an approval, verification); *blocked* steps name what they need (data, evidence, claims, connection, model, budget, configuration). A step interrupted by a worker restart is retried after its 10-minute lease (up to 3 attempts).
* **Limits:** per goal, at most 4 cycles and 12 model calls per 24 h (configurable at creation), 3 open actions, AI steps 90 s apart; tenant AI spend limits (§13) apply on top.
* **Forecast blocked "insufficient history":** the engine needs 26 + horizon daily values; the Autopilot asks for the longest horizon the data supports (minimum 33 values for a 7-day forecast).

* **Small Facebook Page, no Page insights (D-035):** an `organic_social` goal with a connected Page and fewer than 33 KPI values runs in bootstrap mode: it reads the Page profile (weekly) and post counters (daily snapshot), proposes exploratory ideas from that evidence only, and drafts posts only from approved claims linked to the Page's product fact (`facebook-page:<page id>`, created by the profile read). When the goal auto-submits (the default), the submit step hands one draft per cycle to M23 as the `autopilot` agent (D-036), at most `maxPostsPerDay` (default 1) per rolling 24 h: with `PUBLIC_PUBLISHING: pre_authorized_within_limits` and a legal-approved market it is published and verified by read-back; otherwise it waits in Pending approvals; a denial (e.g. a kill switch) returns it to Pending approvals › Facebook post drafts with the reason. Drafts of suggest-only goals stay there until a person schedules one (then policy and approval apply). To stop autonomous posting at once, engage an agent kill switch on `autopilot` or a connector kill switch on the Meta connection. Content blocked on *claims* means no approved claim about that Page's product: approve the proposed ones (someone other than their author) or propose claims citing the Page or store-listing evidence and link them to the product fact.
* **Page insights stay empty:** check the connection's health details (`readInsights`). To add the permission the Page owner, as an admin of the Meta app, issues a new user token with `read_insights` in addition to the current Page permissions (Graph API Explorer or the app's Facebook Login), exchanges it for a long-lived token, reads the Page token from `/me/accounts`, and rotates the connection's credentials (§4, MFA admin). Verify with `debug_token` that the Page token lists `read_insights`, then run *Sync Page insights*. Meta can still return no values for very small Pages; post counters keep working either way.

## 15. Brands, platforms and media (D-041…D-044)

- **Set up a brand:** Autopilot → Brands & channels → Add a brand. Link the brand's channel accounts and store listings, then assign the content program. A program can only be assigned after its Page is linked to the same brand. Existing programs work without a brand; only their new store links get registered identities.
- **Attribution checks:** `GET /v1/app/campaigns?appId=…&platform=android&from=…&to=…&brandId=…` returns only campaigns whose registered identity belongs to the brand; each row's `identity.status` is `registered`, `unregistered` (typed or legacy links) or `brand_mismatch` (registry and app owner disagree — investigate, nothing is attributed).
- **Platform status:** `GET /v1/social/platforms`. `disabled` (X) needs an owner spending decision and a capability change; `awaiting_approval` (LinkedIn, TikTok) needs the platform's app approval; `needs_video` means the Studio cannot produce that format yet; `owner_assisted` (Reddit) is never automated.
- **Caption limits:** `POST /v1/social/caption-check` explains why copy does not fit a platform; scheduling refuses such copy (it is never truncated).
- **Media sources:** `GET /v1/media/providers`. Do not enable a stock or AI source by registry edits alone: the licence (`artifact_licenses`, `stock_media`, commercial use) or model approval (`image_generation`, commercial use, no training on customer data) must be recorded by an authorized person first.
- **Rollback:** migrations 0014 (new tables + nullable column) and 0015 (widened check constraints) are additive; the previous image runs against them unchanged. Do not drop the tables during a rollback.
