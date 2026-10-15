import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { OUTBOX } from './support';

export default function globalSetup() {
  rmSync(OUTBOX, { recursive: true, force: true });
  mkdirSync(OUTBOX, { recursive: true });
  execFileSync('pnpm', ['-w', 'exec', 'tsx', 'apps/web/e2e/reset-db.mts'], { cwd: '../..', stdio: 'inherit', env: process.env });
}
