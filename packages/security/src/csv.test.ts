import { describe, expect, it } from 'vitest';
import {
  CsvFormatError,
  CsvLimitError,
  csvCell,
  csvRow,
  mapCsvRows,
  parseCsv,
  toCsv,
} from './csv.js';

describe('formula injection (SR-2.5, AC-2.4)', () => {
  it.each([
    ['=1+1', `"'=1+1"`],
    ['+1+1', `"'+1+1"`],
    ['-1+1', `"'-1+1"`],
    ['@SUM(A1)', `"'@SUM(A1)"`],
    ['\tformula', `"'\tformula"`],
    ['\rformula', `"'\rformula"`],
    // The payload that actually runs commands when a CSV is opened in Excel.
    [`=cmd|'/c calc'!A1`, `"'=cmd|'/c calc'!A1"`],
    ['=HYPERLINK("http://evil.test","click")', `"'=HYPERLINK(""http://evil.test"",""click"")"`],
  ])('neutralises %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it('leaves ordinary text alone apart from quoting', () => {
    expect(csvCell('Sample Booster Box')).toBe('"Sample Booster Box"');
    expect(csvCell('Gundam: Freedom Ascension')).toBe('"Gundam: Freedom Ascension"');
  });

  it('does not mistake a negative number mid-cell for a formula', () => {
    // Only the FIRST character matters to a spreadsheet.
    expect(csvCell('box -1 edition')).toBe('"box -1 edition"');
  });

  it('escapes a genuine negative number, because a spreadsheet cannot tell them apart', () => {
    expect(csvCell('-12.50')).toBe(`"'-12.50"`);
  });
});

describe('CSV structure (RFC 4180)', () => {
  it('doubles embedded quotes so a quote cannot end the field early', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('a comma or newline in the data cannot shift a column', () => {
    const row = csvRow(['a,b', 'c\nd', 'e']);
    expect(row).toBe('"a,b","c\nd","e"');
    expect(row.split('","')).toHaveLength(3);
  });

  it('renders null and undefined as empty cells, not the words', () => {
    expect(csvRow([null, undefined])).toBe('"",""');
  });

  it('coerces numbers and booleans predictably', () => {
    expect(csvRow([1250, true, 0])).toBe('"1250","true","0"');
  });

  it('builds a document with a header and CRLF endings', () => {
    const csv = toCsv(['card', 'value'], [['Sample Unit Alpha', 1250]]);
    expect(csv).toBe('"card","value"\r\n"Sample Unit Alpha","1250"');
  });

  it('escapes the header too, since column names can come from user input', () => {
    expect(toCsv(['=evil'], [])).toBe(`"'=evil"`);
  });
});

describe('parsing (FR-3.5)', () => {
  it('reads a simple document', () => {
    const doc = parseCsv('card,qty\r\nAlpha,2\r\nBeta,3\r\n');
    expect(doc.header).toEqual(['card', 'qty']);
    expect(doc.rows).toEqual([
      ['Alpha', '2'],
      ['Beta', '3'],
    ]);
  });

  it('survives the things that break naive splitting', () => {
    const doc = parseCsv('card,note\n"Alpha, the First","said ""hi"""\n"multi\nline",ok\n');
    expect(doc.rows).toEqual([
      ['Alpha, the First', 'said "hi"'],
      ['multi\nline', 'ok'],
    ]);
  });

  it('accepts CRLF, LF and a lone CR', () => {
    expect(parseCsv('a,b\r\n1,2\r\n').rows).toEqual([['1', '2']]);
    expect(parseCsv('a,b\n1,2\n').rows).toEqual([['1', '2']]);
    expect(parseCsv('a,b\r1,2\r').rows).toEqual([['1', '2']]);
  });

  it('does not need a trailing newline', () => {
    expect(parseCsv('a,b\n1,2').rows).toEqual([['1', '2']]);
  });

  it('strips a byte-order mark, which would otherwise poison the first column name', () => {
    const doc = parseCsv('﻿card,qty\nAlpha,1\n');
    expect(doc.header[0]).toBe('card');
  });

  it('keeps an empty cell empty rather than dropping the column', () => {
    expect(parseCsv('a,b,c\n1,,3\n').rows).toEqual([['1', '', '3']]);
  });

  it('rejects a file that ends inside a quoted field', () => {
    expect(() => parseCsv('a,b\n"unterminated,2\n')).toThrow(CsvFormatError);
  });

  it('rejects a stray quote mid-field rather than guessing', () => {
    expect(() => parseCsv('a,b\nbro"ken,2\n')).toThrow(CsvFormatError);
  });

  it('rejects a document with no header', () => {
    expect(() => parseCsv('')).toThrow(CsvFormatError);
  });

  it('enforces the row cap (AC-3.5)', () => {
    const tooMany = ['card,qty', ...Array.from({ length: 5001 }, (_, i) => `Card ${String(i)},1`)];
    expect(() => parseCsv(tooMany.join('\n'))).toThrow(CsvLimitError);

    const justEnough = [
      'card,qty',
      ...Array.from({ length: 5000 }, (_, i) => `Card ${String(i)},1`),
    ];
    expect(parseCsv(justEnough.join('\n')).rows).toHaveLength(5000);
  });

  it('enforces the byte cap before doing any work', () => {
    const big = `card,qty\n${'x'.repeat(3 * 1024 * 1024)},1\n`;
    expect(() => parseCsv(big)).toThrow(CsvLimitError);
  });

  it('never evaluates a formula: a payload survives as plain text', () => {
    const doc = parseCsv('card,note\nAlpha,"=cmd|\'/c calc\'!A1"\n');
    expect(doc.rows[0]?.[1]).toBe(`=cmd|'/c calc'!A1`);
  });

  it('round-trips through the writer, payload intact but neutralised', () => {
    const payload = '=HYPERLINK("http://evil.test")';
    const written = toCsv(['card'], [[payload]]);
    const read = parseCsv(written);
    // The apostrophe the writer added is what makes it inert in a spreadsheet, and it is
    // visible here rather than silently stripped.
    expect(read.rows[0]?.[0]).toBe(`'${payload}`);
  });
});

describe('column mapping (FR-3.5)', () => {
  it('keys cells by header name', () => {
    const { records, errors } = mapCsvRows(parseCsv('card,qty\nAlpha,2\n'));
    expect(errors).toEqual([]);
    expect(records).toEqual([{ card: 'Alpha', qty: '2' }]);
  });

  it('reports a short row instead of padding it', () => {
    // Padding would turn a missing quantity into an empty string, and then into zero.
    const { records, errors } = mapCsvRows(parseCsv('card,qty,condition\nAlpha,2\nBeta,1,nm\n'));
    expect(records).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.row).toBe(2);
    expect(errors[0]?.message).toContain('expected 3 columns');
  });

  it('numbers rows the way a person reading the file would', () => {
    const { errors } = mapCsvRows(parseCsv('a,b\n1,2\n3\n'));
    // Header is row 1, so the bad row is row 3.
    expect(errors[0]?.row).toBe(3);
  });

  it('trims surrounding whitespace, which spreadsheets add freely', () => {
    const { records } = mapCsvRows(parseCsv('card , qty\n Alpha , 2 \n'));
    expect(records[0]).toEqual({ card: 'Alpha', qty: '2' });
  });
});
