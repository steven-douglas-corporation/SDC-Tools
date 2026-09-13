"use client";

import type { ReactNode } from "react";

// A submit button that asks for confirmation before letting its form's server
// action run — for destructive, one-click actions (delete task, remove Project
// Release, etc.) that previously fired immediately with no undo. Keeps the
// action on the server (progressive-enhancement friendly); only the confirm is
// client-side.
export function ConfirmSubmit({
  message,
  className,
  title,
  form,
  children,
}: {
  message: string;
  className?: string;
  title?: string;
  form?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="submit"
      form={form}
      title={title}
      className={className}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
