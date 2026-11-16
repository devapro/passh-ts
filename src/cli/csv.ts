// One record of Go's encoding/csv Reader (default settings), as pflag's *strings* flags read
// their values (cli.md §1.1). Only the first record counts; later lines are dropped (known
// issue #15 of the spec audit, reproduced).

const ERR_BARE_QUOTE = 'bare " in non-quoted-field';
const ERR_QUOTE = 'extraneous or missing " in quoted-field';

export class CSVParseError extends Error {
  constructor(startLine: number, line: number, column: number, err: string) {
    super(startLine !== line ? `record on line ${startLine}; parse error on line ${line}, column ${column}: ${err}` : `parse error on line ${line}, column ${column}: ${err}`);
    this.name = "CSVParseError";
  }
}

/** Reads the first CSV record of `value` (Go's csv.NewReader(…).Read()). "" gives []. */
export function readCSVRecord(value: string): string[] {
  if (value === "") return [];
  const data = new TextEncoder().encode(value);
  let off = 0;
  let numLine = 0;
  const dec = new TextDecoder();

  // Go's readLine: up to and including \n; a final \r before EOF dropped; \r\n → \n.
  const readLine = (): { line: Uint8Array; eof: boolean } => {
    if (off >= data.length) return { line: new Uint8Array(0), eof: true };
    let end = data.indexOf(0x0a, off);
    let line: Uint8Array;
    let eof = false;
    if (end < 0) {
      line = data.slice(off);
      off = data.length;
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.slice(0, line.length - 1);
      eof = line.length === 0;
    } else {
      line = data.slice(off, end + 1);
      off = end + 1;
    }
    numLine++;
    const n = line.length;
    if (n >= 2 && line[n - 2] === 0x0d && line[n - 1] === 0x0a) {
      const l2 = line.slice(0, n - 1);
      l2[n - 2] = 0x0a;
      line = l2;
    }
    return { line, eof };
  };
  const lengthNL = (b: Uint8Array) => (b.length > 0 && b[b.length - 1] === 0x0a ? 1 : 0);

  // Skip empty lines (Go skips lines that are only "\n").
  let first = readLine();
  while (!first.eof && first.line.length === lengthNL(first.line) && first.line.length > 0) first = readLine();
  if (first.eof && first.line.length === 0) return [];
  let line = first.line;
  let readEOF = off >= data.length;
  const recLine = numLine;
  const fields: string[] = [];
  let buf: number[] = [];
  let col = 1;
  let lineNo = numLine;
  for (;;) {
    if (line.length === 0 || line[0] !== 0x22) {
      const i = line.indexOf(0x2c);
      let field = i >= 0 ? line.slice(0, i) : line.slice(0, line.length - lengthNL(line));
      const j = field.indexOf(0x22);
      if (j >= 0) throw new CSVParseError(recLine, numLine, col + j, ERR_BARE_QUOTE);
      fields.push(dec.decode(field));
      if (i >= 0) {
        line = line.slice(i + 1);
        col += i + 1;
        continue;
      }
      break;
    }
    // quoted field
    line = line.slice(1);
    col += 1;
    buf = [];
    for (;;) {
      const i = line.indexOf(0x22);
      if (i >= 0) {
        buf.push(...line.slice(0, i));
        line = line.slice(i + 1);
        col += i + 1;
        const rn = line.length > 0 ? line[0] : -1;
        if (rn === 0x22) {
          buf.push(0x22);
          line = line.slice(1);
          col += 1;
        } else if (rn === 0x2c) {
          line = line.slice(1);
          col += 1;
          fields.push(dec.decode(new Uint8Array(buf)));
          buf = [];
          break; // next field
        } else if (lengthNL(line) === line.length) {
          fields.push(dec.decode(new Uint8Array(buf)));
          return fields;
        } else {
          throw new CSVParseError(recLine, numLine, col - 1, ERR_QUOTE);
        }
      } else if (line.length > 0) {
        buf.push(...line);
        if (readEOF) {
          // abrupt end of file inside a quoted field
          throw new CSVParseError(recLine, lineNo, col + line.length, ERR_QUOTE);
        }
        col += line.length;
        const next = readLine();
        line = next.line;
        readEOF = off >= data.length;
        if (line.length > 0) {
          lineNo++;
          col = 1;
        }
      } else {
        throw new CSVParseError(recLine, lineNo, col, ERR_QUOTE);
      }
    }
    // continue with the next field after `",`
    if (line.length === 0) {
      fields.push("");
      return fields;
    }
  }
  return fields;
}
