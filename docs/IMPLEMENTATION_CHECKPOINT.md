# Implementation checkpoint — 2026-11-17

## Resume here

`main` is live: api, worker and jobs follow `main`. The newest applied migration is 0031 (D-055). Every module, gate and release up to the UX layout repair (PR #40) and the discovery follow-ups (PR #37–#39, #41) is recorded in [PROGRESS.md](../PROGRESS.md). External blockers, each with its unblock step, are in [BLOCKERS.md](../BLOCKERS.md). The code has no open TODO markers and no skipped tests.

- **Live baseline:**
  - Web: Pages `81343439`, rollback `a6007b80`.
  - Monitoring: uptime Worker `da1edefb`.
  - EPS organization (`FG Smoke Test 20261021`): the real EPS Page connection (`read_insights` granted 2026-11-15, data access until 2027-02-13), the Google Play account, the EPS brand and Studio program `42216a51`. Also the active Autopilot goal `fe9be4e0`, Growth Warfare F1–F6 (switched on 2026-11-15) and competitor discovery (Tavily, three enrolled Play listings).
- **History:** the P1 checkpoint of 2026-11-08 (D-049 audit findings and changes) is in git history and in PROGRESS.md › *P1 EPS growth intelligence*.

## Remaining work, in order

1. **Code: PR #33 (draft), video switchboard (D-052/D-053).** This comes last, by the owner's choice.
   - Regenerate its migrations 0028/0029 as 0032/0033 (newer journal `when`), then run the full CI before merging.
   - Using it for real also needs B-027, which that branch adds to BLOCKERS.md: credentials, a GPU host, legal review of provider terms and real-provider acceptance tests.
2. **Owner, Meta (B-005):** App Review and Live mode (posts are visible only to app-role users until then), a System User ads token and the data-deletion URL in the App Dashboard. Authorize the app again before 2027-02-13; the alert comes about 30 days ahead. Steps: [META_READINESS.md](META_READINESS.md).
3. **Owner, Google Play (B-023):** enable the Google Play Developer Reporting API in Cloud project `futureai-513908` (app names, crash and ANR rates).
4. **Owner, EPS app:** republish the Privacy Policy and update Data safety. Then upload the 2.2.0+7 AAB to Internal testing and do one real Play-installed telemetry test.
5. **Owner, optional:**
   - Remove the two duplicate Tavily connections.
   - Record the Remotion licence (B-014).
   - Switch the EPS Studio program to one campaign per post if per-post store results are wanted.
   - Add an App Store Connect key for iOS reports (B-022).
6. **Owner decisions with cost or legal review:** see BLOCKERS.md (B-006…B-013, B-015, B-019, B-020, B-026).
7. **Routine:** a monthly restore drill (RUNBOOK §9); the next one is due in the first week of December 2026.

## Preserved pre-existing changes

`docs/D040_CONTENT_STUDIO.md` is dirty on entry and is deliberately left uncommitted. The uptime-worker files of an earlier checkpoint were merged through PR #25 and deployed (P0).
