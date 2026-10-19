# Nebula

A Discord-inspired, real-time communication platform — **an independent implementation with an original identity**. Servers (guilds), text/voice channels, threads, roles & permissions, friends, DMs and group DMs, realtime messaging, attachments, moderation, client-side routing (deep links/history), first-party slash commands, incoming webhooks, and WebRTC voice.

> This is not affiliated with, endorsed by, or derived from Discord's proprietary code or assets. The information architecture (guilds → channels → messages) is reproduced; all code, tokens, copy, and branding are original.

## Status

Nebula is a working full-stack application, verified by automated tests. The honest, per-feature breakdown — including what is **not** built and what is **blocked** — lives in [`docs/FINAL_ACCEPTANCE_REPORT.md`](./docs/FINAL_ACCEPTANCE_REPORT.md). Read that before assuming a capability exists.

| Check | Result |
| --- | --- |
| Typecheck (3 workspaces) | clean |
| Unit + integration tests | 87/87 pass (18 unit + 69 integration) |
| Browser e2e (Playwright) | 32/32 pass (30 specs + 2 auth setup tests) |
| Production build | pass |
| Required journeys (12) verified server-side | 12/12 (7+ also in-browser; forwarding/journeys extended) |

## Stack

- **Server** — Node 22, Fastify 5, Socket.IO 4, PostgreSQL 16 (`pg`, raw SQL), Redis 7, Zod.
- **Web** — React 18, Vite 6, TypeScript, Tailwind 3, Zustand, socket.io-client, lucide-react.
- **Shared** — `packages/shared` — wire types, Zod schemas, permission bitfield + resolution (unit-tested).
- **Monorepo** — npm workspaces; ESM throughout; shared TypeScript consumed via path alias (no build step).

## Layout

```
nebula/
├── apps/
│   ├── server/        # Fastify API + Socket.IO gateway + raw-SQL migrations/seed
│   │   ├── src/{http,domain,realtime,db,auth}/…
│   │   └── test/{journeys,security,threads,group-dms,forwarding,commands,webhooks}.test.ts   # 69 integration tests
│   └── web/           # React SPA
│       ├── src/{components,lib}/…
│       ├── e2e/       # Playwright specs
│       └── playwright.config.ts
├── packages/shared/   # types, schemas, permissions (18 unit tests)
├── docs/              # product/architecture/API/DB/security/test/feature docs + acceptance report
├── docker-compose.yml # dev Postgres (55432) + Redis (56379)
└── .env.example
```

## Prerequisites

- Node **≥ 22.12**
- Docker (for the dev Postgres/Redis)
- A Chromium install for e2e (`npx playwright install chromium`)

## Getting started

```bash
# 1. Datastores on isolated ports (55432 / 56379) to avoid clashing with anything else
docker compose up -d

# 2. Dependencies
npm install

# 3. Config — copy the template and set a real SESSION_SECRET
#    (TOTP_ENCRYPTION_KEY is required and must differ from SESSION_SECRET;
#     set SMTP_URL — or SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS — only if you
#     have real mail credentials; otherwise dev/test capture .eml files)
cp .env.example apps/server/.env

# 4. Schema + demo data (a guild, three users, a few messages)
npm run db:migrate
npm run seed                       # logs the derived dev password

# 5. Run (two terminals)
npm run dev:server                 # API  -> http://localhost:4000
npm run dev:web                    # web  -> http://localhost:5173
```

Open <http://localhost:5173>. The Vite dev server proxies `/api`, `/socket.io`, and `/media` to the API, so cookies/CSRF work same-origin in development.

Seeded users: `nebula_alice` (guild owner), `nebula_bob`, `nebula_carol`. Their password is derived from `SESSION_SECRET` as `Seed-<sha256(SESSION_SECRET + ":seed")[0:20]>!9` (or set `SEED_PASSWORD`). Re-running `seed` is a no-op.

## Testing

```bash
npm run typecheck     # tsc --noEmit across all workspaces
npm test              # shared unit (18) + server integration (86)
npm run build         # production web bundle
npm run test:e2e      # Playwright (33 + 2 auth setup) — requires the dev stack + seeded DB running
```

The server integration suite boots the **real** Fastify + Socket.IO stack against an isolated `nebula_test` database — the same routing, auth, CSRF, and permission code that production runs.

> The E2E suite drives real Chromium against the running dev stack. It expects `RATE_LIMIT_MAX` headroom (the Playwright config starts the **API** server with `RATE_LIMIT_MAX=5000`); if you reuse a manually started API server, set that variable yourself or the global limiter will throttle the later specs.

## Slash commands & webhooks

- **Slash commands** — type `/` in a channel to autocomplete the built-in registry: `/ping /help /shrug /me /user /server /nick /slowmode /timeout /poll /topic`. Informational commands reply ephemerally (only you see them); `/shrug`, `/me` and `/poll` post to the channel. Permissions are enforced (`/timeout`, `/slowmode`, `/topic`, `/nick`), invalid arguments and missing permissions are reported inline, and invocations are rate-limited + idempotent. API: `GET /api/commands?guildId=…`, `POST /api/interactions`.
- **Incoming webhooks** — manage them in **Channel settings → Integrations**: create (the URL token is shown **once**), send a test, rotate (new token once), disable/enable, set an avatar, delete, and inspect delivery history. Deliver with `POST /api/webhooks/{webhookId}/{token}` and body `{"content": "…"}` (optional `X-Idempotency-Key`). The token is a **bearer credential stored only as a SHA-256 hash** — there is no HMAC request signing, delivery cannot be redirected to another channel, embeds are never fetched outbound (no SSRF), and each webhook is limited to 30 deliveries / 10 s. Webhook lifecycle changes are written to the guild audit log.

## Account security & email

Settings → **Security** covers the full account-security surface:

- **Change password** — requires the current password; signs out every *other* device.
- **Email verification** — request/resend from the Security tab; verify via the emailed `/verify-email?token=…` link.
- **Two-factor (TOTP)** — password re-auth to start, then QR **or** manual key; activation verifies a live code first and shows **10 recovery codes once**. Login then asks for a code (or a recovery code). Disable and regeneration both require password + factor.
- **Active sessions** — device list with creation/last-active/current, revoke one, or log out everywhere. A revoked session loses access over HTTP **and** is disconnected from Socket.IO in real time.

**Email delivery:** the server uses nodemailer when a relay is configured — either `SMTP_URL=smtp://user:pass@host:587`, or `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS` — plus optional `SMTP_FROM` (see `resolveSmtpSettings()` in `apps/server/src/config.ts` for the precedence). In development/test, and whenever no relay is configured outside production, each message is captured as an `.eml` file under `MAIL_DEV_DIR` (default `./data/mail`) — this is the local testing method used by the e2e suite, and tokens are never printed to logs or responses. The test and e2e suites blank every `SMTP_*` variable, so they never touch a real relay. In production with no relay configured the endpoints return `503 MAIL_NOT_CONFIGURED` instead of pretending a mail was sent.

**TOTP encryption:** secrets are encrypted at rest (AES-256-GCM) with `TOTP_ENCRYPTION_KEY`, which is required in every environment (≥32 chars) and must differ from `SESSION_SECRET`; startup validation refuses to boot otherwise.

## Documentation

| Doc | Contents |
| --- | --- |
| [PRODUCT_SPEC.md](./docs/PRODUCT_SPEC.md) | product brief, IA, user stories |
| [FEATURE_MATRIX.md](./docs/FEATURE_MATRIX.md) | **single source of truth** for feature status (verified / unverified / not built) |
| [SYSTEM_ARCHITECTURE.md](./docs/SYSTEM_ARCHITECTURE.md) | components, realtime, voice, scaling |
| [DATABASE_DESIGN.md](./docs/DATABASE_DESIGN.md) | schema, indexes, FKs, retention |
| [API_SPECIFICATION.md](./docs/API_SPECIFICATION.md) | REST + gateway contract |
| [SECURITY_MODEL.md](./docs/SECURITY_MODEL.md) | threat model, auth, permissions, media |
| [IMPLEMENTATION_PLAN.md](./docs/IMPLEMENTATION_PLAN.md) | milestones |
| [TEST_PLAN.md](./docs/TEST_PLAN.md) | the 12 required journeys + suites + results |
| [FINAL_ACCEPTANCE_REPORT.md](./docs/FINAL_ACCEPTANCE_REPORT.md) | **what was verified, unverified, blocked, and next** |

## License / attribution

Original work. No Discord assets, fonts, icons, or copy are used.
