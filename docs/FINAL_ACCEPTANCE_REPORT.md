# Nebula — Final Acceptance Report

| Field | Value |
| --- | --- |
| Document | FINAL_ACCEPTANCE_REPORT.md |
| Status | **Verified against running code** (see evidence below) |
| Version | 0.1.0 |
| Date | 2026-10-19 |
| Scope | `apps/server` (Fastify + Socket.IO + Postgres + Redis), `apps/web` (React + Vite), `packages/shared` |
| Verification basis | Every result below was produced by a command that was actually executed in this workspace. Nothing here is a projection. |

> **Honesty statement.** This report separates *verified* (a test or command was run and passed), *unverified* (code exists and runs but has no automated test), *backend-only* (server endpoint exists, no UI), and *not built* (documented gap, not faked). Where a capability is audio-only or incomplete, it is stated plainly rather than implied to be complete.

---

## 1. Build & static checks

| Check | Command | Result |
| --- | --- | --- |
| Typecheck (all workspaces) | `npm run typecheck` | **PASS** — `@nebula/shared`, `@nebula/server`, `@nebula/web` all clean |
| Production web build | `npm run build` | **PASS** — 1654 modules; `index-*.js` 392.76 kB (110.70 kB gzip), `index-*.css` 25.99 kB (5.44 kB gzip) |
| Backend start | `npm start` (cwd `apps/server`) | **PASS** — server ready, `GET /api/health` → `{"ok":true,"storage":"local"}` |
| Migrations | applied on boot | **PASS** — migrations: 5 (32 tables) |

---

## 2. Test results (all executed)

| Suite | File(s) | Count | Result |
| --- | --- | --- | --- |
| Shared unit tests | `packages/shared/test/{permissions,snowflake}.test.ts` | 18 | **18/18 pass** |
| Server integration (journeys) | `apps/server/test/journeys.test.ts` | 13 | **13/13 pass** |
| Server integration (security) | `apps/server/test/security.test.ts` | 14 | **14/14 pass** |
| Server integration (threads) | `apps/server/test/threads.test.ts` | 4 | **4/4 pass** |
| Server integration (group DMs) | `apps/server/test/group-dms.test.ts` | 8 | **8/8 pass** |
| Server integration (slash commands) | `apps/server/test/commands.test.ts` | 9 | **9/9 pass** |
| Server integration (webhooks) | `apps/server/test/webhooks.test.ts` | 12 | **12/12 pass** |
| Browser end-to-end (Playwright, real Chromium) | `apps/web/e2e/*.spec.ts` | 32 | **32/32 pass** (30 specs + 2 auth-setup) |
| **Total** | | **119** | **119/119 pass** |

Commands:

```bash
npm test                 # shared (18) + server (69)
npm run test:e2e         # Playwright (30 specs + 2 auth-setup) — needs the dev stack + seeded DB running
```

The e2e run also asserts **zero browser console errors and zero uncaught page errors** across the exercised journeys.

---

## 3. The 12 required end-to-end journeys

Each journey has an automated integration test (`J1`–`J12` in `apps/server/test/journeys.test.ts`). Seven additionally have a real-browser test. "Browser" means a Playwright test drove two/one real Chromium contexts against the live stack.

| # | Journey | Server integration | Browser e2e | Notes |
| --- | --- | --- | --- | --- |
| 1 | Register/login two users | ✅ J1 (+ security: scrypt, cookie flags, CSRF) | ✅ login + wrong-creds rejection | Real sessions + CSRF |
| 2 | Create server + invite | ✅ J2 | — (UI exists; not e2e-asserted) | Public invite preview verified |
| 3 | Join via invite + create channels | ✅ J3 | — (UI exists; not e2e-asserted) | Role-gated channel creation verified |
| 4 | Realtime multi-client messaging | ✅ J4 | ✅ two-context create/edit/delete + typing | Socket.IO delivery verified live |
| 5 | Edit/delete/reply/react/search | ✅ J5 | ✅ edit + delete; search panel opens | Reply/react/search have server tests |
| 6 | Roles + channel permission overwrites | ✅ J6 | — | Hierarchy + overwrite enforced |
| 7 | Friend requests | ✅ J7 | ✅ add-by-username search → outgoing request | Username search added this session |
| 8 | Direct messages | ✅ J8 | ✅ DM sent + rendered | Realtime delivery in J8 |
| 9 | Voice join + media | ✅ J9 (signalling relay) | ✅ real `getUserMedia` join → "Voice connected" | **Audio only** (see §6) |
| 10 | Attachment upload + authorized access | ✅ J10 | ✅ upload → media link rendered | Magic-byte + ACL re-check in J10/security |
| 11 | Block restrictions | ✅ J11 | — | DM/friend-request suppression enforced |
| 12 | Unauthorized access + moderation denied | ✅ J12 (+ security: IDOR, self-ban, search leak) | — | Horizontal + vertical escalation covered |

**All 12 journeys pass at the server/integration level. 7/12 additionally pass in a real browser.** The remaining browser gaps (invite-join, channel creation, role/overwrite editing, block UI, moderation denial UI) are implemented and covered server-side, but do not yet have dedicated Playwright assertions — see §9.

Additional browser-verified UI flows: user settings (profile/sessions), server settings (roles/members/invites/bans/audit tabs), channel settings modal, search panel, unread/mention badges, voice join/leave, **first-party slash command autocomplete and execution**, **webhook lifecycle console (create/rotate/disable/enable/test/delete)**.

---

## 4. Verified features (test or command exists and passed)

- **Foundation** — npm-workspaces monorepo; TS/ESM; Zod-validated env; raw-SQL migrations (5, 32 tables); snowflake IDs (unit-tested for order/monotonicity/uniqueness/validation); structured logging; `/api/health` + `/api/health/db`; per-route + global rate limiting (security-tested); stable error envelope.
- **Auth & sessions** — register/login/logout/logout-all; scrypt hashing (salted, verified by test); Postgres-backed sessions; HttpOnly + SameSite=Lax cookies (tested); CSRF double-submit (rejected-without-token tested); session list/revoke/logout-all (UI verified).
- **Permissions** — bitfield (bits 0–52), base resolution, ADMINISTRATOR collapse, role OR-ing, overwrite precedence, member-overwrite-last, implicit rules, timeout stripping — **14 unit tests**; hierarchy + overwrite enforcement integration-tested.
- **Users** — public profile projection (private fields omitted — tested), profile edit, presence (online/idle/dnd/invisible), custom status, **username search** (prefix; auth-required; no email leak — 2 new tests this session).
- **Relationships** — friend request accept/remove, directional blocks with DM/friend-request suppression (J7/J11), username-based discovery.
- **Group DMs** — create with up to 10 participants; add/remove participants (owner removes others, anyone leaves); ownership transfer on owner leave; group closes below 2 members; blocked pairs prevented on create and add; realtime `CHANNEL_CREATE/UPDATE/DELETE` fan-out with live channel-room joins so new participants receive messages without reconnecting (8 integration + 1 browser test).
- **Routing** — react-router: URL is the source of truth; deep links for guilds/channels/DMs/threads, browser back/forward, 404 view (4 browser tests).
- **Guilds & members** — create/delete, settings, transfer ownership, leave, member list (hoisted roles, online/offline groups), kick/ban/unban, nickname, timeout (duration-bounded), audit log (`VIEW_AUDIT_LOG`).
- **Channels** — text/voice/category types, settings (topic/nsfw/slowmode/user-limit/parent), permission overwrites (tri-state editor: neutral/allow/deny), per-channel computed permission string.
- **Threads** — public (11) and private (12) threads with panel UI: create from message or channel, post, join/leave, archive, deep-link; private threads are membership-gated server-side (4 integration + 1 browser test).
- **Roles** — CRUD, ordering + hierarchy gating, member assignment, appearance (color/hoist/mentionable), permission editor.
- **Messaging** — send/edit/delete (author-or-manage), reply, reactions (unicode; realtime ±1 delta), pins/unpins, typing indicator (realtime, verified), read-state + unread/mention generation and **channel + DM unread/mention badges**, mention parsing (`<@>`, `<@&>`, `<#>`, `@everyone`/`@here`, gated), **markdown subset with sanitisation** (no raw HTML), message grouping + day dividers + jump-to-message, nonce/id dedup.
- **Search** — cross-channel message search with access scoping (does not leak inaccessible guilds — tested), result jump.
- **Media** — multipart upload, magic-byte sniffing (mismatch rejected — tested), auth-gated download re-checking channel access (tested), path-traversal guard (tested), per-guild quota, `Content-Disposition` + `nosniff`.
- **Notifications** — in-app mention/DM/relationship notifications, unread counts, notification settings, ack.
- **Moderation** — kick/ban/timeout/reason, audit log, reports (`POST /api/reports`).
- **Realtime** — Socket.IO gateway, per-user/guild/channel rooms, authorization-scoped fan-out, presence, automatic channel subscription on connect, reconnect, ordering + dedup.
- **Voice** — join/leave + participant state, WebRTC **mesh audio** over signaling relay, self mute/deafen (browser join verified with fake media devices).
- **Frontend** — design tokens + component primitives; responsive app shell (guild rail, guild/Home sidebars, member list, mobile drawer); Zustand store with optimistic updates; last-view persistence; accessible modals (Escape/dialog roles); reduced-motion setting.
- **First-party slash commands** — autocomplete, argument coercion, permission checks (incl. `/topic` requires `MANAGE_CHANNELS`, `/timeout` requires `MODERATE_MEMBERS`, `/nick` requires `CHANGE_NICKNAME`), ephemeral informational results, commands that post (`/poll`, `/shrug`, `/me`), idempotent invocation (`invocationId`), rate limit per user (20/10s). **Integration + e2e verified.**
- **Incoming webhooks** — create (token shown once), rotate (new token once), update (name/avatar/disable), delete, test delivery (`/execute`), delivery history, per-webhook delivery rate limit (30/10s), idempotency via `X-Idempotency-Key`, bound-channel enforcement, disabled/unknown/invalid-token handling, audit logging (50/51/52), token stored as SHA-256 hash and never exposed in list/detail/delivery responses. **API + UI + integration + e2e verified.** No HMAC signing (bearer URL token only). No outbound URL fetching.

---

## 5. Unverified (code exists, runs, but no dedicated automated test)

These are implemented and were exercised manually/in-browser during development, but are **not** individually asserted by an automated test:

- Invite creation/revocation UI; channel create/delete/reorder UI; role create/edit UI; overwrite editor UI; ban list UI; audit-log rendering.
- Member-profile moderation actions from the UI (nickname/timeout/kick/ban/role assign) — backend is tested, UI is not.
- Notification center UI actions; pins panel; DM/friend list UI beyond the e2e flows.
- Presence transitions beyond the online path; custom-status rendering.
- Slash-command and webhook **backend endpoints** are now covered by integration + e2e tests; **UI exists** for autocomplete/ephemeral results and for webhook management (create/rotate/disable/enable/test/delete/deliveries). No third-party application/OAuth2 platform; webhook HMAC signing not built. No automatic test for the purge UI beyond server behavior.
- Storage driver abstraction is local-disk only; S3 path is documented, not implemented.

---

## 6. Not built (documented gaps — **not** faked)

The following are deliberately absent. Where the backend endpoint exists but has no frontend, that is stated.

| Capability | State |
| --- | --- |
| Camera video in voice | **Not built.** `getUserMedia({ audio: true, video: false })`. |
| Screen share (`getDisplayMedia`) | **Not built.** No capture code. |
| SFU scaling (mediasoup/LiveKit) | Not built (mesh only; documented scaling path). |
| Voice E2E encryption | Not built (in-transit DTLS-SRTP only). |
| Server mute/deafen/move from UI | Not built (no UI; `MUTE_MEMBERS` etc. exist in the bitfield). |
| Slash commands UI / webhook UI | **Built.** Autocomplete + ephemeral results; webhook console in channel settings (create/rotate/disable/enable/test/delete/deliveries). |
| Webhook request signing (HMAC) | **Not built.** Delivery authenticates with a bearer URL token (SHA-256 hashed); there is no `X-Nebula-Signature`/`signing_secret`. |
| Webhook rename UI | **API-only.** `PATCH /api/guilds/:id/webhooks/:wid` accepts `name`; the console only exposes create/rotate/disable/enable/avatar/test/delete. |
| Avatar / guild-icon upload UI | Not built (backend routes exist; UI states "avatar is generated"). |
| Change password / account delete | Not built (no routes, no UI). |
| Email verification / password reset | Out of scope (no SMTP); returns `MAIL_NOT_CONFIGURED`, never simulated. |
| Real 2FA enrollment | Not built — `mfaEnabled` is always `false` (no enrollment flow). |
| Light theme | Not built — the field exists but only the dark theme is styled. |
| Message forwarding | Built. POST /api/messages/:id/forward copies message (attachments re-stored) to up to 10 targets with forward reference; e2e + 9 integration tests. |
| System messages (join/pin/rename/call) | Built. PINNED_MESSAGE, RECIPIENT_ADD, RECIPIENT_REMOVE persisted; non-editable and excluded from search. |
| Announcement/forum/stage channel **creation UI** | Not built (server accepts the types; UI creates text/voice only). |
| Channel drag-reorder | Not built. |
| Thumbnails / thumbhash | Not built. |
| Per-channel notification overrides | Not built. |
| OS-level ("desktop") notifications | Not built — notifications are in-app only (no Web `Notification` API). |
| Auto-mod / raid detection | Out of scope (documented). |
| Third-party bots / OAuth2 apps | Out of scope. |
| Push notifications | Out of scope. |
| Load/perf tests | Not built. |
| i18n | Not built (en-US only). |
| Production container images (Dockerfiles) | Not built — only a dev compose for Postgres/Redis. |

---

## 7. Blocked (external infrastructure required)

| Item | Why blocked | Unblock |
| --- | --- | --- |
| Voice across NAT/firewall | Mesh audio uses STUN only by default; no TURN relay configured (`VITE_ICE_SERVERS` unset). Localhost/LAN works; symmetric NAT will fail. | Run coturn and set `VITE_ICE_SERVERS` with a `turn:` URL + credentials. |
| Email verification / password reset | No SMTP credentials / mail infra. | Set `SMTP_URL` and implement the flows. |
| Horizontal realtime fan-out at scale | `@socket.io/redis-adapter` is a devDependency and can be enabled, but multi-node was not exercised. | Enable the Redis adapter across nodes and load-test. |
| Production TLS termination | Assumes a reverse proxy in front. | Terminate TLS; set `COOKIE_SECURE=true`, `PUBLIC_WEB_ORIGIN=https://…`. |

---

## 8. Remaining security notes / hardening

- **Rotate `SESSION_SECRET`.** The dev default (`dev-only-session-secret-…`) is in `.env`; production must use ≥32 random bytes. The seed password is derived from it, so changing it changes the demo password.
- **`COOKIE_SECURE=false`** is correct for local HTTP; it must be `true` behind HTTPS.
- Downloaded media is served with `Content-Disposition` + `X-Content-Type-Options: nosniff` and never inline-executed; uploads are magic-byte validated and size-capped.
- CSRF is enforced via double-submit cookie + header; state-changing requests without it are rejected (tested).
- Rate limiting is enabled by default (login burst-limited — tested). No persistent account lockout exists beyond per-IP limits.
- Message search is access-scoped and was tested to not leak inaccessible guilds.
- No 2FA and no email verification means account takeover resistance relies on password strength + rate limiting only.
- Block enforcement suppresses DMs and friend requests; the message-visibility rule is a Nebula design choice (documented).
- Webhooks authenticate with a **bearer URL token** stored only as a SHA-256 hash; there is no request signing. Wrong/unknown token → `401`, disabled → `403`, deleted → `404`, destination cannot be redirected from the body, delivery idempotent per `X-Idempotency-Key`, limited to 30/10s, and no outbound URL is fetched (no SSRF). These are covered by integration + e2e tests. Treat the webhook URL as a secret.

---

## 9. Environment & setup

Requirements: **Node ≥ 22.12**, Docker (for Postgres/Redis), a Chromium for e2e.

```bash
# 1. Datastores (isolated ports 55432 / 56379)
docker compose up -d

# 2. Install
npm install

# 3. Configure
cp .env.example apps/server/.env      # then set a real SESSION_SECRET

# 4. Migrate + seed
npm run db:migrate
npm run seed                          # demo guild + users, prints the dev password

# 5. Run (two terminals)
npm run dev:server                    # API  -> http://localhost:4000
npm run dev:web                       # web  -> http://localhost:5173   (proxies /api, /socket.io, /media)
```

Key environment variables (see `.env.example`): `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `SESSION_TTL_DAYS`, `COOKIE_SECURE`, `STORAGE_DRIVER`, `STORAGE_LOCAL_DIR`, `MAX_UPLOAD_BYTES`, `STORAGE_QUOTA_BYTES_PER_GUILD`, `RATE_LIMIT_DISABLED`, optional `SMTP_URL`, and web-side `VITE_ICE_SERVERS`.

Seeded accounts (`nebula_alice` owner, `nebula_bob`, `nebula_carol`) share the derived password `Seed-<sha256(SESSION_SECRET + ":seed")[0:20]>!9`. Override with `SEED_PASSWORD=<≥10 chars>`.

---

## 10. Migrations & deployment

- **Migrations** are raw forward-only SQL applied by `npm run db:migrate` (idempotent; boot also applies them). 5 migrations → 32 tables. No automatic down-migrations; rollback is by restoring a snapshot.
- **Deployment today**: run the API process (`apps/server`) and serve the built SPA (`apps/web/dist`) behind a reverse proxy that terminates TLS; point `PUBLIC_WEB_ORIGIN` at the web origin and set `COOKIE_SECURE=true`.
- **Not provided**: production Dockerfiles, orchestrator manifests, multi-node wiring, backup/restore automation. `docker-compose.yml` is a **dev** datastore only.

---

## 11. Known limitations

- Voice is **audio-only mesh** (≤ ~8 participants by design) and needs TURN for real network conditions.
- No OS notifications; notifications are in-app.
- Only the dark theme is styled; the theme field is present but light is unimplemented.
- Message purge (`POST /api/channels/:id/messages/bulk-delete`) and avatar/icon upload have endpoints but no UI.
- Slash commands and webhooks **do** have UI + e2e coverage; webhook **rename** is API-only, and webhook HMAC request signing is not built.
- Snowflake "monotonic per worker only"; multi-process ID allocation assumes distinct worker ids.
- Search uses the DB's matching with access scoping; ranking/recent-index lag is not tuned.

---

## 12. Exact next steps (prioritized)

1. **Wire coturn + `VITE_ICE_SERVERS`** and re-test voice across NAT (closes the only *blocked* user-facing capability).
2. **Add Playwright assertions for the 5 remaining journeys** (invite join, channel create, role/overwrite edit, block UI, moderation-denied UI) to move 12/12 browser coverage.
3. **Decide on the remaining "backend-only" features** (avatar/icon upload UI) or explicitly mark them out of scope in `FEATURE_MATRIX.md`. Slash-command and webhook UI have been built and are now covered by e2e.
4. **Add camera video + screen share** (`getUserMedia({video})`, `getDisplayMedia`) with the documented unsupported-browser fallback.
5. **Typecheck the e2e specs** (add a `tsconfig.e2e.json` including `e2e/**` + Node types) so CI catches spec drift — the web `tsconfig.json` only includes `src/**`, so the new slash-command/webhook specs are currently only validated by Playwright's runtime.
6. **Production hardening**: real `SESSION_SECRET`, `COOKIE_SECURE=true`, TLS proxy, production Dockerfiles, and enable the Redis socket.io adapter for multi-node.
7. **Load/perf harness** for gateway fan-out and message throughput.

---

## 13. How to reproduce this report

```bash
docker compose up -d
npm install
cp .env.example apps/server/.env
npm run db:migrate && npm run seed
npm run typecheck          # 3 workspaces clean
npm test                   # shared 18 + server 69
npm run build              # web production bundle
# with the dev stack running (npm run dev:server & npm run dev:web):
npm run test:e2e           # Playwright — a setup project logs in as alice+bob once (2 logins)
                           # and reuses storage state, so the dev login rate limit (20/min)
                           # is not tripped by repeated runs.
                           # The config starts the API server with RATE_LIMIT_MAX=5000 so the
                           # global limiter does not throttle the later specs.
```

> **Reuse a running API server?** Export `RATE_LIMIT_MAX=5000` yourself before `npm run dev:server`; otherwise the API runs at the 600/min default and the webhook/command specs can hit `429`.

---

## 14. This cycle's additions (2026-10-19)

Two new browser suites were written against the existing slash-command and webhook implementations:

- **`apps/web/e2e/slash-commands.spec.ts`** (4 tests): autocomplete via keyboard navigation; execute + ephemeral result; invalid-argument + permission-denied responses; poll create/interaction + topic change (including an unauthorized topic attempt). Assertions use `data-testid` hooks (`command-result`, `message-embed`) and per-test isolation.
- **`apps/web/e2e/webhooks.spec.ts`** (8 tests): create → rotate → disable/enable → delete lifecycle (UI + API); authenticated delivery appearing **exactly once** with idempotency replay + realtime fan-out; invalid-secret rejection; revoked/disabled non-delivery; secret not present in any API response or server log; per-webhook rate limit → `429`; unauthorized management → `403`; SSRF/redirect attempt rejected. Public delivery is driven from an explicitly cookie-less request context; authenticated API assertions use `page.request` sharing the user's cookies + CSRF header. Per-test isolated channels are deleted in `finally`.

**Infra fix:** `apps/web/playwright.config.ts` had `RATE_LIMIT_MAX` attached to the **Vite** webServer entry; it now applies to the **API** server entry (`../server`), so the API no longer self-throttles at 600/min.

**Known gaps in this area:** webhook **rename** is API-only (no console control); there is **no HMAC request signing** (bearer URL token only); `apps/web/tsconfig.json` excludes `e2e/**`, so the new specs are not covered by `npm run typecheck`.
