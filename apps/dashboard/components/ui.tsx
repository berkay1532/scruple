"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/* ---------- Badge ---------- */

export type BadgeTone = "ok" | "warn" | "bad" | "info" | "mut";

export function Badge({ tone, children }: { tone: BadgeTone; children?: ReactNode }) {
  return (
    <span className={`badge ${tone}`}>
      <span className="b" />
      {children}
    </span>
  );
}

/* ---------- Panel ---------- */

export function Panel({ className, children }: { className?: string; children?: ReactNode }) {
  return <div className={className ? `panel ${className}` : "panel"}>{children}</div>;
}

/* ---------- Drawer ---------- */

export function Drawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  return (
    <div className={`drawer-wrap${open ? " open" : ""}`}>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" aria-label="Details">
        {children}
      </aside>
    </div>
  );
}

/* ---------- Toast ---------- */

type ToastFn = (msg: string) => void;

const ToastContext = createContext<ToastFn | null>(null);

export function ToastProvider({ children }: { children?: ReactNode }) {
  const [msg, setMsg] = useState("");
  const [show, setShow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const toast = useCallback<ToastFn>((m) => {
    setMsg(m);
    setShow(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setShow(false), 2200);
  }, []);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className={`toast${show ? " show" : ""}`}>{msg}</div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastFn {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}
