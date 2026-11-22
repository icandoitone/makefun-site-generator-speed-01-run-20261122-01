// FastSite — a faster drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly what makefun-site 1.0.0's build returns for the
// same input: the output tree as a JSON object of path -> text, byte for byte.
// It re-implements makefun-site's own dialect (front matter, template dialect,
// Markdown subset, slug rule, report) from its README and reference code, with
// the same checks in the same order and the same error strings, but with the
// hot paths rewritten: HTML escaping and inline Markdown work on whole runs
// instead of one character at a time, the Markdown lexer and front-matter
// parser are hand-written scans instead of regular expressions, slugs are
// memoised with an ASCII fast path, and each template is compiled once per
// build into a small function instead of being walked node by node.
//
// No state is kept from one run() call to the next: every case is answered
// alone, from its own input only.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SLUG_MAX = 64;
const INCLUDE_DEPTH = 8;
export const REPORT_FILE = 'build-report.txt';
const RESERVED = Object.freeze(['posts', 'tags', 'page']);

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `text` with & < > " and ' escaped (the escape table, in this order). */
function escapeHtml(text) {
  ESC_RE.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = ESC_RE.exec(text)) !== null) {
    out += text.slice(last, m.index) + ESCAPES[m[0]];
    last = m.index + 1;
  }
  if (last === 0) return text;
  return out + text.slice(last);
}

/** The slug of `text`, memoised in `cache` (fresh per build). */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const out = slugifyRaw(text);
  cache.set(text, out);
  return out;
}

function slugifyRaw(text) {
  // Pure ASCII text is already in NFKD form and holds no combining marks, so
  // the normalise-and-strip step is the identity on it.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isDigit(c) {
  return c >= 48 && c <= 57;
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10 && ok; i++) {
          if (i !== 4 && i !== 7 && !isDigit(raw.charCodeAt(i))) ok = false;
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t.charCodeAt(i);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; i < raw.length && ok; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      let prevDash = true;
      for (let i = 0; i < raw.length && ok; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) ok = false;
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else ok = false;
      }
      if (prevDash) ok = false;
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * `text` has "\n" line ends. The closing `---` line is found by scanning for it, so the body is sliced out
 * instead of split and re-joined line by line.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let closeStart = -1;
  let from = 3; // the "\n" ending the opening "---" line: the close may follow it at once
  while (true) {
    const idx = text.indexOf('\n---', from);
    if (idx === -1) break;
    const after = idx + 4;
    if (after === text.length || text.charCodeAt(after) === 10) {
      closeStart = idx;
      break;
    }
    from = idx + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  const fmLines = text.slice(4, closeStart).split('\n');
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${j + 2} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${j + 2} is not "key: value"` };
    raw = raw.replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  let bodyStart = closeStart + 4;
  if (text.charCodeAt(bodyStart) === 10) bodyStart++;
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- Markdown

/** A fence's language, or null when `line` does not open one. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = line.slice(3, j);
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
    j++;
  }
  return lang;
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6) return null;
  if (h >= line.length) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let j = h;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  let k = line.length;
  while (k > j && (line.charCodeAt(k - 1) === 32 || line.charCodeAt(k - 1) === 9)) k--;
  if (k === j) return null;
  return { depth: h, text: line.slice(j, k) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let s = 0;
  while (s < line.length && line.charCodeAt(s) === 32) s++;
  if (s < 2 || s >= line.length) return false;
  const c = line.charCodeAt(s);
  return c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 11 && c !== 12;
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break.
 *  Only the lines a first character can open are checked further. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlankLine(line);
  if (c === 96) return fenceLang(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

/** A list item's marker: { ordered, start, text }, or null when `line` opens no list. */
function listMarker(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return { ordered: false, start: 1, text: line.slice(2) };
  let d = 0;
  while (d < line.length && isDigit(line.charCodeAt(d))) d++;
  if (d >= 1 && d <= 9 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
    return { ordered: true, start: Number(line.slice(0, d)), text: line.slice(d + 2) };
  }
  return null;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The characters that can open an inline mark. */
const MARK_RE = /[\\`*[]/g;

/** `s` rendered inline; `env.link(target)` is a link's href. Plain runs are escaped whole; the scan jumps from one
 *  mark to the next with one native regular-expression scan (its lastIndex is set before every exec, so the
 *  recursion into a mark's inner text cannot disturb the outer scan). */
function inline(s, env) {
  let out = '';
  let i = 0;
  let start = 0;
  const n = s.length;
  while (i < n) {
    MARK_RE.lastIndex = i;
    const m = MARK_RE.exec(s);
    if (m === null) break;
    const j = m.index;
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        if (j > start) out += escapeHtml(s.slice(start, j));
        // The escaped character is itself escaped: of the escapable characters only '>' is HTML-special.
        out += s[j + 1] === '>' ? '&gt;' : s[j + 1];
        i = j + 2;
        start = i;
      } else i = j + 1;
      continue;
    }
    if (c === '`') {
      const k2 = s.indexOf('`', j + 1);
      if (k2 > j + 1) {
        if (j > start) out += escapeHtml(s.slice(start, j));
        out += `<code>${escapeHtml(s.slice(j + 1, k2))}</code>`;
        i = k2 + 1;
        start = i;
      } else i = j + 1;
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k2 = findUnescaped(s, '**', j + 2);
        if (k2 > j + 2) {
          if (j > start) out += escapeHtml(s.slice(start, j));
          out += `<strong>${inline(s.slice(j + 2, k2), env)}</strong>`;
          i = k2 + 2;
          start = i;
        } else i = j + 2;
        continue;
      }
      const k2 = findSingleStar(s, j + 1);
      if (k2 > j + 1) {
        if (j > start) out += escapeHtml(s.slice(start, j));
        out += `<em>${inline(s.slice(j + 1, k2), env)}</em>`;
        i = k2 + 1;
        start = i;
      } else i = j + 1;
      continue;
    }
    const k2 = findUnescaped(s, ']', j + 1);
    const mm = k2 !== -1 && s[k2 + 1] === '(' ? s.indexOf(')', k2 + 2) : -1;
    const target = mm === -1 ? '' : s.slice(k2 + 2, mm);
    if (target !== '' && !/\s/.test(target)) {
      if (j > start) out += escapeHtml(s.slice(start, j));
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(j + 1, k2), env)}</a>`;
      i = mm + 1;
      start = i;
    } else i = j + 1;
  }
  if (n > start) out += escapeHtml(s.slice(start, n));
  return out;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env, slugCache) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if (line.length === 0 || c0 === 32 || c0 === 9) {
      if (isBlankLine(line)) {
        i++;
        continue;
      }
      // An indented line opens no block: it is a paragraph line.
    } else if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        let code = '<pre><code';
        if (lang !== '') code += ` class="language-${escapeHtml(lang)}"`;
        code += '>';
        for (let k = 0; k < body.length; k++) {
          code += escapeHtml(body[k]);
          code += '\n';
        }
        code += '</code></pre>';
        blocks.push(`${code}\n`);
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text, slugCache), ids);
        const html = inline(heading.text, env);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        blocks.push('<hr>\n');
        i++;
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (let k = 0; k < body.length; k++) {
        const t = trimLine(body[k]);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    const marker = (c0 === 45 || c0 === 42 || (c0 >= 48 && c0 <= 57)) ? listMarker(line) : null;
    if (marker !== null) {
      const isOrdered = marker.ordered;
      const items = [];
      while (i < n) {
        const m2 = listMarker(lines[i]);
        if (m2 !== null && m2.ordered === isOrdered) {
          items.push([trimLine(m2.text)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && marker.start !== 1 ? `<ol start="${marker.start}">` : `<${tag}>`;
      let html = `${open}\n`;
      for (let k = 0; k < items.length; k++) html += `<li>${inline(items[k].join('\n'), env)}</li>\n`;
      html += `</${tag}>`;
      blocks.push(`${html}\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }), pushing into `out`.
 * The interpreter the compiler falls back to when a template cannot be compiled.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(ctx.escape(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) t(scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

/**
 * A template's nodes compiled into a function (scope, ctx, depth, out) that
 * pushes its rendered text into `out`. Falls back to the interpreter when the
 * platform cannot compile a function.
 */
function compileTemplate(nodes) {
  let uid = 0;
  const gen = (ns, sv) => {
    let code = '';
    for (const n of ns) {
      if (n.kind === 'text') code += 'out.push(' + JSON.stringify(n.text) + ');';
      else if (n.kind === 'var') code += 'out.push(escape(textOf(lookup(' + sv + ',' + JSON.stringify(n.path) + '))));';
      else if (n.kind === 'raw') code += 'out.push(textOf(lookup(' + sv + ',' + JSON.stringify(n.path) + ')));';
      else if (n.kind === 'if') {
        code += 'if(truthy(lookup(' + sv + ',' + JSON.stringify(n.path) + '))!==' + n.not + '){' + gen(n.then, sv) + '}';
        if (n.else !== null) code += 'else{' + gen(n.else, sv) + '}';
      } else if (n.kind === 'for') {
        const nv = 's' + (uid++);
        code += '{const xs=lookup(' + sv + ',' + JSON.stringify(n.path) + ');if(Array.isArray(xs)){for(let k=0;k<xs.length;k++){const ' + nv + '={vars:{[' + JSON.stringify(n.name) + ']:xs[k],loop:{index:k+1,first:k===0,last:k===xs.length-1,length:xs.length}},parent:' + sv + '};' + gen(n.body, nv) + '}}}';
      } else if (n.kind === 'include') {
        code += '{const t=ctx.templates.get(' + JSON.stringify(n.name) + ');if(t!==undefined&&depth<8)t(' + sv + ',ctx,depth+1,out);}';
      }
    }
    return code;
  };
  try {
    const factory = new Function('lookup', 'textOf', 'truthy', 'escape',
      'return function(scope,ctx,depth,out){' + gen(nodes, 'scope') + '}');
    return factory(lookup, textOf, truthy, escapeHtml);
  } catch {
    return (scope, ctx, depth, out) => renderNodes(nodes, scope, ctx, depth, out);
  }
}

// ---------------------------------------------------------------- the build

/** Whether `target` carries a scheme (https:, mailto: ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  const keptSources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const base = baseOf(input);
  const bySource = new Map();
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of keptSources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of keptSources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.rm = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = keptSources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const slug = slugify(name, slugCache);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of keptSources) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name, slugCache)) ?? { name, slug: slugify(name, slugCache), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.rm,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, escape: escapeHtml };
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const out = [];
    fn({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of keptSources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = keptSources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/** `site.base_url` with its trailing slashes dropped. */
function baseOf(input) {
  return input.site.base_url.replace(/\/+$/, '');
}
