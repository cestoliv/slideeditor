import { useState } from "react";
import type { Account } from "@shared/schema/index.js";
import { Button, Dialog, Field, Select } from "../../design/index.js";
import type { SelectOption } from "../../design/index.js";

/** Where the account chosen for the last new slideshow is kept between visits. */
export const LAST_ACCOUNT_KEY = "slide-studio:last-account";

export type NewSlideshowDialogProps = {
  open: boolean;
  accounts: readonly Account[];
  onOpenChange: (open: boolean) => void;
  // Resolves `true` only for a create that actually returned a project —
  // `false` covers both a caller that caught its own error (Dashboard's
  // startProject toasts and swallows it) and one that let it propagate. The
  // account remembered below must reflect an account the reader actually
  // used, not one merely offered to a create that then failed.
  onCreate: (accountId: string) => Promise<boolean>;
};

/**
 * The account to preselect: the one remembered from last time, as long as it
 * still exists (an account can be deleted between visits), falling back to
 * the first account otherwise. A `localStorage` read can throw in private
 * browsing, which is not reason enough to break the dialog.
 */
export function rememberedAccount(accounts: readonly Account[]): string | undefined {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LAST_ACCOUNT_KEY);
  } catch {
    stored = null;
  }
  if (stored !== null && accounts.some((account) => account.id === stored)) return stored;
  return accounts[0]?.id;
}

export function NewSlideshowDialog({
  open,
  accounts,
  onOpenChange,
  onCreate,
}: NewSlideshowDialogProps) {
  /*
   * A reader's own pick, held only once they make one. The dialog is mounted
   * from the moment the dashboard renders (Dialog.Root stays in the tree so it
   * can animate open and closed), which is before AccountsProvider's first
   * load has resolved, so an initializer computed once from `accounts` would
   * freeze at undefined forever. Deriving the effective selection at render
   * time instead means it tracks a late-arriving account list, or an account
   * that got deleted out from under it, without an effect racing the state it
   * reads.
   */
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const accountId =
    chosen !== undefined && accounts.some((account) => account.id === chosen)
      ? chosen
      : rememberedAccount(accounts);
  const [creating, setCreating] = useState(false);
  const options: SelectOption[] = accounts.map((account) => ({
    value: account.id,
    label: account.name,
  }));

  const submit = async () => {
    if (accountId === undefined) return;
    setCreating(true);
    try {
      const created = await onCreate(accountId);
      // A server error, a 401 or a timeout must not be remembered as "the
      // account the reader used" — onCreate resolves false (or throws) for
      // exactly those, rather than only for a create that actually landed.
      if (created) {
        try {
          localStorage.setItem(LAST_ACCOUNT_KEY, accountId);
        } catch {
          // Private browsing can refuse the write; the dialog still worked.
        }
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content compact>
        <Dialog.Title>New slideshow</Dialog.Title>
        <Field label="Account">
          <Select
            items={options}
            {...(accountId === undefined ? {} : { value: accountId })}
            onValueChange={setChosen}
            disabled={accounts.length === 0}
          />
        </Field>
        <Dialog.Actions>
          <Dialog.Close asChild>
            <Button>Cancel</Button>
          </Dialog.Close>
          <Button
            variant="solid"
            busy={creating}
            disabled={accountId === undefined}
            onClick={() => {
              void submit();
            }}
          >
            Create
          </Button>
        </Dialog.Actions>
      </Dialog.Content>
    </Dialog.Root>
  );
}
