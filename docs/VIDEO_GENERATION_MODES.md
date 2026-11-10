# Video generation modes (D-052)

FUTUREGROW makes videos through four independent modes. Each has its own ON/OFF switch in
**Media Studio › Video Generation Settings**, stored per tenant (`tenant_settings.video_routing`,
versioned by `video_routing_version`) and enforced by the server. A switch decides what the
server accepts. Turning a mode ON does **not** make it work: readiness is computed from real
records every time, and the dashboard shows each mode as **Ready**, **Setup required** or **Disabled**.

| Mode | What it does | Cost to FUTUREGROW | Default |
| --- | --- | --- | --- |
| Remotion + FFmpeg | CPU template render: scenes, transitions, subtitles, branding, voiceover, CTA; 9:16, 1:1, 16:9 | none (media worker CPU) | ON (needs the recorded Remotion licence) |
| Google Flow | Manual generation in Google Flow, then a validated MP4 import | none (Flow credits belong to your Google plan) | OFF |
| Wan Cloud | Wan workflows on an operator-hosted ComfyUI GPU worker | GPU time billed by the host | OFF |
| Higgsfield API | Official Higgsfield developer API | provider charges | OFF |

Paid defaults: **Disable all paid generation = ON**, all paid budgets **$0**, approval required.

## Smart router

`POST /v1/media/video-routing/preview` returns the same decision the queue uses (deterministic,
no writes). Each decision lists every mode with its problems, so it is auditable; queueing also
writes a `media.video_routing.decided` audit entry.

1. Template-compatible videos (`quality: "template"`) go to Remotion.
2. A cinematic clip (`quality: "cinematic"`) uses an enabled, ready free mode first (Google Flow → a
   manual hand-off; nothing is generated in the background).
3. Paid providers are considered only when the request explicitly allows paid work
   (`authorizedMaxUsd` on the queue call, `allowPaid` on the preview). Without it the router answers
   `needs_authorization` with the maximum charge. There is never a silent paid fallback.
4. Among eligible paid providers the cheaper maximum charge wins; the tenant priority breaks ties.
   Format support comes from the adapter (a same-aspect size is chosen when the preset size is not
   supported, for example 720×1280 for a 9:16 preset).
5. If nothing is eligible the API returns 403 `VIDEO_ROUTE_UNAVAILABLE` with the setup steps, never a
   fake success.

With Smart Mode OFF, requests go to the **default provider**, which must be ON.

## Budget and billing safety (paid modes)

- Server-side, per tenant, under one advisory lock (`video-budget:<tenant>`): a per-video maximum,
  a daily and a monthly paid budget, plus the tenant AI spending limit. Concurrent requests are
  serialized, so reservations can never overshoot.
- Every job reserves its **maximum** charge (`seconds × usd_per_video_second` of the approved model).
  Reservations count until the charge is known; a job whose charge is unknown keeps its reservation.
- Every paid request must carry `authorizedMaxUsd ≥` the maximum charge. With **approval required**
  (default) the job waits in `awaiting_approval` until an owner or admin with MFA approves it; the
  approval re-checks readiness and budgets. Nothing is submitted before that.
- Idempotency: `idempotencyKey` returns the original job for an identical request and refuses a
  reused key with different parameters; an identical request that is still pending is refused.
- Unresolved billing is persisted **before** the provider is called. An ambiguous submission is
  retried only by an adapter that documents replay-safe idempotency keys (Higgsfield); otherwise
  the job fails and the reservation stays (ComfyUI has no idempotency keys).
- Cost basis is recorded per job: `provider_reported`, `estimated_compute` (Wan: GPU time from the
  worker's own execution timestamps × `FG_WAN_USD_PER_GPU_HOUR`, **not an invoice**) or `unreported`
  (Higgsfield: the API returns no charge).
- **Reconcile** (`POST /v1/media/video-generations/:id/reconcile`, owner/admin/finance with MFA) records
  the authoritative amount from the invoice or billing records. The cost ledger stays append-only:
  the difference is added as an `invoice_adjustment` row and the reservation is released.
- Cancellation: before submission a job is cancelled without charge. After submission the worker asks
  the provider to cancel; the reservation stays until the charge is reconciled. Higgsfield cancels
  only queued requests; ComfyUI removes a queued prompt or interrupts a running one.
- No automatic credit purchase, no automatic GPU rental, no automatic paid fallback.

## Setup

### Remotion

1. Governance › Remotion licence: record the free-licence eligibility or the company licence.
2. The media worker image must contain Remotion and FFmpeg (the existing render job). Nothing else.

### Google Flow (manual)

1. Turn **Google Flow** ON.
2. Click **Open Google Flow** (`https://labs.google/fx/tools/flow`), generate the clip with your own
   Google account, download the MP4.
3. **Import from Google Flow**: choose the file, title, expected format and answer the rights
   questions. FUTUREGROW checks the MP4 signature and size (≤ 100 MB), then the media worker runs
   ffprobe QA (one H.264 video stream, at most one AAC/Opus/MP3 audio stream, 1–90 s, size range,
   aspect ratio of the chosen preset), records a provenance evidence record and the attestation, and
   stores an AI-disclosed video asset. Clips with third-party brands are refused.
4. The clip is usable as a Remotion scene once its source-media rights are cleared (commercial use
   confirmed). To make it **publish-eligible**, record Google's generative-AI terms once as an
   approved artifact licence named `google/flow` (Governance › licences); clips with people also
   need likeness rights. FUTUREGROW never automates the Flow website or touches Flow credits.

### Wan Cloud (remote GPU)

FUTUREGROW does not rent, start or stop GPUs. You host a ComfyUI server with a Wan 2.x workflow on a
GPU provider of your choice. Prefer a serverless or auto-stopping deployment so nothing runs idle.

1. Put ComfyUI behind an HTTPS reverse proxy that requires `Authorization: Bearer <token>`
   (ComfyUI itself has no authentication).
2. Export the workflow in **API format** and replace inputs with placeholders: `{{prompt}}`,
   `{{frames}}` (= seconds × fps + 1, i.e. 4n+1 at 16 fps), `{{fps}}`, `{{seconds}}`, `{{width}}`,
   `{{height}}`, `{{seed}}`; an image-to-video workflow also gets `{{image}}`. The workflow must save
   exactly one MP4 (for example VideoHelperSuite *Video Combine* with `h264-mp4`, no audio).
3. Server environment (api and worker):
   - `FG_WAN_COMFYUI_URL` (https), `FG_WAN_COMFYUI_TOKEN` (≥ 16 chars, secret)
   - `FG_WAN_T2V_WORKFLOW_PATH`, optional `FG_WAN_I2V_WORKFLOW_PATH` (JSON files in the image)
   - `FG_WAN_USD_PER_GPU_HOUR` (your GPU rate, used only for the estimate)
   - optional `FG_WAN_SIZES` (default `832x480,480x832,1280x720,720x1280`), `FG_WAN_MAX_RUN_SECONDS`
     (default 1800; longer runs are cancelled at the worker and failed)
4. Governance: approve a model in the model registry with provider `wan_cloud`, purpose
   `video_generation`, commercial use allowed, no training on customer data and a reviewed
   **maximum** `usd_per_video_second`; add an approved artifact licence `wan_cloud/<modelId>` after
   checking the exact weights' licence.
5. Video Generation Settings: Wan ON, Disable all paid generation OFF, nonzero per-video, daily and
   monthly budgets.

### Higgsfield API

Uses the official developer API (docs.higgsfield.ai), not website credits or automation.

1. Approve Higgsfield's commercial, training and privacy terms for your use, then create API keys.
2. Server environment: `HF_API_KEY_ID`, `HF_API_KEY_SECRET` (secret) and `FG_HIGGSFIELD_MODELS_JSON`,
   a map from model id to the endpoint path and body template **copied from the model's API
   reference** plus the sizes and durations you verified, for example:
   ```json
   { "<modelId>": { "path": "/<vendor>/<model>/<variant>", "body": { "prompt": "{{prompt}}" }, "sizes": [{ "width": 720, "height": 1280 }], "seconds": [5], "imageToVideo": false } }
   ```
   Image-to-video bodies may use `{{image_url}}` (a 15-minute presigned R2 URL of the cleared input
   image; not available on the filesystem store). Optional `FG_HIGGSFIELD_OUTPUT_HOSTS` restricts
   download hosts; downloads are always https-only, size-limited and refuse private addresses.
3. Governance: model registry entry with provider `higgsfield` (priced maximum per second) and an
   approved licence record `higgsfield/<modelId>`.
4. Enable it in Video Generation Settings with budgets. Every finished job keeps its reservation
   until you reconcile the actual charge from Higgsfield's billing records.

**Higgsfield MCP** may be used as an optional interactive interface for exploring prompts, but work
started through it bypasses FUTUREGROW's budgets, approvals and audit. Do not use the production API
key with MCP, and treat any MCP generation as external spend.

## API (authenticated, tenant-scoped)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/media/video-routing` | settings, version, per-mode readiness, usage |
| PUT | `/v1/media/video-routing` | `{ settings, expectedVersion }` — owner/admin with MFA; 409 on a stale version |
| GET | `/v1/media/video-routing/readiness` | per-mode status only |
| POST | `/v1/media/video-routing/preview` | routing decision (no writes) |
| POST | `/v1/media/video-routing/estimate` | maximum charge per mode and budget usage |
| GET | `/v1/media/video-routing/daily-plan` | daily automation plan and blockers |
| POST | `/v1/media/video-generations` | route and queue (Remotion render, Flow hand-off, or paid job) |
| GET | `/v1/media/video-generations` | job history (renders, imports, generations) and usage |
| POST | `/v1/media/video-generations/:id/approve` · `/cancel` · `/reconcile` | approval, cancellation, billing reconciliation |
| POST | `/v1/media/google-flow/import` | binary MP4, metadata in `x-fg-asset-meta` |

## Daily automation

Optional (`dailyAutomation`, target 1–10, default 5). The hourly worker task `video_daily_tick`
renders QA-passed storyboards with Remotion up to the target, at most two in flight per tenant,
skipping storyboards identical to one already rendered. It pauses when automation, Remotion or
its licence is missing. It does not write scripts or storyboards (those stay with the Content
Studio and its approvals) and it never uses paid providers. The target is a goal, not a guarantee.
Publishing still goes through M23 approval and verification.

## Limitations

- No adapter has been exercised against a real ComfyUI GPU worker or the real Higgsfield API;
  both are contract-tested with fixtures only. Run a real-provider acceptance test before enabling.
- Higgsfield's request bodies differ per model and are not documented generically, so they are
  configured, not built in. Status polling follows the documented `/requests/{id}/status` path.
- Wan cost is an estimate from execution time; GPU hosts bill instance time (including idle and
  start-up), so reconcile with the host's invoice.
- Google Flow terms and plan limits are the uploader's responsibility; FUTUREGROW records the
  attestation, it cannot verify it.
- Settings migration `0028_video_mode_switchboard` is additive (two columns, one partial unique
  index, two widened checks). A previous binary ignores them; rollback needs no schema change.
