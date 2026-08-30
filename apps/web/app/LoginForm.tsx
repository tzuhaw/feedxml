const MESSAGES: Record<string, string> = {
  credentials: "Those credentials weren't recognised.",
  unconfigured: "No operator accounts exist yet — create one with the adminuser script.",
};

/**
 * A plain form posting to /api/session. No client JavaScript is involved, so
 * it works before hydration and stays testable over plain HTTP.
 */
export default function LoginForm({ next, error }: { next: string; error?: string }) {
  const message = error ? (MESSAGES[error] ?? "Sign-in failed.") : null;

  return (
    <form className="login" action="/api/session" method="POST">
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

      {message && (
        <p className="error" role="alert">
          {message}
        </p>
      )}

      <button className="btn primary" type="submit">
        Sign in
      </button>
    </form>
  );
}
