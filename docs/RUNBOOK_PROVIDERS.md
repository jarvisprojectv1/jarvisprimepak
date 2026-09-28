# JARVIS Provider Configuration Runbook (Phase 12)

Variable names only - **never put a real secret value in this file, in a
commit, or in any log.** `security/redact.ts` best-effort redacts secret-
shaped values from logs, but the discipline starts with never typing a real
key into a repo file in the first place.

For each provider: what it needs, what breaks without it, and how
`config/providers.ts` classifies it (`CONFIGURED` / `OPTIONAL` /
`CONFIGURATION_REQUIRED` / `INVALID`). Check current state anytime via
`GET /health/ready` (unauthenticated) or `GET /system/health` (login
required, more detail).

## Anthropic API (Claude) - `core/ai`

- `ANTHROPIC_API_KEY`
- Without it: the Brain/orchestrator and AI-narrative synthesis (Phase 11
  BI) return `CONFIGURATION_REQUIRED`, never a fabricated response.
- `core/ai/costControl.ts` enforces daily/monthly spend caps regardless of
  whether this is configured.

## Email (Gmail API) - `tools/email`

- `GMAIL_ACCESS_TOKEN`, `GMAIL_USER_EMAIL`
- Without both: `tools/email` returns `CONFIGURATION_REQUIRED`.
- **Disclosed gap** (see `docs/PHASE7_EMAIL_CRM.md`): token refresh is NOT
  implemented - a short-lived OAuth2 token expiring in production is real
  and unhandled. Re-issue the token manually until a refresh flow exists.

## WhatsApp (Meta Cloud API) - `tools/whatsapp`, `core/whatsapp/webhook.ts`

- `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`
  (outbound send + inbound webhook signature verification - dual purpose),
  `WHATSAPP_WEBHOOK_VERIFY_TOKEN` (the one-time subscription handshake).
- Without `WHATSAPP_APP_SECRET`: `POST /webhooks/whatsapp` fails closed
  (503) - no payload is ever processed without a secret to verify against.
- Without `WHATSAPP_WEBHOOK_VERIFY_TOKEN`: the `GET` subscription handshake
  always returns 403, so Meta can never subscribe this endpoint in the first
  place, even if send credentials are otherwise valid.
- Also required: this API's public HTTPS URL must be registered with Meta
  as the webhook callback (`/webhooks/whatsapp`), reachable from the
  internet - a reverse proxy (see `docs/PHASE12_PRODUCTION.md`) typically
  provides this.

## Voice (Twilio) - `tools/voice`, `core/voice/webhook.ts`

- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (also verifies inbound webhook
  signatures - dual purpose), `TWILIO_PHONE_NUMBER`, and
  `VOICE_PUBLIC_WEBHOOK_URL` (the exact, externally-visible URL Twilio was
  configured to POST `/webhooks/voice` to - used as the authoritative
  signed-URL basis, deliberately never derived from a possibly-spoofed
  request header).
- Without `TWILIO_AUTH_TOKEN`: `POST /webhooks/voice` fails closed (503).
- Optional: `VOICE_MAX_CALL_DURATION_SECONDS`, `VOICE_RECORDING_ENABLED`,
  `VOICE_STT_LANGUAGE`, `VOICE_STT_MODEL`, `VOICE_TTS_VOICE`.

## Web Research (Brave Search) - `tools/web`

- `BRAVE_SEARCH_API_KEY` - genuinely OPTIONAL: nothing else in the system
  requires it. Without it, research/BI features that would use live web
  data degrade gracefully (no crash) rather than blocking.
- Optional tuning: `WEB_SEARCH_TIMEOUT_MS`, `WEB_FETCH_MAX_BYTES`,
  `WEB_FETCH_MAX_REDIRECTS`, `WEB_FETCH_TIMEOUT_MS`.

## Browser Automation (Playwright) - `tools/browser`

- No credential env var. Playwright's Chromium binary must be installed
  (`npx playwright install --with-deps chromium` - the Dockerfile does this
  in the container build; run it manually for a bare-metal deploy).
- `core/business/browserPolicy.ts`'s financial hard-block
  (`isFinancialHardBlock()`) applies unconditionally and is not
  configurable by any env var - see that file's own header comment.

## Session / auth - `core/auth`

- `SESSION_TTL_HOURS` (default 168 = 7 days).
- `OWNER_EMAIL`, `OWNER_PASSWORD` - used ONLY by `npm run seed:owner`, never
  read by any HTTP endpoint.

## Deployment/process env vars (Phase 12, new)

- `FORCE_HTTPS` (default unset/false) - when `true`, rejects any request
  whose `X-Forwarded-Proto` is not `https`. See
  `apps/api/src/middleware/enforceHttps.ts`.
- `TRUST_PROXY_HOPS` (default `0`) - how many reverse-proxy hops to trust
  for `X-Forwarded-*` headers (`req.ip`, `req.secure`). Set to `1` behind a
  single reverse proxy (nginx/Caddy/most PaaS load balancers). Leave at `0`
  if this process is directly internet-facing (not recommended) or purely
  local/dev.
- `DATABASE_URL` - already documented in `.env.example`; Phase 12 adds no
  new required value here, only the `docker-compose.yml` default
  (`file:/data/jarvis.db` inside the container volume).
