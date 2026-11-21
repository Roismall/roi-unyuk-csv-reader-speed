// csv-reader 1.0.0 drop-in — single-pass, byte-level (charCodeAt/indexOf).
// Design (copied from top-3 approach signals, own code): one pass over the
// input string, native indexOf to jump straight to the next delimiter,
// slice() for fields (no split, no regex, no per-char string building on
// the hot path), parts+join only when a field actually needs rewriting
// (doubled quotes, line breaks inside quotes, stray CRs, junk).
// No allocation per field beyond the field string itself; errors are
// pushed only when one actually occurs. No caching between calls: every
// local is created fresh inside run().
export function run(input) {
  const text = input && typeof input.text === "string" ? input.text
    : input && typeof input.csv === "string" ? input.csv
    : typeof input === "string" ? input : String(input && input.text != null ? input.text : "");
  const header = !!(input && input.header);
  const s = text, n = s.length;
  let i = 0;
  if (n > 0 && s.charCodeAt(0) === 0xFEFF) i = 1; // BOM
  let line = 1;
  let lfCache = -1; // first LF at/after current position (n if none);
                    // valid only while no quoted field has been consumed
                    // since it was computed (a quoted LF is content, not
                    // a record end, so it invalidates the cache)
  let columns = null;
  const rows = [];
  const errors = [];
  let width = -1;
  let first = true;
  const Q = 34, C = 44, LF = 10, CR = 13;

  // One native scan: is any CR a stray (not part of CRLF)?
  let hasStray = false;
  {
    let p = s.indexOf("\r", i);
    while (p >= 0) {
      if (p + 1 >= n || s.charCodeAt(p + 1) !== LF) { hasStray = true; break; }
      p = s.indexOf("\r", p + 1);
    }
  }
  const hasCR = s.indexOf("\r", i) >= 0; // one native scan; gates CR checks
  // Fast path — no quotes anywhere and no stray CR: the whole input is
  // plain lines, so native split() (C++ in V8) beats a JS char loop.
  // CRLF is handled by stripping one trailing CR per line; empty lines
  // are skipped; short/long rows and their line/row are identical to
  // the single-pass parser below.
  if (!hasStray && s.indexOf('"', i) < 0) {
    const linesArr = (i > 0 ? s.slice(i) : s).split("\n");
    for (let li = 0; li < linesArr.length; li++) {
      let ln = linesArr[li];
      if (ln.length > 0 && ln.charCodeAt(ln.length - 1) === CR) ln = ln.slice(0, -1);
      if (ln.length === 0) continue;
      const recLine = li + 1;
      const recRow = first && header ? null : rows.length;
      const fields = ln.split(",");
      if (first) {
        width = fields.length;
        if (header) columns = fields; else rows.push(fields);
        first = false;
      } else if (fields.length < width) {
        errors.push({ code: "short_row", line: recLine, row: recRow, fields: fields.length });
        while (fields.length < width) fields.push("");
        rows.push(fields);
      } else if (fields.length > width) {
        const extra = fields.slice(width);
        errors.push({ code: "long_row", line: recLine, row: recRow, extra });
        rows.push(fields.slice(0, width));
      } else rows.push(fields);
    }
    return { columns, rows, errors };
  }

  while (i < n) {
    // Skip blank lines (a line left with no characters is no record).
    for (;;) {
      if (i >= n) break;
      const c = s.charCodeAt(i);
      if (c === LF) { i++; line++; continue; }
      if (c === CR && i + 1 < n && s.charCodeAt(i + 1) === LF) { i += 2; line++; continue; }
      break;
    }
    if (i >= n) break;
    // A line holding only stray CR(s): each CR is a stray_cr, no record.
    if (s.charCodeAt(i) === CR) {
      let j = i;
      while (j < n && s.charCodeAt(j) === CR && !(j + 1 < n && s.charCodeAt(j + 1) === LF)) j++;
      if (j >= n || s.charCodeAt(j) === LF || (s.charCodeAt(j) === CR && j + 1 < n && s.charCodeAt(j + 1) === LF)) {
        const rr = first && header ? null : rows.length;
        for (let k = i; k < j; k++) errors.push({ code: "stray_cr", line, row: rr });
        i = j; continue;
      }
    }
    const recLine = line;
    const recRow = first && header ? null : rows.length;
    const fields = [];
    let recEnd = false;

    while (!recEnd) {
      let field;
      // ---- quoted field: field opens with a quote ----
      if (i < n && s.charCodeAt(i) === Q) {
        const fstart = i;
        let j = i + 1, last = j, parts = null, qline = line, closed = -1;
        while (j < n) {
          let qi = s.indexOf('"', j); if (qi < 0) qi = n;
          // First line break in the span up to the next quote, via native
          // indexOf (stops at the record's own LF when there is none in
          // the span; CR is checked only if the input contains any CR).
          let br = -1;
          {
            const ni2 = s.indexOf("\n", j);
            if (ni2 >= 0 && ni2 < qi) br = ni2;
            if (hasCR) {
              const ri2 = s.indexOf("\r", j);
              if (ri2 >= 0 && ri2 < qi && (br < 0 || ri2 < br)) br = ri2;
            }
          }
          if (br < 0) {
            if (qi >= n) { j = n; break; }
            if (qi + 1 < n && s.charCodeAt(qi + 1) === Q) {
              if (!parts) parts = [];
              parts.push(s.slice(last, qi)); parts.push('"');
              j = qi + 2; last = j; continue;
            }
            closed = qi; break;
          }
          // Line break(s) in this span: each becomes LF, one line each.
          if (!parts) parts = [];
          let m = j;
          while (m < qi) {
            const cc = s.charCodeAt(m);
            if (cc === LF) { parts.push(s.slice(last, m)); parts.push("\n"); m++; last = m; qline++; }
            else if (cc === CR) { parts.push(s.slice(last, m)); parts.push("\n"); qline++; m = (m + 1 < n && s.charCodeAt(m + 1) === LF) ? m + 2 : m + 1; last = m; }
            else m++;
          }
          j = qi;
          // Loop again: the quote at qi is now examined (doubled/closing).
          // NOTE: `last` is NOT reset here — it still marks the start of
          // the segment after the last line break, which the final
          // slice(last, closed) must include.
        }
        if (closed < 0) {
          // Unterminated: the quote is a literal; text after it is
          // re-read as unquoted. Line increments from the tentative
          // scan are discarded (qline never committed).
          errors.push({ code: "unterminated_quote", line: recLine, row: recRow });
          i = fstart;
          // fall through to the unquoted scan below (field starts at i)
        } else {
          line = qline;
          if (parts) { parts.push(s.slice(last, closed)); field = parts.join(""); }
          else field = s.slice(i + 1, closed);
          let k = closed + 1;
          // Junk after the closing quote, up to comma / line break.
          let jk = k, jparts = null, jlast = k;
          while (jk < n) {
            const cc = s.charCodeAt(jk);
            if (cc === C || cc === LF) break;
            if (cc === CR) {
              if (jk + 1 < n && s.charCodeAt(jk + 1) === LF) break;
              errors.push({ code: "stray_cr", line: recLine, row: recRow });
              if (!jparts) jparts = [];
              jparts.push(s.slice(jlast, jk));
              jk++; jlast = jk; continue;
            }
            jk++;
          }
          if (jk > k) {
            let junk;
            if (jparts) { jparts.push(s.slice(jlast, jk)); junk = jparts.join(""); }
            else junk = s.slice(k, jk);
            if (junk.length > 0) {
              field += junk;
              errors.push({ code: "quote_junk", line: recLine, row: recRow });
            }
          }
          i = jk;
          fields.push(field);
          lfCache = -1; // a quoted field may have swallowed the cached LF
          if (i >= n) recEnd = true;
          else if (s.charCodeAt(i) === C) i++;
          else if (s.charCodeAt(i) === LF) { i++; line++; recEnd = true; }
          else { i += 2; line++; recEnd = true; } // CRLF
          continue;
        }
      }
      // ---- unquoted field (also the re-read of an unterminated quote) ----
      {
        if (lfCache < i) { lfCache = s.indexOf("\n", i); if (lfCache < 0) lfCache = n; }
        let ci = s.indexOf(",", i); if (ci < 0) ci = n;
        let j, term;
        if (ci < lfCache) { j = ci; term = 0; }
        else if (lfCache < n) { j = lfCache; term = 1; }
        else { j = n; term = 3; }
        if (term === 1 && j > i && s.charCodeAt(j - 1) === CR) { j--; term = 2; } // CRLF
        // Scan only this field's span for a stray CR — and only when the
        // input is known to contain one (hasStray, computed once above).
        let cr = -1;
        if (hasStray) {
          let k = i;
          while (k < j) { if (s.charCodeAt(k) === CR) { cr = k; break; } k++; }
        }
        if (cr < 0) {
          field = s.slice(i, j);
          i = j;
        } else {
          // Drop each lone CR in the span (one stray_cr each).
          const parts = [];
          let last = i, m = i;
          while (m < j) {
            if (s.charCodeAt(m) === CR) {
              errors.push({ code: "stray_cr", line: recLine, row: recRow });
              parts.push(s.slice(last, m));
              m++; last = m;
            } else m++;
          }
          parts.push(s.slice(last, j));
          field = parts.join("");
          i = j;
        }
        fields.push(field);
        if (term === 3) recEnd = true;
        else if (term === 0) i++;
        else if (term === 1) { i++; line++; recEnd = true; }
        else { i += 2; line++; recEnd = true; }
      }
    }

    if (first) {
      width = fields.length;
      if (header) columns = fields; else rows.push(fields);
      first = false;
    } else if (fields.length < width) {
      errors.push({ code: "short_row", line: recLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push("");
      rows.push(fields);
    } else if (fields.length > width) {
      const extra = fields.slice(width);
      errors.push({ code: "long_row", line: recLine, row: recRow, extra });
      rows.push(fields.slice(0, width));
    } else {
      rows.push(fields);
    }
  }
  return { columns, rows, errors };
}
export default run;
