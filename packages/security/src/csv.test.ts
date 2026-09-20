import { describe, expect, it } from 'vitest';
import { csvCell, csvRow, toCsv } from './csv.js';

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
