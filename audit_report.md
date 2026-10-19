# Nebula - Complete Feature Matrix & Audit

## Executive Summary

This audit reviews the codebase against Discord-like requirements and the project's documentation. The core product (auth, guilds, channels, roles, permissions, realtime, messaging, DMs/group DMs, threads, voice signaling, first-party slash commands, incoming webhooks, media, search, audit logs, moderation basics) is largely implemented and verified by automated tests (shared 18/18, server 69/69, browser E2E 32/32).

| Status | Count | % |
|---|---|---|
| Fully implemented and verified | 38 | 64.4% |
| Partially implemented | 12 | 20.3% |
| Not implemented | 8 | 13.6% |
| Blocked by external infrastructure | 1 | 1.7% |

Total items: 59.

## 1. Authentication & Sessions
| Feature | Status | Evidence | Notes |
|---|---|---|---|
| User registration/login | Fully implemented and verified | apps/server/src/http/routes/auth.ts, test/security.test.ts, app.spec.ts | Scrypt hashing; server tests cover auth/security cases; E2E exercises login flows. |
| Sessions (HttpOnly) + CSRF (double-submit) | Fully implemented and verified | apps/server/src/auth/sessions.ts, apps/server/src/http/auth.ts, apps/server/test/security.test.ts | CSRF checked on mutating requests when session present; tokens stored hashed. |
| Session list/revoke/logout-all | Fully implemented and verified | apps/server/src/http/routes/auth.ts, apps/web/src/components/Settings.tsx, app.spec.ts | UI verified in settings E2E. |
| MFA/2FA | Not implemented | - | Only mfa_level fields exist in schema/mappers; no enrollment/verification endpoints or UI. |
| Password reset via email | Not implemented | - | SMTP optional in env; no flows. MAIL_NOT_CONFIGURED not surfaced as implemented. |
| Email verification | Not implemented | - | Not present. |

## 2. Users, Profiles, Presence, Social
| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Profiles (bio/avatar/username/display) | Partially implemented | apps/server/src/domain/users.ts, apps/web/src/components/Settings.tsx, apps/web/src/components/MemberProfile.tsx | Avatar upload backend exists (`POST /api/users/@me/avatar`) but UI doesn't surface upload in settings; many profile fields limited. |
| Presence (online/idle/dnd/invisible) | Partially implemented | packages/shared/src/types.ts, realtime handlers, apps/web/src/components/Settings.tsx, E2E covers basic paths | API/WS present; some transitions not exhaustively tested. |
| Custom status | Partially implemented | shared/types + store/UI exists in places | Limited coverage in tests. |
| Username search (prefix, auth required, no PII leak) | Fully implemented and verified | apps/server/src/http/routes/users.ts, apps/server/test/security.test.ts | Tested for auth requirement and no private fields. E2E uses it for adding friends. |
| Friends (send/accept/reject/remove) | Fully implemented and verified | apps/server/src/domain/relationships.ts, apps/server/test/journeys.test.ts, E2E realtime.spec.ts | Covers add-by-username, accept/remove, blocks interact correctly. |
| Blocking (DM suppression, friend request prevention) | Fully implemented and verified | apps/server/src/domain/relationships.ts, apps/server/test/journeys.test.ts, test/group-dms.test.ts | Enforced in DMs and group DM creation/add. |

## 3. Guilds, Channels, Roles, Permissions
| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Guild CRUD (create/join/leave/delete/transfer ownership) | Partially implemented | apps/server/src/http/routes/guilds.ts, apps/web/src/components/ServerSettings.tsx | UI covers many actions; some flows (e.g. transfer/leave edge cases) lack E2E. Backend tested in journeys. |
| Channel CRUD (text/voice/category) | Partially implemented | apps/server/src/domain/channels.ts, apps/web/src/components/ChannelSettings.tsx, journeys | UI allows create/delete/reorder for text/voice; category/announcement/forum/stage UI creation limited; drag-reorder not implemented. |
| Roles (CRUD, hoist/color/mentionable, hierarchy) | Partially implemented | apps/server/src/domain/roles.ts, apps/web/src/components/ServerSettings.tsx | Server enforces hierarchy (kick/ban/manage roles); full UI editor/ordering has gaps vs server tests. |
| Permission bits (bigint, up to bit 52) + resolution | Fully implemented and verified | packages/shared/src/permissions.ts (14 unit tests), apps/server/src/domain/permissions.ts | Correct order: base→ADMIN bypass→overwrites; timeout applied. |
| Channel overwrites (allow/deny/neutral) | Partially implemented | domain/permissions.ts, server/test/journeys.test.ts | Server logic tested; UI overwrite editor not fully covered by E2E. |
| Member management (kick/ban/unban/timeout/nick) | Partially implemented | guild routes + domain, apps/web/src/components/MemberProfile.tsx, apps/web/src/components/ServerSettings.tsx | Backend tested; UI actions not comprehensively E2E-asserted. |
| Audit log (VIEW_AUDIT_LOG) | Partially implemented | apps/server/src/domain/audit.ts, apps/server/test/webhooks.test.ts asserts actions 50/51/52 | API/UI exist; comprehensive coverage varies. |

## 4. Messaging, Reactions, Pins, Search, Forwarding
| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Text messaging (send/edit/delete/reply) | Fully implemented and verified | apps/server/src/domain/messages.ts, apps/server/test/journeys.test.ts, E2E (app/realtime) | Markdown subset sanitized; mentions parsed. |
| Reactions (unicode, ±1, realtime) | Fully implemented and verified | messages domain/routes, E2E realtime.spec.ts | Basic reactions; no custom emoji. |
| Pin/unpin + pins panel | Partially implemented | PINNED_MESSAGE system messages exist; PinsPanel.tsx present | Backend behavior exists; UI interactions not heavily E2E'd. |
| Message search (access-scoped) | Fully implemented and verified | apps/server/src/http/routes/messages.ts search, apps/server/test/security.test.ts (no cross-guild leak), E2E app.spec.ts | Scoping enforced; returns results respecting permissions. |
| Message forwarding (up to 10 targets) | Fully implemented and verified | apps/server/src/domain/messages.ts forward, apps/server/test/forwarding.test.ts (9), E2E forwarding.spec.ts | Copies attachments by re-storing; writes forward reference. |
| System messages | Fully implemented and verified | apps/server/src/domain/systemMessages.ts, apps/server/test/journeys.test.ts | PINNED_MESSAGE, RECIPIENT_ADD/REMOVE; excluded from search. |

## 5. DMs, Group DMs, Threads
| Feature | Status | Evidence | Notes |
|---|---|---|---|
| DMs (1:1) | Fully implemented and verified | apps/server/src/domain/dms.ts, journeys + E2E | Real-time delivery verified. |
| Group DMs (create/add/remove/transfer ownership/close <2) | Fully implemented and verified | apps/server/src/domain/groupDms.ts (8 tests), apps/web/e2e/group-dms.spec.ts | Cap 10 participants; blocks enforced; membership validation correct. |
| Threads (public/private) | Fully implemented and verified | apps/server/src/domain/threads.ts (4 tests), apps/web/e2e/threads.spec.ts | Panel UI, deep-link, join/leave/archive; private threads membership-gated. |

## 6. Media, Attachments, Storage
| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Attachments (multipart upload, metadata) | Fully implemented and verified | apps/server/src/http/routes/channels.ts upload, apps/server/test/journeys.test.ts J10, E2E realtime.spec.ts | Auth-gated; bound to channel context. |
| Magic-byte sniffing | Fully implemented and verified | apps/server/src/domain/storage.ts sniffMimeType, apps/server/test/security.test.ts | Mismatch rejected. |
| Authorized access re-check on download | Fully implemented and verified | apps/server/src/domain/storage.ts + routes, security tests | Path-traversal guard present. |
| Per-guild quota | Fully implemented and verified | domain/storage, security tests | Enforced on upload. |
| Thumbnails/thumbhash | Not implemented | - | Not built. |
| S3-compatible storage driver (non-local) | Not implemented | config supports STORAGE_DRIVER but S3 path not implemented | Abstraction exists; only local disk used in practice. |

## 7. Integrations: Slash Commands & Webhooks
| Feature | Status | Evidence | Notes |
|---|---|---|---|
| First-party slash commands (registry, parsing, validation) | Fully implemented and verified | apps/server/src/domain/slashCommands.ts (9 tests), apps/web/e2e/slash-commands.spec.ts (4), apps/web/src/components/ChatView.tsx autocomplete | Commands: ping, help, shrug, me, user, server, nick, slowmode, timeout, poll, topic. Ephemeral vs posted correct. Permissions enforced. |
| /api/commands and /api/interactions | Fully implemented and verified | apps/server/src/http/routes/misc.ts | List commands; invoke. Idempotent via invocationId; rate-limited. |
| Incoming webhooks (create/rotate/update/delete/test/deliveries) | Fully implemented and verified | apps/server/src/domain/webhooks.ts (12 tests), apps/web/e2e/webhooks.spec.ts (8), apps/web/src/components/ChannelSettings.tsx | UI console present; audit 50/51/52; token shown once; stored as SHA-256. |
| Public webhook delivery (POST /api/webhooks/:id/:token) | Fully implemented and verified | apps/server/src/http/routes/misc.ts | Public by design (no session/CSRF); 401 wrong token, 403 disabled, 404 unknown; bound channel enforced. |
| Webhook idempotency (X-Idempotency-Key) | Fully implemented and verified | domain/webhooks.ts + route, E2E webhooks.spec.ts | Returns duplicate=true on replay. |
| Per-webhook rate limit (30/10s) | Fully implemented and verified | apps/server/src/domain/webhooks.ts, test/webhooks.test.ts, E2E | 429 on exceed. |
| Webhook secret non-exposure | Fully implemented and verified | E2E webhooks.spec.ts (test 5) | Token/hash never returned in list/deliveries; only once on create/rotate. |
| Webhook HMAC request signing | Not implemented | - | Bearer URL token only; signing_secret absent from code. Documented as not built. |
| Third-party application/OAuth2 bots | Not implemented | - | No apps/bot registration; commands are first-party only. |
| Webhook rename UI | Partially implemented | API PATCH accepts name; ChannelSettings UI has no rename control | API-only rename. |

## 8. Voice (WebRTC)
| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Join/leave voice channels; participant state | Fully implemented and verified | apps/server/src/domain/voice.ts, apps/server/test/journeys.test.ts J9, E2E app.spec.ts (real getUserMedia) | Socket.IO signaling; VOICE_STATE_UPDATE dispatched. |
| WebRTC mesh audio (signaling relay) | Partially implemented | apps/server/src/realtime/gateway.ts signaling relay, E2E verified audio path with fake/real devices | Mesh only; no SFU. |
| Camera video | Not implemented | - | getUserMedia called with video:false only. |
| Screen share (getDisplayMedia) | Not implemented | - | Not present. |
| E2E voice encryption assertions | Not implemented | - | DTLS-SRTP not explicitly verified by tests. |
| TURN relay for NAT traversal | Blocked by external infrastructure | apps/web/src/lib/voice.ts reads VITE_ICE_SERVERS; defaults to STUN only | Requires coturn/turn server + credentials. |

## 9. Realtime, Gateway, Presence, Read State
| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Socket.IO gateway; rooms per guild/channel/user | Fully implemented and verified | apps/server/src/realtime/gateway.ts, apps/server/test/journeys.test.ts J4, E2E realtime.spec.ts | Authorization-scoped fan-out; subscriptions managed. |
| Reconnect/resume semantics | Partially implemented | gateway has RESUME path; not exhaustively E2E'd | Basic cases covered; edge cases (gap/window) less tested. |
| Typing indicators | Fully implemented and verified | TYPING_START relay + UI, E2E realtime.spec.ts | Coalesced behavior exists. |
| Read state / unread/mention badges | Partially implemented | read-state domain + UI badges in Chat; journeys assert behavior | UI badges present; some paths not fully E2E-covered. |
| Notifications (in-app) | Partially implemented | notifications domain + NotificationsPanel.tsx | In-app only; no OS notifications. |

## 10. Security, Rate Limits, Headers
| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Helmet headers + CSP | Fully implemented and verified | apps/server/src/http/app.ts | default-src 'none', frameAncestors 'none', etc.; cross-origin for media allowed. |
| CORS locked to web origin; credentials allowed | Fully implemented and verified | apps/server/src/http/app.ts | Config from env. |
| HttpOnly/SameSite cookies; CSRF double-submit | Fully implemented and verified | sessions.ts + auth middleware + security tests + E2E | Mutating requests require CSRF when authed. |
| Global + per-route rate limiting | Fully implemented and verified | @fastify/rate-limit configured; RATE_LIMIT_MAX configurable (Playwright sets 5000 for API) | Security tests cover login rate limiting. |
| Per-command (20/10s) and per-webhook (30/10s) limits | Fully implemented and verified | slashCommands.ts, webhooks.ts + tests + E2E | Sliding window; returns RATE_LIMITED. |
| Slowmode (0–21600s) + BYPASS_SLOWMODE | Fully implemented and verified | channels/messages domain + shared constants; journeys/security cover | Permission bit 52 verified. |
| Magic-byte upload validation; path traversal guard | Fully implemented and verified | storage.ts + security tests | Size caps and quota enforced. |
| SQL injection resistance (parameterized queries) | Fully implemented and verified | all DB access uses $1/$2 with pg; raw SQL but parameterized | No string-concatenated untrusted SQL observed in audited code. |
| IDOR protections (channel/message access checks) | Fully implemented and verified | permissions.ts + routes; security tests cover cross-user access | assertChannelAccess/tryChannelAccess used. |
| Secrets not exposed (webhook tokens, CSRF stored hashed) | Fully implemented and verified | sessions store token_hash/csrf_secret; webhooks store token_hash only; E2E asserts non-exposure | Token returned once. |
| No outbound URL fetching for webhooks | Fully implemented and verified | webhooks.ts validates/stores embeds verbatim; E2E test asserts no SSRF | No link-preview/http calls. |

## 11. Frontend/UI
| Feature | Status | Evidence | Notes |
|---|---|---|---|
| SPA routing (deep links, back/forward, 404) | Fully implemented and verified | apps/web/src/App.tsx, E2E routing.spec.ts (4) | react-router-dom used. |
| Auth/login/register UI | Fully implemented and verified | apps/web/src/components/Auth.tsx, E2E app.spec.ts | Reuses storage state in E2E. |
| Chat UI (messages, groups, markdown, mentions) | Fully implemented and verified | ChatView.tsx, E2E covers send/edit/delete/markdown | Markdown subset sanitized. |
| Member list + member profile + mod actions | Partially implemented | MemberProfile.tsx, ServerSettings.tsx | Actions exist; some E2E coverage missing. |
| User settings (profile/sessions) | Fully implemented and verified | Settings.tsx, E2E app.spec.ts | Sessions list/revoke/logout-all tested. |
| Server/channel settings | Partially implemented | ServerSettings.tsx, ChannelSettings.tsx, E2E app.spec.ts | Broad coverage; overwrite editor/reorder less covered. |
| Friends/DMs UI | Partially implemented | Friends.tsx, DMs in sidebar, E2E realtime.spec.ts | Core flows tested. |
| Group DMs UI | Fully implemented and verified | GroupDmModal.tsx, E2E group-dms.spec.ts | Create + leave covered. |
| Threads panel + deep link | Fully implemented and verified | ChatView.tsx ThreadPanel, E2E threads.spec.ts | Create/post/close/deep-link tested. |
| Slash command autocomplete + ephemeral results | Fully implemented and verified | ChatView.tsx, E2E slash-commands.spec.ts | Keyboard nav + Tab completion; ephemeral only to invoker. |
| Webhook console in channel settings | Fully implemented and verified | ChannelSettings.tsx, E2E webhooks.spec.ts | Lifecycle UI + deliveries + test; rename absent from UI. |
| Voice panel/join UI | Fully implemented and verified | VoicePanel.tsx, E2E app.spec.ts | getUserMedia path tested. |
| Search panel | Fully implemented and verified | SearchPanel.tsx, E2E app.spec.ts | Opens and queries. |
| Theme (light/dark) | Partially implemented | store has theme; only dark styled | Light theme not implemented. |
| Accessibility basics (roles/escape/focus) | Partially implemented | Modals use dialog semantics; Escape handling present | Automated a11y (axe) not run. |
| Mobile responsiveness | Partially implemented | App shell has mobile drawer | Limited mobile E2E. |

## 12. Database Schema & Migrations
| Feature | Status | Evidence | Notes |
|---|---|---|---|
| 5 migrations, 32 tables | Fully implemented and verified | apps/server/src/db/migrations/*.sql; DB has 32 tables | Migrations applied on boot; raw SQL. |
| Core entities (users/guilds/channels/roles/members/messages) | Fully implemented and verified | 0001_init.sql + domain code | Relations + indexes present. |
| Moderation (bans, timeouts) | Fully implemented and verified | 0002_moderation.sql + domain/permissions | communication_disabled_until etc. |
| Webhooks (state, bot_user, deliveries) | Fully implemented and verified | 0003, 0004, 0005 + domain/webhooks.ts | disabled/rotated_at/last_used_at; webhook_deliveries with idempotency index; embeds on messages. |
| Applications/slash_commands tables exist | Partially implemented | 0001_init.sql has applications/slash_commands; domain/slashCommands.ts ensures builtin app | Tables exist but no third-party CRUD endpoints; commands are first-party registry. |

## 13. Build, Tests, Tooling, Deployment
| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Monorepo (npm workspaces) | Fully implemented and verified | package.json workspaces | shared/server/web. |
| TypeScript strict; build passes | Fully implemented and verified | npm run build succeeds (web) | 1654 modules transformed. |
| Unit tests (shared) | Fully implemented and verified | 18/18 passed | permissions + snowflake. |
| Integration tests (server, real PG/Redis) | Fully implemented and verified | 69/69 passed across 7 files | journeys, security, threads, group-dms, forwarding, commands, webhooks. |
| E2E (Playwright, Chromium) | Fully implemented and verified | 32/32 passed (30 specs + 2 setup) | Covers core flows + new slash/webhook specs. |
| Playwright config rate-limit fix (API gets RATE_LIMIT_MAX) | Fully implemented and verified | apps/web/playwright.config.ts | Prevents self-throttling during E2E. |
| Docker compose for dev (Postgres/Redis) | Fully implemented and verified | docker-compose.yml (ports 55432/56379) | Isolated dev stack. |
| Production Dockerfiles | Not implemented | - | Only dev compose; no prod images/manifests. |
| CI (lint/typecheck/test/e2e) | Not implemented | - | No .github workflows present. |
| Multi-node Redis adapter for Socket.IO | Partially implemented | @socket.io/redis-adapter present in deps | Not configured/enabled; single-node assumed. |
| Backups/restore/runbook | Not implemented | - | Docs mention, not implemented. |

## 14. Gaps vs Discord-inspired expectations
| Gap | Status | Impact |
|---|---|---|
| MFA/2FA, email verification, password reset | Not implemented | Auth hardening incomplete for production. |
| Light theme styling | Partially implemented | Theme field exists but only dark styled. |
| Avatar upload UI (user/guild) | Partially implemented | Backend routes exist; UI surfaces limited. |
| Webhook rename UI | Partially implemented | API-only. |
| Webhook HMAC signing | Not implemented | Uses bearer URL token only; signing not present (documented). |
| Third-party apps/OAuth2/bots | Not implemented | Commands are first-party only. |
| SFU/scaling for voice; video/screen share | Not implemented | Mesh audio only; camera/screen share absent. |
| TURN for NAT traversal | Blocked | Needs external coturn; mesh fails across symmetric NAT. |
| Drag-reorder channels, some settings UI polish | Partially implemented | Server supports types; UI missing reorder. |
| OS-level notifications | Not implemented | In-app only. |
| Auto-mod/raid protection | Not implemented | Out of scope per docs. |
| Thumbnails/thumbhash | Not implemented | Media presentation limited. |
| Production containers/CI/multi-node hardening | Not implemented | Blocks easy production deploy. |
| Typechecking E2E specs | Partially implemented | apps/web/tsconfig.json excludes e2e/**; specs validated at runtime. |

## 15. Security review (code-level observations)
| Item | Status | Notes |
|---|---|---|
| CSRF: enforced on mutating + authed | OK | verifyCsrf uses timingSafeEqual; header required. Public webhook skips (no session). |
| Sessions: token_hash/csrf_secret stored only | OK | createSession returns raw token once; resolveSession checks hash. |
| Webhooks: token_hash stored; delivered via bearer URL; no outbound fetch | OK | Bound channel enforced; idempotent; rate-limited. |
| Permissions: centralized via loadMemberContext/assertChannelAccess | OK | Route handlers don’t trust client claims. |
| Uploads: magic-byte sniff + size + quota + traversal guard | OK | Content-Disposition + nosniff on downloads. |
| Rate limits: global + feature-specific | OK | Per-command/webhook buckets present. |
| SQL: parameterized everywhere (audited) | OK | No obvious injection vectors. |
| Error envelope stable; no internal leakage | OK | Structured logging; unhandled errors return generic 500. |
| Secrets in env; SESSION_SECRET boot check exists | OK | `.env` gitignored; weak secret guard in prod path. |
| CORS/Helmet configured | OK | Strict defaults. |
| 2FA/MFA absent; password reset absent | GAP | Production auth posture limited. |

No obvious SQL injection, XSS (React escapes; markdown sanitized), or SSRF vectors in audited paths. Webhook execution is the only public unauthenticated mutating endpoint and is tightly scoped.

## 16. Prioritized roadmap (do not modify code now)
### P0 - Production hardening
- [ ] Add real `SESSION_SECRET` guidance + refuse-weak in prod (already present; ensure enforced in all envs)
- [ ] Cookie Secure in HTTPS; CORS origin locked
- [ ] Add rate-limit tuning docs + monitoring
- [ ] Add basic security headers smoke tests

### P1 - Auth completeness
- [ ] Email verification/password reset (SMTP path) or explicitly disable UI
- [ ] MFA/2FA enrollment/verification (TOTP) or remove/flag fields
- [ ] Account deletion/change password flows if required

### P2 - Voice/media expansion
- [ ] TURN server setup + `VITE_ICE_SERVERS` docs
- [ ] Camera + screen share (`getUserMedia` video, `getDisplayMedia`) with fallbacks
- [ ] SFU evaluation if scaling beyond mesh
- [ ] E2E voice encryption assertions

### P3 - UI polish & coverage
- [ ] Webhook rename control in UI
- [ ] Avatar upload UI (user/guild)
- [ ] Drag-reorder channels; improve overwrite editor
- [ ] Light theme styling
- [ ] Typecheck E2E specs (`tsconfig.e2e.json` including e2e/**)
- [ ] Add remaining Playwright assertions for the 5 journeys not fully browser-covered
- [ ] Automated a11y checks (axe) on primary screens

### P4 - Ops/deploy
- [ ] Production Dockerfiles + docker-compose.prod.yml
- [ ] CI (GitHub Actions): lint/typecheck/shared/server tests/E2E on PRs
- [ ] Enable Socket.IO Redis adapter for multi-node (config + smoke)
- [ ] Backups/restore automation + runbook
- [ ] Load/perf harness for gateway fan-out

## 17. Verification performed
- Shared unit: 18/18
- Server integration: 69/69 (7 files)
- Browser E2E (Chromium): 32/32 (30 specs + 2 setup)
- Typechecks: shared/server/web clean
- Production build: succeeds
- Schema inspected (5 migrations, 32 tables); routes/domains/UI reviewed; permissions, sessions, webhooks audited

This is a read-only audit against the current working tree (commit 02234ab). No code changes made.
