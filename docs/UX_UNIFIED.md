# Unified product experience (D-048)

FUTUREGROW's signed-in product is one application: one header, one sidebar, one search, one
set of design tokens, for the Home dashboard, the Autopilot and all 24 modules. The approved
visual reference is `docs/design/FUTUREGROW_UX_Reference.png`; its numbers are illustrative and
never hard-coded.

## Shell

| Part | What it does | Source |
|---|---|---|
| Header | Logo, organization switcher (`#org`), search (`Ctrl+K` / `Cmd+K`), Quick action menu (role-filtered), notifications, page help, account menu (roles, Account & security, sign out). | `components/Shell.tsx` |
| Sidebar | Groups Home · Journey · Goals · Content · Channels · Apps & Intelligence · Results · Reviews · Settings. Primary items are always shown; rarely used tools are under "More … tools" per group (the group of the current page opens itself) and in **All tools**. Live badges: approvals waiting, open incidents + alerts, Autopilot state. | `lib/nav.ts` |
| Page frame | Breadcrumbs (Home › Group › Page), title, one-line summary, a folded "How this works" guide with the journey steps done on that page. | `Shell.tsx` |
| Phones and tablets | ≤ 1023 px: the sidebar becomes a drawer (with the organization switcher); ≤ 640 px: search becomes an icon, Quick action an icon, cards stack; no page scrolls sideways at 320–390 px. | `styles/global.css` |

Every page is a static route generated from `PAGES` (`/app/<slug>`); the API is unchanged except
for one read-only endpoint (`GET /v1/system/status`, below).

## Information architecture and old → new routes

| Group | Page | Route | Was |
|---|---|---|---|
| Home | Home | `/app/` | Autopilot home (when on) or classic Overview |
| Journey | Growth Journey | `/app/journey` | Overview (rank, roadmap, pipeline) |
| | Onboarding & Setup | `/app/setup` | `/app/?view=setup` (Business setup) |
| Goals | Goals & OKRs (list, filters, `?id=` details and execution timeline) | `/app/goals` | `/app/?view=goals`, `?view=results` |
| | Autopilot (Growth Engine) | `/app/autopilot` | `/app/?view=activity` |
| Content | Content Studio | `/app/content` | `/app/?view=content` |
| | Content Calendar | `/app/calendar` | — (new view over the studio plan and posts) |
| | Creative briefs · Asset studio · Synthetic personas · Knowledge & claims | `/app/creative` · `/app/assets` · `/app/personas` · `/app/knowledge` | same routes |
| Channels | Channels & Accounts | `/app/channels` | `/app/?view=brands` |
| | Organic social · Campaigns & paid media | `/app/social` · `/app/ads` | same routes |
| | Lifecycle messaging · Conversations · Creators & referrals · SEO, ASO & AI discovery · Offers & CRO | `/app/lifecycle` · `/app/conversations` · `/app/creators` · `/app/discovery` · `/app/offers` | same routes |
| Apps & Intelligence | Apps & Store Reports (`?app=`, `?tab=accounts`) | `/app/apps` | `/app/?view=apps` |
| | Growth Brain · Market & Competitors · Forecasts & Analytics | `/app/brain` · `/app/market` · `/app/analytics` | same routes |
| | App attribution & cohorts · Audiences · Customers & consent · Evidence | `/app/app` · `/app/audiences` · `/app/customers` · `/app/evidence` | same routes |
| Results | Performance & Reports | `/app/results` | `/app/?view=results` (per goal) |
| | Insights & Learnings | `/app/insights` | — (new: lessons, store signals, decisions, content learning) |
| | Experiments | `/app/experiments` | same route |
| Reviews | Approvals (Autopilot inbox + all actions, `?id=`, `?tab=`) | `/app/approvals` | `/app/approvals` + `/app/?view=approvals` |
| | Incidents & Alerts | `/app/incidents` | alerts/incidents tables in Governance |
| | Audit trail · Activity log | `/app/audit` · `/app/activity` | same route · new |
| Settings | Organization & Team · Governance & Security · Connections & Credentials | `/app/settings` · `/app/governance` · `/app/connections` | same routes |
| | All tools | `/app/tools` | `/app/advanced` (redirects) |

`/app/?view=<old view>` and `/app/advanced` redirect on load (`legacyRedirect`), so bookmarks
and links in old notifications keep working.

## Module coverage

All 24 modules are reachable (checked by `apps/web/test/unified-ux.test.ts`): M01 Evidence ·
M02 Customers · M03 Knowledge · M04–M06 Market · M07 Growth Brain · M08–M09 Forecasts &
Analytics · M10 Experiments · M11 Audiences · M12 Offers · M13 Creative · M14 Assets · M15
Personas · M16 Organic social / Content Studio · M17 Campaigns & paid media · M18 SEO/ASO · M19
Apps & Store Reports / App attribution · M20 Lifecycle · M21 Conversations · M22 Creators · M23
Approvals / Connections · M24 Governance / Audit / Incidents. Nothing was removed; module
screens keep their forms, row actions and permission checks.

## Home dashboard

| Card | Data (persisted, tenant-scoped) | Honesty rules |
|---|---|---|
| Journey stepper | The 18 live-checked journey tasks, grouped into Setup · Connect · Plan · Create · Launch · Measure · Improve | Rank thresholds are frozen at the original stage totals (0/40/80/130/190/270/330/410 XP), so regrouping changed nobody's rank. |
| At a glance | `GET /v1/autopilot/goals` | "Needs attention" = latest cycle blocked/failed or result below the forecast range; a forecast without data next to a verified result is on track; "not measured yet" is stated separately, without claiming the data is only late (since D-049: a Facebook-insights KPI may need `read_insights`; the goal's cycle lesson says so). |
| Next best action | approvals, escalations, incidents, kill switches, Autopilot status and inbox, goals, journey | Priority: stop → escalation → severe incident → oldest approval (exact `?id=`) → inbox → blocked goal → next journey task → "You're on track". Skeleton until every input loaded; an error (not "on track") when one failed. |
| Performance | `GET /v1/app-intelligence/overview?window=reported` + `/apps/:id` series, or a daily KPI series (`/v1/analytics/series/:id/points`) | Unreported days are gaps; partial days hollow; totals only for complete windows; % change only against a complete previous window; source and data-through date shown; table alternative. |
| Blockers | kill switches, incidents, cycle attention notes, store account health and warnings, connections, policy | Levels: Critical · Action required · External setup needed · Optional enhancement · Temporarily unavailable. The Play Reporting API is always "Optional enhancement". |
| System health | `GET /v1/system/status` (new, read-only, sign-in required, same redaction as `/statusz`) | API, worker, database, backups, job queues with ages; "external alert delivery configured / not configured" from the notifier, never claimed as verified. |
| Growth summary | overview totals + `GET /v1/social/posts` | Android installs and iOS first-time downloads are never added together; open totals say so. |
| Recent activity / completions | `GET /v1/governance/audit`, `GET /v1/actions?status=VERIFIED`, goals, status | Plain sentences, local time, actor words; ids only under "Technical details" (Activity log). |

## Global search

`Ctrl+K` / `Cmd+K` or the header search opens a combobox dialog (arrow keys, Enter, Escape,
focus returned on close). Static: 38 pages (titles, summaries, keywords, module ids such as
"M17"), role-filtered quick actions, journey tasks and "how it works" guides. Records (fetched
on first open, per organization, from existing endpoints that the API already scopes to the
tenant and role): goals, apps, brands, connections, posts, actions waiting for approval. A list
the role cannot read contributes nothing. Limits: no full-text search inside evidence, claims or
audit payloads; up to 200 posts and 100 approvals are indexed.

## Accessibility

Landmarks (`banner`, `navigation "Main"`, `main`, breadcrumb nav), one `h1` per page, visible
focus, skip link, labelled controls, menus/dialogs closable with Escape, focus kept in the
palette, charts as keyboard sliders (arrow keys read each value) with a table alternative,
counts and states with text alternatives, `prefers-reduced-motion` honoured, 44 px touch
targets on phones, light and dark tokens.

## Acceptance scenarios → automated tests

| # | Scenario | Test |
|---|---|---|
| 1 | First-time user finds the first setup step | `autopilot.spec` (Home → "Turn it on" → Setup); unit `nextBestAction` (setup) |
| 2 | Returning owner sees the most important action | `autopilot.spec` (Unblock → exact goal; approval → exact `?id=`) |
| 3 | Search reaches any module | `autopilot.spec` (Ctrl+K "M17" → Enter); unit: every page found by title |
| 4 | Create a goal, view its execution timeline | `autopilot.spec` (composer → Details & timeline) |
| 5 | EPS calendar and verified post history | Calendar page (local visual QA with fixtures); content studio checks in `autopilot.spec` |
| 6 | Chart → app report | `autopilot.spec` phone test ("Open the app report" → `?app=`) |
| 7 | Missing Play days vs zeros | `autopilot.spec` ("total open: 3 of 28", "gaps, not zero"); unit chart rules |
| 8 | Optional provider API is not a failure | `autopilot.spec` (Blockers drawer: Optional enhancement, not Critical) |
| 9 | Approval from the notification bell | `autopilot.spec` (fixture action → bell → exact drawer) |
| 10 | Forecast, decision, audit evidence via navigation | `control-plane.spec` (every page renders) + goal details |
| 11 | All advanced modules in the same shell | `control-plane.spec` (38 pages, same nav/search) and `/app/advanced` redirect |
| 12 | 390 px phone, no hidden actions or overflow | `autopilot.spec` and `control-plane.spec` phone tests (390 and 320 px) |
| 13 | No restricted actions via search or deep links | `control-plane.spec` (approver: quick actions, search, deep links, 403) |
| 14 | Switching organization leaks nothing | `control-plane.spec` (second organization: no goals, no search records) |
| 15 | Empty, slow, failing, unavailable states | `autopilot.spec` (held request → skeleton; 500 → error, not "on track"); unit tests |

Not automated: the real EPS Page and Google Play account (production credentials; covered with
fixtures of the same shape).
