#!/usr/bin/env node
// Lightweight secret scan over git-tracked files (PRD §12.3 "vérification secrets", Q02).
// Not a replacement for a dedicated scanner in CI history scans; it blocks the obvious leaks.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PATTERNS = [
  ['recall/svix webhook secret', /whsec_[A-Za-z0-9+/=]{16,}/],
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/],
  ['openai/anthropic-style key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/],
  ['aws access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['url with inline password (non-local)', /\b[a-z]+:\/\/[^\s:@/]+:(?!alfred\b|postgres\b|password\b|x\b)[^\s:@/]{6,}@(?!localhost|127\.0\.0\.1)[^\s/]+/i],
  ['secret-looking env assignment', /^\s*[A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|PRIVATE_KEY|PASSWORD)[A-Z0-9_]*\s*=\s*['"]?(?!['"]?\s*(?:#|$))[A-Za-z0-9+/_=.-]{16,}/m],
];

export function scanText(text) {
  return PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const bad = [];
  for (const f of files) {
    if (/(^|\/)\.env(\.|$)/.test(f) && !f.endsWith('.env.example')) bad.push([f, 'tracked .env file']);
    if (/\.(png|jpg|ico|woff2?|lock|docx)$/.test(f) || f.endsWith('pnpm-lock.yaml') || f === 'scripts/secrets-scan.mjs' || f.endsWith('secrets-scan.test.ts')) continue;
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    for (const name of scanText(text)) bad.push([f, name]);
  }
  if (bad.length) {
    for (const [f, n] of bad) console.error(`SECRET? ${n} in ${f}`);
    process.exit(1);
  }
  console.log(`secrets:scan OK (${files.length} tracked files)`);
}
