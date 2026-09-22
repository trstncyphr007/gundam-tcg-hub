'use client';

import { type ChangeEvent, useRef, useState } from 'react';

interface ImportReport {
  dryRun: boolean;
  rows: number;
  valid: number;
  created: number;
  updated: number;
  cardsAdded: number;
  errors: { row: number; message: string }[];
}

const MAX_BYTES = 2 * 1024 * 1024;
const TEMPLATE = 'set,number,finish,language,condition,quantity,acquired_price\n';

/**
 * CSV import and export (FR-3.5).
 *
 * The import is two buttons, not one, and they are not interchangeable: **Preview** never
 * writes, and **Apply** only appears once a preview has come back. An import can overwrite a
 * collection someone spent hours building, so the destructive path is the one you have to
 * choose on purpose — the server defaults the same way, and this mirrors it rather than
 * relying on it.
 */
export function CsvPanel({
  collectionId,
  onImported,
}: {
  collectionId: string;
  onImported: () => void;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [mode, setMode] = useState<'add' | 'replace'>('add');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function onFile(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    setReport(null);
    // Checked here so an oversized file is refused before it is read into memory, and again
    // by the route and the parser. The person gets told immediately either way.
    if (file.size > MAX_BYTES) {
      setError('That file is over 2 MB. Split it up.');
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setFileName(file.name);
    void file.text().then(setText);
  }

  async function send(apply: boolean): Promise<void> {
    if (text.trim() === '') {
      setError('Nothing to import yet.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/v1/collections/${collectionId}/import?mode=${mode}${apply ? '&apply=true' : ''}`,
        { method: 'POST', headers: { 'content-type': 'text/csv' }, body: text },
      );
      if (response.status === 413) {
        setError('That file is over 2 MB. Split it up.');
        return;
      }
      if (!response.ok) {
        setError('Could not read that file.');
        return;
      }
      const result = (await response.json()) as ImportReport;
      setReport(result);
      if (apply) {
        setText('');
        setFileName(null);
        if (fileRef.current) fileRef.current.value = '';
        onImported();
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4 rounded border p-4 bg-surface border-line">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-medium">Import and export</h2>
        <a
          href={`/v1/collections/${collectionId}/export`}
          className="ml-auto text-sm underline"
          data-testid="export-csv"
        >
          Export CSV
        </a>
      </div>

      <p className="text-xs text-muted">
        Columns: <code>{TEMPLATE.trim()}</code>. Up to 5,000 rows and 2 MB. Only <code>set</code>,{' '}
        <code>number</code> and <code>quantity</code> are required.
      </p>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          onChange={onFile}
          data-testid="csv-file"
          className="text-sm"
        />
        {fileName && <span className="text-muted">{fileName}</span>}
      </div>

      <label className="block text-sm">
        <span className="text-muted">…or paste it</span>
        <textarea
          rows={4}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setReport(null);
          }}
          placeholder={TEMPLATE}
          data-testid="csv-text"
          className="mt-1 w-full rounded border px-3 py-2 font-mono text-xs bg-page border-line"
        />
      </label>

      <fieldset className="flex flex-wrap gap-4 text-sm">
        <legend className="text-xs text-muted">When a card is already in this collection</legend>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="import-mode"
            checked={mode === 'add'}
            onChange={() => {
              setMode('add');
              setReport(null);
            }}
          />
          Add to the quantity
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="import-mode"
            checked={mode === 'replace'}
            onChange={() => {
              setMode('replace');
              setReport(null);
            }}
          />
          Replace the line
        </label>
      </fieldset>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => void send(false)}
          disabled={busy || text.trim() === ''}
          data-testid="preview-import"
          className="rounded border px-4 py-2 text-sm font-medium disabled:opacity-50 border-line"
        >
          {busy ? 'Reading…' : 'Preview'}
        </button>
        {report?.dryRun === true && report.valid > 0 && (
          <button
            type="button"
            onClick={() => void send(true)}
            disabled={busy}
            data-testid="apply-import"
            className="rounded px-4 py-2 text-sm font-medium disabled:opacity-50 bg-accent"
          >
            Import {report.valid} row{report.valid === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {report && (
        <div className="space-y-2 text-sm" data-testid="import-report">
          <p>
            {report.dryRun ? 'Preview: ' : 'Imported: '}
            <strong>{report.valid}</strong> of {report.rows} row
            {report.rows === 1 ? '' : 's'} are good
            {report.dryRun
              ? '. Nothing has been written yet.'
              : ` — ${String(report.created)} added, ${String(report.updated)} updated.`}
          </p>
          {report.errors.length > 0 && (
            <ul className="space-y-1 text-xs text-danger">
              {report.errors.slice(0, 20).map((issue) => (
                <li key={`${String(issue.row)}-${issue.message}`}>
                  {issue.row === 0 ? 'File' : `Row ${String(issue.row)}`}: {issue.message}
                </li>
              ))}
              {report.errors.length > 20 && (
                <li className="text-muted">…and {report.errors.length - 20} more.</li>
              )}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
