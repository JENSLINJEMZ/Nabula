# Nebula — Feature Matrix

| Field | Value |
| --- | --- |
| Document | FEATURE_MATRIX.md |
| Status | **Reconciled** — reflects the code that exists in this repository today |
| Version | 0.1.0 |
| Last updated | 2026-10-19 |

> **Read this first.** This matrix is the single source of truth for feature status. It was written during planning as all-`Planned` and has now been reconciled against the running code and the passing test suites (see [FINAL_ACCEPTANCE_REPORT.md](./FINAL_ACCEPTANCE_REPORT.md) and [TEST_PLAN.md](./TEST_PLAN.md)). Every `Verified` cell is backed by a test or command that was actually run; every gap is stated explicitly rather than implied.

## Status legend

| Status | Meaning |
| --- | --- |
| `Verified` | Code exists and a unit/integration/e2e test (or build/health command) passes for it. |
| `Unverified` | Code exists and runs, but no dedicated automated test asserts it. |
| `Partial` | Partially implemented (e.g. dark theme only; local-disk storage only; a UI shows a reduced form). |
| `Not built` | Deliberately or not-yet built; not faked. |
| `Out of scope` | Excluded on purpose and documented. |
| `n/a` | Not applicable to that column. |

**Verification totals:** 119 automated tests pass — 18 shared unit, 69 server integration, 32 browser e2e specs (30 journeys + 2 auth-setup). All 12 required journeys pass integration-side; 8 also pass in-browser (login, realtime, edit/delete, friends, DM, voice, media, slash commands/webhooks).

---

## Feature matrix

| Feature | Area | Dependencies | Backend status | UI status | Test status | Limitations |
| --- | --- | --- | --- | --- | --- | --- |
| npm-workspaces monorepo (`apps/server`, `apps/web`, `packages/shared`) | Foundation | — | Verified | n/a | Verified (build) | ESM-only |
| TypeScript + ESM build pipeline (server tsx/tsc, web Vite) | Foundation | Monorepo | Verified | n/a | Verified (build) | No CJS interop guarantee |
| Env/config loading + Zod validation | Foundation | Monorepo | Verified | n/a | Unverified | Single-process env; no hot reload |
| Docker Compose dev stack (Postgres 16, Redis 7) | Foundation | — | Verified | n/a | Verified (used by tests) | Dev-grade; isolated ports 55432/56379 |
| Raw SQL migration runner (`pg`) | Foundation | Postgres | Verified | n/a | Verified (integration boot) | Forward-only; no down-migrations |
| Snowflake ID service (`BigInt`, 41/5/5/12) | Foundation | — | Verified | n/a | Verified (unit) | Monotonic per worker only |
| Shared domain types + Zod schemas | Foundation | `@nebula/shared` | Verified | Verified | Verified (typecheck) | Must stay in sync with API docs |
| Error envelope + stable error codes | Foundation | — | Verified | Verified | Verified (integration) | Nebula-specific codes |
| Structured logging + request IDs | Observability | — | Verified | n/a | Unverified | Content redaction by default |
| Metrics endpoint + health/readiness | Observability | — | Verified | n/a | Verified (`/api/health`) | No dashboards shipped |
| Rate limiting (per-route + global buckets) | Foundation | Redis | Verified | n/a | Verified (integration) | Nebula-defined limits |
| CI pipeline (lint, typecheck, unit, integration, e2e) | Foundation | All suites | Not built | n/a | n/a | No CI config committed; suites run locally |
| Permission bitfield constants (bits 0–52, bit 47 unused) | Permissions | — | Verified | n/a | Verified (unit) | — |
| Permission computation (base → ADMIN → overwrites) | Permissions | Bitfield | Verified | n/a | Verified (unit) | Matches documented order |
| Implicit permission rules (VIEW_CHANNEL/SEND_MESSAGES/CONNECT) | Permissions | Computation | Verified | n/a | Verified (unit) | — |
| Timed-out member permission effect | Permissions | Computation, moderation | Verified | Unverified | Verified (unit) | Owner/ADMIN exempt |
| Permission hierarchy (position-gated management) | Permissions | Roles | Verified | Verified | Verified (integration J6) | Applies to actions, not resolution |
| Category permission syncing | Permissions | Overwrites, categories | Unverified | Partial | Unverified | Overwrites implemented; auto-sync semantics not asserted |
| Register account | Auth | Users, credentials | Verified | Verified | Verified (integration + e2e) | No email verification (no mail infra) |
| Login / logout | Auth | Sessions | Verified | Verified | Verified (integration + e2e) | — |
| Server-side sessions (Postgres-backed, opaque cookie) | Auth | Redis/PG | Verified | Verified | Verified (integration + e2e) | Session store is DB |
| scrypt password hashing (N=2^15,r=8,p=1, per-user salt) | Auth | — | Verified | n/a | Verified (integration) | Memory-heavy; documented |
| CSRF double-submit protection | Auth | Sessions | Verified | n/a | Verified (integration) | Cookie+header pair required |
| Session/device list + revoke + "log out everywhere" | Auth | Sessions | Verified | Verified | Verified (integration + e2e) | Device naming approximated from UA |
| Change password | Auth | Sessions | Not built | Not built | n/a | No route, no UI |
| Email verification / password reset | Auth | SMTP | Out of scope | Not built | n/a | Returns `MAIL_NOT_CONFIGURED`; never simulated |
| Account deactivation/delete | Auth | Sessions, FK policies | Not built | Not built | n/a | Deletion policy documented only |
| Public user object + profile view | Users | — | Verified | Verified | Verified (integration + e2e) | Private fields omitted |
| Edit own profile (display name, about, accent) | Users | — | Verified | Verified | Unverified | — |
| Username rules + case-insensitive uniqueness | Users | — | Verified | Verified | Verified (integration) | 2–32 chars; reserved words blocked |
| Avatar/icon upload | Users/Media | Upload pipeline | Unverified | Not built | Unverified | Routes exist (`/api/users/@me/avatar`, `/api/guilds/:id/icon`); no UI |
| Presence (online/idle/dnd/invisible/offline) | Presence | Redis, gateway | Verified | Verified | Verified (integration) | Ephemeral; PG fallback |
| Custom status (text + emoji) | Presence | Presence | Verified | Verified | Unverified | ≤128 chars |
| Multi-session presence aggregation | Presence | Sessions | Unverified | n/a | Unverified | Online if any session online |
| Friend requests | Relationships | Users, events | Verified | Verified | Verified (integration J7 + e2e) | Username search implemented this cycle |
| Friendships (symmetric) | Relationships | Users | Verified | Verified | Verified (integration J7) | Removal is symmetric |
| Blocks (directional) | Relationships | Users, DM | Verified | Unverified | Verified (integration J11 + security) | Suppresses DMs/friend requests |
| Direct message channel (type 1) | DM | Relationships | Verified | Verified | Verified (integration J8 + e2e) | Membership-based |
| Group DM (type 3) | DM | DM | Verified | Verified | Verified (integration + e2e) | ≤10 participants; owner-managed removal; closes below 2 members |
| Create guild | Guilds | Auth, roles | Verified | Verified | Verified (integration J2) | Creates @everyone + defaults |
| Guild settings (name/description) | Guilds | Guilds | Verified | Verified | Unverified | Gated by `MANAGE_GUILD` |
| Delete guild | Guilds | Guilds | Verified | Verified | Unverified | Owner-only |
| Guild member list (online/offline, hoisted roles) | Guilds | Presence, roles | Verified | Verified | Verified (e2e) | Not paginated yet |
| Join/leave guild | Guilds | Invites | Verified | Verified | Verified (integration J2/J3) | — |
| Kick / ban / unban | Moderation | Permissions, audit | Verified | Verified | Verified (integration J12 + security) | Hierarchy-checked |
| Nicknames (self + others) | Guilds | Permissions | Verified | Verified | Unverified | `CHANGE_NICKNAME`/`MANAGE_NICKNAMES` |
| Invites (code, max_age, max_uses, temporary) | Invites | Guilds, channels | Verified | Verified | Verified (integration J2/J3 + security) | Use limits enforced |
| Text channels (type 0) | Channels | Guilds | Verified | Verified | Verified (integration J3 + e2e) | Name 1–100 |
| Voice channels (type 2) | Channels | Voice | Verified | Verified | Verified (integration J9 + e2e) | bitrate/user_limit |
| Categories (type 4) | Channels | Guilds | Verified | Verified | Unverified | ≤50 children |
| Announcement channels (type 5) | Channels | Channels | Verified (server accepts type) | Not built | Unverified | No creation UI; no crosspost |
| Forum channels (type 15) | Channels | Threads | Verified (server accepts type) | Not built | Unverified | No creation UI; no tags/sort |
| Stage channels (type 13) | Channels | Voice | Verified (voice path) | Partial | Unverified | Treated as voice; no stage UI |
| Threads (public 11 / private 12) | Channels | Channels | Verified | Verified | Verified (integration + e2e) | Panel UI; private threads membership-gated |
| Channel settings (topic/nsfw/slowmode/parent) | Channels | Permissions | Verified | Verified | Verified (e2e) | Topic ≤1024 |
| Permission overwrites (role/member) | Channels/Permissions | Roles | Verified | Verified | Verified (integration J6 + security) | `{targetId,type,allow,deny}` |
| Channel reorder / positions | Channels | Channels | Not built | Not built | n/a | No drag-reorder / position edit |
| Slowmode enforcement | Messaging | Channels, Redis | Verified | Verified | Unverified | `BYPASS_SLOWMODE` exempts |
| Role CRUD | Roles | Guilds | Verified | Verified | Verified (integration J3/J6) | `MANAGE_ROLES` |
| Role ordering + hierarchy gating | Roles | Roles | Verified | Verified | Verified (integration J6) | Cannot manage roles above your highest |
| Member role assignment/removal | Roles | Roles, members | Verified | Verified | Verified (integration J3) | Cannot grant perms you lack |
| Role appearance (color/hoist/mentionable) | Roles | Roles | Verified | Verified | Unverified | Hoisted roles group the member list |
| Guild-wide 2FA-required permission gating | Roles | Sessions | Not built | Not built | n/a | `mfaEnabled` is always false; no enrollment |
| Send message | Messaging | Channels, snowflake | Verified | Verified | Verified (integration J4 + e2e) | ≤2000 chars |
| Edit / delete message | Messaging | Messaging | Verified | Verified | Verified (integration J5 + e2e) | Author-or-manage; IDOR-tested |
| Reply | Messaging | Messaging | Verified | Verified | Verified (integration J5) | `message_reference` |
| Reactions (unicode) | Messaging | Messaging | Verified | Verified | Verified (integration J5 + e2e) | Realtime ±1 delta |
| Pins | Messaging | Permissions | Verified | Verified | Verified (integration J5) | `PIN_MESSAGES` |
| Typing indicator | Messaging | Gateway | Verified | Verified | Verified (e2e) | 10 s TTL; coalesced |
| Read state + unread/mention counts | Messaging | Redis/PG | Verified | Verified | Verified (integration) | Badges rendered; ack route |
| Mention parsing (`<@>`,`<@&>`,`<#>`,`@everyone/here`) | Messaging | Permissions | Verified | Verified | Verified (unit + integration) | `@everyone/here` gated |
| Markdown subset + sanitisation | Messaging | — | Verified | Verified | Verified (e2e) | Safe renderer; no raw HTML |
| Message search (guild/DMs) | Search | Postgres | Verified | Verified | Verified (security scope + e2e) | Access-scoped; index not tuned |
| Message forwarding (snapshot) | Messaging | Messaging | Verified | Verified | Verified (integration + e2e) | Copies to up to 10 targets; forward reference (cross-channel) |
| System messages (join/pin/rename/call) | Messaging | Messaging | Verified | Verified | Verified (integration + codepaths) | PINNED_MESSAGE, RECIPIENT_ADD, RECIPIENT_REMOVE created server-side |
| Message grouping + jump-to-message | Messaging UI | Web | Verified | Verified | Verified (e2e) | Client-side grouping + day dividers |
| Message nonce dedup | Messaging | Messaging | Verified | n/a | Unverified | Idempotent send |
| Upload endpoint (multipart) | Media | Storage | Verified | Verified | Verified (integration J10 + e2e) | ≤25 MiB default |
| Upload validation (magic bytes + allowlist) | Media/Security | Storage | Verified | n/a | Verified (security) | Rejects content-type/magic mismatch |
| Image/video dimension detection | Media | Storage | Not built | n/a | n/a | — |
| Auth-gated attachment download | Media/Security | Permissions | Verified | Verified | Verified (integration J10 + security) | Re-checks channel access on GET |
| Storage driver abstraction | Media | — | Partial | n/a | Unverified | Local disk implemented; S3 documented only |
| Per-guild storage quota | Media | Storage | Verified | n/a | Unverified | Default 1 GiB (env) |
| `Content-Disposition` + `nosniff` serving | Media/Security | Storage | Verified | n/a | Unverified | No inline SVG/HTML |
| Thumbnails / thumbhash | Media | Image lib | Not built | Not built | n/a | — |
| In-app notifications (mentions/DMs) | Notifications | Presence | Verified | Verified | Unverified | In-app only (not OS-level) |
| Per-channel mute + notification overrides | Notifications | Channels | Not built | Not built | n/a | — |
| Push notifications | Notifications | Push infra | Out of scope | n/a | n/a | — |
| Audit log | Moderation | Permissions | Verified | Verified | Verified (integration J12) | `VIEW_AUDIT_LOG` |
| Message purge (bulk delete) | Moderation | Permissions | Verified (route) | Not built | Unverified | `/messages/bulk-delete`; no UI |
| Timeout (communication disabled) | Moderation | Permissions | Verified | Verified | Unverified | Duration-bounded |
| Reports | Moderation | Moderation | Verified (basic) | Not built | Unverified | Basic queue only |
| Auto-mod rules | Moderation | Messaging | Out of scope | Not built | n/a | — |
| Raid detection / incident alert mode | Moderation | — | Out of scope | n/a | n/a | — |
| Slash commands (first-party) | Integrations | Commands | Verified | Verified | Verified (integration + e2e) | `/api/commands`, `/api/interactions`; autocomplete + ephemeral results UI; `/ping /help /shrug /me /user /server /nick /slowmode /timeout /poll /topic` |
| Incoming webhooks | Integrations | Channels | Verified | Verified | Verified (integration + e2e) | Create/rotate/disable/rename/test/delete + one-time token reveal UI; delivery `POST /api/webhooks/:id/:token`; delivery history |
| Webhook request signing (HMAC-SHA256) | Integrations/Security | Webhooks | Not built | n/a | n/a | Bearer URL token only; no request signature (documented, not faked) |
| Third-party bots / OAuth2 apps | Integrations | — | Out of scope | n/a | n/a | — |
| Voice join/leave + participant state | Voice | Channels, gateway | Verified | Verified | Verified (integration J9 + e2e) | `VOICE_STATE_UPDATE` |
| Mesh WebRTC audio (getUserMedia) | Voice | Signaling | Verified | Verified | Verified (e2e) | **Audio only**; cap ~8 |
| Camera video | Voice | Signaling | Not built | Not built | n/a | `getUserMedia({video:false})` |
| Screen share (getDisplayMedia) | Voice | Signaling | Not built | Not built | n/a | No capture code |
| Voice signaling relay (offer/answer/ICE) | Voice | Gateway | Verified | Verified | Verified (integration J9) | Scoped to channel |
| Self mute / deafen | Voice | Voice state | Verified | Verified | Unverified | — |
| Server mute / deafen / move | Voice | Permissions | Unverified | Not built | Unverified | Bits exist; no UI/coverage |
| SFU scaling (mediasoup/LiveKit) | Voice | Infra | Out of scope | n/a | n/a | Documented path only |
| Voice E2E encryption | Voice | Crypto | Out of scope | n/a | n/a | DTLS-SRTP in transit only |
| TURN relay for NAT traversal | Voice | coturn | Blocked | n/a | n/a | STUN-only; set `VITE_ICE_SERVERS` |
| Socket.IO gateway | Realtime | — | Verified | n/a | Verified (integration J4 + e2e) | REST writes, gateway dispatch |
| Redis adapter for horizontal fan-out | Realtime | Redis, gateway | Not built | n/a | n/a | Dep present (dev); multi-node not exercised |
| Event scoping/authorization per subscriber | Realtime/Security | Permissions | Verified | n/a | Verified (security search scope) | Never fan out hidden events |
| Reconnect + resume | Realtime | Redis/PG | Verified (reconnect) | Verified | Unverified | No gap replay buffer |
| Client subscription management (guild/channel) | Realtime | Gateway | Verified | n/a | Verified (e2e) | Auto-subscribe on connect; DM rooms joined on creation/add |
| Ordering + duplicate suppression | Realtime | Messaging | Verified | Verified | Verified (unit + e2e) | Snowflake order; id dedup |
| Design system + tokens (Tailwind) | Frontend | — | n/a | Verified | Verified (build) | Original palette; no Discord assets |
| App shell + responsive layout | Frontend | Design system | n/a | Verified | Verified (e2e) | Mobile drawer; breakpoints xs–xl |
| Dark/light theme | Frontend | Design system | n/a | Partial | Unverified | Dark only; light unimplemented |
| Client state (Zustand stores) | Frontend | Gateway | n/a | Verified | Verified (e2e) | Optimistic updates; last-view persistence |
| Routing (react-router-dom) | Frontend | Web | n/a | Verified | Verified (e2e) | URL is source of truth; deep links, history, 404 |
| Accessibility (WCAG 2.1 AA target) | Frontend | All UI | n/a | Partial | Unverified | Dialog roles/Escape/keyboard; no axe run |
| i18n readiness (t(), Intl) | Frontend | All UI | n/a | Not built | n/a | en-US only |
| Unit tests (`@nebula/shared`, server units) | Testing | — | n/a | n/a | Verified (18) | Vitest |
| Integration tests (server + real PG/Redis) | Testing | Compose | n/a | n/a | Verified (69) | Real Fastify + Socket.IO |
| End-to-end tests (Playwright) | Testing | Web+server | n/a | n/a | Verified (17) | +2 auth-setup tests; journey coverage in TEST_PLAN §9 |
| Realtime multi-client tests | Testing | Gateway | n/a | n/a | Verified (e2e) | Two Chromium contexts |
| Authorization/security tests | Testing | Permissions | n/a | n/a | Verified (14) | Horizontal + vertical cases |
| Voice tests | Testing | Voice | n/a | n/a | Verified (integration + e2e) | Signalling + fake-device join |
| Load/perf tests | Testing | Realtime | Not built | n/a | n/a | — |
| Deployment containers (server/web) | Ops | Build | Not built | Not built | n/a | Dev compose for PG/Redis only |
| Migrations + seed (dev fixtures) | Ops | Postgres | Verified | n/a | Verified (integration boot) | Seed = demo guild/users |

---

## Cross-cutting dependency order (summary)

```
Foundation (monorepo, config, IDs, errors, DB/Redis, logging)
   └── Auth & sessions ── Users/profiles ── Presence
          └── Guilds ── Members ── Roles ── Permissions ── Channels/overwrites/categories
                 └── Messaging (REST + gateway) ── Reactions/pins/typing/read-state/search
                        ├── DMs & relationships
                        ├── Attachments/media
                        └── Notifications
                               └── Moderation ── Integrations
                                      └── Voice/video (mesh audio)
                                             └── Hardening / a11y / perf / deploy
```

## Reconciliation summary

- **Verified end-to-end (server + browser):** auth/sessions, permissions, guilds/roles/channels/overwrites, text messaging (send/edit/delete/reply/react/pin/typing/search/markdown/mentions), friends/blocks, DMs, **group DMs with participant management**, **threads**, **client-side routing (deep links/history/404)**, **first-party slash commands (autocomplete/execute/ephemeral results/polls/topic)**, **incoming webhooks (lifecycle UI + delivery/security)**, media upload + authorized access, moderation, realtime, and **audio** voice.
- **Backend exists, no UI (labelled "Verified (routes) / Not built"):** message purge, avatar/icon upload.
- **Not built:** camera video, screen share, server mute/deafen/move UI, change password, account delete, channel reorder, webhook HMAC request signing, thumbnails, per-channel notification overrides, OS notifications, light theme, 2FA enrollment, CI config, production containers, load tests.
- **Blocked:** TURN (cross-NAT voice); mail infra (verification/reset); multi-node realtime (Redis adapter); TLS termination.
- **Out of scope (documented):** voice E2E encryption, SFU, push, auto-mod, raid detection, third-party bots/OAuth2, email verification/reset.

See [FINAL_ACCEPTANCE_REPORT.md](./FINAL_ACCEPTANCE_REPORT.md) for evidence and reproduction commands.
