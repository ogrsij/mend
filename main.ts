// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, the three-tier line matching of section 5, unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing
// write of section 10. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move pairs (old, new) of the move edits that succeeded, for the `R` output lines. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* ---------------- Files as lines (SPEC.md section 3) ---------------- */

interface FileModel {
  lines: string[];
  br: '\n' | '\r\n';
  eol: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', eol: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const eol = text.endsWith(br);
  const parts = text.split(br);
  if (eol) parts.pop();
  return { lines: parts, br, eol };
}

function writeFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.eol ? m.br : '');
}

/* ---------------- Matching lines (SPEC.md section 5) ---------------- */

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function matchLine(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function matchesAt(lines: string[], pos: number, o: string[], tier: number): boolean {
  for (let j = 0; j < o.length; j += 1) if (!matchLine(lines[pos + j]!, o[j]!, tier)) return false;
  return true;
}

/** The first tier at which O occurs in lines at or after `from`, and every position there. */
function findOccurrences(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier += 1) {
    const positions: number[] = [];
    for (let i = from; i + o.length <= lines.length; i += 1) if (matchesAt(lines, i, o, tier)) positions.push(i);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** At tier 2 a written line of N that is not a context line is re-indented from P to F (section 5). */
function reindent(line: string, f: string, p: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/** One body line of a unified hunk or a V4A chunk: context, deleted, added, or a `\` note. */
interface BodyLine {
  k: 'c' | 'd' | 'a' | 'b';
  t: string;
}

const oldLines = (body: BodyLine[]): string[] => body.filter((e) => e.k === 'c' || e.k === 'd').map((e) => e.t);
const newCount = (body: BodyLine[]): number => body.filter((e) => e.k === 'c' || e.k === 'a').length;

/** The lines a matched body writes over the file's lines at `pos`: context lines are the file's own. */
function buildSegment(fileLines: string[], pos: number, body: BodyLine[], tier: number): string[] {
  const seg: string[] = [];
  const o = oldLines(body);
  const f = tier === 2 ? leadWs(fileLines[pos]!) : '';
  const p = tier === 2 ? leadWs(o[0]!) : '';
  let oi = 0;
  for (const e of body) {
    if (e.k === 'c') {
      seg.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (e.k === 'd') {
      oi += 1;
    } else if (e.k === 'a') {
      seg.push(tier === 2 ? reindent(e.t, f, p) : e.t);
    }
  }
  return seg;
}

/** Whether a `\` line follows the body's last context or `+` line. */
function backslashAfterLastWritten(body: BodyLine[]): boolean {
  let last = -1;
  body.forEach((e, i) => {
    if (e.k === 'c' || e.k === 'a') last = i;
  });
  return last >= 0 && body[last + 1]?.k === 'b';
}

/* ---------------- Format detection (SPEC.md section 4) ---------------- */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---------------- Unified diffs (SPEC.md section 6) ---------------- */

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  gitOld?: string;
  gitNew?: string;
  pairOld?: string | null;
  pairNew?: string | null;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const trimPad = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** The path a `--- ` or `+++ ` header line names: after the four characters, to the first tab, `/dev/null` is null. */
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = trimPad(t);
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseDiffGit(line: string, at: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${at + 1}`);
  const sep = rest.indexOf(' b/', 2);
  if (sep < 0) throw new Exit2(`error: parse ${at + 1}`);
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') throw new Exit2(`error: parse ${at + 1}`);
  return [x, y];
}

function unifiedSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  const pairAt = (i: number): boolean => lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const [x, y] = parseDiffGit(line, i);
      cur = { gitOld: x, gitNew: y, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (pairAt(i)) {
      if (cur !== null && cur.pairOld === undefined && cur.hunks.length === 0) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
      } else {
        cur = { newFile: false, deletedFile: false, hunks: [], pairOld: headerPath(line), pairNew: headerPath(lines[i + 1]!) };
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: (BodyLine & { emptyRaw?: boolean })[] = [];
      i += 1;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ') || pairAt(i)) break;
        if (bl === '') {
          body.push({ k: 'c', t: '', emptyRaw: true });
          i += 1;
        } else if (bl[0] === ' ') {
          body.push({ k: 'c', t: bl.slice(1) });
          i += 1;
        } else if (bl[0] === '-') {
          body.push({ k: 'd', t: bl.slice(1) });
          i += 1;
        } else if (bl[0] === '+') {
          body.push({ k: 'a', t: bl.slice(1) });
          i += 1;
        } else if (bl[0] === '\\') {
          body.push({ k: 'b', t: bl.slice(1) });
          i += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1]!.emptyRaw) body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // The section's header, before its first hunk.
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = trimPad(line.slice('rename from '.length));
      else if (line.startsWith('rename to ')) cur.renameTo = trimPad(line.slice('rename to '.length));
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1; // Outside bodies and headers, lines are ignored.
  }
  return sections;
}

/** Apply a section's hunks to a file model; a hunk that finds nothing fails the section. */
function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const o = oldLines(h.body);
    const n = newCount(h.body);
    if (o.length === 0) {
      let at = h.a + d;
      if (at > model.lines.length) at = model.lines.length;
      if (at < 0) at = 0;
      const seg = h.body.filter((e) => e.k === 'a').map((e) => e.t);
      const atEnd = at === model.lines.length;
      model.lines.splice(at, 0, ...seg);
      if (atEnd) model.eol = !backslashAfterLastWritten(h.body);
    } else {
      const found = findOccurrences(model.lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.positions[0]!;
      for (const p of found.positions) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      const seg = buildSegment(model.lines, pos, h.body, found.tier);
      const touchesEnd = pos + o.length === model.lines.length;
      model.lines.splice(pos, o.length, ...seg);
      if (touchesEnd) model.eol = !backslashAfterLastWritten(h.body);
    }
    d += n - o.length;
  }
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld!;
  const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew!;
  return (tree) => {
    if (oldP === null || sec.newFile) {
      // A creation: the file is the `+` lines of all the section's hunks.
      if (newP === null) return;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const ls: string[] = [];
      let lastHunk: Hunk | null = null;
      for (const h of sec.hunks) {
        let has = false;
        for (const e of h.body) {
          if (e.k === 'a') {
            ls.push(e.t);
            has = true;
          }
        }
        if (has) lastHunk = h;
      }
      const eol = lastHunk === null || !backslashAfterLastWritten(lastHunk.body);
      tree.now.set(newP, writeFile({ lines: ls, br: '\n', eol }));
      return;
    }
    if (newP === null || sec.deletedFile) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (newP !== oldP && tree.get(newP) !== null) throw new Fail('exists', newP);
    const model = parseFile(before);
    applyHunks(model, sec.hunks, strict, oldP);
    const out = writeFile(model);
    if (newP !== oldP) {
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(newP, out);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = unifiedSections(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => sectionEdit(s, strict));
}

/* ---------------- SEARCH/REPLACE blocks (SPEC.md section 7) ---------------- */

function srEdit(path: string, o: string[], n: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (o.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, writeFile({ lines: [...n], br: '\n', eol: true }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = parseFile(before);
    const found = findOccurrences(model.lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const seg =
      found.tier === 2 ? n.map((l) => reindent(l, leadWs(model.lines[pos]!), leadWs(o[0]!))) : [...n];
    model.lines.splice(pos, o.length, ...seg);
    tree.now.set(path, writeFile(model));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const at = i;
    let eq = -1;
    for (let j = at + 1; j < lines.length; j += 1) if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
    if (eq < 0) throw new Exit2(`error: parse ${at + 1}`);
    let rp = -1;
    for (let j = eq + 1; j < lines.length; j += 1) if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rp = j; break; }
    if (rp < 0) throw new Exit2(`error: parse ${at + 1}`);
    let path: string | null = null;
    for (let j = at - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${at + 1}`);
    }
    edits.push(srEdit(path, lines.slice(at + 1, eq), lines.slice(eq + 1, rp), strict));
    prevPath = path;
    prevEnd = rp + 1;
    i = rp + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---------------- V4A patches (SPEC.md section 8) ---------------- */

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function v4aUpdate(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundPos = -1;
        const top = strict ? 0 : 2;
        for (let tier = 0; tier <= top && foundPos < 0; tier += 1) {
          for (let p = cursor; p < model.lines.length; p += 1) {
            if (matchLine(model.lines[p]!, ch.anchor, tier)) {
              foundPos = p;
              break;
            }
          }
        }
        if (foundPos < 0) throw new Fail('no-match', path);
        cursor = foundPos + 1;
      }
      const o = oldLines(ch.body);
      if (o.length === 0) {
        const seg = ch.body.filter((e) => e.k === 'a').map((e) => e.t);
        const at = ch.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        model.lines.splice(at, 0, ...seg);
        cursor = at + seg.length;
        continue;
      }
      const top = strict ? 0 : 2;
      let occ: { tier: number; positions: number[] } | null = null;
      for (let tier = 0; tier <= top; tier += 1) {
        const ps: number[] = [];
        for (let p = cursor; p + o.length <= model.lines.length; p += 1) {
          if (!matchesAt(model.lines, p, o, tier)) continue;
          if (ch.eof && p + o.length !== model.lines.length) continue;
          ps.push(p);
        }
        if (ps.length > 0) {
          occ = { tier, positions: ps };
          break;
        }
      }
      if (occ === null) throw new Fail('no-match', path);
      const pos = occ.positions[0]!;
      const seg = buildSegment(model.lines, pos, ch.body, occ.tier);
      model.lines.splice(pos, o.length, ...seg);
      cursor = pos + seg.length;
    }
    const out = writeFile(model);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstNB = lines.findIndex((l) => !blank(l));
  if (firstNB < 0) throw new Exit2('error: parse 1');
  if (lines[firstNB]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNB + 1}`);
  let lastNB = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) if (!blank(lines[j]!)) { lastNB = j; break; }
  if (lines[lastNB]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secStart = (l: string): 'add' | 'del' | 'upd' | null =>
    l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'del' : l.startsWith('*** Update File: ') ? 'upd' : null;
  const edits: Edit[] = [];
  let i = firstNB + 1;
  while (i < lastNB) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = secStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const secLine = i;
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'del' ? '*** Delete File: ' : '*** Update File: ';
    const path = trimPad(line.slice(prefix.length));
    const raw: { t: string; n: number }[] = [];
    i += 1;
    while (i < lastNB && secStart(lines[i]!) === null) {
      raw.push({ t: lines[i]!, n: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.t)) raw.pop();
    if (kind === 'add') {
      const content: string[] = [];
      for (const r of raw) {
        if (r.t.startsWith('+')) content.push(r.t.slice(1));
        else if (r.t === '') content.push('');
        else throw new Exit2(`error: parse ${r.n}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, writeFile({ lines: content, br: '\n', eol: true }));
      });
    } else if (kind === 'del') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.n}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let idx = 0;
      let moveTo: string | null = null;
      if (idx < raw.length && raw[idx]!.t.startsWith('*** Move to: ')) {
        moveTo = trimPad(raw[idx]!.t.slice('*** Move to: '.length));
        idx += 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      let afterEof = false;
      for (; idx < raw.length; idx += 1) {
        const r = raw[idx]!;
        const t = r.t;
        if (t.startsWith('@@')) {
          cur = { anchor: trimPad(t.slice(2)) || null, eof: false, body: [] };
          chunks.push(cur);
          afterEof = false;
        } else if (t.trimEnd() === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          cur.eof = true;
          cur = null;
          afterEof = true;
        } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (cur === null) {
            if (chunks.length === 0 && !afterEof) {
              cur = { anchor: null, eof: false, body: [] };
              chunks.push(cur);
            } else throw new Exit2(`error: parse ${r.n}`);
          }
          if (t === '') cur.body.push({ k: 'c', t: '' });
          else if (t[0] === ' ') cur.body.push({ k: 'c', t: t.slice(1) });
          else if (t[0] === '-') cur.body.push({ k: 'd', t: t.slice(1) });
          else cur.body.push({ k: 'a', t: t.slice(1) });
        } else {
          throw new Exit2(`error: parse ${r.n}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine + 1}`);
      edits.push(v4aUpdate(path, moveTo, chunks, strict));
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---------------- JSON edits (SPEC.md section 9) ---------------- */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      // section 9: the file gains a final break if it did not end with one
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + br);
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------------- The run (SPEC.md sections 1, 2 and 10) ---------------- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const state = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const rows: { key: string; text: string }[] = [];
  const consumed = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (consumed.has(o) || consumed.has(n)) continue;
    if (tree.original(o) !== null && state(o) === null && tree.original(n) === null && state(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      consumed.add(o);
      consumed.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
