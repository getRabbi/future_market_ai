# Automatic competitor discovery (D-055)

FUTUREGROW finds competitors on its own. It searches the open web (store listings, websites, video
channels, social pages) and the Apple App Store with the brand's keywords. The approved model judges
every result, and confident competitors are enrolled and monitored. Growth Warfare F1 then turns their
public changes into market signals. You set it up once, and you tune it in the settings form, not in code.

```
brand keywords (Growth Warfare brand profile) × search patterns
  → Tavily web search (+ free App Store search)          ← monthly cap, rotation across runs
  → AI judge: direct / indirect / not a competitor        ← quote must exist in the result
  → enrolled (confidence ≥ threshold) or review list
  → standing approval: listing / home page monitored     ← robots.txt honoured on every fetch
  → page changes → competitor observations → F1 signals → opportunities
```

## One-time setup (owner)

1. **Tavily key.** Create a free account at tavily.com. The free plan has 1,000 searches a month and
   needs no card. Copy the API key (`tvly-…`).
2. **Connection.** In Settings › Connections, choose **Tavily**, give it any label, and paste the key.
3. **Brand keywords.** In Growth Warfare › Growth Settings › Brand growth profile, list what customers
   search for, in every language they use. Discovery reads the same keywords.
4. **Turn discovery on.** In Market & Competitors › Competitor discovery › *Configure automatic
   discovery*, choose the brand, keep **Tavily**, select the Tavily connection, keep the market (`BD`),
   and save. The defaults are:
   - searches every 24 h, 4 web searches per run, at most 300 a month
   - the App Store is also searched (free)
   - the AI judges results; confidence 0.8 or more is enrolled without review
   - monitoring of enrolled competitors' public listings and home pages is approved once (standing approval)

You do this once, signed in with your normal two-factor session. Nothing asks for a code again per action.

## What runs by itself

| Step | When |
|---|---|
| Search with the next keywords | Hourly check; each brand runs once per interval (`competitor_discovery_tick`) |
| AI judgement, enrolment | Same run |
| Monitoring of approved sources | Hourly (`competitor_crawl`); each source per its crawl interval (default 24 h) |
| Change extraction (model, snippet-verified) | After each captured change |
| F1 signals and opportunities | Growth Warfare tick (every 15 min; scans per monitoring hours) |

## Re-runs and the judge

- **Run now.** *Queue discovery* (a person) runs immediately instead of waiting for the interval. It never runs within 10 minutes of the last run, and the monthly cap still applies.
- **Unjudged batches are repeated.** A run where the AI judge was unavailable does not count. The next run repeats the same queries, so those results get a verdict. Its note says why the judge was unavailable.
- **Verdicts are not overwritten.** A later run without the model only refreshes when a candidate was seen. An earlier candidate the judge now calls not a competitor stays in review at confidence 0.1, under category `not_competitor`.
- **Hosts that are never competitors:** search providers, reference and document hosts, APK mirrors, app directories (e.g. AppBrain, which lists other publishers' apps) and government sites (`*.gov`, `*.gov.xx`, `*.go.xx`). Official non-government bodies are left to the judge.
- **Self-cleaning.** Each run rejects earlier web candidates on such hosts (or the brand's own exclusions, or URLs that are no longer an entity). If one was enrolled, its monitoring source is revoked, but only when the standing approval alone approved it. Sources a person approved, and store listings, are never touched. The run note counts what was removed.
- **Model call.** The judge sees at most 20 results with 220-character snippets. It is asked for competitors only, and the call runs at low reasoning effort (Groq gpt-oss) with a 6,000-token budget, so the JSON fits.

## What stays with a person

- **Uncertain candidates.** "Indirect" candidates, below the threshold, wait under *Discovery rankings
  and review* (enroll or reject).
- **Revoking monitoring.** Revoke a source any time in *Monitored sources*. A revoked source is never
  re-approved by discovery.
- **Opportunities.** Accepting an opportunity, approving a campaign package and submitting a channel
  task stay with a person (D-054).

## Tuning (settings form, "More options")

| Setting | Default | Meaning |
|---|---|---|
| Search patterns | `{keyword}`, `{keyword} app`, `{keyword} {country}` | `{keyword}` = each profile keyword (or the brand name), `{brand}`, `{country}` |
| Searches per run | 4 | Successive runs rotate through all keyword × pattern queries |
| Web searches per month | 300 | Per organization, calendar month (UTC); stops before the free 1,000 |
| Enroll without review from | 0.8 | AI "direct" = 0.85, "indirect" = 0.6; lexical fallback ≤ 0.9 for exact App Store matches |
| Never treat as competitors | — | Hosts to skip (the brand's own apps and landing page are always skipped) |

## Limits, stated plainly

- **Search results are secondary evidence.** Discovery stores a title, URL and snippet. Pages are fetched
  only by the monitor, only for approved sources, and only where robots.txt allows.
- **Google Play.** Listings are found through the web index. There is no Google Play catalogue API, and
  Play is never scraped. If Play's robots.txt disallows a listing, its source records `robots_disallowed`.
- **Signals need changes.** Signals appear only when a monitored page changes, for example a price,
  a feature or the positioning. The first crawl is the baseline.
- **The AI judges only what it is shown.** It cannot use outside knowledge. Its verdict is a relevance
  judgement, not a market measurement, and every verdict quotes the result.
- **Without a model** (no approved model, or the AI budget is exhausted), the lexical heuristics apply.
  Web candidates then stay in review at confidence 0.5.

## Data

- **Settings:** `competitor_discovery_settings.options` holds `includeAppStore`, `queryTemplates`,
  `maxQueriesPerRun`, `monthlySearchLimit`, `aiJudge`, `autoEnrollConfidence`,
  `standingSourceApproval` and `excludeDomains`.
- **Runs:** each run records its queries, `search_count`, result count and a note (AI judged / fallback,
  enrolled, cap reached, provider errors).
- **Standing approvals:** sources approved this way carry `approved_by = standing:<approver>`, and the
  audit log records `competitor.source.approved` with the approver and the time.
