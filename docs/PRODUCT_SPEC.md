# Nebula — Product Specification

| Field | Value |
| --- | --- |
| Document | PRODUCT_SPEC.md |
| Project | Nebula |
| Status | **Implemented (partial)** — the shipped slice is described by [FEATURE_MATRIX.md](./FEATURE_MATRIX.md) and [FINAL_ACCEPTANCE_REPORT.md](./FINAL_ACCEPTANCE_REPORT.md); this document is the product intent |
| Version | 0.1.0 |
| Last updated | 2026-10-19 |
| Audience | Product, engineering, design, QA, security |

> **Status honesty note.** Nebula is a greenfield build. Every capability described here is **planned**. Where the repository already contains a small scaffold (`package.json` workspaces, `docker-compose.yml`, `.env.example`, `tsconfig.base.json`, and a single untested reference module `packages/shared/src/permissions.ts`), that scaffold is configuration/spec material only — it is **not** a runnable application and is not counted as implemented. See [FEATURE_MATRIX.md](./FEATURE_MATRIX.md).

> **Evidence convention used across all Nebula docs.**
> - **[VERIFIED]** — behaviour confirmed against official Discord documentation (`docs.discord.com`, fetched 2026). Cited inline.
> - **[DESIGN]** — an independent Nebula decision; Discord may differ.
> - **[UNKNOWN]** — not inspected / not verified; must not be invented, only resolved by research or testing.

---

## 1. Vision

Nebula is a **self-hostable, production-quality real-time communication platform** — servers ("guilds"), text and voice channels, roles and granular permissions, direct messages, and small-group voice/video — built from scratch as an independent implementation.

Nebula's north star: *a small team or community can run a real, ergonomic chat-and-voice platform on a single VPS, and the same codebase can scale horizontally when they outgrow it.* The product deliberately mirrors the **mental model** of modern chat platforms (guilds → categories → channels → messages, a permission bitfield + overwrites, presence, typing, reactions) because that model is well understood by users. It does **not** reuse any proprietary code, assets, branding, string catalogs, sounds, icons, or emoji artwork.

### 1.1 One-sentence pitch
> "Everything a community needs to talk — servers, channels, roles, threads, DMs, and small-group voice — in one self-hostable, TypeScript-everywhere stack."

### 1.2 Principles
1. **Real, not a mock.** Working vertical slice end-to-end (auth → guild → message → voice) over real Postgres/Redis/Socket.IO/WebRTC, not stubbed screens.
2. **Correct permissions.** The permission engine implements the documented computation order and implicit-deny rules, and is enforced on *every* resource read and write — server-side, never trusted from the client.
3. **Honest scope.** Features that need infrastructure we are not building (email, payments, SFU, E2E voice) are documented as out of scope rather than faked.
4. **Self-hostable by default.** Docker Compose brings up Postgres + Redis; the app runs on one node; horizontal scaling is a documented path, not a prerequisite.
5. **Accessible & responsive.** WCAG 2.1 AA target, keyboard-first navigation, and layouts from 360 px to ultrawide.
6. **Original identity.** Name, logo, palette, type, sounds, and copy are Nebula's own. No Discord trademark, wordmark, "Nitro", bot "verified" badges, or proprietary emoji.

---

## 2. Problem statement & positioning

Communities that want a Discord-like experience face a trade-off: hosted platforms (Discord, Slack, Matrix bridges) mean giving up control of data and hosting; building from scratch means re-deriving a permission model, realtime fan-out, and a media pipeline. Nebula targets the gap: **a credible, open, self-hostable implementation of the "server/channels/roles" model with a genuinely working real-time and voice slice.**

Positioning sentence: *"Discord's ergonomics and permission model, on infrastructure you control, in a stack a full-stack TypeScript team can extend in an afternoon."*

---

## 3. Target users & personas

| Persona | Profile | Primary goals | Nebula features that matter most |
| --- | --- | --- | --- |
| **Mara — Server Owner / Hobbyist Admin** | Runs a 50–500 member gaming community. Semi-technical. | Set up a server fast; invite friends; moderate troublemakers; not babysit config. | Guild creation, invites, roles, kick/ban/timeout, audit log, default permission templates. |
| **Dev — Community Organizer** | Runs a study group / OSS community. Cares about structure. | Organize channels by topic; private channels; announcements; onboarding. | Categories, channel overwrites, role hierarchy, threads, pins, search. |
| **Sam — Casual Member** | Joins via invite, mostly on mobile-width browser. | Read, chat, react, hop into voice; not learn a manual. | Responsive UI, typing/presence, reactions, replies, unread badges, DMs. |
| **Priya — Moderator** | Delegated manage-messages/manage-members. | Act quickly and accountably; see who did what. | Timeout, message delete/purge, audit log entries with reason, report queue. |
| **Owen — Self-hoster / Operator** | Deploys Nebula for their org; owns the infra. | One-command bring-up; clear config; observability; scale-out path; storage quotas. | Docker Compose, env config, health checks, structured logs, S3-compatible storage, quota controls. |

### 3.1 Anti-personas (explicitly not targeted)
- Large public "discovery" communities (no guild discovery, no vanity URLs, no server templates marketplace).
- Enterprises needing SSO/SAML/SCIM, compliance exports, retention policies (see non-goals).
- Third-party bot developers wanting an OAuth2 app platform (only first-party slash commands + webhooks are in scope).

---

## 4. Core user journeys

Each journey is written so it can be turned directly into an end-to-end test (see [TEST_PLAN.md](./TEST_PLAN.md) — the 12 required journeys).

### J1 — Register and establish a session
1. Visitor opens Nebula web app (`http://localhost:5173`), clicks **Create account**.
2. Enters email + username + password. Client validates live (username 2–32 chars; see §6.2 rules).
3. `POST /api/v1/auth/register` validates with Zod, hashes password with `scrypt` (per-user salt), inserts `users` + `credentials`, and creates a session.
4. Server sets `nebula_session` (HttpOnly, SameSite=Lax, Secure in prod) and `nebula_csrf` (readable) cookies.
5. Client is dropped into an empty "no servers yet" state with the option to create a server or accept an invite link.
6. **Email verification is not required** in the default build (no mail infra); the account is usable immediately. This is a documented limitation, not a silent stub.

### J2 — Create a server and invite people
1. **+ Create a server** → name, optional icon upload, template (Community / Gaming / Study / Empty).
2. `POST /api/v1/guilds` creates the guild, an `@everyone` role (id == guild id), a default `#general` text channel and `General` voice channel, and adds the creator as owner with `ADMINISTRATOR`.
3. Owner opens **Invite people** → `POST /api/v1/channels/{id}/invites` with `max_age`, `max_uses`, optional `temporary`.
4. Invite code is shared. A second user opens `http://localhost:5173/invite/{code}`.
5. `GET /api/v1/invites/{code}` previews the guild; **Accept** → `POST /api/v1/invites/{code}` adds a `guild_members` row and dispatches `GUILD_CREATE` + `GUILD_MEMBER_ADD` to the joiner and existing members.

### J3 — Organize with categories, channels, and roles
1. Manage-channels user creates a **Category** (`type 4`), then channels inside it (`parent_id` = category).
2. Private channel: create `#leadership` and set `@everyone` overwrite `deny: VIEW_CHANNEL`.
3. Create role **Moderator** with a permission bitfield; assign it; drag to reorder (`position`).
4. Non-members see the private channel as **inaccessible**; API omits it from `GET /guilds/{id}/channels` and returns `403` on direct access.

### J4 — Real-time text conversation
1. Member types in `#general`; `TYPING_START` fans out to others for ~10 s (coalesced).
2. Enter sends `POST /api/v1/channels/{id}/messages`; server assigns a snowflake, persists, returns the message, and emits `MESSAGE_CREATE` to all channel subscribers.
3. Reply (sets `message_reference`), edit (`MESSAGE_UPDATE` with `edited_timestamp`), delete (`MESSAGE_DELETE`), react (`MESSAGE_REACTION_ADD`), pin (`PIN_ADD`), search.
4. Two browser clients observe identical ordering (snowflake ascending); a reconnect neither loses nor duplicates messages.

### J5 — Direct messages and friends
1. Send friend request (`POST /api/v1/friends/requests`, by username) → target sees `RELATIONSHIP_ADD`.
2. On accept, both gain a `friendship`; a **DM channel** (`type 1`) can be opened.
3. DM message delivery uses the same `MESSAGE_CREATE` shape, scoped to the two recipients.
4. **Block** a user → `RELATIONSHIP_REMOVE`/block relationship; blocked user's DMs and friend requests are rejected; shared-channel messages from the blocked user are hidden or collapsed per product setting (**[DESIGN]** — final visibility rule pinned in §6.3).

### J6 — Join voice and talk
1. Member clicks a voice channel → `VOICE_STATE_UPDATE` join; server records `voice_states`, returns the participant list.
2. Mesh WebRTC: each pair negotiates; signaling travels over Socket.IO via `VOICE_SIGNAL` (offer/answer/ICE).
3. Toggle mute; enable screen share via `getDisplayMedia`; the mesh adds a track and renegotiates.
4. When the deployment has no media path (e.g. headless CI), voice degrades to **signaling-only verification** (see TEST_PLAN).

### J7 — Moderation
1. Moderator times out a member (`POST /api/v1/guilds/{gid}/members/{uid}/timeout`): member loses all permissions except `VIEW_CHANNEL` and `READ_MESSAGE_HISTORY` until expiry; owner/`ADMINISTRATOR` exempt. **[VERIFIED]**
2. Kick / ban / unban; every action writes an `audit_log_entries` row with actor, target, action type, and optional reason.
3. Authorisation is re-checked server-side for every one of these calls.

### J8 — Upload and access a file
1. Attach an image to a message; client requests an upload slot / posts multipart to `POST /api/v1/channels/{id}/attachments`.
2. Server validates size, magic bytes, and content-type allowlist; detects image dimensions; enforces per-guild quota; stores via the storage driver (local disk behind an S3-compatible interface).
3. Message references the attachment. Downloads go through `GET /api/v1/attachments/{id}` which **re-checks channel access** and serves with `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`.

---

## 5. Functional requirements by area

> Priority uses MoSCoW. "Slice" = the M-vertical slice described in [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

### 5.1 Accounts, authentication, sessions
- **FR-A1 (Must, slice)** Register with email + username + password; unique email and case-insensitive-unique username.
- **FR-A2 (Must, slice)** Login / logout; server-side sessions in Postgres, referenced by an opaque HttpOnly cookie.
- **FR-A3 (Must, slice)** Password hashing: `scrypt` N=2^15, r=8, p=1, 32-byte random per-user salt, 64-byte derived key; constant-time comparison. **[DESIGN]**
- **FR-A4 (Must)** CSRF double-submit token required on all state-changing cookie-authenticated requests.
- **FR-A5 (Must)** Session listing + revoke (per device); "log out everywhere".
- **FR-A6 (Should)** Change password (invalidates other sessions). Requires current password.
- **FR-A7 (Won't — documented)** Email verification and password reset (need SMTP; see non-goals). Endpoints may exist but return `503 MAIL_NOT_CONFIGURED` when `SMTP_URL` is unset, and the UI hides them.

### 5.2 Users, profiles, presence
- **FR-U1 (Must, slice)** Public user object (id, username, display name, avatar, accent color, bot flag, created_at).
- **FR-U2 (Must)** Edit own profile (display name, avatar, about-me, accent color); username change allowed with uniqueness re-check.
- **FR-U3 (Must, slice)** Presence: `online`, `idle` (client inactivity), `dnd`, `invisible`, `offline`. Multi-session aggregation (online if any session online). Stored ephemerally in Redis with a Postgres "last known" fallback. **[DESIGN]**
- **FR-U4 (Should)** Custom status text (≤128 chars) with optional emoji.
- **FR-U5 (Should)** User profile view (mutual servers, roles in a given guild, member-since).

### 5.3 Relationships: friends & blocks
- **FR-R1 (Must)** Friend requests (send/cancel/accept/decline) keyed by username.
- **FR-R2 (Must)** Friendships are symmetric; removing a friend removes both directions.
- **FR-R3 (Must)** Blocks are directional and override friendship: a block silently drops the other party's friend requests and DM delivery.
- **FR-R4 (Should)** Per-relationship nickname (client-local preference).

### 5.4 Guilds (servers), members, invites
- **FR-G1 (Must, slice)** Create/rename/delete guild; owner-only delete with typed confirmation.
- **FR-G2 (Must, slice)** Guild membership lifecycle: join via invite, leave, kick, ban.
- **FR-G3 (Must)** Invites: code, optional expiry (`max_age` 0–604800 s), `max_uses` (0–100), `temporary`, created by channel. **[VERIFIED: Discord ranges]** Nebula mirrors these bounds as **[DESIGN]**.
- **FR-G4 (Must)** Member list with online/offline grouping; role hoisting (`hoist=true`).
- **FR-G5 (Should)** Nicknames (self with `CHANGE_NICKNAME`, others with `MANAGE_NICKNAMES`).
- **FR-G6 (Should)** Guild settings: name, icon, default notification level, system-messages channel, explicit-content filter.
- **FR-G7 (Could)** Vanity-ish "friendly" invite alias (still an invite row; no discovery).

### 5.5 Channels, categories, overwrites, threads
- **FR-C1 (Must, slice)** Channel types implemented: `0 GUILD_TEXT`, `1 DM`, `2 GUILD_VOICE`, `3 GROUP_DM`, `4 GUILD_CATEGORY`, `5 GUILD_ANNOUNCEMENT`, `13 GUILD_STAGE_VOICE` (signaling/basic), `11/12` threads, `15 GUILD_FORUM`. **[VERIFIED: type ids]**
- **FR-C2 (Must, slice)** Categories contain children via `parent_id`; per Discord, a category holds up to 50 channels. **[VERIFIED]**
- **FR-C3 (Must, slice)** Permission overwrites `{id, type: 0|1, allow, deny}` where `type` 0 = role, 1 = member. **[VERIFIED]**
- **FR-C4 (Must)** Channel settings: name (1–100), topic (≤1024; ≤4096 for forum), nsfw, slowmode `rate_limit_per_user` (0–21600 s), voice `bitrate`/`user_limit`, position. **[VERIFIED: bounds]**
- **FR-C5 (Should)** Category permission syncing: a child is "synced" iff its overwrites equal its parent's; synced children update when the parent changes; editing a child de-syncs it. **[VERIFIED: Permission Syncing]**
- **FR-C6 (Should)** Threads: public/private, `auto_archive_duration` ∈ {60,1440,4320,10080} minutes, archive/lock, `SEND_MESSAGES_IN_THREADS` required (not inherited). **[VERIFIED]**
- **FR-C7 (Could)** Forum channels: threads as posts, tags, default sort order. **[VERIFIED: type 15, sort orders]**

### 5.6 Roles & permissions
- **FR-P1 (Must, slice)** Roles with name, color, `hoist`, `position`, `mentionable`, `permissions` bitfield. **[VERIFIED: role object]**
- **FR-P2 (Must, slice)** Compute channel permissions in the documented order: base (@everyone role OR member roles) → `ADMINISTRATOR` bypass → overwrites (@everyone deny, @everyone allow, role deny OR, role allow OR, member deny, member allow). **[VERIFIED]**
- **FR-P3 (Must, slice)** Implicit denies: no `VIEW_CHANNEL` ⇒ nothing else applies; no `SEND_MESSAGES` ⇒ `MENTION_EVERYONE`, `SEND_TTS_MESSAGES`, `ATTACH_FILES`, `EMBED_LINKS` denied; voice `CONNECT` denial implies the voice sub-permissions. **[VERIFIED]**
- **FR-P4 (Must, slice)** Timed-out members keep only `VIEW_CHANNEL` + `READ_MESSAGE_HISTORY`; owner/`ADMINISTRATOR` exempt. **[VERIFIED]**
- **FR-P5 (Must)** Hierarchy-gated actions use role `position`: may only manage roles/users strictly below your highest role. **[VERIFIED: Permission Hierarchy]**
- **FR-P6 (Must)** Server-side enforcement helper used by every route and every realtime fan-out; the client's displayed permissions are cosmetic only.

### 5.7 Messaging
- **FR-M1 (Must, slice)** Send messages (≤2000 chars content), with optional reply reference and nonce for dedup. **[VERIFIED: 2000]** / **[DESIGN: nonce use]**
- **FR-M2 (Must, slice)** Edit (sets `edited_timestamp`), delete (author with permission or `MANAGE_MESSAGES`).
- **FR-M3 (Must, slice)** Reply via `message_reference` (`message_id`, `channel_id`, `guild_id`); a reply does not ping the referenced author unless requested. **[VERIFIED: message reference / replied_user default false]**
- **FR-M4 (Must, slice)** Reactions: unicode + custom emoji; `me`/count; remove. `ADD_REACTIONS` needed to add. **[VERIFIED: reaction object]**
- **FR-M5 (Must, slice)** Pins: pin/unpin with `PIN_MESSAGES`; `last_pin_timestamp` on channel. **[VERIFIED: bit 51, channel field]**
- **FR-M6 (Must, slice)** Typing indicator (10 s TTL; coalesced ~1 event / 5 s per user/channel). **[VERIFIED: 10 s]**
- **FR-M7 (Must, slice)** Read state / unread badges / mention counts, per user per channel.
- **FR-M8 (Should)** Message search within guilds the user can read, respecting `READ_MESSAGE_HISTORY`.
- **FR-M9 (Should)** Markdown subset: bold, italic, underline, strikethrough, inline code, code block, spoiler, blockquote, links; mentions `<@id>`, `<@&id>`, `<#id>`, `@everyone`/`@here` gated by `MENTION_EVERYONE`.
- **FR-M10 (Should)** Context menu actions (edit/delete/copy-link/reply/react); message grouping by author+time window.
- **FR-M11 (Could)** Forwarding (`message_reference` type `FORWARD` + immutable snapshot). **[VERIFIED: message reference types]** Nebula documents snapshot semantics but may ship later.
- **FR-M12 (Could)** System messages (join, pin, channel rename) as typed messages, following Discord's message **types** table.

### 5.8 Direct & group messages
- **FR-D1 (Must)** 1:1 DM channel (`type 1`) auto-created on first message.
- **FR-D2 (Must)** Group DM (`type 3`) with owner, add/remove recipients, name/icon. **[VERIFIED: group DM fields]**
- **FR-D3 (Must)** DMs ignore guild permissions; access is membership-based only.
- **FR-D4 (Should)** DM voice/video call (mesh) — same signaling as guild voice.

### 5.9 Attachments & media
- **FR-AT1 (Must, slice)** Upload files up to `MAX_UPLOAD_BYTES` (default 25 MiB / 26214400, matching Discord's documented 25 MiB request cap). **[VERIFIED: 25 MiB]** / env override **[DESIGN]**
- **FR-AT2 (Must)** Validate magic bytes + sniffed content type against an allowlist; reject mismatches.
- **FR-AT3 (Must)** Detect image/video `width`/`height`. **[VERIFIED: attachment fields]**
- **FR-AT4 (Must)** Auth-gated download: `GET /api/v1/attachments/{id}` re-checks channel membership/permission.
- **FR-AT5 (Must)** Serve with `Content-Disposition` and `X-Content-Type-Options: nosniff`; never inline-execute SVG/HTML.
- **FR-AT6 (Must)** Per-guild storage quota (`STORAGE_QUOTA_BYTES_PER_GUILD`, default 1 GiB), enforced on upload.
- **FR-AT7 (Should)** Attachment metadata stored on the message (filename, size, content_type, width/height, url/proxy_url).
- **FR-AT8 (Could)** Image thumbnails / `placeholder` thumbhash. **[VERIFIED: placeholder field exists]** — generation is **[DESIGN]** and may be deferred.

### 5.10 Notifications, unread, mentions
- **FR-N1 (Must)** Per-channel read state; unread and mention-pill counts.
- **FR-N2 (Must)** Desktop in-app notifications (Web Notifications API) respecting per-guild/channel notification levels and `dnd`.
- **FR-N3 (Must)** `@everyone`/`@here` only honored with `MENTION_EVERYONE`, or role mentionable with the role.
- **FR-N4 (Should)** Per-channel mute and notification overrides.
- **FR-N5 (Could)** Push notifications (requires external push infra — **out of scope**, documented).

### 5.11 Moderation & safety
- **FR-MOD1 (Must, slice)** Kick, ban, unban (with reason, `KICK_MEMBERS`/`BAN_MEMBERS`).
- **FR-MOD2 (Must, slice)** Timeout (`MODERATE_MEMBERS`) with duration; permission effect per FR-P4.
- **FR-MOD3 (Must, slice)** Audit log: actor, target, action, reason, timestamp; `VIEW_AUDIT_LOG`.
- **FR-MOD4 (Must)** Delete/purge messages; `MANAGE_MESSAGES`.
- **FR-MOD5 (Could)** Reports queue + auto-mod rules (keyword/spam) — basic only; full auto-mod **out of scope**.
- **FR-MOD6 (Out of scope)** Raid detection, incident alert mode, cross-server bans (documented as future).

### 5.12 Integrations: slash commands & webhooks
- **FR-I1 (Must)** First-party slash commands registered per guild/global; invoked from composer; results posted as ephemeral or public messages.
- **FR-I2 (Must)** Incoming webhooks: a channel-bound token URL that creates messages authored by the webhook identity. `MANAGE_WEBHOOKS` to manage.
- **FR-I3 (Must)** Webhook requests authenticate with a bearer token in the delivery URL (stored only as a SHA-256 hash). **No request signing** is implemented. **[IMPLEMENTED: bearer token; signing not built]**
- **FR-I4 (Out of scope)** Third-party OAuth2 bot apps, RPC, embedded Activities, slash-command permissions matrix beyond channel/role gating.

### 5.13 Voice / video / screen share
- **FR-V1 (Must, slice)** Join/leave voice; in-channel participant roster via `VOICE_STATE_UPDATE`. **[VERIFIED: event name]**
- **FR-V2 (Must)** Mesh WebRTC for calls up to a documented cap (default 8 participants) with `getUserMedia` audio; `getDisplayMedia` screen share; camera via `getUserMedia({video})`.
- **FR-V3 (Must)** Signaling relay `VOICE_SIGNAL` (offer/answer/ICE) through Socket.IO, authenticated and scoped to the channel.
- **FR-V4 (Must)** Mute/deafen (self) and server mute/deafen/move (with `MUTE_MEMBERS`/`DEAFEN_MEMBERS`/`MOVE_MEMBERS`).
- **FR-V5 (Out of scope / documented)** SFU scaling (mediasoup/LiveKit), E2E voice encryption, per-user bitrate management, RTX/FEC tuning, priority speaker mechanics beyond the permission bit.

### 5.14 Search
- **FR-S1 (Must)** Guild message search: query string, optional `channel_id`, `author_id`, `mentions`, `has`, `before`/`after`/`during`, pagination. Implemented over Postgres full-text search (`tsvector` + GIN) with a documented "index may lag" semantics. **[DESIGN]** Nebula's search is **not** a replication of Discord's search operators beyond a documented subset.

### 5.15 Settings
- **FR-SET1 (Must)** User settings: appearance (theme, message display), notifications, voice/video devices, privacy (DM from server members), language.
- **FR-SET2 (Must)** Guild settings (see FR-G6) and per-channel settings, each gated by the correct permission.

---

## 6. Detailed rules and data-shape requirements

### 6.1 Username and identity rules **[VERIFIED]**
- Length 2–32 characters.
- Must not contain `@`, `#`, `:`, ``` ``` ``` (three backticks), or the substring `discord` (Nebula additionally forbids its own reserved substrings, e.g. `nebula` staff prefixes — **[DESIGN]**).
- Must not be `everyone` or `here`.
- Case-insensitive uniqueness (store a normalized lower-case column with a unique index).
- Nebula uses **unique usernames without discriminators** (no `#1234`) — **[DESIGN]**, stated explicitly because Discord's historical discriminator model is not adopted.

### 6.2 Snowflake IDs **[DESIGN, inspired by Discord's documented format]**
- 64-bit unsigned integer, serialized as a **string** in all JSON.
- Layout: `timestamp_ms_since_epoch (41 bits) | worker (5) | process (5) | increment (12)`.
- Epoch `2026-01-01T00:00:00.000Z` (epoch ms `1767225600000`).
- Guarantees monotonic-ish, time-sortable IDs usable as cursor pagination keys (`before`/`after`).
- Implemented with `BigInt` end-to-end; **never** used as a JS `number`.

### 6.3 Blocking visibility rule **[DESIGN]**
When A blocks B: B cannot DM A, cannot send A a friend request, and A stops receiving B's presence/typing. In shared channels, B's messages are **hidden by default** for A with a "blocked user — show message" affordance (client-side filter driven by a `blocked_user_ids` set). This is a Nebula choice and is labeled as such; Discord's exact behavior was not treated as normative here.

### 6.4 Message content handling **[DESIGN]**
- Content is stored as raw text and rendered with a **sanitizing** markdown renderer; the renderer never emits `dangerouslySetInnerHTML` with unsanitized input.
- Mentions are parsed server-side into `mentions`, `mention_roles`, `mention_everyone`; the client does not get to declare who was mentioned.
- `allowed_mentions` semantics: only `@users` are parsed for webhooks unless configured otherwise. **[VERIFIED: webhook defaults parse users only]**

---

## 7. Non-functional requirements

### 7.1 Performance budgets **[DESIGN targets for the slice]**
| Metric | Target | Measurement |
| --- | --- | --- |
| API p95 (read) | ≤ 150 ms | server timing histograms |
| API p95 (write/message) | ≤ 250 ms | histogram |
| Realtime fan-out p95 (100-member channel) | ≤ 100 ms event receipt | synthetic load harness |
| First contentful paint (cold, fast 3G) | ≤ 2.5 s | Lighthouse |
| Time to interactive | ≤ 3.5 s | Lighthouse |
| Web bundle (initial JS, gzip) | ≤ 250 KiB | Vite build report |
| Idle memory (server, 1k sockets) | ≤ 400 MiB | process metrics |
| DB query p95 | ≤ 25 ms | `pg_stat_statements` |

### 7.2 Accessibility — WCAG 2.1 AA **[DESIGN, target]**
- All interactive elements keyboard reachable; visible focus ring; logical tab order.
- Roles/ARIA for the app shell (list of servers, channel tree, message log as `role="log"` with `aria-live="polite"` for incoming messages).
- Color contrast ≥ 4.5:1 for body text, ≥ 3:1 for large text and UI boundaries; presence and unread are never conveyed by color alone.
- Respect `prefers-reduced-motion`; no motion that can't be disabled.
- Form errors announced via `aria-live` and tied to fields with `aria-describedby`.
- Voice/participant status conveyed textually, not just by icon.
- Automated checks: `axe-core` in component tests and an axe pass in e2e; manual keyboard-only and screen-reader smoke each milestone.

### 7.3 Responsive breakpoints **[DESIGN]**
| Name | Width | Layout |
| --- | --- | --- |
| `xs` | 360–479 px | single column; server rail collapsible; channels as overlay drawer |
| `sm` | 480–767 px | channel drawer + message pane |
| `md` | 768–1023 px | three columns (rail, channels, messages) |
| `lg` | 1024–1439 px | + member list |
| `xl` | ≥1440 px | + optional thread/right pane |
Touch targets ≥ 44×44 px on `xs`/`sm`.

### 7.4 Internationalisation readiness **[DESIGN]**
- All user-facing strings via a `t()` catalog; no literal strings in JSX.
- Dates/times via `Intl.DateTimeFormat`; relative times via `Intl.RelativeTimeFormat`; numbers via `Intl.NumberFormat`.
- Copy is **not** concatenated (no string building that breaks word order); pluralization via ICU-style `{count, plural, ...}`.
- Logical CSS properties (`margin-inline`, `padding-inline`) so RTL is a flip, not a rewrite; `dir` driven by locale.
- Default locale `en-US`; message catalogs under `apps/web/src/i18n/locales/`. Full translation is **out of scope** for the slice but the plumbing is required.

### 7.5 Security & privacy (summary — full detail in SECURITY_MODEL.md)
- Session cookies: `HttpOnly`, `SameSite=Lax`, `Secure` in prod, `Path=/`.
- CSRF double-submit on every unsafe method.
- All SQL through parameterized queries (`pg` placeholders); no string interpolation of user input.
- Uploads validated by magic bytes + allowlist; served `attachment` + `nosniff`.
- Server-side authorization on every read/write and every realtime fan-out.
- Logs redact tokens, cookies, passwords, emails (hashed/truncated), and message content by default.

### 7.6 Reliability & data
- Postgres is the source of truth; Redis holds presence, rate-limit counters, and the Socket.IO adapter pub/sub (all **reconstructable**).
- Idempotent message send via client `nonce`; ordering by snowflake.
- Graceful shutdown: stop accepting, drain sockets, close pool.
- Backup guidance: `pg_dump` daily + uploads volume snapshot (documented, not automated in the slice).

### 7.7 Browser support **[DESIGN]**
- Evergreen Chromium, Firefox, Safari (last 2 versions); Safari/iOS WebRTC quirks documented.
- No IE/legacy; `getDisplayMedia` unsupported browsers get a disabled control with explanation.

---

## 8. Explicit non-goals / out of scope

These are **intentionally not implemented** and documented rather than faked:

1. **Voice E2E encryption** — WebRTC provides DTLS-SRTP in transit, but no application-layer E2E group keying.
2. **Real SFU scaling** — mesh only; mediasoup/LiveKit are the documented scaling path, not built.
3. **Nitro / premium / monetization** — no subscriptions, no boosts, no SKUs, and explicitly **no fake payment simulation or mock checkout**.
4. **Activities / soundboard / stickers** — permission bits exist in the bitfield for fidelity, but the features are not built.
5. **Crossposting / channel following** — announcement channels exist; following into another guild is out of scope.
6. **Full auto-mod** — only basic keyword/spam rules (if at all); raid detection and incident alert mode are out.
7. **Bots / third-party OAuth2 apps** — only first-party slash commands + incoming webhooks.
8. **Email verification / password reset / email change confirmation** — require mail infra; endpoints are gated and documented, not simulated. `SMTP_URL` unset ⇒ disabled with a clear error.
9. **Guild discovery / public directory / templates marketplace** — none.
10. **Push notifications (mobile/desktop)**, **SMS**, **phone support**.
11. **Federation/Matrix bridging**, **E2E DMs**.
12. **Compliance-grade retention/legal hold/exports**, **SSO/SAML/SCIM**, **audit log streaming to SIEM**.
13. **Stickers/emoji marketplace**, **custom soundboard sounds**.
14. **Multi-region active-active** — single-region with a documented read-replica + CDN + multi-node path.

---

## 9. How Nebula differs from Discord

| Dimension | Discord | Nebula |
| --- | --- | --- |
| Hosting | SaaS only | Self-hostable; Docker Compose default |
| Identity/branding | Discord wordmark, Blurple, proprietary assets | Original "Nebula" name, palette, type, logo, sounds, and copy **[DESIGN]** |
| Usernames | (historically) `name#discriminator`; now unique names | Unique usernames, no discriminator **[DESIGN]** |
| Premium | Nitro/Boosts/SKUs | None — explicitly out of scope, and **not simulated** |
| Bots | Full OAuth2 app platform, huge bot ecosystem | First-party slash commands + incoming webhooks only |
| Scaling | Purpose-built distributed infra + SFU | Mesh voice; documented SFU/read-replica/CDN path |
| Search | Dedicated search infra with rich operators | Postgres FTS over a documented operator subset |
| Permission model | Exact 53-bit-span model (bit 47 unused) | Reimplements the **documented** computation order, implicit denies, timeout effect **[VERIFIED]** |
| Email | Deep email infra | Optional; disabled without SMTP (not faked) |

**Original-identity guardrails:** no Discord trademarks or logos; no copied icon set (use `lucide-react`); no reused Discord sounds; no copied emoji artwork (system emoji via the OS font, or an open-licensed set with attribution); the `nebula` name and mark are original. Where a behavior is copied, it is a **documented behavioral model**, not copied code or assets.

---

## 10. Terminology mapping **[DESIGN]**

| Nebula UI term | Model/DB term | Discord term |
| --- | --- | --- |
| Server | `guilds` | Guild / Server |
| Channel | `channels` | Channel |
| Category | channel `type 4` | Category |
| Role | `roles` | Role |
| Moderation Timeout | member `timed_out_until` | Timeout (Communication Disabled) |
| Direct Message | `dm_channels` `type 1/3` | DM / Group DM |

The word "guild" is retained in the API/DB for fidelity with the permission model and events, but the UI says **"Server"**.

---

## 11. Success criteria for the vertical slice

The slice is considered product-complete when the 12 end-to-end journeys in [TEST_PLAN.md](./TEST_PLAN.md) pass on a single-node deployment with real Postgres + Redis, including at least one real-time multi-client messaging test, one permission-denial test, and one media round-trip when a browser with a fake media device is available.

| Dimension | Target |
| --- | --- |
| Journey coverage | 12/12 required e2e journeys automated (voice journey may run signaling-only mode) |
| Permission correctness | 100% of the authorization unit cases pass |
| Accessibility | no `axe` critical/serious violations on primary screens |
| Performance | §7.1 budgets met in a local load check |
| Security | all SECURITY_MODEL.md authorization cases pass |

---

## 12. Open questions & uncertainty

- **[UNKNOWN]** Discord's exact client-side rendering heuristics for message grouping, mention styling, and blocked-user message handling were not inspected; Nebula's choices are labeled **[DESIGN]**.
- **[UNKNOWN]** Discord's precise slowmode/typing coalescing windows; Nebula uses documented TTLs (typing 10 s) and defines its own coalescing.
- **[UNKNOWN]** Search operator parity — Nebula implements a documented subset and does not claim parity.
- **[DESIGN OPEN]** Whether group-DM voice calls ship in the slice or immediately after (M5 vs M6).
- **[DESIGN OPEN]** Whether message forwarding (snapshot) ships in the slice (currently Could).
