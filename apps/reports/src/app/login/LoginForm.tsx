"use client";

import Image from "next/image";
import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { registerUser, changePassword } from "./actions";

type Mode = "signin" | "signup" | "change";

export default function LoginForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  function switchMode(next: Mode) {
    setMode(next);
    setError("");
    setNotice("");
    setPassword("");
    setNewPassword("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      if (mode === "change") {
        const res = await changePassword({ email, currentPassword: password, newPassword });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        // Back to sign-in with the email prefilled and a confirmation.
        setMode("signin");
        setPassword("");
        setNewPassword("");
        setNotice("Password changed — sign in with your new password.");
        return;
      }
      if (mode === "signup") {
        const res = await registerUser({ name, email, password });
        if (!res.ok) {
          setError(res.error);
          return;
        }
      }
      const res = await signIn("credentials", { email, password, redirect: false });
      if (res?.error) {
        setError(mode === "signup" ? "Account created, but sign-in failed. Try signing in." : "Invalid email or password.");
        return;
      }
      router.push("/");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const title = mode === "signin" ? "Sign in" : mode === "signup" ? "Create your account" : "Change password";
  const subtitle =
    mode === "signin"
      ? "Use your Steven Douglas Corp. account"
      : mode === "signup"
        ? "Set up a new SDC Projects Reports account"
        : "Enter your current password, then a new one";
  const submitLabel = mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Change password";

  return (
    <div className="flex min-h-[var(--app-vh)] items-center justify-center bg-background">
      <div className="relative w-full max-w-sm space-y-5 overflow-hidden rounded-2xl border border-sdc-border bg-white p-8 shadow-xl">
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-sdc-blue to-sdc-blue-dark" />
        <div className="flex flex-col items-center gap-2 pb-2">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-sdc-navy">
            <Image src="/brand/sdc-logo-white.png" alt="SDC" width={28} height={16} unoptimized />
          </div>
          <h1 className="font-heading text-lg font-bold text-sdc-navy">{title}</h1>
          <p className="text-xs text-sdc-gray-400">{subtitle}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {mode === "signup" && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-sdc-gray-700">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-sdc-border px-3 py-2 text-sm focus:border-sdc-blue focus:outline-none"
                autoComplete="name"
                required
              />
            </div>
          )}
          <div className="space-y-1">
            <label className="text-xs font-medium text-sdc-gray-700">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-sdc-border px-3 py-2 text-sm focus:border-sdc-blue focus:outline-none"
              autoComplete="email"
              required
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-sdc-gray-700">{mode === "change" ? "Current password" : "Password"}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-sdc-border px-3 py-2 text-sm focus:border-sdc-blue focus:outline-none"
              autoComplete={mode === "signin" || mode === "change" ? "current-password" : "new-password"}
              required
            />
          </div>
          {mode === "change" && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-sdc-gray-700">New password</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full rounded-lg border border-sdc-border px-3 py-2 text-sm focus:border-sdc-blue focus:outline-none"
                autoComplete="new-password"
                required
              />
            </div>
          )}
          {notice && <p className="text-sm text-sdc-green-text">{notice}</p>}
          {error && <p className="text-sm text-sdc-red-text">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-sdc-blue py-2 text-sm font-medium text-white shadow-sm hover:bg-sdc-blue-dark disabled:opacity-60"
          >
            {busy ? "Please wait…" : submitLabel}
          </button>
        </form>

        <div className="space-y-1 text-center text-xs text-sdc-gray-400">
          {mode === "signin" && (
            <>
              <p>
                Don&apos;t have an account?{" "}
                <button type="button" onClick={() => switchMode("signup")} className="font-medium text-sdc-blue hover:underline">
                  Create one
                </button>
              </p>
              <p>
                <button type="button" onClick={() => switchMode("change")} className="font-medium text-sdc-blue hover:underline">
                  Change password
                </button>
              </p>
            </>
          )}
          {mode === "signup" && (
            <p>
              Already have an account?{" "}
              <button type="button" onClick={() => switchMode("signin")} className="font-medium text-sdc-blue hover:underline">
                Sign in
              </button>
            </p>
          )}
          {mode === "change" && (
            <p>
              <button type="button" onClick={() => switchMode("signin")} className="font-medium text-sdc-blue hover:underline">
                Back to sign in
              </button>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
