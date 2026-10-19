# Nebula — Implementation Plan

| Field | Value |
| --- | --- |
| Document | IMPLEMENTATION_PLAN.md |
| Status | **In progress** — M1–M4 core implemented and verified; routing, threads, group DMs, and (this cycle) first-party slash commands + incoming webhooks delivered and e2e-tested (see [FEATURE_MATRIX.md](./FEATURE_MATRIX.md) for what is verified vs not built) |
| Version | 0.1.0 |
| Last updated | 2026-10-19 |

> Status note: milestone exit criteria are objective gates; a milestone is not "done" until its criteria and the associated tests in [TEST_PLAN.md](./TEST_PLAN.md) pass. Tasks marked **Done** have passing tests; everything else below is planned.

---

## 1. Milestone overview

| # | Milestone | Theme | Primary outcome | Depends on |
| --- | --- | --- | --- | --- |
| M1 | Foundation, design system, DB, auth | Walk, talk, persist | A user can register, log in, and see an authenticated shell backed by real Postgres/Redis | — |
| M2 | Servers, channels, roles, permissions | Structure & authorization | Guilds, channels, categories, overwrites, roles, and a server-enforced permission engine | M1 |
| M3 | Messaging + realtime | Conversation | Real-time text with edit/delete/reply/react/pin/typing/read-state over Socket.IO | M2 |
| M4 | DMs, friends, reactions, attachments, search, notifications | Reach & richness | Friends/DMs/group DMs, uploads, search, unread/mention notifications | M3 |
| M5 | Voice / video | Presence in voice | Mesh WebRTC audio, camera, screen share, and signaling | M3 |
| M6 | Moderation, integrations, settings | Operate & extend | Kick/ban/timeout/audit, slash commands, webhooks, full settings | M4 (M2 for perms) |
| M7 | Hardening, perf, a11y, e2e, deploy | Production readiness | Security/authz test suite green, a11y pass, perf budgets, containers | M1–M6 |

**Critical path:** M1 → M2 → M3 → M4 → M6 → M7. M5 branches from M3 and can proceed in parallel with M4 if staffing allows.

---

## 2. M1 — Foundation, design system, DB, auth

### Scope
Turn the scaffold into a running monorepo: build/typecheck/test pipeline, config, structured logging, error envelope, database migrations, the identity/account/session model, and a minimal authenticated web shell with a design-token system.

### Deliverables
- Workspace wiring: `apps/server` (Fastify 5 + Socket.IO 4 skeleton), `apps/web` (Vite 6 + React 18 + Tailwind 3 + router), `packages/shared` (types, Zod schemas, errors, snowflake, permissions).
- `docker-compose up` brings up Postgres 16 (`55432`) + Redis 7 (`56379`); `npm run db:migrate` applies migrations; `npm run seed` inserts demo data.
- Config loader with Zod validation of every env var in `.env.example`; server refuses to boot on missing/weak `SESSION_SECRET` in prod.
- Structured logging (pino) with request ids + redaction list; `/healthz`, `/readyz`, `/metrics`.
- Error envelope + stable error codes; CSRF double-submit; per-route rate-limit middleware (Redis-backed) with headers.
- Snowflake ID service (BigInt, epoch 2026-01-01).
- Schema v1: `users`, `credentials`, `devices`, `sessions`.
- Auth endpoints: register, login, logout, session list/revoke, change password; scrypt hashing.
- Web: design tokens (color/type/spacing, original palette), app shell layout, register/login screens, authenticated empty state, theme toggle, i18n `t()` scaffolding.

### Exit criteria
- `npm run typecheck` and `npm run test` pass in CI on a clean checkout.
- Register → login → `/users/@me` returns the created user over real Postgres; cookies set with correct flags.
- S-01…S-08 auth/CSRF test cases pass.
- `/readyz` reflects DB/Redis/schema state and returns `503` when a dependency is down.
- Lighthouse on the login screen ≥ 90 performance; no `axe` critical violations.

### Dependencies
None (start). Blocks everything.

### Remaining work
Entire milestone. Includes fixing the known `packages/shared/src/permissions.ts` input-interface gap (`everyoneRoleId`) so the module compiles and can be unit-tested — tracked under **T2.1**.

---

## 3. M2 — Servers, channels, roles, permissions

### Scope
The structural core: guilds, members, invites, channels, categories, overwrites, roles, and the **server-enforced** permission engine used by every route and every future real-time fan-out.

### Deliverables
- Schema: `guilds`, `roles`, `guild_members`, `member_roles`, `guild_bans`, `channels`, `channel_overwrites`, `invites`, `audit_log_entries` (write path), `guild_emojis`.
- Permission engine wired into a reusable guard: base → `ADMINISTRATOR` → ordered overwrites → implicit denies → timeout. Hierarchy gating for role/member management. **[VERIFIED rules]**
- Category permission syncing (synced iff child overwrites equal parent's; editing a child de-syncs).
- REST: guild CRUD, member list, kick/ban/unban, nicknames, role CRUD + reorder, channel CRUD, overwrite edit/delete, invites create/accept/preview, default `@everyone` + default channels on guild create.
- Web: server rail, channel tree with categories, channel/category create + settings modals, role manager (drag reorder, permission toggles grouped), "Create server" and invite flows, channel-permission editor.
- Realtime (early): `GUILD_CREATE`, `CHANNEL_*`, `GUILD_ROLE_*`, `GUILD_MEMBER_*` via the gateway with room checks (stabilised in M3).

### Exit criteria
- The authorization table in [SECURITY_MODEL.md](./SECURITY_MODEL.md) §11.1 and §11.2 passes (horizontal + vertical escalation), including hierarchy and "cannot grant perms you lack".
- A private channel is omitted from `GET /guilds/{id}/channels` and returns `403` on direct access. **[VERIFIED]**
- Category syncing de-syncs correctly when a child overwrite changes.
- Permission unit tests cover: owner bypass, `ADMINISTRATOR`, overwrite order, implicit denies, timeout effect, and the 53-bit-span flags (bit 47 unused).

### Dependencies
M1 (auth identity, DB, shared module).

### Remaining work
Entire milestone. Note: category syncing, forum/stage channel types, and 2FA gating are the riskiest sub-items and may be split to "Should" if the slice slips.

---

## 4. M3 — Messaging + realtime

### Scope
Real-time text: message send/edit/delete/reply/react/pin/typing/read-state, plus the Redis Socket.IO adapter, room scoping, sequence/resume, and ordering/duplicate handling.

### Deliverables
- Schema: `messages`, `reactions`, `pins`, `read_states`, `notifications` (insert path), `attachments` (metadata only).
- REST: message list (cursor), send (nonce idempotency), edit, delete, bulk delete, reactions, pins, typing, ack, threads create/join/leave/archive.
- Gateway hardening: Redis adapter, rooms (`user:`, `guild:`, `channel:`), `READY`/`RESUME`, `seq` gap detection, backpressure/coalescing ([SYSTEM_ARCHITECTURE.md](./SYSTEM_ARCHITECTURE.md) §5).
- Web: message list (grouping, virtualization), composer, markdown renderer (sanitizing), reactions bar, pin panel, reply UI, typing indicator, unread divider + jump-to-message, thread panel.

### Exit criteria
- Two browser clients see identical ordering (snowflake ascending); reconnect neither loses nor duplicates messages.
- Idempotent send: two POSTs with the same `nonce` create one message.
- Implicit-deny and slowmode behaviors pass (`SLOWMODE_ACTIVE` with `retry_after`; `BYPASS_SLOWMODE` exempt).
- Realtime multi-client test (2+ sockets) passes; a `seq` gap triggers a successful resume.
- Permission denials never fan out a message event to unauthorized sockets.

### Dependencies
M2 (channels, permissions, gateway skeleton).

### Remaining work
Entire milestone. Resume-buffer bounds and partial-vs-full resync are open design points.

---

## 5. M4 — DMs, friends, reactions, attachments, search, notifications

### Scope
Reach features: relationships (friends/blocks), DM and group-DM channels, the full media pipeline, message search, and unread/mention notifications.

### Deliverables
- Schema: `friend_requests`, `friendships`, `blocks`, `dm_channels`, `dm_recipients`, `attachments` (full), `guild_storage_usage`, `notifications` (full).
- REST: relationships (send/accept/decline/cancel/block/unblock), DM create/list, group-DM recipients, attachments upload/download/delete, guild search, notification list/ack.
- Media: storage port (local disk + S3-compatible driver), magic-byte validation, dimension detection, quota, auth-gated download with `Content-Disposition`/`nosniff`.
- Web: friends list + add-friend, DM + group-DM creation, relationship actions, attachment upload with previews, image lightbox, search UI, unread/mention badges, notification center, notification settings.

### Exit criteria
- H-05, H-06, H-09 (DM/block horizontal cases) and U-01…U-05 (upload cases) pass.
- Blocking suppresses DMs and friend requests (A-blocks-B direction) and hides B's messages per the documented design rule.
- Attachment in a channel the caller can't view returns `403`; quota enforcement returns `413 QUOTA_EXCEEDED`.
- Search respects `READ_MESSAGE_HISTORY` and returns only readable channels' messages.

### Dependencies
M3 (realtime dispatch, messages).

### Remaining work
Entire milestone. Thumbnails/thumbhash are optional and may slip. Search operator parity is explicitly not claimed.

---

## 6. M5 — Voice / video

### Scope
Mesh WebRTC for small calls: join/leave, audio, camera, screen share, mute/deafen (self + server), and Socket.IO signaling.

### Deliverables
- Schema: `voice_states`.
- Realtime: `VOICE_STATE_UPDATE` (join/leave/mute/deafen/move), `VOICE_SIGNAL` relay (offer/answer/ICE), room scoping to the voice channel.
- Web: voice channel UI (participant tiles), `getUserMedia` audio, `getDisplayMedia` screen share, camera toggle, mute/deafen controls, device selection, graceful "voice unavailable" state when media is blocked.
- Server mute/deafen/move endpoints gated by `MUTE_MEMBERS`/`DEAFEN_MEMBERS`/`MOVE_MEMBERS`.

### Exit criteria
- In a browser with fake media devices (`--use-fake-device-for-media-stream`), two clients join the same channel, exchange offer/answer/ICE, and reach `connectionState === "connected"` with an audio track present.
- When media infra is unavailable (headless CI without fake devices), the **signaling-only** path is verified: join/leave state, signal relay addressing, and permission checks all pass, and the media assertion is **skipped with an explicit reason** (never faked as passed).
- Server mute/deafen/move enforced and broadcast.

### Dependencies
M3 (gateway, rooms). Parallelizable with M4.

### Remaining work
Entire milestone. SFU and E2E voice are explicitly out of scope (documented).

---

## 7. M6 — Moderation, integrations, settings

### Scope
Operational and extensibility features: moderation (kick/ban/timeout/audit/purge), first-party slash commands, incoming webhooks, and the full settings surface.

### Deliverables
- Schema: `webhooks` (+ delivery/idempotency tables), `webhook_bot_user`, `reports`, plus audit-log completeness. (There is no `applications`/`slash_commands` table — commands are a first-party server-side registry.)
- Moderation: timeout (`communication_disabled_until` + permission effect), ban/unban with reason, message purge, audit-log read API + UI, reports queue.
- Integrations: **first-party slash commands** (registry, argument parsing/validation, permission gate, idempotent invocation, ephemeral vs posted results) and **incoming webhooks** (create/rotate/disable/rename/test/delete, one-time token reveal, public delivery route, delivery history). Webhook auth is a **bearer URL token stored only as a SHA-256 hash** — **no HMAC signing**.
- Settings: user settings (appearance/notifications/voice/privacy/language), guild settings, channel settings, notification-level controls.

### Exit criteria
- Timeout permission effect verified (only `VIEW_CHANNEL`+`READ_MESSAGE_HISTORY`; owner/`ADMINISTRATOR` exempt). **[VERIFIED]**
- Every privileged action writes an audit entry with actor/target/action/reason; audit is append-only. **[VERIFIED: webhook create/update/delete = 50/51/52]**
- W-01…W-07 webhook cases pass (token auth, bound channel, disable/rotate/delete, idempotency, rate limit, secret non-exposure, no URL fetch); a valid call posts to the bound channel only. **[VERIFIED: integration + e2e]**
- Slash command invocation returns an ephemeral result or posts a message, gated by the command's permission (e.g. `/topic` needs `MANAGE_CHANNELS`). **[VERIFIED: integration + e2e]**

### Dependencies
M4 (realtime, notifications); permission pieces from M2.

### Status
**Built and tested** (integration + browser e2e). Remaining gaps: no third-party application/OAuth2 platform; no webhook HMAC signing; auto-mod limited/deferred. See [FEATURE_MATRIX.md](./FEATURE_MATRIX.md).

---

## 8. M7 — Hardening, performance, accessibility, e2e, deploy

### Scope
Make the slice production-credible: complete the security/authorization test suite, meet performance budgets, pass accessibility checks, wire the 12 end-to-end journeys, and ship containers.

### Deliverables
- CI matrix: lint, typecheck, unit, integration (ephemeral PG/Redis), e2e (Playwright), security cases.
- Hardening pass against [SECURITY_MODEL.md](./SECURITY_MODEL.md): headers, CSP, upload edge cases, rate-limit tuning, redaction audit, refuse-to-boot checks.
- Performance: index verification (`EXPLAIN`), pagination caps, fan-out load harness against the §7.1 budgets in [PRODUCT_SPEC.md](./PRODUCT_SPEC.md).
- Accessibility: axe pass on primary screens, keyboard-only walkthrough, screen-reader smoke; fix critical/serious issues.
- Deployment: Dockerfiles (server, web), `docker-compose.prod.yml`, migrations-on-boot guard, backups doc, runbook.
- Documentation: README quickstart, ops guide, known-limitations page.

### Exit criteria
- All 12 required e2e journeys (TEST_PLAN §4) pass on a single-node deployment with real Postgres/Redis (voice journey may run in signaling-only mode with an explicit skip for the media assertion).
- The full authorization table passes; no critical/serious `axe` violations on primary screens.
- Performance budgets met in a local load check.
- `docker compose -f docker-compose.prod.yml up` serves the app end-to-end behind the proxy.
- Every [FEATURE_MATRIX.md](./FEATURE_MATRIX.md) row intended for the slice can be promoted from `Planned` to `Implemented-verified` with a linked test.

### Dependencies
M1–M6.

### Remaining work
Entire milestone.

---

## 9. Dependency-ordered task list

Tasks are ordered so each row can start only after the rows it depends on. IDs are stable for tracking. "M#" = milestone.

### Foundation (M1)
| ID | Task | Depends on |
| --- | --- | --- |
| T1.1 | Finalise workspace scripts, tsconfig references, lint/format, CI skeleton | — |
| T1.2 | Config loader + Zod env schema + refuse-to-boot checks | T1.1 |
| T1.3 | Structured logging, request ids, redaction list | T1.1 |
| T1.4 | Error envelope + error-code registry + Fastify error mapper | T1.3 |
| T1.5 | Migration runner + `schema_migrations` + down files | T1.1 |
| T1.6 | Snowflake ID service (BigInt) + tests | T1.1 |
| T1.7 | Redis client + namespacing helpers | T1.2 |
| T1.8 | `/healthz`, `/readyz`, `/metrics` | T1.5, T1.7 |
| T1.9 | Rate-limit middleware (Redis) + headers + 429 body | T1.7, T1.4 |
| T1.10 | CSRF double-submit middleware | T1.4 |
| T1.11 | Schema: users, credentials, devices, sessions | T1.5 |
| T1.12 | scrypt hashing util + timing-safe verify + tests | T1.1 |
| T1.13 | Auth routes: register/login/logout | T1.11, T1.12, T1.10 |
| T1.14 | Session list/revoke/revoke-all + password change | T1.13 |
| T1.15 | Web: design tokens + Tailwind theme (original palette) | T1.1 |
| T1.16 | Web: app shell + router + state stores (Zustand) | T1.15 |
| T1.17 | Web: register/login/logout UI + session restore | T1.13, T1.16 |
| T1.18 | Web: i18n `t()` scaffolding + Intl formatting helpers | T1.16 |
| T1.19 | Auth unit + integration tests; S-01…S-08 cases | T1.13, T1.14 |

### Structure & permissions (M2)
| ID | Task | Depends on |
| --- | --- | --- |
| T2.1 | Fix `packages/shared` permissions input interface (`everyoneRoleId`) + full unit tests | T1.1 |
| T2.2 | Schema: guilds, roles, guild_members, member_roles, guild_bans | T1.5 |
| T2.3 | Schema: channels, channel_overwrites, invites, guild_emojis | T2.2 |
| T2.4 | Permission guard (base → ADMIN → overwrites → implicit → timeout) | T2.1, T2.2, T2.3 |
| T2.5 | Hierarchy gating helpers (kick/ban/edit-role/edit-nick) | T2.4 |
| T2.6 | Guild CRUD + default `@everyone`/channels on create | T2.2, T2.4 |
| T2.7 | Channel/category CRUD + overwrite edit/delete | T2.3, T2.4 |
| T2.8 | Role CRUD + reorder + member role assign | T2.2, T2.5 |
| T2.9 | Invites (create/preview/accept) + member lifecycle | T2.6 |
| T2.10 | Category permission syncing | T2.7 |
| T2.11 | Audit-log write path | T2.2 |
| T2.12 | Gateway skeleton + `GUILD_CREATE`/`CHANNEL_*`/`GUILD_ROLE_*`/`GUILD_MEMBER_*` | T2.4, T1.3 |
| T2.13 | Web: server rail + channel tree + create/modals | T1.16, T2.6, T2.7 |
| T2.14 | Web: role manager + permission editor | T2.8 |
| T2.15 | Web: channel permission editor + invite UI | T2.7, T2.9 |
| T2.16 | Authorization test suite (H-01…H-10, V-01…V-18 subset) | T2.4…T2.9 |

### Messaging & realtime (M3)
| ID | Task | Depends on |
| --- | --- | --- |
| T3.1 | Schema: messages, reactions, pins, read_states | T2.3 |
| T3.2 | Message REST (list/send/edit/delete/bulk) + nonce dedup | T3.1, T2.4 |
| T3.3 | Reaction/pin/typing/ack REST | T3.1 |
| T3.4 | Threads schema + create/join/leave/archive | T3.1 | **Done** (4 integration tests) |
| T3.5 | Redis Socket.IO adapter + room model | T2.12, T1.7 |
| T3.6 | `READY`/`RESUME`/`seq` gap handling + backpressure | T3.5 |
| T3.7 | Dispatch scoping + room re-check on permission change | T3.5, T2.4 |
| T3.8 | Web: message list + grouping + virtualization | T2.13, T3.2 |
| T3.9 | Web: composer + sanitizing markdown renderer + mentions | T3.8 |
| T3.10 | Web: reactions, pins, reply, typing, unread divider | T3.8, T3.3 |
| T3.11 | Web: thread panel | T3.8, T3.4 | **Done** (browser spec: create/post/close/deep-link) |
| T3.12 | Realtime multi-client + reconnect/ordering tests | T3.6, T3.7 |

### Reach & richness (M4)
| ID | Task | Depends on |
| --- | --- | --- |
| T4.1 | Schema: friend_requests, friendships, blocks | T1.11 |
| T4.2 | Relationships REST + events | T4.1, T3.5 |
| T4.3 | DM/group-DM schema (`dm_channels`, `dm_recipients`) | T2.3 |
| T4.4 | DM/group-DM REST + recipient management | T4.3, T4.1 | **Done** (8 integration tests) |
| T4.5 | Storage port (local + S3 driver) + key generation | T1.2 |
| T4.6 | Upload pipeline: size, magic bytes, dims, quota | T4.5, T1.5 |
| T4.7 | Auth-gated download + `Content-Disposition`/`nosniff` | T4.5, T2.4 |
| T4.8 | Message attachment binding | T4.6, T3.2 |
| T4.9 | Search: `content_tsv`, GIN index, query endpoint | T3.1 |
| T4.10 | Notifications: unread/mention counts, settings, in-app | T3.1, T3.5 |
| T4.11 | Web: friends + DMs + group DMs | T4.2, T4.4, T2.13 | **Done** (browser spec: group-DM create/add/leave) |
| T4.12 | Web: upload UI + lightbox + search UI + notification center | T4.8, T4.9, T4.10 |
| T4.13 | DM/block + upload/authorization tests (H-05/06/09, U-01…U-05) | T4.4, T4.7 |

### Voice (M5)
| ID | Task | Depends on |
| --- | --- | --- |
| T5.1 | Schema: voice_states | T2.3 |
| T5.2 | `VOICE_STATE_UPDATE` join/leave/mute/move + scoping | T5.1, T3.5 |
| T5.3 | `VOICE_SIGNAL` relay (offer/answer/ICE) | T5.2 |
| T5.4 | Server mute/deafen/move endpoints | T5.2, T2.5 |
| T5.5 | Web: voice UI + `getUserMedia` audio | T5.2, T3.8 |
| T5.6 | Web: camera + screen share + device selection | T5.5 |
| T5.7 | Voice tests (fake-device connectivity + signaling-only fallback) | T5.3, T5.5 |

### Operate & extend (M6)
| ID | Task | Depends on |
| --- | --- | --- |
| T6.1 | Schema: webhooks (+ deliveries/idempotency), webhook bot user, reports | T2.3 |
| T6.2 | Timeout + ban/unban + purge + audit read API/UI | T2.4, T2.11, T3.2 |
| T6.3 | Reports queue API/UI | T6.1, T6.2 |
| T6.4 | Incoming webhooks: create/rotate/disable/delete + bearer-token delivery route (no HMAC) | T6.1, T2.4 |
| T6.5 | First-party slash commands: registry + invocation + permission gate | T6.1, T3.5 |
| T6.6 | User/guild/channel settings surfaces | T1.16, T4.10 |
| T6.7 | Moderation/webhook test cases (W-01…W-07, timeout effect) | T6.2, T6.4 |

### Harden & ship (M7)
| ID | Task | Depends on |
| --- | --- | --- |
| T7.1 | Full authorization suite wired into CI | all authz tasks |
| T7.2 | Security headers, CSP, redaction audit | T1.3, T1.10 |
| T7.3 | Performance: index verification + load harness | T3.2, T4.9 |
| T7.4 | Accessibility pass (axe + keyboard + SR) | T1.16, T3.8, T5.5 |
| T7.5 | The 12 e2e journeys in Playwright | M1–M6 |
| T7.6 | Dockerfiles + prod compose + migration guard | T1.5 |
| T7.7 | Runbook, README, known-limitations docs | T7.6 |
| T7.8 | Promote FEATURE_MATRIX rows with linked evidence | T7.5, T7.1 |

---

## 10. Sequencing notes & risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Permission correctness | High — gates every feature | Land T2.1/T2.4 early with exhaustive unit tests; treat the authz suite as a merge gate from M2 onward |
| Realtime ordering/reconnect | High — user-visible trust | Build T3.6/T3.12 before layering features; keep the resume window bounded |
| Socket.IO adapter/rooms | Medium | Stabilise in M3; load-test before M7 |
| Voice in CI | Medium — media unavailable | Verify signaling-only and skip media assertions with an explicit reason |
| Quota/permission races | Medium | Transactional quota counter; re-check permission at fan-out |
| Scope creep (forum/stage/threads/forwarding) | Medium | Marked "Should/Could"; can slip without blocking the slice |
| Email-dependent features | Low | Kept out of scope with a clear `MAIL_NOT_CONFIGURED` path |

---

## 11. Definition of done (per task)
1. Code merged with tests; `typecheck` + `lint` clean.
2. The relevant test from [TEST_PLAN.md](./TEST_PLAN.md) added and passing in CI (or an explicit, reviewed skip with reason for media).
3. [FEATURE_MATRIX.md](./FEATURE_MATRIX.md) status updated with a linked test — never `Implemented-verified` without a passing test.
4. Security implications reviewed against [SECURITY_MODEL.md](./SECURITY_MODEL.md); new resource paths have authorization cases.
5. Docs updated (API/DATABASE/ARCHITECTURE) when contracts change.

---

## 12. Uncertainty / open items
- **[DESIGN OPEN]** Whether M5 runs in parallel with M4 depends on team size; the plan supports either.
- **[DESIGN OPEN]** Resume-buffer bounds and rate-limit fail-open/closed policy need decisions before T3.6/T1.9 are considered final.
- **[DESIGN OPEN]** TOTP/2FA enrollment scope (flag/gating only vs full enrollment) affects M2 completion.
- **[UNKNOWN]** Real-world fan-out performance on a single node is untested; the M7 load harness will pin the budget.
