import type { Readable, Writable } from 'node:stream';
import { MacPermissionDenied, type MacBridge } from './mac_bridge.ts';

export interface HelperIo { stdin: Writable; stdout: Readable }
export interface MacEvents { delivered(token: string): void; clicked(token: string): void; zoomOpened?(token: string): void }

/** Dialogue NDJSON avec le helper Swift. Une commande sans `notify_result` dans le délai → erreur transitoire (l'outbox réessaiera). */
export class ProcessMacBridge implements MacBridge {
  #io: HelperIo; #events: MacEvents; #timeout: number;
  #waiters = new Map<string, (status: string) => void>();
  #buf = '';
  constructor(io: HelperIo, events: MacEvents, timeoutMs = 5000) {
    this.#io = io; this.#events = events; this.#timeout = timeoutMs;
    io.stdout.on('data', (c: Buffer | string) => { this.#buf += c.toString(); let i; while ((i = this.#buf.indexOf('\n')) >= 0) { const line = this.#buf.slice(0, i); this.#buf = this.#buf.slice(i + 1); this.#onLine(line); } });
  }

  #onLine(line: string): void {
    let m: { type?: string; token?: string; status?: string };
    try { m = JSON.parse(line); } catch { return; } // ligne de log du helper : ignorée
    if (!m.token) return;
    if (m.type === 'notify_result') this.#waiters.get(m.token)?.(m.status ?? 'error');
    else if (m.type === 'delivered') this.#events.delivered(m.token);
    else if (m.type === 'clicked') this.#events.clicked(m.token);
    else if (m.type === 'zoom_opened') this.#events.zoomOpened?.(m.token);
  }

  notify(n: Parameters<MacBridge['notify']>[0] & { join_url?: string }): Promise<'added'> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#waiters.delete(n.token); reject(new Error('mac_helper_timeout')); }, this.#timeout);
      this.#waiters.set(n.token, (status) => {
        clearTimeout(timer); this.#waiters.delete(n.token);
        if (status === 'added') resolve('added'); else if (status === 'denied') reject(new MacPermissionDenied('permission notifications refusée')); else reject(new Error(`mac_helper_${status}`));
      });
      this.#io.stdin.write(JSON.stringify({ type: 'notify', ...n }) + '\n');
    });
  }
}
