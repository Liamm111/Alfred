#!/usr/bin/env node
// Repo guard (PRD v0.2 invariant): nothing may join a meeting as an additional identity — no meeting bot, no Meeting SDK join,
// no "recall"-style participant provider, no bot_join=true. AST-based for JS/TS, pattern-based for Swift/JSON/YAML/env files.
// Allowed Zoom surfaces: @zoom/rtms (official RTMS stream consumer) and the Zoom Apps SDK (in-client surface app).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const FORBIDDEN_CALLS = new Set(['joinMeeting', 'joinCall', 'createBot', 'startBot', 'inviteBot', 'joinAsBot', 'joinMeetingAsBot']);
const FORBIDDEN_MODULE = /(^|[/@-])(recall(ai|-ai)?|meetingsdk|meeting-sdk|zoomus|websdk|zoomMtg|zoom-meeting)([/-]|$)/i;
const FORBIDDEN_OBJECTS = new Set(['ZoomMtg', 'ZoomMtgEmbedded']);
const SWIFT_RE = /\b(ZoomSDK|MobileRTC|MeetingSDK|ZMMeetingService|joinMeeting)\b/;
const HOST_RE = /\bapi\.recall\.ai\b|recall\.ai\/api/i;
const FLAG_RE = /(^|[^A-Za-z0-9_])bot_join\s*[:=]\s*['"]?true\b/im; // for non-JS/TS files (the AST covers code)

/** @returns {string[]} violation messages for one file */
export function scanSource(path, text) {
  const out = [];
  if (/\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(path)) {
    const kind = /x$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
    const at = (n) => `${path}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
    const visit = (n) => {
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const e = n.expression;
        const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
        if (name && FORBIDDEN_CALLS.has(name)) out.push(`${at(n)} forbidden call ${name}()`);
        if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && FORBIDDEN_OBJECTS.has(e.expression.text)) out.push(`${at(n)} forbidden ${e.expression.text}.${e.name.text}()`);
        if (ts.isIdentifier(e) && e.text === 'require' && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && FORBIDDEN_MODULE.test(n.arguments[0].text)) out.push(`${at(n)} forbidden require("${n.arguments[0].text}")`);
        if (e.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && FORBIDDEN_MODULE.test(n.arguments[0].text)) out.push(`${at(n)} forbidden import("${n.arguments[0].text}")`);
      }
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && FORBIDDEN_MODULE.test(n.moduleSpecifier.text)) out.push(`${at(n)} forbidden module "${n.moduleSpecifier.text}"`);
      if (ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isMethodSignature(n)) {
        const nm = n.name && ts.isIdentifier(n.name) ? n.name.text : null;
        if (nm && FORBIDDEN_CALLS.has(nm)) out.push(`${at(n)} forbidden declaration ${nm}`);
      }
      if (ts.isPropertyAssignment(n) || ts.isVariableDeclaration(n) || ts.isBinaryExpression(n)) {
        const [lhs, rhs] = ts.isBinaryExpression(n) ? [n.left, n.right] : [n.name, ts.isPropertyAssignment(n) ? n.initializer : n.initializer];
        const lname = lhs && (ts.isIdentifier(lhs) ? lhs.text : ts.isStringLiteral(lhs) ? lhs.text : ts.isPropertyAccessExpression(lhs) ? lhs.name.text : null);
        if (lname && /^bot_join$/i.test(lname) && rhs && (rhs.kind === ts.SyntaxKind.TrueKeyword || (ts.isStringLiteral(rhs) && rhs.text.toLowerCase() === 'true'))) out.push(`${at(n)} bot_join must never be true`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  if (path.endsWith('package.json')) {
    try {
      const j = JSON.parse(text);
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const dep of Object.keys(j[section] ?? {})) if (FORBIDDEN_MODULE.test(dep)) out.push(`${path} forbidden dependency ${dep}`);
      }
    } catch { /* not json */ }
  }
  if (path.endsWith('.swift') && SWIFT_RE.test(text)) out.push(`${path} forbidden Zoom meeting-join API in Swift`);
  const binary = /\.(png|jpg|ico|lock|docx)$/.test(path);
  const isCode = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(path);
  if (!binary && HOST_RE.test(text)) out.push(`${path} forbidden meeting-bot provider host`);
  if (!binary && !isCode && FLAG_RE.test(text)) out.push(`${path} bot_join=true is forbidden`);
  return out;
}

const EXEMPT = /^(docs\/|reports\/|archive\/|scripts\/forbid-bot-join\.mjs$|scripts\/__tests__\/forbid-bot-join\.test\.ts$|pnpm-lock\.yaml$)/;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter((f) => f && !EXEMPT.test(f));
  const violations = [];
  for (const f of files) {
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    violations.push(...scanSource(f, text));
  }
  if (violations.length) {
    for (const v of violations) console.error(`BOT-JOIN GUARD: ${v}`);
    process.exit(1);
  }
  console.log(`check:no-bot OK (${files.length} tracked files scanned; docs/, reports/, archive/ exempt as history)`);
}
