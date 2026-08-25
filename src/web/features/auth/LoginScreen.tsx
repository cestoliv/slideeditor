import { useState, type FormEvent } from "react";
import { Button, Card, Field, Input } from "../../design/index.js";
import { api } from "../../app/api.js";
import styles from "./LoginScreen.module.css";

/*
 * What the Gate in App.tsx renders in place of the whole app whenever the
 * session probe says nobody is signed in. There is nothing else on screen: no
 * header, no library, because none of it will answer until this succeeds.
 */

export interface LoginScreenProps {
  onSignedIn: () => void;
  /** Injected so a test needs no network. */
  login?: (password: string) => Promise<void>;
}

export function LoginScreen({ onSignedIn, login = api.login }: LoginScreenProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!password || pending) return;
    setPending(true);
    setError(null);
    try {
      await login(password);
      onSignedIn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign in failed.");
      // The value is wrong, and leaving it invites a second identical attempt.
      setPassword("");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={styles.screen}>
      <Card className={styles.card} padding="lg">
        <span className={styles.mark} aria-hidden="true" />
        <h1 className={styles.title}>Slide Studio</h1>
        <p className={styles.intro}>Enter the password to open this server’s editor.</p>
        <form className={styles.form} onSubmit={(event) => void submit(event)}>
          <Field label="Password">
            <Input
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          {error === null ? null : (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <Button
            className={styles.submit}
            type="submit"
            variant="solid"
            busy={pending}
            disabled={pending}
          >
            Sign in
          </Button>
        </form>
      </Card>
    </div>
  );
}
