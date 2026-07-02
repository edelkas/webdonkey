// expr.js — search-expression construction.
//
// PURE MODULE: no DOM, no network. Two responsibilities:
//   1. parseBooleanQuery(text): parse eMule-style boolean search-bar syntax
//      (AND / OR / NOT, quoted phrases, parentheses, implicit-AND) into the
//      normalized search-tree node model from protocol.js.
//   2. buildSearchTree(fields): combine the parsed query with the structured
//      form fields (type, size min/max, format, min sources, media meta) into a
//      single tree ready for protocol.serializeSearchTree().
//
// See CLAUDE.md §4.5 (expression encoding) and §5.1 (form fields).

import { node, FT } from './protocol.js';

// ---------------------------------------------------------------------------
// 1. Boolean query parser
// ---------------------------------------------------------------------------
//
// Grammar (recursive descent, precedence: NOT > AND > OR; space => implicit AND):
//   orExpr   := andExpr ( OR andExpr )*
//   andExpr  := notExpr ( (AND | <implicit>) notExpr )*
//   notExpr  := NOT notExpr | primary
//   primary  := '(' orExpr ')' | QUOTED | WORD

const KEYWORDS = new Set(['AND', 'OR', 'NOT']);

/** Tokenize into {type:'lparen'|'rparen'|'op'|'term', value} tokens. */
function tokenize(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '(') {
      tokens.push({ type: 'lparen' });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ type: 'rparen' });
      i++;
      continue;
    }
    if (c === '"') {
      // quoted phrase — kept verbatim as a single term
      let j = i + 1;
      let s = '';
      while (j < n && text[j] !== '"') s += text[j++];
      tokens.push({ type: 'term', value: s, phrase: true });
      i = j < n ? j + 1 : j;
      continue;
    }
    // bare word: run until whitespace or a paren/quote
    let j = i;
    let s = '';
    while (j < n && !' \t\n\r()"'.includes(text[j])) s += text[j++];
    i = j;
    const upper = s.toUpperCase();
    if (KEYWORDS.has(upper)) tokens.push({ type: 'op', value: upper });
    else tokens.push({ type: 'term', value: s });
  }
  return tokens;
}

/**
 * Parse eMule-style boolean search text into a search-tree node (or null if the
 * text has no usable terms). Malformed grouping degrades gracefully rather than
 * throwing.
 */
export function parseBooleanQuery(text) {
  const tokens = tokenize(text ?? '');
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().type === 'op' && peek().value === 'OR') {
      next();
      const right = parseAnd();
      left = combine('or', left, right);
    }
    return left;
  }

  function parseAnd() {
    let left = parseNot();
    while (peek()) {
      const t = peek();
      if (t.type === 'op' && t.value === 'AND') {
        next();
        left = combine('and', left, parseNot());
      } else if (t.type === 'term' || t.type === 'lparen' || (t.type === 'op' && t.value === 'NOT')) {
        // implicit AND between adjacent terms
        left = combine('and', left, parseNot());
      } else {
        break; // OR or rparen
      }
    }
    return left;
  }

  function parseNot() {
    if (peek() && peek().type === 'op' && peek().value === 'NOT') {
      next();
      const operand = parseNot();
      return operand ? node.not(operand) : null;
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const t = peek();
    if (!t) return null;
    if (t.type === 'lparen') {
      next();
      const inner = parseOr();
      if (peek() && peek().type === 'rparen') next(); // tolerate missing ')'
      return inner;
    }
    if (t.type === 'term') {
      next();
      const v = t.value.trim();
      return v ? node.str(v) : null;
    }
    // stray operator/rparen — skip to avoid infinite loop
    next();
    return null;
  }

  const tree = parseOr();
  return tree ?? null;
}

/** Combine two possibly-null operands under a boolean op, flattening nulls. */
function combine(op, a, b) {
  if (!a) return b;
  if (!b) return a;
  return op === 'or' ? node.or(a, b) : node.and(a, b);
}

// ---------------------------------------------------------------------------
// 2. Form -> search tree
// ---------------------------------------------------------------------------

/**
 * Build the final search tree from form fields. All present constraints are
 * AND-ed together with the parsed boolean query.
 *
 * @param {object} fields
 * @param {string} [fields.query]        boolean search-bar text
 * @param {string} [fields.type]         FILETYPE.* value (e.g. 'Audio')
 * @param {string} [fields.format]       extension/format (e.g. 'mp3')
 * @param {number|bigint} [fields.minSize]  bytes
 * @param {number|bigint} [fields.maxSize]  bytes
 * @param {number} [fields.minSources]   minimum availability
 * @param {number} [fields.minBitrate]
 * @param {number} [fields.maxBitrate]
 * @param {number} [fields.minLength]    seconds
 * @param {number} [fields.maxLength]    seconds
 * @param {string} [fields.codec]
 * @returns {object|null} search tree node, or null if there are no constraints
 */
export function buildSearchTree(fields = {}) {
  const parts = [];

  const q = parseBooleanQuery(fields.query);
  if (q) parts.push(q);

  if (fields.type) parts.push(node.meta(fields.type, FT.FILETYPE));
  if (fields.format) parts.push(node.meta(fields.format, FT.FILEFORMAT));
  if (fields.codec) parts.push(node.meta(fields.codec, FT.MEDIA_CODEC));

  if (isNum(fields.minSize)) parts.push(node.min(FT.FILESIZE, toBig(fields.minSize)));
  if (isNum(fields.maxSize)) parts.push(node.max(FT.FILESIZE, toBig(fields.maxSize)));
  if (isNum(fields.minSources)) parts.push(node.min(FT.SOURCES, fields.minSources));
  if (isNum(fields.minBitrate)) parts.push(node.min(FT.MEDIA_BITRATE, fields.minBitrate));
  if (isNum(fields.maxBitrate)) parts.push(node.max(FT.MEDIA_BITRATE, fields.maxBitrate));
  if (isNum(fields.minLength)) parts.push(node.min(FT.MEDIA_LENGTH, fields.minLength));
  if (isNum(fields.maxLength)) parts.push(node.max(FT.MEDIA_LENGTH, fields.maxLength));

  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return node.and(...parts);
}

function isNum(v) {
  return v !== undefined && v !== null && v !== '' && !Number.isNaN(Number(v));
}
function toBig(v) {
  return typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v)));
}
