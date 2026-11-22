// mend: one patch tool for every AI edit format (SPEC.md v1).
// Written in this session: the three-tier line matching of section 5,
// unified diffs (section 6), SEARCH/REPLACE blocks (section 7) and V4A
// patches (section 8), plus move rows in the output, on top of the
// starter's sections 1-4, 9 and 10. Node 22, standard library only.

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

/** A file as lines, with its own line break and whether it ends with one. */
interface FileState {
  lines: string[];
  br: string;
  fin: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function renderFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.fin ? s.br : '');
}

const leadingWS = (s: string): string => s.match(/^[ \t]*/)?.[0] ?? '';
const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** One body line of a hunk or chunk: context, deleted or added. */
interface Op {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  /** A `\` line followed this op (no line break after it). */
  noEol?: boolean;
  /** A context line that came from a blank patch line (not a ` ` line). */
  blank?: boolean;
}

const oldLinesOf = (ops: Op[]): string[] => ops.filter((o) => o.kind !== 'add').map((o) => o.text);
const newLinesOf = (ops: Op[]): string[] => ops.filter((o) => o.kind !== 'del').map((o) => o.text);

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWS(a) === trimEndWS(b);
  return trimWS(a) === trimWS(b);
}

/** Every position where O occurs in lines at the given tier, from `from` on. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) where O occurs. */
function findTier(lines: string[], o: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Replace the O lines at `pos` with the ops' N lines (SPEC.md section 5). */
function applyOps(lines: string[], pos: number, ops: Op[], tier: number): string[] {
  const o = oldLinesOf(ops);
  const f = pos < lines.length ? leadingWS(lines[pos]!) : '';
  const p = o.length > 0 ? leadingWS(o[0]!) : '';
  const out: string[] = lines.slice(0, pos);
  let oi = 0;
  for (const op of ops) {
    if (op.kind === 'del') {
      oi += 1;
      continue;
    }
    if (op.kind === 'ctx') {
      out.push(lines[pos + oi]!);
      oi += 1;
      continue;
    }
    let t = op.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  out.push(...lines.slice(pos + o.length));
  return out;
}

function insertLines(lines: string[], at: number, add: string[]): string[] {
  return [...lines.slice(0, at), ...add, ...lines.slice(at)];
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

type MoveInfo = { from: string; to: string };
type Edit = (tree: Tree) => MoveInfo | void;

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
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

/* ---------------- unified diffs (SPEC.md section 6) ---------------- */

interface Hunk {
  a: number;
  ops: Op[];
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(h: Hunk): boolean {
  for (let k = h.ops.length - 1; k >= 0; k -= 1) {
    const op = h.ops[k]!;
    if (op.kind === 'del') continue;
    return op.noEol === true;
  }
  return false;
}

interface Section {
  diffOld?: string;
  diffNew?: string;
  oldPath?: string;
  newPath?: string;
  renameFrom?: string;
  renameTo?: string;
  createFlag: boolean;
  deleteFlag: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;
const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)\s*$/;

/** Path after `--- ` / `+++ `: text after 4 chars, up to the first tab, spaces trimmed. */
function headerPath(line: string): string {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  return t.trim();
}

const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

/** Apply a section's hunks in order to a file state. */
function applyHunks(state: FileState, hunks: Hunk[], path: string, strict: boolean): FileState {
  let cur = state;
  let d = 0;
  for (const h of hunks) {
    const o = oldLinesOf(h.ops);
    const n = newLinesOf(h.ops);
    if (h.ops.length === 0) continue;
    if (o.length > 0) {
      const found = findTier(cur.lines, o, 0, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const lines = applyOps(cur.lines, best, h.ops, found.tier);
      const atEnd = best + o.length === cur.lines.length;
      cur = { lines, br: cur.br, fin: atEnd ? !hunkNoEol(h) : cur.fin };
    } else {
      const ins = Math.min(h.a + d, cur.lines.length);
      const lines = insertLines(cur.lines, ins, n);
      cur = { lines, br: cur.br, fin: ins === cur.lines.length ? !hunkNoEol(h) : cur.fin };
    }
    d += n.length - o.length;
  }
  return cur;
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  const oldRaw = sec.oldPath ?? sec.renameFrom ?? sec.diffOld ?? '';
  const newRaw = sec.newPath ?? sec.renameTo ?? sec.diffNew ?? '';
  const oldIsNull = oldRaw === '/dev/null';
  const newIsNull = newRaw === '/dev/null';
  const oldPath = oldIsNull ? null : stripAB(oldRaw);
  const newPath = newIsNull ? null : stripAB(newRaw);
  const isCreate = oldIsNull || sec.createFlag;
  const isDelete = newIsNull || sec.deleteFlag;
  const isMove = oldPath !== null && newPath !== null && oldPath !== newPath;
  return (tree: Tree) => {
    if (isCreate) {
      if (newPath === null || !safe(newPath)) throw new Fail('unsafe', newPath ?? '');
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const added: string[] = [];
      let lastAddNoEol = false;
      for (const h of sec.hunks) {
        for (const op of h.ops) {
          if (op.kind === 'add') {
            added.push(op.text);
            lastAddNoEol = op.noEol === true;
          }
        }
      }
      tree.now.set(newPath, renderFile({ lines: added, br: '\n', fin: added.length === 0 || !lastAddNoEol }));
      return undefined;
    }
    if (isDelete) {
      if (oldPath === null || !safe(oldPath)) throw new Fail('unsafe', oldPath ?? '');
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return undefined;
    }
    if (isMove) {
      const from = oldPath!;
      const to = newPath!;
      if (!safe(from)) throw new Fail('unsafe', from);
      if (!safe(to)) throw new Fail('unsafe', to);
      const cur = tree.get(from);
      if (cur === null) throw new Fail('missing', from);
      if (tree.get(to) !== null) throw new Fail('exists', to);
      const out = applyHunks(parseFile(cur), sec.hunks, from, strict);
      tree.now.set(to, renderFile(out));
      tree.now.set(from, null);
      return { from, to };
    }
    const p = oldPath ?? '';
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const out = applyHunks(parseFile(cur), sec.hunks, p, strict);
    tree.now.set(p, renderFile(out));
    return undefined;
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  const n = lines.length;
  let sec: Section | null = null;
  let inHeader = false;
  let i = 0;
  const newSection = (): Section => ({ createFlag: false, deleteFlag: false, hunks: [] });
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = newSection();
      sec.diffOld = m[1]!;
      sec.diffNew = m[2]!;
      sections.push(sec);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec !== null && inHeader && sec.oldPath === undefined) {
        sec.oldPath = stripAB(headerPath(line));
        sec.newPath = stripAB(headerPath(lines[i + 1]!));
        i += 2;
        continue;
      }
      sec = newSection();
      sec.oldPath = stripAB(headerPath(line));
      sec.newPath = stripAB(headerPath(lines[i + 1]!));
      sections.push(sec);
      inHeader = true;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && sec !== null && inHeader) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const hunk: Hunk = { a: parseInt(m[1]!, 10), ops: [] };
      i += 1;
      const body: string[] = [];
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\') || bl === '') {
          body.push(bl);
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
      for (const bl of body) {
        if (bl.startsWith(' ')) hunk.ops.push({ kind: 'ctx', text: bl.slice(1) });
        else if (bl.startsWith('-')) hunk.ops.push({ kind: 'del', text: bl.slice(1) });
        else if (bl.startsWith('+')) hunk.ops.push({ kind: 'add', text: bl.slice(1) });
        else if (bl.startsWith('\\')) {
          const lastOp = hunk.ops[hunk.ops.length - 1];
          if (lastOp !== undefined) lastOp.noEol = true;
        } else hunk.ops.push({ kind: 'ctx', text: '', blank: true });
      }
      sec.hunks.push(hunk);
      continue;
    }
    if (sec !== null && inHeader) {
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) sec.createFlag = true;
      else if (line.startsWith('deleted file mode')) sec.deleteFlag = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/* ------------- SEARCH/REPLACE blocks (SPEC.md section 7) ------------- */

function searchReplaceEdit(path: string, oldL: string[], newL: string[], strict: boolean): Edit {
  const ops: Op[] = [
    ...oldL.map((t): Op => ({ kind: 'del', text: t })),
    ...newL.map((t): Op => ({ kind: 'add', text: t })),
  ];
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldL.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, renderFile({ lines: newL, br: '\n', fin: newL.length > 0 }));
      return undefined;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const st = parseFile(cur);
    const found = findTier(st.lines, oldL, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const lines = applyOps(st.lines, found.occ[0]!, ops, found.tier);
    tree.now.set(path, renderFile({ lines, br: st.br, fin: st.fin }));
    return undefined;
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let prevEnd = -1;
  let prevPath: string | null = null;
  while (true) {
    let s = -1;
    for (let k = i; k < n; k += 1) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        s = k;
        break;
      }
    }
    if (s === -1) break;
    let path: string | null = null;
    for (let k = s - 1; k > prevEnd; k -= 1) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let k = s + 1; k < n; k += 1) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < n; k += 1) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------- V4A patches (SPEC.md section 8) ------------------- */

interface Chunk {
  anchor: string | null;
  ops: Op[];
  eof: boolean;
}

function applyV4aChunk(st: FileState, ch: Chunk, cursor: number, strict: boolean, path: string): { st: FileState; cursor: number } {
  let cur = cursor;
  if (ch.anchor !== null && ch.anchor !== '') {
    const found = findTier(st.lines, [ch.anchor], cur, strict);
    if (found === null) throw new Fail('no-match', path);
    cur = found.occ[0]! + 1;
  }
  const o = oldLinesOf(ch.ops);
  const n = newLinesOf(ch.ops);
  if (o.length > 0) {
    const found = findTier(st.lines, o, cur, strict);
    if (found === null) throw new Fail('no-match', path);
    let pos: number | undefined;
    if (ch.eof) {
      for (const p of found.occ) {
        if (p + o.length === st.lines.length) {
          pos = p;
          break;
        }
      }
      if (pos === undefined) throw new Fail('no-match', path);
    } else {
      pos = found.occ[0]!;
    }
    const lines = applyOps(st.lines, pos, ch.ops, found.tier);
    return { st: { lines, br: st.br, fin: st.fin }, cursor: pos + n.length };
  }
  const ins = ch.eof ? st.lines.length : cur;
  const lines = insertLines(st.lines, ins, n);
  return { st: { lines, br: st.br, fin: st.fin }, cursor: ins + n.length };
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, renderFile({ lines: fileLines, br: '\n', fin: fileLines.length > 0 }));
    return undefined;
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
    return undefined;
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let st = parseFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      const r = applyV4aChunk(st, ch, cursor, strict, path);
      st = r.st;
      cursor = r.cursor;
    }
    const out = renderFile(st);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      return { from: path, to: moveTo };
    }
    tree.now.set(path, out);
    return undefined;
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const kindOf = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  const edits: Edit[] = [];
  let i = first + 1;
  while (true) {
    while (i < last && blank(lines[i]!)) i += 1;
    if (i >= last) break;
    const kind = kindOf(lines[i]!);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const headerNo = i + 1;
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const path = lines[i]!.slice(prefix.length).trim();
    i += 1;
    const content: { text: string; no: number }[] = [];
    while (i < last && kindOf(lines[i]!) === null) {
      content.push({ text: lines[i]!, no: i + 1 });
      i += 1;
    }
    // Blank lines (empty or only whitespace) at the end of a section are
    // not part of it, so they never become file lines or chunk lines.
    while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
    if (kind === 'add') {
      const items: { text: string; blankLine: boolean }[] = [];
      for (const c of content) {
        if (c.text === '') items.push({ text: '', blankLine: true });
        else if (c.text.startsWith('+')) items.push({ text: c.text.slice(1), blankLine: false });
        else throw new Exit2(`error: parse ${c.no}`);
      }
      while (items.length > 0 && items[items.length - 1]!.blankLine) items.pop();
      edits.push(v4aAddEdit(path, items.map((x) => x.text)));
    } else if (kind === 'delete') {
      for (const c of content) {
        if (c.text === '') continue;
        throw new Exit2(`error: parse ${c.no}`);
      }
      edits.push(v4aDeleteEdit(path));
    } else {
      let moveTo: string | null = null;
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      let started = false;
      let afterEof = false;
      let seenNonBlank = false;
      const pending: Op[] = [];
      const bodyOp = (l: string): Op => {
        if (l.startsWith(' ')) return { kind: 'ctx', text: l.slice(1) };
        if (l.startsWith('-')) return { kind: 'del', text: l.slice(1) };
        return { kind: 'add', text: l.slice(1) };
      };
      for (const c of content) {
        const l = c.text;
        if (l === '') {
          if (cur !== null) cur.ops.push({ kind: 'ctx', text: '', blank: true });
          else if (!started) pending.push({ kind: 'ctx', text: '', blank: true });
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${c.no}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          started = true;
          afterEof = true;
          pending.length = 0;
          continue;
        }
        if (l.startsWith('@@')) {
          if (cur !== null) {
            chunks.push(cur);
            cur = null;
          }
          pending.length = 0;
          cur = { anchor: l.slice(2).trim(), ops: [], eof: false };
          started = true;
          afterEof = false;
          seenNonBlank = true;
          continue;
        }
        if (l.startsWith('*** Move to: ')) {
          if (moveTo !== null || started || cur !== null || seenNonBlank) throw new Exit2(`error: parse ${c.no}`);
          moveTo = l.slice('*** Move to: '.length).trim();
          seenNonBlank = true;
          pending.length = 0;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (afterEof) throw new Exit2(`error: parse ${c.no}`);
          if (cur === null) {
            cur = { anchor: null, ops: [...pending], eof: false };
            pending.length = 0;
            started = true;
          }
          cur.ops.push(bodyOp(l));
          seenNonBlank = true;
          continue;
        }
        throw new Exit2(`error: parse ${c.no}`);
      }
      if (cur !== null) {
        while (cur.ops.length > 0) {
          const lastOp = cur.ops[cur.ops.length - 1]!;
          if (lastOp.kind === 'ctx' && lastOp.text === '' && lastOp.blank === true) cur.ops.pop();
          else break;
        }
        chunks.push(cur);
        cur = null;
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerNo}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: MoveInfo[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const r = edit(tree);
      if (r !== undefined) moves.push(r);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const consumed = new Set<string>();
  for (const mv of moves) {
    const wasOld = tree.original(mv.from);
    const wasNew = tree.original(mv.to);
    const nowOld = tree.now.get(mv.from);
    const nowNew = tree.now.get(mv.to);
    if (wasOld !== null && wasNew === null && nowOld === null && nowNew !== null) {
      rows.push({ key: mv.to, text: `R ${mv.from} -> ${mv.to}` });
      consumed.add(mv.from);
      consumed.add(mv.to);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
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
