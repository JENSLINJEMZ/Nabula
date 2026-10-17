import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { PublicUser } from "@nebula/shared";
import { avatarColor, cx, presenceColor } from "../lib/ui";

/* -------------------------------------------------------------- Avatar */

export function Avatar({
  user,
  id,
  name,
  size = 40,
  presence,
}: {
  user?: PublicUser | null;
  id?: string;
  name?: string;
  size?: number;
  presence?: string;
}) {
  const resolvedId = user?.id ?? id ?? "?";
  const label = name ?? user?.displayName ?? user?.username ?? "?";
  const url = user?.avatarUrl;
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      {url ? (
        <img
          src={url}
          alt=""
          className="h-full w-full rounded-full object-cover"
          style={{ width: size, height: size }}
        />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center rounded-full font-semibold text-white"
          style={{ backgroundColor: avatarColor(resolvedId), fontSize: size * 0.36 }}
          aria-hidden
        >
          {label.slice(0, 2).toUpperCase()}
        </span>
      )}
      {presence !== undefined && (
        <span
          className="absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-nebula-950"
          style={{
            backgroundColor: presenceColor(presence),
            width: Math.max(10, size * 0.3),
            height: Math.max(10, size * 0.3),
          }}
          aria-hidden
        />
      )}
    </span>
  );
}

/* ------------------------------------------------------------ IconButton */

export function IconButton({
  title,
  onClick,
  children,
  tone = "default",
  className,
  pressed,
  disabled,
}: {
  title: string;
  onClick?: (e: React.MouseEvent) => void;
  children: ReactNode;
  tone?: "default" | "danger" | "accent";
  className?: string;
  pressed?: boolean;
  disabled?: boolean;
}) {
  const tones = {
    default: "text-slate-400 hover:bg-white/5 hover:text-slate-100",
    danger: "text-slate-400 hover:bg-nebula-danger/10 hover:text-nebula-danger",
    accent: "text-slate-400 hover:bg-nebula-accent/10 hover:text-nebula-accent",
  } as const;
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "rounded p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        tones[tone],
        className,
      )}
    >
      {children}
    </button>
  );
}

/* --------------------------------------------------------------- Switch */

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-40",
        checked ? "bg-nebula-accent2" : "bg-nebula-700",
      )}
    >
      <span
        className={cx(
          "absolute h-5 w-5 rounded-full bg-white shadow transition-all",
          checked ? "left-[22px]" : "left-0.5",
        )}
      />
    </button>
  );
}

/* ---------------------------------------------------------------- Field */

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

/* ---------------------------------------------------------------- Modal */

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  size = "md",
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
}) {
  const width = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" }[size];
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(
          "flex max-h-[85vh] w-full flex-col overflow-hidden rounded-xl border border-nebula-700 bg-nebula-900 shadow-2xl",
          width,
        )}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-nebula-800 px-5 py-3">
          <div>
            <h2 className="font-semibold text-slate-100">{title}</h2>
            {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
          </div>
          <IconButton title="Close" onClick={onClose}>
            <X size={18} aria-hidden />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <footer className="shrink-0 border-t border-nebula-800 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

/* --------------------------------------------------------- Outside click */

export function useOutsideClick<T extends HTMLElement>(onOutside: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onOutside]);
  return ref;
}

/* ------------------------------------------------------------- Dropdown */

export function Dropdown({
  trigger,
  children,
  align = "right",
  className,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClick<HTMLDivElement>(() => setOpen(false));
  return (
    <div ref={ref} className={cx("relative", className)}>
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open && (
        <div
          role="menu"
          className={cx(
            "absolute z-30 mt-1 min-w-48 overflow-hidden rounded-lg border border-nebula-700 bg-nebula-900 py-1 shadow-2xl",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  danger,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cx(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors",
        danger ? "text-nebula-danger hover:bg-nebula-danger/10" : "text-slate-300 hover:bg-white/5 hover:text-slate-100",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
