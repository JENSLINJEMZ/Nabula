# Nebula — Security Model

| Field | Value |
| --- | --- |
| Document | SECURITY_MODEL.md |
| Status | **Implemented (verified)** — controls are implemented and covered by 14 integration/security tests + scrypt/cookie/CSRF unit assertions (see [FINAL_ACCEPTANCE_REPORT.md](./FINAL_ACCEPTANCE_REPORT.md) §8 for remaining hardening notes) |
| Version | 0.1.0 |
| Last updated | 2026-10-19 |

> Status note: every control below is a **design commitment**, not a verified behavior. The authorization test-case table (§11) is the acceptance gate: no resource-handling feature may be marked `Implemented-verified` until its cases pass. Discord-derived rules are marked **[VERIFIED]**.

---

## 1. Security objectives

1. **Confidentiality** — a user can only read content (channels, messages, attachments, DMs) they are authorized for, enforced server-side on every request and every realtime fan-out.
2. **Integrity** — only authorized actors mutate state; audit-logged moderation is tamper-evident (append-only).
3. **Availability** — abuse is rate-limited; uploads are bounded; one tenant cannot exhaust shared resources (per-guild quota).
4. **Accountability** — privileged actions record actor/target/action/reason; logs are structured and redacted.
5. **Privacy** — minimize stored personal data (hashed IPs, no raw tokens), redact secrets from logs.

**Trust boundaries:** browser (untrusted) → reverse proxy → Fastify/Socket.IO (trusted app) → Postgres/Redis/object storage. The client is always untrusted: cached permissions, hidden fields, and disabled buttons are cosmetic.

---

## 2. Threat model (STRIDE)

| STRIDE | Threat | Example in Nebula | Primary mitigations |
| --- | --- | --- | --- |
| **S**poofing | Impersonate a user or a webhook | Stolen/forged session cookie; forged webhook call | HttpOnly sessions, `Secure`+`SameSite`, high-entropy bearer webhook tokens stored only as a SHA-256 hash, constant-time compares |
| **T**ampering | Alter requests or stored data | CSRF (forced state change); parameter tampering (`type` on overwrite) | CSRF double-submit, Zod validation, server-side re-derivation of `mention`/permissions |
| **R**epudiation | Deny a privileged action | Moderator claims they didn't ban | Append-only `audit_log_entries` with actor/target/reason |
| **I**nformation disclosure | Read others' private data | IDOR on `/channels/{id}/messages`; attachment URL guessing; user enumeration | Per-resource authorization, auth-gated attachment route, generic login errors |
| **D**enial of service | Exhaust resources | Message flood, huge uploads, socket flood, expensive search | Per-route + global rate limits, size caps, quota, coalescing, pagination caps |
| **E**levation of privilege | Gain permissions you lack | Forge `ADMINISTRATOR`; edit a higher role; grant a permission you don't hold | Server recomputes permissions; hierarchy gating; cannot grant perms you lack **[VERIFIED: hierarchy]** |

**Additional classes considered:** XSS via message content/embeds, SSRF via link unfurling (Nebula does **not** fetch remote URLs server-side in the slice — see §6), insecure deserialization (JSON only, no eval), supply-chain (dependency review), misconfigured CORS, path traversal in the storage driver, and race conditions in quota/permission checks.

### 2.1 Assets
Session cookies; password hashes; webhook tokens/signing secrets; private channel/DM content; uploaded media; audit log; user PII (email, IP).

### 2.2 Out-of-scope threats (documented)
E2E voice content confidentiality (DTLS-SRTP only), malicious server operators (self-hosting implies operator trust), client-device compromise, and physical access.

---

## 3. Authentication

### 3.1 Password storage **[DESIGN]**
- Algorithm: **scrypt**, parameters **N = 2^15 (32768), r = 8, p = 1**, **32-byte random per-user salt**, **64-byte derived key**.
- Encoded form: `scrypt$N$r$p$<base64 salt>$<base64 hash>` stored in `credentials.password_hash`.
- Verification uses `crypto.timingSafeEqual` on the derived keys (equal length guaranteed by fixed key size). Never a plain `===`.
- Parameters are stored per credential so they can be raised later; on successful login with old parameters, the hash is transparently re-derived at the new cost.
- Rationale: scrypt is memory-hard (resists GPU/ASIC cracking) and available in `node:crypto` with no native dependency. Argon2id would be preferable but adds a build dependency; this trade-off is explicit.
- **Caveat:** N=2^15 uses ~32 MiB per verification; login/register routes are rate-limited to prevent memory-exhaustion DoS via parallel hashing.

### 3.2 Sessions **[DESIGN]**
- On login/register the server generates a **32-byte random** opaque token; only its **SHA-256 hash** is stored (`sessions.token_hash`). The raw token is the cookie value and is never logged or stored.
- Cookie `nebula_session`: `HttpOnly`, `SameSite=Lax`, `Secure` when `COOKIE_SECURE=true` (default in prod), `Path=/`, `Max-Age = SESSION_TTL_DAYS`.
- Session rows carry `expires_at`, `revoked_at`, `last_seen_at`, and optional `device_id`/`user_agent`/hashed IP.
- Logout revokes the current session; changing the password revokes all others; "log out everywhere" revokes all.
- **Fixation:** a new token is issued on login (never reuse a pre-login token).
- **Idle vs absolute expiry:** slice uses absolute expiry with sliding `last_seen_at`; sliding TTL is a documented option.
- Expired/revoked sessions are rejected at hydration and cleaned up by a worker.

### 3.3 Multi-factor
- `users.mfa_enabled` and `guilds.mfa_level` exist for the documented 2FA-gated permission set. TOTP enrollment is **[DESIGN OPEN]**; the slice may ship the flag/gating without full enrollment. This is documented, not faked as "2FA enabled".

### 3.4 Registration & enumeration
- Login failures always return `401 INVALID_CREDENTIALS` with the same message and comparable timing regardless of whether the username/email exists (dummy hash comparison on miss to equalize timing).
- Registration may reveal username/email existence via `409 CONFLICT` (a usability trade-off). This is acknowledged; the alternative (silent "check your email") requires email infrastructure we do not have.

---

## 4. CSRF **[DESIGN]**

- **Double-submit cookie:** on session establishment the server sets a non-secret `nebula_csrf` cookie (`SameSite=Lax`) and stores `sessions.csrf_hash` = SHA-256 of the token.
- Unsafe methods (`POST/PUT/PATCH/DELETE`) must send `X-CSRF-Token` matching the session's CSRF token; the server compares constant-time against the stored hash; mismatch → `403 CSRF_FAILED`.
- `SameSite=Lax` provides a baseline (blocks most cross-site POSTs); the double-submit is the defense-in-depth.
- **Realtime:** Socket.IO handshakes are cookie-authenticated; client→server events that mutate state (`PRESENCE_UPDATE`, `VOICE_STATE_UPDATE`, `TYPING_START`) are authorization-checked per event and cannot perform durable writes, limiting CSRF value. Socket.IO's own transport is not a CSRF vector for cookie auth in the same way as form posts, but the design assumes cross-site WebSocket hijacking is possible and therefore **does not rely on `Origin` checks alone** — every event is authorized by session.
- **CORS:** the API allows only `PUBLIC_WEB_ORIGIN` with `credentials: true`; no wildcard with credentials.

---

## 5. XSS & content sanitization **[DESIGN]**

- **Message content** is stored raw and rendered through a **strict markdown renderer** that (a) escapes HTML by default, (b) allow-lists a small subset (bold/italic/underline/strikethrough/inline code/code block/blockquote/spoiler/links), and (c) never calls `dangerouslySetInnerHTML` with unsanitized input. Raw HTML in a message is displayed as text, never parsed.
- **Links** are rendered with `rel="noopener noreferrer"` and `target="_blank"`; `javascript:`/`data:`/`vbscript:` schemes are rejected at render time.
- **Mentions** are parsed **server-side** into `mentions`/`mention_roles`/`mention_everyone`; the client cannot fabricate who was mentioned or bypass `MENTION_EVERYONE`. **[VERIFIED: allowed mentions validation]**
- **Embeds/previews:** in the slice Nebula does **not** fetch remote URLs to build link previews (avoids SSRF and content injection). Rich embeds, if any, come only from first-party slash commands/webhooks and are length-limited (title 256, description 4096, ≤25 fields, ≤6000 total, ≤10 embeds). **[VERIFIED: embed limits]**
- **Filenames** are escaped in the UI; the download route forces `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` so a crafted "image" can never execute in origin.
- **User-generated names** (username, display name, guild/channel/role names, nicknames) are rendered as text nodes only.
- **CSP (recommended):** `default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' wss:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'`. Set at the reverse proxy. **[DESIGN]**

---

## 6. Injection & server-side request handling

### 6.1 SQL injection **[DESIGN]**
- All queries use **parameterized** placeholders (`$1, $2, …`) via `pg`. No string interpolation of user input into SQL, including identifiers (sort/column names are mapped through fixed allow-lists).
- Dynamic `IN (...)` lists are built with generated placeholders (`$1,$2,…`), never concatenated values.
- Search uses `to_tsquery` with a sanitized/parameterized query; no raw SQL echo.
- DB role `nebula_app` has only DML on app tables; migrations run as a separate role.
- Repository code review includes an `EXPLAIN` check for index usage on hot paths.

### 6.2 Command/template injection
- No `eval`, no dynamic `require`/`import` of user input, no shell execution of user data. Any shell-out (e.g. image tooling) uses `execFile` with argument arrays, never a shell string.

### 6.3 SSRF
- The slice makes **no** outbound HTTP requests driven by user input (no unfurling). Future features that fetch URLs must block private/link-local ranges and use an allow-list. Documented as a constraint.

### 6.4 Path traversal (storage) **[DESIGN]**
- Storage keys are **server-generated** (`guild/{guildId}/{channelId}/{snowflake}.{ext}`), never derived from the client filename. The client filename is metadata only.
- Filesystem driver resolves paths and asserts the result stays within `STORAGE_LOCAL_DIR` (resolve + prefix check) before any read/write.

---

## 7. Authorization (enforcement everywhere)

- **Single source of truth:** the permission engine (in `@nebula/shared`, mirrored server-side) computes a channel permission integer in the documented order: base (@everyone role OR member roles) → `ADMINISTRATOR` bypass → overwrites (@everyone deny, @everyone allow, role deny OR, role allow OR, member deny, member allow), then implicit denies and timeout effect. **[VERIFIED]**
- **Every route** calls a guard: authenticate → load membership → compute permissions for the target channel/guild → check the specific bit → proceed. There is no route that trusts a client-supplied permission.
- **Every realtime fan-out** re-checks the recipient's permission before emitting; a socket is removed from rooms it can no longer see.
- **Hierarchy gating** for role/member management: a user may only kick/ban/edit-nickname users whose highest role is below theirs, and may only grant permissions they themselves hold. **[VERIFIED: hierarchy]**
- **Implicit rules** are applied before any check: no `VIEW_CHANNEL` ⇒ deny everything else; no `SEND_MESSAGES` ⇒ deny `MENTION_EVERYONE`/`SEND_TTS_MESSAGES`/`ATTACH_FILES`/`EMBED_LINKS`; no voice `CONNECT` ⇒ deny voice sub-permissions. **[VERIFIED]**
- **Timeout:** timed-out members hold only `VIEW_CHANNEL` + `READ_MESSAGE_HISTORY`; owner/`ADMINISTRATOR` exempt. **[VERIFIED]**
- **Ownership:** the guild owner implicitly has all permissions; the `@everyone` role id equals the guild id. **[VERIFIED]**
- **Audit:** privileged actions append to `audit_log_entries` with a redacted `changes` diff and the optional `reason`.

### 7.1 Authorization decision pseudocode (server)
```
can(user, action, target):
  ctx = loadContext(user)                 # membership, roles, owner?
  if target is guild-scoped:
     base = computeBasePermissions(ctx, guild)
  else:
     base = computeBasePermissions(ctx, guildOf(channel))
  perms = computeOverwrites(base, ctx, channel)   # includes ADMIN bypass
  perms = applyImplicitPermissions(perms, channel.type)
  perms = applyTimeout(perms, ctx.timedOutUntil)
  if target is DM: return ctx.isRecipient(channel)   # DMs are membership-based
  return hasPermission(perms, action)
```

---

## 8. Upload security **[DESIGN]**

- **Size cap:** `MAX_UPLOAD_BYTES` (default 25 MiB / 26214400, matching Discord's documented 25 MiB request cap). **[VERIFIED]**
- **Content-type allow-list** (by sniffed type, not the client header): `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif?`, `audio/*` (ogg/mp3/wav), `video/mp4`/`video/webm`, `text/plain`, `application/pdf`, `application/zip`. Unknown → `415 UNSUPPORTED_MEDIA_TYPE`.
- **Magic-byte validation:** the declared/sniffed type must match the detected signature; mismatch → `415`. Files with an executable/script/HTML signature are rejected.
- **Never inline-execute:** downloads are served with `Content-Disposition: attachment; filename="…"` (filename RFC 5987/`filename*` encoded), `X-Content-Type-Options: nosniff`, and `Content-Security-Policy: default-src 'none'` on the response. SVG is served as a download, never rendered inline.
- **Auth-gated access:** `GET /attachments/{id}` re-checks the caller's permission on the owning channel (or DM recipient) on every request — the storage key is unguessable **and** access-controlled (defense in depth).
- **Quota:** per-guild `STORAGE_QUOTA_BYTES_PER_GUILD` (default 1 GiB), enforced transactionally against `guild_storage_usage` before persisting; `413 QUOTA_EXCEEDED` with `used`/`limit`.
- **Storage isolation:** server-generated keys; disk writes confined to `STORAGE_LOCAL_DIR`; the S3 driver uses per-object keys with no path semantics.
- **Malware:** not scanned in the slice (no AV infra) — documented limitation; AV scanning is a listed future integration.
- **Image decoding:** dimension detection is bounded (pixel/decoded-size limits) to prevent decompression-bomb DoS.

---

## 9. Rate limiting & abuse **[DESIGN]**

- Buckets are keyed per identity (user or IP for anonymous) plus a **global** cap; responses expose `x-ratelimit-limit` / `x-ratelimit-remaining` / `x-ratelimit-reset` and a `429` with `error.code = RATE_LIMITED` (`details.retryAfterMs`), modeled on Discord's documented scheme. **[VERIFIED: header format/429]**
- Defaults: a global per-identity cap (`RATE_LIMIT_MAX`, default 600/min) plus stricter per-route buckets (login/register, message send + slowmode, typing coalesced, uploads, search, friend requests).
- **Slowmode** (`rate_limit_per_user` 0–21600 s) is enforced per channel using a Redis key; `BYPASS_SLOWMODE` exempt. **[VERIFIED: bit 52 & range]**
- **Feature-specific buckets (in-process, sliding window):** webhook delivery **30 / 10 s per webhook**; command invocation **20 / 10 s per user** (both `429 RATE_LIMITED`). **[VERIFIED: integration + e2e]**
- **Connection limits:** max sockets per user and per IP; oversized/slow sockets disconnected (see architecture backpressure).
- **Fail posture:** sensitive routes (auth) **fail closed** when the limiter is unavailable; benign routes fail open with a loud log. This per-route policy is **[DESIGN OPEN]**.

---

## 10. Webhooks, secrets, logging

### 10.1 Webhook authenticity
- A webhook is a **bearer capability**: the high-entropy `token` in the delivery URL (`POST /api/webhooks/{id}/{token}`) is the only credential. It is stored **only as a SHA-256 hash** (`token_hash`) and never returned after the one-time creation/rotation display. Possession of the URL is both necessary and sufficient — treat it as a credential. **[VERIFIED: e2e + integration]**
- The delivery endpoint is **public by design** (no session cookie, no CSRF); it authenticates via the URL token only. A wrong/unknown token → `401`; a **disabled** webhook → `403`; a deleted webhook → `404`.
- The destination channel is **bound to the webhook**; the request body cannot redirect it (unknown fields are rejected). **[VERIFIED: e2e cross-channel case]**
- Delivery is **idempotent** per `X-Idempotency-Key` (scoped per webhook) and **rate-limited to 30 deliveries / 10 s per webhook** (`429 RATE_LIMITED`). Managing webhooks requires `MANAGE_WEBHOOKS`. **[VERIFIED: bit 29 + e2e rate-limit case]**
- **No HMAC request signing** is implemented, and **no outbound URL is ever fetched** (embeds are validated/stored verbatim; no link-preview fetch) — no signing secret to manage, no SSRF surface. **[Not built: signing]**
- Lifecycle changes are recorded in the guild audit log (create=50, update/rotate/disable=51, delete=52). **[VERIFIED: integration + e2e]**

### 10.2 Secret management
- Required secrets come from env (`SESSION_SECRET`, DB/Redis credentials, optional `SMTP_URL`, storage credentials). `.env.example` documents them; `.env` is git-ignored.
- The server **refuses to boot** if `SESSION_SECRET` is missing/weak in production (`< 32 bytes` entropy check).
- No secrets are committed; no secrets logged; no secrets returned by any API after creation-time display (session tokens, webhook tokens, signing secrets).
- Rotation: `SESSION_SECRET` rotation invalidates sessions unless key-versioned; documented.

### 10.3 Privacy-aware logging & redaction **[DESIGN]**
- Structured logs (pino) with a **redaction list**: `req.headers.cookie`, `authorization`, `x-csrf-token`, `*.password`, `*.token`, `*.secret`, `*.email`, message `content`, and raw IPs.
- Emails are logged only as a truncated hash; IPs stored hashed (`sessions.ip_hash`) and logged only as a prefix or hash.
- **No message content in logs** by default; a debug flag can enable content logging and is refused when `NODE_ENV=production`.
- Error responses never include stack traces or SQL; `request_id` links a client error to a server-side log line.
- Audit `changes` diffs are redacted (no permission secrets, no PII beyond ids).

### 10.4 Data minimization
- IP stored only as a hash; user-agent stored for session display but pruned with the session.
- User deletion soft-deletes and anonymizes; messages authored by a deleted user are `SET NULL` (kept, author hidden) per the DB design.

---

## 11. Authorization test cases (acceptance gate)

Each case must be automated by an integration/security test (see [TEST_PLAN.md](./TEST_PLAN.md)). "Actor" is the authenticated principal; "Target" is the resource/action.

### 11.1 Horizontal privilege escalation (same role, other user's data)

| ID | Actor | Target / Action | Expected |
| --- | --- | --- | --- |
| H-01 | Member A | `GET /channels/{privateB}` where A lacks `VIEW_CHANNEL` | `403 MISSING_PERMISSIONS`; channel omitted from `GET /guilds/{id}/channels` |
| H-02 | Member A | `GET /channels/{textB}/messages` where A lacks `VIEW_CHANNEL` | `403`; no message bodies leaked |
| H-03 | Member A | `PATCH`/`DELETE` B's message without `MANAGE_MESSAGES` | `403`; message unchanged |
| H-04 | Member A | `GET /attachments/{id}` for an attachment in a channel A can't view | `403`; no bytes served |
| H-05 | Member A | Read A's DM channel that belongs to others (`GET /channels/{dmBetweenOthers}`) | `403`; not a recipient |
| H-06 | Member A | `POST /users/@me/channels` DM to a user who blocked A | `403 BLOCKED` |
| H-07 | Member A | `PATCH /guilds/{id}/members/{B}` nickname without `MANAGE_NICKNAMES` | `403` |
| H-08 | Member A | Reaction listing/get on a message in a channel A can't view | `403` |
| H-09 | Friend B (blocked by A) | `POST /users/@me/relationships` to A | `403 BLOCKED` |
| H-10 | Member A | Open a thread in a channel A can't `VIEW_CHANNEL` | `403` |

### 11.2 Vertical privilege escalation (lower role acting with higher privileges)

| ID | Actor | Target / Action | Expected |
| --- | --- | --- | --- |
| V-01 | Member (no perms) | `POST /guilds/{id}/channels` (needs `MANAGE_CHANNELS`) | `403 MISSING_PERMISSIONS` |
| V-02 | Member | `PUT /guilds/{id}/bans/{victim}` (needs `BAN_MEMBERS`) | `403` |
| V-03 | Member | `DELETE /channels/{id}/permissions/{role}` (needs `MANAGE_ROLES`) | `403` |
| V-04 | Moderator (lower than target) | Kick/ban a user whose highest role is **above** theirs | `403` (hierarchy) |
| V-05 | Moderator | Grant a permission they do **not** hold via role create/edit | `403` |
| V-06 | Member | Edit a role whose `position` is **above** their highest role | `403` |
| V-07 | Member | `PATCH /guilds/{id}/roles` reordering above their highest | `403` |
| V-08 | Non-owner | `DELETE /guilds/{id}` | `403` (owner only) |
| V-09 | Member | Set an overwrite to grant `ADMINISTRATOR` to themselves | `403` / stripped (cannot grant perms you lack) |
| V-10 | Timed-out member | `POST /channels/{id}/messages` (only `VIEW_CHANNEL`+`READ_MESSAGE_HISTORY`) | `403` |
| V-11 | Timed-out member | `VOICE_STATE_UPDATE` join (needs `CONNECT` beyond timeout allowance) | `403` |
| V-12 | Member | `POST /channels/{id}/messages` with `@everyone` without `MENTION_EVERYONE` | mention stripped; message posts without the ping |
| V-13 | Member | `POST` message with `tts:true` without `SEND_TTS_MESSAGES` | `403` |
| V-14 | Member without `SEND_MESSAGES` | Attach a file (`ATTACH_FILES` implicitly denied) | `403` |
| V-15 | Member | `GET /guilds/{id}/audit-logs` without `VIEW_AUDIT_LOG` | `403` |
| V-16 | Banned user | `POST /invites/{code}` to rejoin | `403` |
| V-17 | Any user | Forge `type` on `PUT /channels/{id}/permissions/{x}` to bypass scope | validated; invalid target rejected |
| V-18 | Anonymous | Any authenticated route | `401 UNAUTHENTICATED` |
| V-19 | Member without `MANAGE_WEBHOOKS` | Create/rotate/disable/delete/read a channel webhook | `403 MISSING_PERMISSIONS`; no state change |
| V-20 | Member without `MANAGE_CHANNELS` | `/topic <text>` slash command | `403`; channel topic unchanged (read-only `/topic` still works) |

### 11.3 Session / CSRF / auth cases

| ID | Scenario | Expected |
| --- | --- | --- |
| S-01 | Unsafe request without `X-CSRF-Token` | `403 CSRF_FAILED` |
| S-02 | Unsafe request with a token from another session | `403 CSRF_FAILED` |
| S-03 | Request with an expired/revoked session cookie | `401 UNAUTHENTICATED` |
| S-04 | Login with unknown user vs wrong password | identical `401` + comparable timing |
| S-05 | Reuse a pre-login session token after login (fixation) | old token invalid |
| S-06 | Password change | other sessions revoked; current remains valid |
| S-07 | Consistent-time scrypt compare | no early-exit timing leak |
| S-08 | Cookie flags | `HttpOnly`, `SameSite=Lax`, `Secure` in prod |

### 11.4 Upload / injection / webhook cases

| ID | Scenario | Expected |
| --- | --- | --- |
| U-01 | Upload a `.png` whose bytes are an HTML/PHP script | `415` (magic-byte mismatch) |
| U-02 | Upload > `MAX_UPLOAD_BYTES` | `413 PAYLOAD_TOO_LARGE` |
| U-03 | Upload when guild quota exceeded | `413 QUOTA_EXCEEDED` |
| U-04 | Download an attachment | `Content-Disposition: attachment`, `nosniff` present |
| U-05 | Crafted filename with `../` | key is server-generated; no traversal |
| I-01 | Message content `<script>` / `javascript:` link | rendered as text / link rejected; no script executes |
| I-02 | `id` parameter `1 OR 1=1` on any route | treated as invalid snowflake; no SQL effect |
| W-01 | Webhook call with a wrong/unknown token | `401 UNAUTHENTICATED`; no message created |
| W-02 | Webhook body tries to redirect the destination (`channelId`/unknown field) | `400` (strict schema); posts only to the bound channel |
| W-03 | Deliver to a **disabled** webhook | `403`; no message created |
| W-04 | Exceed the per-webhook delivery rate limit | `429 RATE_LIMITED` after 30 / 10 s |
| W-05 | Reuse a **rotated** token / deliver to a **deleted** webhook | `401` / `404` |
| W-06 | Read webhook list / delivery history | `token`/`token_hash` never present (`tokenPrefix` only) |
| W-07 | Embed URL points at an internal/non-routable address | stored verbatim, **never fetched** (no outbound HTTP → no SSRF) |

---

## 12. Secure development & operations

- **Dependencies:** pinned via lockfile; `npm audit`/Dependabot in CI; review before upgrades.
- **Secrets in CI:** provided via encrypted secrets; never echoed.
- **Headers (at proxy/app):** `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY` (+ `frame-ancestors 'none'`), `Content-Security-Policy` as in §5.
- **TLS:** terminated at the proxy; `Secure` cookies; HSTS in prod.
- **Backups:** `pg_dump` + uploads snapshot; restore drill documented; backups are as sensitive as production.
- **Incident response:** session revocation, webhook secret rotation, and force-logout are available operations; the audit log is the forensic record.
- **Threat-model review** is required when adding a new trust boundary (file parsing, URL fetching, new auth method, third-party integration).

---

## 13. Uncertainty / open items
- **[UNKNOWN]** Discord's exact internal session/CSRF mechanics are not replicated; Nebula defines its own (cookie + double-submit). No parity is claimed.
- **[DESIGN OPEN]** Argon2id vs scrypt (chosen: scrypt to avoid a native build dependency) may be revisited if `node:crypto` gains Argon2 or a WASM build is acceptable.
- **[DESIGN OPEN]** `token_hash` at-rest encryption requires a key-management decision; without a KMS it is stored as a restricted-access text column. (There is no `signing_secret` — webhook request signing was not built.)
- **[DESIGN OPEN]** Whether the slice implements TOTP enrollment or only the `mfa_level` gating.
- **[DESIGN OPEN]** Malware scanning for uploads is out of scope; a future AV integration is documented.
