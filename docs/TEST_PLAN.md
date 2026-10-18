# Nebula — Test Plan

| Field | Value |
| --- | --- |
| Document | TEST_PLAN.md |
| Status | **Reconciled** — the suites exist and pass; results recorded in §14 |
| Version | 0.1.0 |
| Last updated | 2026-10-17 |

> Status note: this plan was written before any code existed. It has now been **reconciled against the running implementation**: 56 automated tests exist and pass (18 unit, 27 integration, 11 browser e2e). Section §14 records the actual, executed results and the deviations from the plan. Anything not covered by a real run is called out there and in [FEATURE_MATRIX.md](./FEATURE_MATRIX.md); no result is cited as a pass unless it came from an actual run. Voice media assertions that cannot run are **skipped with a reason**, never reported as passing.

---

## 1. Strategy

Nebula uses a pragmatic test pyramid:

```
        ▲  E2E (Playwright)          ~10%  — 12 required journeys + realtime multi-client
       ███ Integration (server)      ~20%  — routes + gateways against real Postgres/Redis
     █████ Unit (shared + server)    ~70%  — pure logic: permissions, snowflake, schemas, use-cases
```

**Principles**
1. **Test behavior, not implementation.** Assert on HTTP responses, events, and DB state, not private functions.
2. **Real dependencies where they matter.** Integration tests run against a **real Postgres 16** and **real Redis 7**, never mocks, because the permission engine, SQL, and pub/sub are the risk.
3. **Determinism.** Time is injectable (`Clock` port); snowflake generation is seeded per test; IDs are asserted structurally (monotonic, string) not by literal value.
4. **Isolation.** Each integration run gets a fresh database (template clone or `CREATE DATABASE nebula_test_<n>`), migrated + seeded, and a Redis DB index namespaced per run.
5. **Never fake a pass.** Unavailable infrastructure (media devices) yields an explicit `skip` with reason; no `assert.ok(true)` placeholders.
6. **Security cases are first-class.** The authorization table in [SECURITY_MODEL.md](./SECURITY_MODEL.md) §11 is a required suite, not an afterthought.

---

## 2. Test boundaries

| Layer | Tool | Runs against | What it covers | What it must NOT cover |
| --- | --- | --- | --- | --- |
| **Unit** | Vitest | In-process, no I/O | `@nebula/shared` (permissions, snowflake, Zod, errors); server pure use-cases with in-memory ports | HTTP, sockets, SQL, DOM |
| **Integration** | Vitest + Fastify `inject` + real PG/Redis | Ephemeral Postgres 16 + Redis 7 | Routes, guards, repositories/SQL, gateway handlers, pub/sub fan-out, upload validation | Browser rendering, visual layout |
| **E2E** | Playwright | Built web + running server + real PG/Redis | Full user journeys, realtime between real browser contexts, accessibility | Deep logic already covered by unit/integration |

### 2.1 Unit test scope
- **Permissions:** all 52 flags and bit 47 unused; serialization to string; `computeBasePermissions`; `computeChannelPermissions` (overwrite order @everyone deny/allow → role deny/allow → member deny/allow); `ADMINISTRATOR` bypass; implicit denies; `applyTimeout`; hierarchy helpers. **[VERIFIED rules]**
- **Snowflake:** layout, monotonicity under sequence overflow, worker/process bits, string round-trip, epoch math.
- **Validation:** every Zod schema (username rules, message length, overwrite shapes, invite bounds).
- **Error registry:** code → HTTP mapping is exhaustive and stable.
- **Use-cases with in-memory ports:** e.g. block filtering, read-state math, nonce dedup decision.

### 2.2 Integration test scope
- Auth/session/CSRF flows; cookie flags.
- Permission enforcement on every route (positive + negative).
- Repository SQL correctness and index-usage sanity (`EXPLAIN` on the hot message query).
- Gateway: `READY`, room join/leave, dispatch scoping, `RESUME`, backpressure coalescing.
- Upload pipeline: magic bytes, size, dimensions, quota, download headers.
- Webhook signature verification.

### 2.3 E2E test scope
The 12 journeys (§4), realtime multi-client behavior, reconnection/duplicates, and accessibility smoke. E2E drives only the public UI/API; it does not reach into the DB except for seeding.

---

## 3. Test data & fixtures

- **Seed command** (`npm run seed`) creates deterministic fixtures: users `mara`/`dev`/`sam` with known passwords, a guild "Nebula Devs", roles (`@everyone`, `Moderator`), channels (`#general`, `General` voice, a private `#secret`), and a handful of messages.
- **Per-test isolation** uses unique usernames (suffixed) or per-run databases so parallel tests don't collide.
- **Clock/ID injection** makes timestamps and snowflakes reproducible.
- **Media fixtures:** tiny valid PNG/JPEG, an HTML file renamed `.png` (for magic-byte rejection), and a file just over `MAX_UPLOAD_BYTES`.

---

## 4. The 12 required end-to-end journeys

These are the **required** journeys, reproduced verbatim from the project brief. Each must be automated in Playwright (voice per §8). Status is **Planned** for all.

1. **register 2 users**
2. **create server + invite**
3. **join + create channels**
4. **real-time messaging between multiple clients**
5. **edit/delete/reply/react/search**
6. **roles + channel permission verification**
7. **friend requests**
8. **direct conversation**
9. **join voice channel + media connectivity when infra available**
10. **upload + authorized access of an attachment**
11. **block a user + verify restrictions**
12. **unauthorized users cannot access private channels or moderate**

### 4.1 Journey detail & assertions

| # | Journey | Key steps | Assertions | Suite | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | register 2 users | Register user A and user B via the UI | Both reach the authenticated empty state; `/users/@me` returns each identity; cookies are `HttpOnly`/`SameSite=Lax` | `e2e/auth` | Planned |
| 2 | create server + invite | A creates a server; generates an invite | Guild created with `@everyone` + default channels; invite code valid; B previews it | `e2e/guilds` | Planned |
| 3 | join + create channels | B accepts invite; A creates a category + text + voice channel | B is a member and sees the guild; new channels appear for B in realtime (`CHANNEL_CREATE`); ordering by position holds | `e2e/channels` | Planned |
| 4 | real-time messaging between multiple clients | Two browser contexts in `#general`; each sends messages | The other context receives `MESSAGE_CREATE` within the latency budget; snowflake order identical in both; no duplicates | `e2e/realtime` | Planned |
| 5 | edit/delete/reply/react/search | Edit a message, delete one, reply to one, add a reaction, run a search | `MESSAGE_UPDATE` shows `edited_timestamp`; deleted message disappears for both; reply references the original; reaction count/`me` correct; search returns the message to an authorized user only | `e2e/messages` | Planned |
| 6 | roles + channel permission verification | Create a role, assign it, deny `VIEW_CHANNEL` on a channel to a role/member | Denied user cannot see or fetch the channel/its messages (`403`); allowed user can; overwrite order honored | `e2e/permissions` | Planned |
| 7 | friend requests | A sends B a friend request; B accepts | `RELATIONSHIP_ADD` in both directions; friends list updates; blocked target gets `403 BLOCKED` | `e2e/friends` | Planned |
| 8 | direct conversation | A opens a DM with B and sends a message | DM channel created once (idempotent); B receives `MESSAGE_CREATE`; DMs ignore guild permissions | `e2e/dms` | Planned |
| 9 | join voice channel + media connectivity when infra available | A and B join the same voice channel | `VOICE_STATE_UPDATE` for both; signaling offer/answer/ICE relayed; with fake media devices both reach `connected`; otherwise the media assertion is **skipped with reason** | `e2e/voice` | Planned |
| 10 | upload + authorized access of an attachment | A uploads an image to `#general`; B downloads it; C (no access) tries | Upload returns metadata with dimensions; B's download succeeds with `Content-Disposition: attachment` + `nosniff`; C gets `403`; invalid file → `415`; oversize → `413` | `e2e/media` | Planned |
| 11 | block a user + verify restrictions | A blocks B | B can no longer DM A (`403 BLOCKED`) or send a friend request; A stops receiving B's presence/typing; blocked-message visibility rule applied | `e2e/blocks` | Planned |
| 12 | unauthorized users cannot access private channels or moderate | Non-member / unauthorized member attempts private channel access and moderation actions | `403`/omission for channel + messages + attachments; kick/ban/timeout/audit denied without permission; no state change; audit shows nothing for denied attempts | `e2e/authorization` | Planned |

> Journey 9 is the only journey whose full assertion depends on browser media support; the plan defines an explicit signaling-only mode (§8).

---

## 5. Realtime, reconnection, and ordering tests

| ID | Test | Assertion |
| --- | --- | --- |
| RT-01 | Two sockets in one channel receive a broadcast | Both receive the same `MESSAGE_CREATE` payload |
| RT-02 | Ordering under concurrent sends | Messages ordered by snowflake `id` ascending in every client; per-channel commit order preserved |
| RT-03 | Duplicate suppression | Two sends with the same `nonce` produce one message and one event |
| RT-04 | Reconnect without loss | Disconnect a socket, send while offline, reconnect → missed messages delivered (via `RESUME` or re-sync) |
| RT-05 | `seq` gap handling | Force a gap → client detects it and resumes; no silent holes |
| RT-06 | Resume buffer bound | Beyond the buffer window, a full scoped re-sync occurs instead of partial replay |
| RT-07 | Room re-check on permission change | Removing `VIEW_CHANNEL` stops delivery to that socket; `CHANNEL_DELETE`-style removal event sent **[DESIGN]** |
| RT-08 | Typing coalescing | Rapid typing yields at most one event per window per user |
| RT-09 | Backpressure | A slow consumer does not block others; ephemeral events coalesce/drop, message events never drop |
| RT-10 | Presence aggregation | Multiple sessions aggregate correctly to online; last disconnect → offline |
| RT-11 | Voice signal addressing | `VOICE_SIGNAL` is delivered only to the addressed participant, not the channel |

---

## 6. Security & authorization tests

These implement the table in [SECURITY_MODEL.md](./SECURITY_MODEL.md) §11 and are run at the **integration** layer (fast, deterministic) with a subset mirrored in E2E journey 12.

| Group | Cases | Layer |
| --- | --- | --- |
| Horizontal escalation | H-01…H-10 | Integration (+ E2E 12) |
| Vertical escalation | V-01…V-18 | Integration (+ E2E 12) |
| Session/CSRF/auth | S-01…S-08 | Integration |
| Upload/injection/webhook | U-01…U-05, I-01…I-02, W-01…W-03 | Integration (+ E2E 10) |

**Passing criteria:** every listed case returns the specified status/effect and **no side effects occur** (e.g. a denied `PATCH` leaves the row byte-identical; a denied moderation action creates no audit entry).

**Coverage rule:** every route that touches a resource must have at least one positive and one negative authorization test. This is enforced by a route inventory check in CI (fail if a route lacks a registered authz test).

---

## 7. Additional suites

| Suite | Purpose |
| --- | --- |
| **Permission property tests** | Fuzz random role/overwrite combinations and assert the engine matches a reference implementation of the documented order |
| **Regression** | Nonce dedup, deleted-message references, category sync, path traversal |
| **Performance/load** | Fan-out to N sockets in one channel; measure p95 event latency vs the [PRODUCT_SPEC.md](./PRODUCT_SPEC.md) §7.1 budget; DB query `EXPLAIN` checks |
| **Accessibility** | `axe-core` on primary screens; keyboard-only walkthrough; screen-reader smoke; fail on critical/serious |
| **Visual** (optional) | Screenshot snapshots for the design system; advisory only |
| **Migration** | Migrations apply on a clean DB and are idempotent under the runner; server refuses to boot on schema mismatch |

---

## 8. Voice testing when media infrastructure is absent

Reality: CI runners and headless browsers often have **no camera/microphone** and may block `getDisplayMedia`. The plan handles this explicitly.

1. **Preferred (media available):** launch Chromium with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`. Two browser contexts join the same voice channel; assert both reach `RTCPeerConnection.connectionState === "connected"` and that a remote audio track is present.
2. **Fallback (signaling-only):** always run the **signaling and state** assertions regardless of media:
   - `VOICE_STATE_UPDATE` join/leave reaches the other participant.
   - `VOICE_SIGNAL` offer/answer/ICE is relayed to the correct target only (RT-11).
   - Permission checks: `CONNECT` required to join; `SPEAK` required to publish audio; server mute/deafen/move gated by the correct bit.
   - Media assertions are **skipped** with a machine-readable reason (e.g. `skip: media-unavailable`), never marked passed.
3. **CI policy:** the voice suite is reported as **passed-with-skips**; a run with skips is not evidence that media connectivity works. Media connectivity is only claimed from a run where the media assertions executed.
4. **Manual smoke (documented):** maintain a checklist for one real-browser, real-device smoke when a human is available; results recorded manually with environment details.

---

## 9. CI matrix

| Job | Depends | Command | Gate |
| --- | --- | --- | --- |
| `lint` | — | `npm run lint` *(script to be added)* | required |
| `typecheck` | — | `npm run typecheck` | required |
| `unit` | `typecheck` | `npm run test:unit` *(root aggregation)* | required |
| `integration` | `unit` + services | `npm run test:integration --workspace @nebula/server` | required |
| `e2e` | `integration` | `npm run test:e2e` | required |
| `a11y` | `e2e` | `npm run test:a11y --workspace @nebula/web` *(script to be added)* | required (critical/serious) |
| `voice` | `e2e` | `npm run test:voice --workspace @nebula/web` *(script to be added)* | advisory (skips allowed) |
| `load` | `integration` | `npm run test:load --workspace @nebula/server` *(script to be added)* | advisory/nightly |

---

## 10. Exact commands

> Some scripts already exist in the scaffold root `package.json` (`test`, `test:e2e`, `db:migrate`, `seed`, `typecheck`, `build`); others below are the **planned** interface to add in M1/M7. Commands are listed exactly as they will be run.

### 10.1 One-time setup
```bash
# from /home/jenslin/Jemz/nebula
npm install
docker compose up -d              # Postgres 16 on 127.0.0.1:55432, Redis 7 on 127.0.0.1:56379
cp .env.example .env              # then set SESSION_SECRET
npm run db:migrate                # apply raw SQL migrations
npm run seed                      # deterministic dev/e2e fixtures
```

### 10.2 Unit tests
```bash
# all unit tests (shared + server)
npm test

# shared package only (permissions, snowflake, schemas)
npm run test --workspace @nebula/shared

# server unit tests only
npm run test:unit --workspace @nebula/server          # planned script

# watch mode while developing
npm run test --workspace @nebula/shared -- --watch
```

### 10.3 Integration tests (real Postgres + Redis)
```bash
# ensure services are up
docker compose up -d

# run the server integration suite against an ephemeral test DB + Redis DB
npm run test:integration --workspace @nebula/server   # planned script
```

### 10.4 End-to-end tests (Playwright)
```bash
# install browsers once
npx playwright install --with-deps

# build web + start server, then run the 12 journeys
npm run test:e2e                                      # existing root script (@nebula/web)

# run a single journey file
npm run test:e2e -- e2e/messages.spec.ts

# headed for debugging
npm run test:e2e -- --headed

# with a trace for a failing journey
npm run test:e2e -- --trace on
```

### 10.5 Accessibility tests
```bash
npm run test:a11y --workspace @nebula/web             # planned script (axe + keyboard helpers)
```

### 10.6 Voice tests (media-aware, with signaling-only fallback)
```bash
# fake media devices (asserts real connectivity when supported)
npm run test:voice --workspace @nebula/web            # planned script

# force signaling-only mode (media assertions skipped with reason)
NEBULA_TEST_MEDIA=off npm run test:voice --workspace @nebula/web
```

### 10.7 Performance / load tests
```bash
npm run test:load --workspace @nebula/server          # planned script (fan-out + latency)
```

### 10.8 Static checks
```bash
npm run typecheck                                     # existing root script
npm run lint                                          # planned script
```

### 10.9 Full local gate (what CI runs)
```bash
docker compose up -d
npm install
npm run db:migrate
npm run typecheck
npm test
npm run test:integration --workspace @nebula/server
npm run test:e2e
npm run test:a11y --workspace @nebula/web
npm run test:voice --workspace @nebula/web            # skips allowed when media absent
```

---

## 11. Coverage & quality targets

| Metric | Target |
| --- | --- |
| `@nebula/shared` line coverage (unit) | ≥ 90% (permission engine must be ~100%) |
| Server unit + integration coverage | ≥ 75% lines; 100% of routes have an authz test |
| The 12 e2e journeys | 12/12 automated; voice may run signaling-only with explicit skips |
| Security cases (SECURITY_MODEL §11) | 100% pass |
| Flake rate | < 1% (realtime tests use deterministic clocks and explicit waits) |
| Test duration | unit < 30 s; integration < 3 min; e2e < 10 min |

---

## 12. Defect severity & triage

| Severity | Definition | Example |
| --- | --- | --- |
| S1 | Security/authorization bypass or data loss | A user reads a private channel; message loss on reconnect |
| S2 | Core flow broken | Cannot send a message; voice never connects in supported env |
| S3 | Degraded but usable | Reaction count wrong after reconnect; slow search |
| S4 | Cosmetic | Layout shift; incorrect icon |

S1/S2 block a milestone exit. S3/S4 are tracked but may ship with a documented limitation.

---

## 13. Uncertainty / open items
- **[UNKNOWN]** Actual Playwright support for `getDisplayMedia` varies by version/flag; the exact launch args are to be pinned in M5 and the skip policy adjusted accordingly.
- **[DESIGN OPEN]** Integration isolation strategy: per-run `CREATE DATABASE` vs template clone — to be decided for CI speed.
- **[DESIGN OPEN]** The route-inventory authz coverage check mechanism (build-time manifest vs runtime assertion) is not yet chosen.
- **[DESIGN OPEN]** Load-harness scale and pass thresholds beyond the §7.1 budgets.

---

## 14. Reconciled results (executed 2026-10-18)

### 14.1 Suite inventory & results

| Suite | Location | Tests | Result |
| --- | --- | --- | --- |
| Shared unit | `packages/shared/test/{permissions,snowflake}.test.ts` | 18 | **18/18 pass** |
| Server integration — journeys | `apps/server/test/journeys.test.ts` | 13 | **13/13 pass** |
| Server integration — security | `apps/server/test/security.test.ts` | 14 | **14/14 pass** |
| Server integration — threads | `apps/server/test/threads.test.ts` | 4 | **4/4 pass** |
| Server integration — group DMs | `apps/server/test/group-dms.test.ts` | 8 | **8/8 pass** |
| Browser end-to-end | `apps/web/e2e/*.spec.ts` | 17 | **17/17 pass** (+2 auth-setup) |
| **Total** | | **76** | **76/76 pass** |

Static gates (also executed): `npm run typecheck` (3 workspaces clean) and `npm run build` (production bundle produced).

### 14.2 Journey → test mapping

`J1`–`J12` in `apps/server/test/journeys.test.ts` cover the 12 required journeys exactly; `J5` also carries the edit/delete/reply/react/search assertions. Browser (Playwright) coverage exists for J1, J4, J5, J7, J8, J9, J10 (login, realtime multi-client, edit/delete, friend search, DM, voice join, attachment), plus UI flows for user/server/channel settings and search.

### 14.3 Security cases actually covered

Salted-scrypt storage; hardened session cookies (HttpOnly/SameSite=Lax); CSRF rejection; cross-user message IDOR; media path-traversal; upload magic-byte mismatch; search access-scoping (no cross-guild leak); invite use limits; indistinguishable login errors; self-ban prevention; login rate limiting; malformed-JSON 400; unauthenticated username search rejected; username search returns no private fields.

### 14.4 Deviations from the original plan (as built)

- **Integration isolation:** the plan proposed per-run `CREATE DATABASE`. Implemented as a single `nebula_test` database with `fileParallelism: false` / `singleFork: true`, so runs are serial and deterministic.
- **Accessibility:** the planned automated `axe` pass is **not built**; accessibility is limited to dialog roles, Escape handling, focus, and keyboard paths (verified manually).
- **Load/perf:** not built.
- **Voice:** tested with Chromium fake media devices (real `getUserMedia` join → "Voice connected") plus signalling relay in `J9`; camera/screen-share are not implemented, so no media assertions for them.
- **Browser journey coverage:** 7 of the 12 journeys currently have dedicated Playwright assertions (J1, J4, J5, J7, J8, J9, J10); the rest are server-verified. Closing this gap is the first test-side next step in the acceptance report.
- **New this cycle:** two security tests for the added `/api/users/search` endpoint (auth required; no private-field leakage); 4 integration tests for threads (creation, posting, private-thread membership enforcement, archive/join/leave); 8 integration tests for group DMs (creation with participant validation, block enforcement, adds/removals, 10-participant cap, ownership transfer, closure below two members, realtime fan-out with live channel-room joins); browser specs for client routing (deep links, back/forward, 404), threads (create/post/close/deep-link), and group DMs (create, realtime sidebar update, message delivery, leave-closes-group).

### 14.5 Commands

```bash
npm run typecheck       # 3 workspaces
npm test                # shared (18) + server (39)
npm run build           # web bundle
npm run test:e2e        # Playwright (17 + 2 auth setup) — dev stack + seeded DB must be running
```
