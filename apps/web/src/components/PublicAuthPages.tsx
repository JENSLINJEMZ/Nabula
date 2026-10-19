import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiPost } from "../lib/api";
import { useApp } from "../store";

/**
 * Public (signed-out-friendly) account pages reached from email links:
 * forgot-password, reset-password and verify-email. Each is wired to the real
 * backend; errors are shown, never masked as success.
 */

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-gradient-to-br from-nebula-950 via-nebula-900 to-nebula-950 px-4 py-8">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-nebula-accent text-2xl font-black text-white shadow-lg shadow-nebula-accent/30">
            N
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">{title}</h1>
          <p className="mt-1 text-sm text-slate-400">{subtitle}</p>
        </div>
        <div className="card space-y-4 p-6">{children}</div>
      </div>
    </div>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await apiPost<{ ok: boolean; message: string }>("/api/auth/password/forgot", {
        email: email.trim(),
      });
      setMessage(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell title="Reset your password" subtitle="We'll email you a secure link to choose a new password.">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <label htmlFor="forgot-email" className="block text-xs font-semibold uppercase tracking-wide text-slate-400">
            Email address
          </label>
          <input
            id="forgot-email"
            name="email"
            type="email"
            className="input"
            autoComplete="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </div>

        {message && (
          <p role="status" data-testid="forgot-success" className="rounded-md border border-nebula-accent2/40 bg-nebula-accent2/10 px-3 py-2 text-sm text-nebula-accent2">
            {message}
          </p>
        )}
        {error && (
          <p role="alert" className="rounded-md border border-nebula-danger/40 bg-nebula-danger/10 px-3 py-2 text-sm text-nebula-danger">
            {error}
          </p>
        )}

        <button type="submit" className="btn-primary w-full" disabled={busy || !email}>
          {busy ? "Sending…" : "Send reset link"}
        </button>
        <p className="text-center text-sm">
          <Link to="/" className="text-slate-400 hover:text-nebula-accent hover:underline">
            Back to sign in
          </Link>
        </p>
      </form>
    </Shell>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const refreshSelf = useApp((s) => s.refreshSelf);
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (next.length < 8) return setError("Password must be at least 8 characters.");
    if (next !== confirm) return setError("Passwords do not match.");
    setBusy(true);
    try {
      await apiPost("/api/auth/password/reset", { token, newPassword: next });
      setDone(true);
      void refreshSelf().catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "This reset link is invalid or has expired.");
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <Shell title="Reset your password" subtitle="This link is missing its reset token.">
        <p className="text-sm text-nebula-danger">The reset link is incomplete. Request a new one.</p>
        <Link to="/forgot-password" className="btn-primary block text-center">
          Request a new link
        </Link>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell title="Password updated" subtitle="You can now sign in with your new password.">
        <p role="status" data-testid="reset-success" className="text-sm text-nebula-accent2">
          Your password has been changed and all other sessions were signed out.
        </p>
        <Link to="/" className="btn-primary block text-center">
          Go to sign in
        </Link>
      </Shell>
    );
  }

  return (
    <Shell title="Choose a new password" subtitle="Pick something you haven't used before.">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          placeholder="New password"
          aria-label="New password"
          autoFocus
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
        {error && (
          <p role="alert" data-testid="reset-error" className="rounded-md border border-nebula-danger/40 bg-nebula-danger/10 px-3 py-2 text-sm text-nebula-danger">
            {error}
          </p>
        )}
        <button type="submit" className="btn-primary w-full" disabled={busy || !next || !confirm}>
          {busy ? "Updating…" : "Reset password"}
        </button>
      </form>
    </Shell>
  );
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const refreshSelf = useApp((s) => s.refreshSelf);
  const [state, setState] = useState<"pending" | "ok" | "error">("pending");
  const [error, setError] = useState<string | null>(null);
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    if (!token) {
      setState("error");
      setError("This verification link is missing its token.");
      return;
    }
    void (async () => {
      try {
        await apiPost("/api/auth/email/verify", { token });
        setState("ok");
        void refreshSelf().catch(() => undefined);
      } catch (err) {
        setState("error");
        setError(err instanceof Error ? err.message : "This verification link is invalid or has expired.");
      }
    })();
  }, [token, refreshSelf]);

  return (
    <Shell title="Verify your email" subtitle="Confirming the address on your Nebula account.">
      {state === "pending" && (
        <p role="status" className="text-sm text-slate-400">
          Verifying…
        </p>
      )}
      {state === "ok" && (
        <p role="status" data-testid="verify-success" className="text-sm text-nebula-accent2">
          Your email address is verified.
        </p>
      )}
      {state === "error" && (
        <p role="alert" data-testid="verify-error" className="text-sm text-nebula-danger">
          {error}
        </p>
      )}
      <Link to="/" className="btn-primary block text-center">
        Continue to Nebula
      </Link>
    </Shell>
  );
}
