// Bounded dead-letter queue. Entries hold redacted metadata only (never media/text payloads).
import { redact } from './redact.js';

export class DeadLetter {
  constructor({ max = 1000, onEntry = () => {}, now = Date.now } = {}) {
    this.max = max; this.entries = []; this.dropped = 0; this.onEntry = onEntry; this.now = now;
  }
  push(reason, detail = {}) {
    const entry = { at: this.now(), reason, detail: redact(detail) };
    if (this.entries.length >= this.max) { this.entries.shift(); this.dropped++; }
    this.entries.push(entry);
    this.onEntry(entry);
    return entry;
  }
  count(reason) { return this.entries.filter((e) => e.reason === reason).length; }
}
