import { useEffect } from "react";
import { BrowserRouter } from "react-router-dom";
import { useApp } from "./store";
import { AuthScreen } from "./components/Auth";
import { AppRoutes } from "./routes";
import { ToastHost } from "./components/Toast";

export default function App() {
  const booted = useApp((s) => s.booted);
  const me = useApp((s) => s.me);
  const bootstrap = useApp((s) => s.bootstrap);
  const toast = useApp((s) => s.toast);
  const dismissToast = useApp((s) => s.dismissToast);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (!booted) {
    return (
      <div className="flex h-full items-center justify-center bg-nebula-950">
        <div className="flex flex-col items-center gap-3 text-slate-400" role="status" aria-live="polite">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-nebula-600 border-t-nebula-accent" />
          <span className="text-sm">Loading Nebula…</span>
        </div>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <div className="h-full">
        {me ? <AppRoutes /> : <AuthScreen />}
        <ToastHost toast={toast} onClose={dismissToast} />
      </div>
    </BrowserRouter>
  );
}
