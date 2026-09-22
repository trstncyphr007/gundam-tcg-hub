'use client';

import { type SyntheticEvent, useState } from 'react';

interface Profile {
  handle: string;
  displayName: string;
  bio: string | null;
  published: boolean;
}

/**
 * Claim a public breaker page (FR-4.3).
 *
 * Publishing is a separate, explicit control rather than an implied consequence of filling
 * the form in. Saving an unpublished profile is a supported thing to do: it holds the handle
 * and lets someone see what the page would say about them before anyone else can.
 */
export function ProfileForm({ initial }: { initial: Profile | null }): React.JSX.Element {
  const [handle, setHandle] = useState(initial?.handle ?? '');
  const [displayName, setDisplayName] = useState(initial?.displayName ?? '');
  const [bio, setBio] = useState(initial?.bio ?? '');
  const [published, setPublished] = useState(initial?.published ?? false);
  const [saved, setSaved] = useState<Profile | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/v1/me/profile', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          handle: handle.trim().toLowerCase(),
          displayName: displayName.trim(),
          // An empty box means "no bio", which is a value, not an omission.
          ...(bio.trim().length > 0 ? { bio: bio.trim() } : {}),
          published,
        }),
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { reason?: string } | null;
        setError(detail?.reason ?? 'That did not save.');
        return;
      }
      const body = (await response.json()) as { profile: Profile };
      setSaved(body.profile);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="space-y-4 rounded border p-4 bg-surface border-line"
      data-testid="profile-form"
    >
      <label className="block text-sm">
        <span className="text-muted">Handle</span>
        <input
          required
          value={handle}
          onChange={(e) => {
            setHandle(e.target.value);
          }}
          placeholder="gundam-with-trstn"
          pattern="[a-zA-Z0-9][a-zA-Z0-9-]{1,30}[a-zA-Z0-9]"
          data-testid="profile-handle"
          className="mt-1 w-full rounded border px-3 py-2 bg-page border-line"
        />
        <span className="mt-1 block text-xs text-muted">
          Your page lives at /breakers/{handle.trim().toLowerCase() || 'your-handle'}
        </span>
      </label>

      <label className="block text-sm">
        <span className="text-muted">Display name</span>
        <input
          required
          maxLength={60}
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value);
          }}
          data-testid="profile-display-name"
          className="mt-1 w-full rounded border px-3 py-2 bg-page border-line"
        />
        <span className="mt-1 block text-xs text-muted">
          This is the only name that appears publicly. Your account name and email never do.
        </span>
      </label>

      <label className="block text-sm">
        <span className="text-muted">Bio</span>
        <textarea
          maxLength={280}
          rows={3}
          value={bio}
          onChange={(e) => {
            setBio(e.target.value);
          }}
          data-testid="profile-bio"
          className="mt-1 w-full rounded border px-3 py-2 bg-page border-line"
        />
      </label>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={published}
          onChange={(e) => {
            setPublished(e.target.checked);
          }}
          data-testid="profile-published"
          className="mt-1"
        />
        <span>
          Publish this page
          <span className="block text-xs text-muted">
            Anyone can read it, including your break counts and hit rates. Unchecking hides the page
            again and keeps the handle.
          </span>
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          data-testid="profile-save"
          className="rounded px-4 py-2 text-sm font-medium disabled:opacity-50 bg-accent"
        >
          Save
        </button>
        {saved && (
          <a
            href={`/breakers/${saved.handle}`}
            className="text-sm underline"
            data-testid="profile-link"
          >
            {saved.published ? 'View your page' : 'Preview (only you can see it)'}
          </a>
        )}
      </div>

      {error && (
        <p role="alert" data-testid="profile-error" className="text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
