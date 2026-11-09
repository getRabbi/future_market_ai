# Meta readiness: App Review, live operation and token renewal

What FUTUREGROW needs from Meta to run customer-facing Facebook operations for EPS TOPIK Bangla, what is already implemented, and how the Page token is renewed before it lapses. Live facts were read on 2026-11-07 (~21:20 UTC) with read-only Graph calls (`debug_token`, the app node, `/{app}/subscriptions`, the Page node); nothing was changed at Meta.

## Current state (read-only, 2026-11-07)

| Item | State |
|---|---|
| App | `futuregrowth` (1699997775173008), category Business. Mode (Development/Live) is not readable through the Graph API; treat it as **Development** until the owner checks the App Dashboard. In Development mode, posts the app publishes are visible only to people with a role on the app. |
| App roles | One administrator. No testers or developers. |
| Privacy Policy / Terms URLs | Set on the app: `https://futuregrow.scalemyprints.com/privacy`, `/terms`. App domain `futuregrow.scalemyprints.com`. |
| Data deletion | Instructions page live at `https://futuregrow.scalemyprints.com/data-deletion`. It must still be entered in App Dashboard › Settings › Basic › *Data deletion instructions URL* (not readable through the API). |
| Webhooks | App subscription `page` › `feed`, active, callback `https://http--api--mjmcf2c5fbyt.code.run/webhooks/meta`. Deliveries are verified with `X-Hub-Signature-256` (app secret) and resolved to the tenant per Page. |
| Page | *EPS-topik-Bangla* 1428505150337906, 13 followers, no Instagram professional account linked. |
| Page token | Type `PAGE`, valid, `expires_at` never, **data access until 2027-01-25 06:29 UTC**. Scopes: `pages_show_list`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_posts`, `pages_manage_engagement`, `pages_manage_metadata`, `pages_manage_ads`, `ads_read`, `ads_management`, `business_management`, `public_profile`. **No `read_insights`.** |
| Ads token | Type `USER` (not a system user), `expires_at` never, data access until 2027-01-25 06:29 UTC. Ad account `act_6269640959734898`, nothing spent. |
| Page insights | `/{page}/insights?metric=page_post_engagements` returns an empty list (no `read_insights`). Post counters (reactions, top-level comments) work without it; `shares` is omitted by Meta when there are none and is recorded as unknown. |

## Permissions: what each capability needs

| Capability | Permission | Implemented | Needed for Live / customers |
|---|---|---|---|
| Publish text and photo posts to the Page (M16 → M23) | `pages_manage_posts` (+ `pages_read_engagement`, `pages_show_list`) | Yes, production-verified on EPS with read-back verification | App Review (Advanced Access) to act on Pages of people without an app role |
| Read post counters for Studio learning | `pages_read_engagement` | Yes, production-verified (daily 11:25 UTC snapshot) | App Review |
| Read and moderate comments; comment inbox (M21) | `pages_read_user_content`, `pages_manage_engagement` | Yes; signed `feed` webhook delivery verified live once | App Review **and Live mode**: in Development mode Meta delivers webhooks only for people with an app role |
| Subscribe the Page to webhooks | `pages_manage_metadata` | Yes (health check reports `feedWebhook`) | App Review |
| Page insights → `kpi.facebook.*` series, forecasts, Growth Brain | `read_insights` | Yes (daily sync, `no_data` never becomes zero); empty today | Grant `read_insights` in a new authorization, then App Review |
| Ads read and budget/status changes (M17) | `ads_read`, `ads_management` | Yes, fixture-tested; ad account readable live | App Review; a system-user token avoids the 90-day data-access lapse |
| Instagram publishing | `instagram_basic`, `instagram_content_publish` + linked professional account | Executor fixture-tested | Link an Instagram professional account to the Page, then App Review |

## Owner checklist before Live mode

1. **App Dashboard › App settings › Basic:** confirm the Privacy Policy and Terms URLs (already set); enter the data deletion instructions URL `https://futuregrow.scalemyprints.com/data-deletion`; add an app icon and a contact email; complete **Business verification** for Futuregrowth (1868866234283607) if Meta asks for it.
2. **App Review › Permissions and features:** request Advanced Access for `pages_manage_posts`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_engagement`, `pages_manage_metadata`, `read_insights` (and `ads_read`/`ads_management` only if paid ads will be managed). For each: a short use-case description and a screen recording.
3. **Evidence for the recordings** (all exist in the product): sign-in with two-factor; Connections › Meta health check (token type, scopes, webhook); Content studio calendar and card preview; an Autopilot post going through Pending approvals or the pre-authorized policy to *Published, verified* with its Facebook link; Activity log showing the M23 execution and read-back; the comment inbox with a reply; the privacy, terms and data-deletion pages.
4. **Switch to Live** only after review approval. Development-mode posts are visible only to app-role users, so public visibility of EPS posts has not been independently verified yet.
5. **Instagram (optional):** link an Instagram professional account to the Page in Meta Business Suite before requesting the Instagram permissions.

Nothing above can be done from FUTUREGROW: submitting App Review, switching the app mode and granting permissions are owner actions at Meta. Fixture tests passing is not review approval.

## Token lifecycle and renewal (P1-07)

**Two different dates.** `expires_at` is when a token stops working at all (long-lived Page tokens derived from a long-lived user token report *never*). `data_access_expires_at` is when Meta stops returning data for user-derived tokens unless a person who granted the permissions uses the app again; a token can be valid and still lose data access. Both EPS tokens are user-derived, so both lapse on **2027-01-25 06:29 UTC**. A system-user token (Business Settings › System users) does not lapse this way.

**What FUTUREGROW does (implemented, tested):**
* The hourly `connector_health` job reads `debug_token` and records `tokenType`, `tokenExpiresAt`, `tokenDataAccessUntil` (and the ads equivalents) in the health result; token values are never stored in results, logs, audit or alerts.
* **30 days before** either date: an in-app warning alert `connector.token_expiring` (notification bell, Incidents & Alerts). For EPS this is due on **2026-12-26**.
* **7 days before:** a critical alert (also sent to the operator Discord webhook by `ops_monitor`) and the connection reads `degraded` with the warning. For EPS: **2027-01-18**. Posting is not blocked by `degraded`.
* Each alert is raised once per date and severity, also after it is acknowledged.
* When Meta refuses the token (code 190): the health check or the publish attempt moves the connection to `reauth_required` and raises a critical `connector.reauth_required` alert. A publish that was refused is `FAILED` (not retried); queued actions on a `reauth_required` connection wait as transient denials and are never attempted. No cycle reports a refused post as published.

**Renewal steps (owner, before 2026-12-26 ideally, at the latest before 2027-01-25):**
1. In the Graph API Explorer or the app's login flow, sign in as the Page admin, select app `futuregrowth` and grant the existing scopes plus `read_insights`. Exchange the short-lived user token for a long-lived one (`GET /oauth/access_token?grant_type=fb_exchange_token…`), then read the Page token with `GET /me/accounts` (or `/{page-id}?fields=access_token`).
2. Test it **before** saving: Connections › Meta › *Test credentials* (read-only; nothing is stored). Check type `PAGE`, the Page id 1428505150337906, the scopes and the new data-access date.
3. Only then **Rotate credentials** on the existing connection (admin with two-factor). Never overwrite the working token with an untested one. Run a health check afterwards; the next 11:25 UTC sync then fills `kpi.facebook.*` if Meta serves insights for the Page.
4. For the ads token, prefer a system-user token with `ads_read`/`ads_management` on the ad account.
5. Acknowledge the `connector.token_expiring` alerts once the new dates show in the health result.
