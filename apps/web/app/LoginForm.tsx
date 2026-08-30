"use client";

import { useActionState } from "react";
import { signIn } from "./actions";

export default function LoginForm({ next }: { next: string }) {
  const [error, action, pending] = useActionState(signIn, null);

  return (
    <form className="login" action={action}>
      <input type="hidden" name="next" value={next} />

      <label className="field">
        <span>Username</span>
        <input
          name="user"
          autoComplete="username"
          autoFocus
          required
          spellCheck={false}
          autoCapitalize="none"
        />
      </label>

      <label className="field">
        <span>Password</span>
        <input name="password" type="password" autoComplete="current-password" required />
      </label>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <button className="btn primary" type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
