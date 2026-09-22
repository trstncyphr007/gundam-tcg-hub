'use client';

import { type SyntheticEvent, useState } from 'react';

const REAUTH = `/sign-in?reason=step-up&next=${encodeURIComponent('/account/data')}`;

interface Problem {
  message: string;
  /** Where to go to fix it, when the fix is signing in again. */
  reauth?: string;
}

function problemFor(error: string | undefined, status: number): Problem {
  switch (error) {
    case 'step_up_required':
      return {
        message: 'For your safety, sign in again (within the last ten minutes) first.',
        reauth: REAUTH,
      };
    case 'passkey_required':
      return {
        message: 'This account has a passkey, so it can only be deleted from a passkey sign-in.',
        reauth: REAUTH,
      };
    case 'confirmation_mismatch':
      return { message: 'That is not the email address on this account. Nothing was deleted.' };
    case 'admin_cannot_self_delete':
      return {
        message:
          'Administrator accounts cannot delete themselves. Ask an operator to remove the admin role first.',
      };
    default:
      return status === 429
        ? { message: 'That has been done several times this hour already. Try again later.' }
        : { message: 'That did not work. Nothing was changed.' };
  }
}

async function errorOf(response: Response): Promise<string | undefined> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === 'string' ? body.error : undefined;
}

function ProblemLine({ problem, testId }: { problem: Problem; testId: string }) {
  return (
    <p role="alert" className="text-sm text-danger" data-testid={testId}>
      {problem.message}{' '}
      {problem.reauth && (
        <a href={problem.reauth} className="underline" data-testid={`${testId}-reauth`}>
          Sign in again
        </a>
      )}
    </p>
  );
}

/**
 * Download everything, or delete everything (SR-X.25, ADR-027).
 *
 * Both need a sign-in from the last ten minutes; both email the account when they happen.
 */
export function DataManager({ email }: { email: string }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [exportProblem, setExportProblem] = useState<Problem | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [deleteProblem, setDeleteProblem] = useState<Problem | null>(null);
  const [deleted, setDeleted] = useState(false);

  async function download(): Promise<void> {
    setBusy(true);
    setExportProblem(null);
    setDownloaded(false);
    try {
      const response = await fetch('/v1/account/export', { cache: 'no-store' });
      if (!response.ok) {
        setExportProblem(problemFor(await errorOf(response), response.status));
        return;
      }
      const name =
        /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ??
        'gundam-tcg-hub-export.json';
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
      setDownloaded(true);
    } finally {
      setBusy(false);
    }
  }

  async function remove(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setDeleteProblem(null);
    try {
      const response = await fetch('/v1/account/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm }),
      });
      if (!response.ok) {
        setDeleteProblem(problemFor(await errorOf(response), response.status));
        return;
      }
      setDeleted(true);
    } finally {
      setBusy(false);
    }
  }

  if (deleted) {
    return (
      <section
        role="status"
        className="space-y-2 rounded border p-4 bg-surface border-line"
        data-testid="account-deleted"
      >
        <h2 className="font-medium">Your account has been deleted</h2>
        <p className="text-sm text-muted">
          Everything that was only yours is gone, and you are signed out everywhere. We have sent a
          last email to confirm it.
        </p>
        <a href="/" className="text-sm underline">
          Back to the home page
        </a>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <section
        className="space-y-3 rounded border p-4 bg-surface border-line"
        data-testid="export-panel"
      >
        <h2 className="font-medium">Download your data</h2>
        <p className="max-w-prose text-sm text-muted">
          One file with everything this account holds: your profile, sign-ins, watches, collections,
          breaks, live sales, price reports and API keys. It leaves out anything that would work as
          a password, and other people&rsquo;s names.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void download()}
          data-testid="export-data"
          className="rounded px-4 py-2 text-sm font-medium disabled:opacity-50 bg-accent"
        >
          Download my data
        </button>
        {downloaded && (
          <p role="status" className="text-sm" data-testid="export-done">
            Downloaded. We have emailed you to say so.
          </p>
        )}
        {exportProblem && <ProblemLine problem={exportProblem} testId="export-problem" />}
      </section>

      <section
        className="space-y-3 rounded border p-4 bg-surface border-danger"
        data-testid="delete-panel"
      >
        <h2 className="font-medium">Delete your account</h2>
        <p className="max-w-prose text-sm text-muted">
          Permanent, straight away. Your watches, collections, breaks, profile, live sales, sessions
          and passkeys are deleted. Prices you reported that already count in the public index stay
          in it, with nothing that connects them to you. Download your data first if you want a
          copy.
        </p>
        <form onSubmit={(e) => void remove(e)} className="flex flex-wrap items-end gap-3">
          <label className="flex-1 text-sm min-w-64">
            <span className="text-muted">
              Type <strong>{email}</strong> to confirm
            </span>
            <input
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value);
              }}
              autoComplete="off"
              data-testid="delete-confirm"
              className="mt-1 w-full rounded border px-3 py-2 bg-page border-line"
            />
          </label>
          <button
            type="submit"
            disabled={busy || confirm.trim() === ''}
            data-testid="delete-account"
            className="rounded bg-[#b91c1c] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Delete my account permanently
          </button>
        </form>
        {deleteProblem && <ProblemLine problem={deleteProblem} testId="delete-problem" />}
      </section>
    </div>
  );
}
