import { useEffect } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import type { Toast } from "../store";

/** Transient banner driven by the store's `toast` field. */
export function ToastHost({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(onClose, 6000);
    return () => clearTimeout(timer);
  }, [toast, onClose]);

  if (!toast) return null;

  const tone = {
    error: { border: "border-nebula-danger/40", icon: <AlertTriangle size={16} className="text-nebula-danger" aria-hidden /> },
    success: { border: "border-nebula-accent2/40", icon: <CheckCircle2 size={16} className="text-nebula-accent2" aria-hidden /> },
    info: { border: "border-nebula-accent/40", icon: <Info size={16} className="text-nebula-accent" aria-hidden /> },
  }[toast.kind];

  return (
    <div role="alert" aria-live="assertive" className="pointer-events-none fixed inset-x-0 top-4 z-50 flex justify-center">
      <div className={`pointer-events-auto flex items-center gap-3 rounded-md border ${tone.border} bg-nebula-900 px-4 py-2.5 text-sm text-slate-100 shadow-lg`}>
        {tone.icon}
        <span>{toast.message}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss notification"
          className="rounded p-1 text-slate-400 hover:bg-white/5 hover:text-slate-200"
        >
          <X size={14} aria-hidden />
        </button>
      </div>
    </div>
  );
}
