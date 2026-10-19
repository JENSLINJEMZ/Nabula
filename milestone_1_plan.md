# MILESTONE 1: Authentication & Account Security - Implementation Plan

## Phase 1 - Repository Inspection Summary

### Current State
- Users table exists with `email_verified BOOLEAN DEFAULT FALSE`, password hash/salt/params (scrypt). No 2FA fields, no email verification tokens logic beyond table `email_tokens` (schema exists).
- `email_tokens` table (type: 'verify_email' or 'reset_password', token_hash, expires_at, used_at). No domain routes using it yet.
- Sessions: token_hash, csrf_secret, revoked_at, expires_at; list/revoke/logout-all implemented; HttpOnly+CSRF in place.
- Auth routes: register/login/logout/me/sessions endpoints exist.
- Settings UI has sessions tab only; Auth has login/register only. No password change UI, no forgot/reset, no 2FA, no verify-email UI.
- No mailer module. No TOTP library deps. SMTP_URL in config but unused.
- password hashing is scrypt (node:crypto). verifyPassword/hashPassword implemented.
- No TOTP encryption key env var yet.

### Gaps Identified
1. Change password (current password verification, new password, confirm, revoke sessions policy)
2. Email verification (generate/verify tokens, resend, email sending with SMTP, dev/test fallback)
3. Forgot password / reset password (secure tokens, generic response, invalidate sessions)
4. 2FA/TOTP (enroll, verify, disable, login second factor)
5. Recovery codes (generate hashes, single-use, display once)
6. Session management improvements (ensure Socket.IO respects revoked; already filters revoked/expired on resolve; gateway uses session auth)
7. New migrations for 2FA/recovery codes (users may need 2FA fields like mfa_enabled, mfa_secret_encrypted etc.)
8. New env vars: TOTP_ENCRYPTION_KEY, SMTP_FROM, maybe APP_URL/PUBLIC_WEB_ORIGIN related for links
9. Frontend routes/pages for forgot/reset/verify-email
10. Tests for all new flows

### Implementation Plan

#### DB Schema Changes
Need migrations (forward-only):
- Add to users: `mfa_enabled BOOLEAN DEFAULT FALSE`, `mfa_secret TEXT` (encrypted) - maybe store as encrypted blob; or `mfa_secret_enc` bytea/text with nonce
- New table `totp_recovery_codes` (user_id FK, code_hash TEXT UNIQUE, used_at TIMESTAMPTZ NULL, created_at)
- Possibly adjust `email_tokens` - already fine

Create migration file 0006_account_security.sql.

#### Config
Add env vars:
- `TOTP_ENCRYPTION_KEY` (min 32 chars) - for encrypting TOTP secrets at rest. Must not equal SESSION_SECRET.
- `SMTP_FROM` (default or required depending)
- `SMTP_URL` already exists
- `APP_URL` or derive from PUBLIC_WEB_ORIGIN for verification/reset links

Update config validation and production checks.

#### Server additions
- `apps/server/src/mail/mailer.ts` - SMTP send (nodemailer if available? not installed; add minimal or use nodemailer). Check: can add dependency. But user wants to implement; maybe use `node:https`/`node:smtp` is overkill. Add `nodemailer` to server deps? Let us check if we can add. The environment allows installing deps in workspace.
- `apps/server/src/auth/totp.ts` - TOTP helpers (generate secret, verify code, QR data) using `otplib` + `qrcode`? Need to add deps.
- `apps/server/src/auth/encryption.ts` - encrypt/decrypt for TOTP secret (AES-256-GCM with TOTP_ENCRYPTION_KEY).
- Domain: `apps/server/src/domain/accountSecurity.ts` - change password, email verify/reset, 2FA/recovery logic.
- Routes: extend auth routes with new endpoints + add pages/routes for verify/reset.

#### Frontend
- Update Settings with Password/2FA/Email verification sections
- Add Auth pages: ForgotPassword, ResetPassword, VerifyEmail (or integrate into routes)
- Update store with API calls
- Add routes for /auth/forgot-password, /auth/reset-password, /auth/verify-email

#### Testing
Add tests in server/test for account security flows; add E2E specs.

This is a substantial feature set. Proceeding to implementation phase. First add necessary dependencies and migrations.

---

## Implementation status (2026-10-19) — all 10 gaps closed

| # | Gap | Status |
| --- | --- | --- |
| 1 | Change password | **Done** — `POST /api/auth/password/change` (re-auth, revokes other sessions) + Security tab UI. |
| 2 | Email verification | **Done** — hashed single-use 24 h tokens, resend rate-limited, SMTP or `.eml` capture, prod fails safe with `MAIL_NOT_CONFIGURED`. |
| 3 | Forgot / reset password | **Done** — generic `202` (no enumeration), single-use 1 h token, revokes all sessions, replay rejected. |
| 4 | 2FA / TOTP | **Done** — `otplib` v13; password-reauth enroll, verify-before-activate, disable, QR + manual key, second-factor login challenge. |
| 5 | Recovery codes | **Done** — 10 CSPRNG codes, SHA-256 at rest, single-use, shown only on (re)generation. |
| 6 | Session / Socket.IO revocation | **Done** — `realtime/sessionSockets.ts` registry; revocation emits `SESSION_REVOKED` and disconnects (single-process; multi-node gap documented). |
| 7 | Migrations | **Done** — `0006_account_security.sql` (forward-only): `users.mfa_secret_enc`/`mfa_enrolled_at`, `totp_recovery_codes`, `mfa_challenges`, `security_events`, `email_tokens` index. |
| 8 | Env vars | **Done** — `TOTP_ENCRYPTION_KEY` (required, ≥32, ≠ `SESSION_SECRET`), `SMTP_FROM`, `MAIL_DEV_DIR`, exported `APP_URL`; production fail-fast checks. |
| 9 | Frontend routes/pages | **Done** — `/forgot-password`, `/reset-password`, `/verify-email`; Settings → Security (password/email/2FA/recovery/sessions); login 2FA step. |
| 10 | Tests | **Done** — 15 server integration + 2 new rate-limit/CSRF tests + 3 Playwright specs (139/139 total green). |

Dependencies added (`apps/server`): `otplib@13`, `qrcode`, `nodemailer@10`, plus dev `@types/qrcode`, `@types/nodemailer`.

Remaining external step: set `SMTP_URL` (+`SMTP_FROM`) for real outbound email. See `docs/FINAL_ACCEPTANCE_REPORT.md` §15.
