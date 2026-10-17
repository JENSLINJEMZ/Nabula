import { useState, type FormEvent } from "react";
import { useApp } from "../store";

type Mode = "login" | "register";

export function AuthScreen() {
  const login = useApp((s) => s.login);
  const register = useApp((s) => s.register);

  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (mode === "register") {
      if (username.trim().length < 2) return setError("Username must be at least 2 characters.");
      if (password.length < 8) return setError("Password must be at least 8 characters.");
    }

    setBusy(true);
    try {
      if (mode === "login") {
        await login(username.trim(), password);
      } else {
        await register(username.trim(), password, inviteCode.trim() || undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-gradient-to-br from-nebula-950 via-nebula-900 to-nebula-950 px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-nebula-accent text-2xl font-black text-white shadow-lg shadow-nebula-accent/30">
            N
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Nebula</h1>
          <p className="mt-1 text-sm text-slate-400">
            {mode === "login" ? "Welcome back to your constellation." : "Create your account."}
          </p>
        </div>

        <form onSubmit={onSubmit} className="card space-y-4 p-6" noValidate>
          <div className="space-y-1.5">
            <label htmlFor="username" className="block text-xs font-semibold uppercase tracking-wide text-slate-400">
              Username
            </label>
            <input
              id="username"
              name="username"
              className="input"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="your_handle"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password" className="block text-xs font-semibold uppercase tracking-wide text-slate-400">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              className="input"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          {mode === "register" && (
            <div className="space-y-1.5">
              <label htmlFor="invite" className="block text-xs font-semibold uppercase tracking-wide text-slate-400">
                Invite code <span className="font-normal normal-case text-slate-500">(optional)</span>
              </label>
              <input
                id="invite"
                name="invite"
                className="input"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder="Join a server on sign-up"
              />
            </div>
          )}

          {error && (
            <p role="alert" className="rounded-md border border-nebula-danger/40 bg-nebula-danger/10 px-3 py-2 text-sm text-nebula-danger">
              {error}
            </p>
          )}

          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? "Please wait…" : mode === "login" ? "Log in" : "Create account"}
          </button>

          <p className="text-center text-sm text-slate-400">
            {mode === "login" ? "Need an account? " : "Already registered? "}
            <button
              type="button"
              className="font-medium text-nebula-accent hover:underline"
              onClick={() => {
                setMode(mode === "login" ? "register" : "login");
                setError(null);
              }}
            >
              {mode === "login" ? "Register" : "Log in"}
            </button>
          </p>
        </form>
      </div>
    </div>
  );
}
