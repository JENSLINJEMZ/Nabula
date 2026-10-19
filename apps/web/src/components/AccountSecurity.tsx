import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Copy, KeyRound, MailCheck, ShieldCheck, ShieldOff } from "lucide-react";
import { useApp } from "../store";
import { ApiError, apiDelete, apiGet, apiPost } from "../lib/api";

/**
 * Account-security settings: change password, email verification and TOTP
 * two-factor authentication (enrollment, activation, recovery codes, disable).
 * Every control talks to the real backend; nothing here is mocked.
 */
export function AccountSecurityTab() {
  const me = useApp((s) => s.me);
  const refreshSelf = useApp((s) => s.refreshSelf);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-6" data-testid="security-tab">
      {error && (
        <p role="alert" className="rounded-md border border-nebula-danger/40 bg-nebula-danger/10 px-3 py-2 text-sm text-nebula-danger">
          {error}
        </p>
      )}

      <ChangePasswordCard onError={setError} />
      <EmailVerificationCard email={me?.email ?? null} verified={me?.emailVerified ?? false} onRefresh={refreshSelf} />
      <TwoFactorCard
        enabled={me?.mfaEnabled ?? false}
        onRefresh={refreshSelf}
      />
    </div>
  );
}

function Card({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-nebula-800 bg-nebula-900/40 p-4">
      <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
      {description && <p className="mt-1 text-xs text-slate-500">{description}</p>}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function Feedback({ ok, message }: { ok: boolean; message: string }) {
  return (
    <p
      role="status"
      className={ok ? "text-xs text-nebula-accent2" : "text-xs text-nebula-danger"}
      data-testid={ok ? "security-success" : "security-error"}
    >
      {message}
    </p>
  );
}

// --------------------------------------------------------------- password ---

function ChangePasswordCard({ onError }: { onError: (message: string | null) => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);

  async function submit() {
    onError(null);
    setFeedback(null);
    if (next.length < 8) return setFeedback({ ok: false, message: "New password must be at least 8 characters." });
    if (next !== confirm) return setFeedback({ ok: false, message: "New passwords do not match." });
    setBusy(true);
    try {
      const res = await apiPost<{ ok: boolean; revokedSessions: number }>("/api/auth/password/change", {
        currentPassword: current,
        newPassword: next,
      });
      setFeedback({
        ok: true,
        message:
          res.revokedSessions > 0
            ? `Password updated. ${res.revokedSessions} other session${res.revokedSessions === 1 ? "" : "s"} signed out.`
            : "Password updated.",
      });
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setFeedback({ ok: false, message: err instanceof ApiError || err instanceof Error ? err.message : "Could not update password." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Change password" description="Changing your password signs out every other device.">
      <input
        className="input"
        type="password"
        autoComplete="current-password"
        placeholder="Current password"
        aria-label="Current password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
      />
      <input
        className="input"
        type="password"
        autoComplete="new-password"
        placeholder="New password"
        aria-label="New password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
      />
      <input
        className="input"
        type="password"
        autoComplete="new-password"
        placeholder="Confirm new password"
        aria-label="Confirm new password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      {feedback && <Feedback ok={feedback.ok} message={feedback.message} />}
      <button
        type="button"
        className="btn-primary text-sm"
        disabled={busy || !current || !next}
        onClick={() => void submit()}
      >
        {busy ? "Updating…" : "Update password"}
      </button>
    </Card>
  );
}

// ------------------------------------------------------------------ email ---

function EmailVerificationCard({
  email,
  verified,
  onRefresh,
}: {
  email: string | null;
  verified: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);

  async function resend() {
    setBusy(true);
    setFeedback(null);
    try {
      await apiPost("/api/auth/email/verify-request");
      setFeedback({ ok: true, message: "Verification email sent. Check your inbox." });
      await onRefresh();
    } catch (err) {
      setFeedback({ ok: false, message: err instanceof Error ? err.message : "Could not send verification email." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Email verification">
      {email ? (
        <p className="flex items-center gap-2 text-sm text-slate-300" data-testid="email-status">
          {verified ? (
            <>
              <MailCheck size={15} aria-hidden className="text-nebula-accent2" />
              <span className="text-nebula-accent2">{email} verified</span>
            </>
          ) : (
            <>
              <MailCheck size={15} aria-hidden className="text-amber-400" />
              <span>{email} — not yet verified</span>
            </>
          )}
        </p>
      ) : (
        <p className="text-sm text-slate-400">No email address is on file for this account.</p>
      )}

      {email && !verified && (
        <button type="button" className="btn-ghost text-sm" disabled={busy} onClick={() => void resend()}>
          {busy ? "Sending…" : "Resend verification email"}
        </button>
      )}
      {feedback && <Feedback ok={feedback.ok} message={feedback.message} />}
    </Card>
  );
}

// -------------------------------------------------------------- two-factor ---

interface EnrollState {
  secret: string;
  uri: string;
  qrDataUrl: string;
}

function TwoFactorCard({ enabled, onRefresh }: { enabled: boolean; onRefresh: () => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [enrollment, setEnrollment] = useState<EnrollState | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");

  const [regenPassword, setRegenPassword] = useState("");
  const [regenCode, setRegenCode] = useState("");

  const reloadStatus = useCallback(async () => {
    try {
      const res = await apiGet<{ mfaEnabled: boolean; recoveryCodesRemaining: number }>("/api/auth/2fa");
      setRemaining(res.recoveryCodesRemaining);
    } catch {
      setRemaining(null);
    }
  }, []);

  useEffect(() => {
    void reloadStatus();
  }, [reloadStatus, enabled]);

  async function startEnroll() {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiPost<EnrollState>("/api/auth/2fa/enroll", { password });
      setEnrollment(res);
      setPassword("");
    } catch (err) {
      setFeedback({ ok: false, message: err instanceof Error ? err.message : "Could not start enrollment." });
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiPost<{ recoveryCodes: string[] }>("/api/auth/2fa/activate", { code: code.trim() });
      setRecoveryCodes(res.recoveryCodes);
      setEnrollment(null);
      setCode("");
      setFeedback({ ok: true, message: "Two-factor authentication enabled." });
      await onRefresh();
      await reloadStatus();
    } catch (err) {
      setFeedback({ ok: false, message: err instanceof Error ? err.message : "Could not activate 2FA." });
    } finally {
      setBusy(false);
    }
  }

  async function cancelEnroll() {
    setEnrollment(null);
    setCode("");
    await apiPost("/api/auth/2fa/enroll/cancel").catch(() => undefined);
  }

  async function disable() {
    setBusy(true);
    setFeedback(null);
    try {
      await apiPost("/api/auth/2fa/disable", {
        password: disablePassword,
        code: disableCode.trim() || undefined,
      });
      setFeedback({ ok: true, message: "Two-factor authentication disabled." });
      setDisablePassword("");
      setDisableCode("");
      await onRefresh();
      await reloadStatus();
    } catch (err) {
      setFeedback({ ok: false, message: err instanceof Error ? err.message : "Could not disable 2FA." });
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiPost<{ recoveryCodes: string[] }>("/api/auth/2fa/recovery-codes", {
        password: regenPassword,
        code: regenCode.trim() || undefined,
      });
      setRecoveryCodes(res.recoveryCodes);
      setRegenPassword("");
      setRegenCode("");
      await reloadStatus();
    } catch (err) {
      setFeedback({ ok: false, message: err instanceof Error ? err.message : "Could not regenerate recovery codes." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Two-factor authentication"
      description="Protect your account with a TOTP authenticator app (Google Authenticator, Authy, 1Password…)."
    >
      <p className="flex items-center gap-2 text-sm" data-testid="mfa-status">
        {enabled ? (
          <>
            <ShieldCheck size={15} aria-hidden className="text-nebula-accent2" />
            <span className="text-nebula-accent2">Enabled</span>
            {remaining !== null && <span className="text-xs text-slate-500">· {remaining} recovery codes left</span>}
          </>
        ) : (
          <>
            <ShieldOff size={15} aria-hidden className="text-slate-400" />
            <span className="text-slate-400">Disabled</span>
          </>
        )}
      </p>

      {recoveryCodes && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3" data-testid="recovery-codes">
          <p className="text-xs font-semibold text-amber-300">
            Save these recovery codes now — they are shown only once.
          </p>
          <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm text-slate-100">
            {recoveryCodes.map((rc) => (
              <li key={rc}>{rc}</li>
            ))}
          </ul>
          <button
            type="button"
            className="btn-ghost mt-2 text-xs"
            onClick={() => {
              void navigator.clipboard?.writeText(recoveryCodes.join("\n"));
            }}
          >
            <Copy size={13} aria-hidden className="mr-1 inline" /> Copy codes
          </button>
        </div>
      )}

      {!enabled && !enrollment && (
        <div className="space-y-2">
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            placeholder="Confirm your password to begin"
            aria-label="Password to begin 2FA enrollment"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="button" className="btn-primary text-sm" disabled={busy || !password} onClick={() => void startEnroll()}>
            {busy ? "Starting…" : "Set up 2FA"}
          </button>
        </div>
      )}

      {!enabled && enrollment && (
        <div className="space-y-3" data-testid="mfa-enrollment">
          <p className="text-xs text-slate-400">
            Scan this QR code, or enter the setup key manually, then confirm with a generated code.
          </p>
          <img src={enrollment.qrDataUrl} alt="Scan with your authenticator app" className="h-40 w-40 rounded bg-white p-2" />
          <p className="break-all font-mono text-xs text-slate-400" data-testid="mfa-manual-key">
            <KeyRound size={12} aria-hidden className="mr-1 inline" />
            {enrollment.secret}
          </p>
          <input
            className="input tracking-[0.4em]"
            inputMode="numeric"
            maxLength={6}
            placeholder="000000"
            aria-label="Authenticator code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          />
          <div className="flex items-center gap-2">
            <button type="button" className="btn-primary text-sm" disabled={busy || code.length !== 6} onClick={() => void activate()}>
              {busy ? "Verifying…" : "Verify and enable"}
            </button>
            <button type="button" className="btn-ghost text-sm" onClick={() => void cancelEnroll()}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {enabled && (
        <div className="space-y-4 border-t border-nebula-800 pt-3">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Disable 2FA</p>
            <input
              className="input"
              type="password"
              placeholder="Password"
              aria-label="Password to disable 2FA"
              value={disablePassword}
              onChange={(e) => setDisablePassword(e.target.value)}
            />
            <input
              className="input tracking-[0.4em]"
              inputMode="numeric"
              maxLength={6}
              placeholder="Authenticator code"
              aria-label="Authenticator code to disable 2FA"
              value={disableCode}
              onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, ""))}
            />
            <button
              type="button"
              className="btn-ghost text-sm text-nebula-danger"
              disabled={busy || !disablePassword || disableCode.length !== 6}
              onClick={() => void disable()}
            >
              Disable two-factor
            </button>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Regenerate recovery codes</p>
            <input
              className="input"
              type="password"
              placeholder="Password"
              aria-label="Password to regenerate recovery codes"
              value={regenPassword}
              onChange={(e) => setRegenPassword(e.target.value)}
            />
            <input
              className="input tracking-[0.4em]"
              inputMode="numeric"
              maxLength={6}
              placeholder="Authenticator code"
              aria-label="Authenticator code to regenerate recovery codes"
              value={regenCode}
              onChange={(e) => setRegenCode(e.target.value.replace(/\D/g, ""))}
            />
            <button
              type="button"
              className="btn-ghost text-sm"
              disabled={busy || !regenPassword || regenCode.length !== 6}
              onClick={() => void regenerate()}
            >
              Regenerate codes
            </button>
          </div>
        </div>
      )}

      {feedback && (
        <p className="flex items-center gap-1">
          {feedback.ok && <CheckCircle2 size={13} aria-hidden className="text-nebula-accent2" />}
          <Feedback ok={feedback.ok} message={feedback.message} />
        </p>
      )}
    </Card>
  );
}

// Re-exported for the sessions tab so it can reuse the same revoke helper.
export async function revokeSession(id: string): Promise<void> {
  await apiDelete(`/api/auth/sessions/${id}`);
}
