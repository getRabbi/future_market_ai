# FUTUREGROW AI — Final Validated Tech Stack

## Executive Summary

The final architecture is locked around a **small infrastructure footprint with strong internal controls**: Cloudflare Pages for the web control plane, Cloudflare R2 for media/evidence/object storage, and Northflank for exactly two always-on application services, one PostgreSQL addon, and two bounded jobs. The core backend is TypeScript/Node.js 24 LTS with Fastify, Zod/OpenAPI, Better Auth, Drizzle/PostgreSQL, and Graphile Worker; numerical forecasting runs separately as a Python job; Remotion/FFmpeg runs separately as a media job. The most important architectural conclusion from the research is that FUTUREGROW should **not** be implemented as an uncontrolled multi-agent swarm. Instead, logical agents operate inside a deterministic Agent Kernel where models may propose decisions but deterministic code owns permissions, budget limits, approvals, idempotency, execution, verification, and evidence. Northflank’s Developer Sandbox is suitable for development, demonstrations, and a controlled beta, but its own documentation explicitly says it should not be used for production applications; therefore preserving quality means upgrading compute for a public production launch rather than removing verification, lowering media fidelity, or weakening the product. citeturn20view2turn20view3

**Final Claude/Codex-ready file:**  
[Download `FUTUREGROW_AI_TECH_STACK.md`](sandbox:/mnt/data/FUTUREGROW_AI_TECH_STACK.md)

**SHA-256:** `c53ec236a1baedb7e5afc38ed8edf8d7b72238702786b1dbb447b7a0b3d84284`

## Validated Architecture Decisions

The final topology deliberately avoids infrastructure that is unnecessary at the present scale. Northflank currently documents a Developer Sandbox allowance of **two services, two jobs, and one addon**. Its public pricing also supports Git/Docker deployment, managed databases including PostgreSQL, secrets, custom domains, logs and metrics. Current paid reference plans include `nf-compute-20` at 0.2 shared vCPU/512 MB for $5.40/month and `nf-compute-50` at 0.5 shared vCPU/1 GB for $12/month. citeturn20view0turn20view2

That constraint leads to this final service model:

| Runtime | Final responsibility |
|---|---|
| **Cloudflare Pages** | Astro + React frontend, public marketing site and authenticated dashboard |
| **Northflank `api`** | Fastify API, Better Auth, webhooks, R2 signed URLs, OpenAPI, admin/control plane |
| **Northflank `worker`** | Graphile Worker, Agent Kernel, AI reasoning, social/ad connectors, verification/reconciliation |
| **Northflank PostgreSQL addon** | Application state, events, analytics facts, workflow state and Graphile queue |
| **Northflank `analytics-job`** | Forecasting, opportunity models, anomaly detection, experiment analysis, backup verification |
| **Northflank `media-job`** | Remotion/FFmpeg rendering and R2 media delivery |
| **Cloudflare R2** | Uploads, generated videos/images, raw evidence, API-response archives and database exports |

Node.js 24 is an LTS line at the October 2026 validation point, making it the runtime baseline rather than adopting the non-LTS current release. citeturn10search13

Graphile Worker is particularly important to the design: its official project describes it as a PostgreSQL-backed Node.js job queue and publishes it under the MIT license. That allows FUTUREGROW to obtain durable background processing without consuming the single addon allowance on Redis. citeturn12view1 Better Auth similarly provides a TypeScript-oriented authentication framework with session/account management and other authentication capabilities, and its official project is MIT-licensed. citeturn12view2turn12view3

The specification therefore **does not add Redis, Kafka, RabbitMQ, Elasticsearch, a dedicated vector database, a separate LiteLLM gateway, Kubernetes, or one deployment per AI agent**. Those exclusions are architectural choices rather than temporary shortcuts: every additional stateful component would compete directly with the free-tier resource envelope without improving decision correctness.

The AI architecture is also intentionally framework-independent. FUTUREGROW may expose logical roles such as **Observer → Researcher → Strategist → Creator → Experimenter → Publisher → Optimizer → Verifier**, but those roles execute through one typed runtime. LangGraph, LangChain, Mastra, CrewAI, or similar frameworks are therefore not part of the critical-path contract in v1. They can later be used experimentally without changing the execution/security model.

## Free-Tier Deployment Reality and Scaling Path

Cloudflare fits the static/object-storage half of the design unusually well at beta scale. Cloudflare currently documents Pages Free limits including **500 builds per month, one concurrent build, 20,000 files per site, and a 25 MiB maximum individual static asset**; Pages Functions consume Workers quota, which is one reason the final design keeps the core dynamic API on Northflank instead. citeturn2view0

R2 Standard currently provides a free monthly allowance of **10 GB-month of storage, one million Class A operations, ten million Class B operations, and free Internet egress**. Standard storage beyond the included amount is currently listed at $0.015 per GB-month. citeturn2view1

Northflank is the harder constraint. Its own documentation describes Developer Sandbox as intended for exploration, hobby, and testing and explicitly says it **should not be used for production applications**. It also requires a payment method before resources can be created. citeturn20view2 Consequently, the file makes a distinction that earlier drafts needed to make more strongly:

**Controlled/internal beta on the free Sandbox: yes. Public production claiming production-grade infrastructure on Sandbox: no.**

Quality is preserved by keeping the software topology identical when upgrading. There is no “cheap architecture” followed by a rewrite.

A practical paid-beta baseline is approximately:

```text
API          nf-compute-20       $5.40/month
Worker       nf-compute-50      $12.00/month
PostgreSQL   ~nf-compute-20      $5.40/month
10 GB disk                        $1.50/month
light jobs                       ~variable
---------------------------------------------
bare floor                       ~US$25/month
```

Northflank currently lists CPU at $0.01667/vCPU-hour, memory at $0.00833/GB-hour, disk at $0.15/GB-month, and network egress at $0.06/GB. The exact addon/job charge still depends on the provisioned project and runtime consumption, so the file treats roughly **$25 as the low-traffic floor and $32–$40/month as a more sensible small public-beta core-infrastructure range**, before model API calls, ads, messaging, domain registration, or media licensing. citeturn20view0

Another important research correction concerns vector search. `pgvector` itself is a genuine PostgreSQL vector extension and supports installation through `CREATE EXTENSION vector`. citeturn8search2turn8search14 However, I did **not** find authoritative Northflank documentation guaranteeing that the free managed PostgreSQL addon exposes that extension. The specification therefore correctly labels **Northflank managed-addon pgvector support as UNSPECIFIED**, rather than pretending it is guaranteed.

The deployment now performs this capability probe:

```sql
SELECT name, installed_version, default_version
FROM pg_available_extensions
WHERE name = 'vector';
```

If available, FUTUREGROW enables pgvector. If unavailable, beta embeddings remain stored as arrays or compact objects and exact cosine similarity is calculated application-side. This reduces scalability, **not ranking fidelity**, which follows the user's “no quality compromise” requirement.

## Automation Brain, Verification and Data Integrity

The deepest architectural change is that the **LLM is not the automation authority**.

The final runtime is:

```text
Observe
  ↓
Normalize / deduplicate
  ↓
Retrieve evidence
  ↓
Calculate features + forecasts
  ↓
Planner proposes action
  ↓
Critic checks assumptions
  ↓
Expected-value / uncertainty / risk scoring
  ↓
Deterministic Policy Engine
  ├── DENY
  ├── REQUIRE HUMAN APPROVAL
  └── PRE-AUTHORIZED EXECUTION
             ↓
      Idempotent connector
             ↓
        Provider API
             ↓
      Read-back verification
             ↓
 Receipt + evidence + learning
```

This distinction is critical for a platform that may eventually control money, publishing, targeting, customer communication and external identities. The agent may propose `increase_budget`, but only the policy engine determines whether that action may exist. Model prompts never become access-control policies.

The file establishes several hard invariants:

**Every external mutation has an idempotency key.** Duplicate delivery cannot result in duplicate ads, posts or spend.

**Every inbound webhook goes through an inbox/deduplication layer.** Providers can safely retry delivery.

**State changes use a transactional outbox.** Database state and the intention to execute an external action cannot diverge silently.

**Every action is verified after execution.** Receiving HTTP `200` is insufficient; the connector must read back state or poll the provider's asynchronous-status endpoint.

**The LLM never receives OAuth refresh tokens or platform secrets.** Connector code retrieves credentials only at the execution boundary.

**Every consequential decision has evidence.** The system records evidence IDs, model ID, prompt version, policy version, assumptions, proposal, approval, execution response, provider request ID and verification state.

The audit trail is also designed to be tamper-evident:

```text
record_hash =
SHA256(previous_record_hash || canonical_current_record)
```

Large underlying evidence lives in private R2 objects with its own SHA-256 checksum.

For the requested “future detection,” the final design does not pretend that an LLM can literally know future outcomes. It separates reasoning from statistical forecasting. The analytics layer calculates probabilistic opportunity estimates, anomaly signals, experiment lift and uncertainty, while the LLM interprets those results and generates hypotheses. That means the system can use Thompson sampling, confidence/credible intervals, calibrated predictions, time-series forecasts, holdouts and controlled experiments instead of calling an AI guess a prediction.

Its optimization target is explicitly risk-adjusted:

```text
expected_utility
  = expected_incremental_business_value
  - λcost × expected_cost
  - λrisk × policy_or_brand_risk
  - λuncertainty × predictive_uncertainty
```

That gives FUTUREGROW a much stronger foundation for competitor analysis, creative testing, acquisition optimization and “next-best action” decisions than simply asking multiple agents what they think.

## Licensing and Social-API Findings

The Remotion finding deserves special attention because it invalidates the common assumption that Remotion is ordinary permissive open source. Remotion's own documentation says it is **source-available and not open source under the OSI definition**. Its current Free License applies to individuals and organizations/teams of up to three people and permits commercial automation. Organizations outside that eligibility generally need a Company License; the currently documented Automators option is **$0.01 per render with a $100/month minimum**. citeturn15view0turn15view1

Therefore the repository must contain a license gate before activating automated Remotion rendering commercially. This is not merely an accounting note: once the organization crosses the license threshold, it can materially change FUTUREGROW's minimum operating cost. Remotion also explicitly notes that its software license does not itself grant third-party codec-patent rights. citeturn15view1

The social-platform research also reinforces why connector capabilities must be dynamic rather than hardcoded as “all marketing is automatic.”

For Meta, the official Graph API is designed for programmatic graph operations including publishing/data/ads functionality, while the current permissions documentation identifies capabilities such as `ads_management`, `pages_manage_posts`, and `pages_read_engagement` for relevant account operations. citeturn18search0turn19search0turn19search14 Exact app-review, Instagram-product, rate-limit and version-specific behavior should be capability-checked because those requirements can evolve; the final file marks unresolved specifics as **UNSPECIFIED** rather than inventing guarantees.

Google Ads requires **OAuth 2.0 plus a developer token**. Current documentation distinguishes Test, Explorer, Basic and Standard access. Google currently documents production limits of 2,880 operations/day for Explorer and 15,000/day for Basic, while Standard removes the general daily operation cap although service-specific limits can still apply. citeturn16search4turn16search7turn16search10 FUTUREGROW therefore stores an account's approved access/capability state and refuses unsupported mutations rather than waiting for provider errors.

TikTok is even more significant for the “automatic UGC/influencer engine.” Direct publishing requires an approved `video.publish` scope and user authorization; unaudited clients are restricted to private visibility. TikTok's current Direct Post documentation also requires creator-information/consent handling, documents a **six requests per minute per user access token** initialization limit, and exposes an `is_aigc` field for AI-generated-content disclosure. citeturn17view3turn17view4

That means FUTUREGROW's virtual influencers and synthetic UGC can still be automated, but the architecture must support platform disclosures, sponsorship flags, account-specific consent, app audit status and human approval where necessary. It must never rely on fake accounts, fake engagement, account farming, impersonation, unauthorized scraping or attempts to bypass provider controls.

## Final Implementation Contract

The generated specification now contains the exact repo contract Codex or Claude should build against:

```text
apps/
  web/
  api/
  worker/

jobs/
  analytics/
  media/

packages/
  contracts/
  db/
  agent-kernel/
  policies/
  connectors/
  events/
  experiments/
  storage/
  media-contracts/
  observability/

infra/
  northflank/
  cloudflare/

docs/
  ARCHITECTURE.md
  EVENT_TAXONOMY.md
  CONNECTOR_CAPABILITIES.md
  POLICY_MATRIX.md
  RUNBOOK.md
```

It also fixes twelve architectural rules, including:

```text
No provider SDK outside packages/connectors.
No side effect without ActionRequest + policy decision.
No mutation without Idempotency-Key.
No unvalidated model output.
No secret exposure to models.
No SUCCESS before external verification.
Every model/prompt/policy/schema is versioned.
Every artifact carries SHA-256 + provenance.
Every tenant boundary has isolation tests.
Every connector supports capability discovery.
Unknown permission state means DENY.
Every prediction carries uncertainty and horizon.
```

The `.md` additionally includes a concrete Zod `ActionRequestSchema`, a `DecisionProposalSchema`, an OpenAPI mutation contract, event envelope, event taxonomy, PostgreSQL table groups, Northflank deployment matrix, cost progression, CI/CD pipeline, disaster tests, pre-launch gates, pgvector probe/fallback, Remotion licensing logic and an official-source evidence ledger.

The final implementation sequence is intentionally vertical rather than feature-by-feature: first build authentication/data/contracts, then event ingestion and queue semantics, then evidence/policy/idempotency, then take **one marketing connector all the way through `read → propose → approve → execute → verify → learn`** before adding additional networks. This prevents FUTUREGROW from becoming a large collection of half-working integrations.

## Final Verdict

The validated stack is:

**Astro + React → Cloudflare Pages**  
**Node.js 24 + Fastify + Zod/OpenAPI → Northflank API**  
**Better Auth → authentication/organization layer**  
**PostgreSQL + Drizzle → source of truth**  
**Graphile Worker → durable asynchronous execution**  
**Custom typed Agent Kernel → FUTUREGROW reasoning/orchestration**  
**Python analytics job → forecasting/statistics/experiments**  
**Remotion + FFmpeg media job → generated UGC/video**  
**Cloudflare R2 → assets/evidence/backups**  
**pgvector when runtime-proven, exact-vector fallback otherwise**  
**Official Meta/Google/TikTok APIs → execution channels**

The infrastructure remains deliberately lean, but the quality-critical mechanisms are **not** lean: evidence, uncertainty, approval, spend controls, idempotency, execution verification, experiments, attribution, provenance, credential isolation and auditing are all first-class architecture.

The only acceptable degradation under free-tier pressure is **throughput or waiting time**. The system may queue ten renders instead of rendering ten simultaneously; it may run analytics less frequently; it may restrict worker concurrency. It must **not** silently lower video fidelity, skip verification, weaken security, remove evidence, fake engagement, reduce statistical rigor or allow an LLM to bypass an approval gate.

Northflank's current Sandbox limitation makes that distinction particularly important: free infrastructure can prove FUTUREGROW's full behavior, but a genuine public-production deployment should upgrade resources rather than compromise the product. citeturn20view2turn20view0

**Final implementation artifact:** [Download `FUTUREGROW_AI_TECH_STACK.md`](sandbox:/mnt/data/FUTUREGROW_AI_TECH_STACK.md)