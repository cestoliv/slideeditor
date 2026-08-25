import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button, Dialog, Field, Input } from "../../design/index.js";
import { api } from "../../app/api.js";
import type { AccessToken } from "../../app/api.js";
import styles from "./TokenSettings.module.css";

/*
 * Where a person mints and revokes the tokens an agent authenticates with.
 * Reached at /settings (router.tsx wraps it with the shared Header, the way
 * it wraps every other route), and hidden from the header entirely when the
 * server runs in "open" mode, where no token authenticates anything.
 *
 * Self-contained rather than drawing its own Header: it renders no <Link>,
 * so it needs no router context, which is what keeps its test free of one.
 */

export interface TokenSettingsProps {
  listTokens?: () => Promise<{ tokens: AccessToken[] }>;
  createToken?: (name: string) => Promise<{ token: AccessToken; secret: string }>;
  deleteToken?: (id: string) => Promise<void>;
}

/** api.js:272-285, without the execCommand fallback for a browser that has one. */
function copyText(value: string): void {
  void navigator.clipboard?.writeText(value).catch(() => undefined);
}

function mcpAddCommand(secret: string): string {
  const url = `${window.location.origin}/mcp`;
  return `claude mcp add --transport http slide-studio ${url} --header "Authorization: Bearer ${secret}"`;
}

export function TokenSettings({
  listTokens = api.listTokens,
  createToken = api.createToken,
  deleteToken = api.deleteToken,
}: TokenSettingsProps) {
  const [tokens, setTokens] = useState<AccessToken[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<{ token: AccessToken; secret: string } | null>(
    null,
  );

  const refresh = useCallback(() => {
    listTokens()
      .then((result) => setTokens(result.tokens))
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, [listTokens]);

  useEffect(refresh, [refresh]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createToken(trimmed);
      setMinted(created);
      setName("");
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn’t create the token.");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(token: AccessToken): Promise<void> {
    await deleteToken(token.id);
    refresh();
  }

  return (
    <>
      <main className={styles.settings}>
        <h1 className={styles.pageTitle}>Settings</h1>
        <section>
          <h2 className={styles.title}>New token</h2>
          <form className={styles.form} onSubmit={(event) => void submit(event)}>
            <div className={styles.formRow}>
              <Field label="Token name">
                <Input
                  value={name}
                  placeholder="e.g. laptop"
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Button type="submit" variant="solid" busy={creating}>
                Create token
              </Button>
            </div>
            {error === null ? null : (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
          </form>
        </section>

        <section>
          <h2 className={styles.title}>Tokens</h2>
          {loaded && tokens.length === 0 ? (
            <p className={styles.empty}>
              No tokens yet. An agent needs one to authenticate.
            </p>
          ) : (
            <ul className={styles.list}>
              {tokens.map((token) => (
                <li key={token.id} className={styles.row}>
                  <span className={styles.meta}>
                    <span className={styles.name}>{token.name}</span>
                    <code className={styles.prefix}>{token.prefix}</code>
                  </span>
                  <Button
                    variant="danger"
                    aria-label={`Revoke ${token.name}`}
                    onClick={() => void revoke(token)}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      <Dialog.Root
        open={minted !== null}
        onOpenChange={(open) => {
          if (!open) setMinted(null);
        }}
      >
        <Dialog.Content>
          <Dialog.Title>Token created</Dialog.Title>
          <Dialog.Description>
            <span className={styles.warning}>This will not be shown again.</span> Copy it
            now and store it somewhere safe.
          </Dialog.Description>
          {minted === null ? null : (
            <>
              <p className={styles.hint}>
                Paste this straight into a terminal to connect an agent:
              </p>
              <code className={styles.command}>{mcpAddCommand(minted.secret)}</code>
              <div className={styles.copyRow}>
                <Button onClick={() => copyText(minted.secret)}>Copy secret</Button>
              </div>
            </>
          )}
          <Dialog.Actions>
            <Dialog.Close asChild>
              <Button variant="solid">Done</Button>
            </Dialog.Close>
          </Dialog.Actions>
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}
