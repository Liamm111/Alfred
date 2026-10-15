import { ENGINE_VERSION, type AddressClass, type UserProfile } from './types.ts';

export interface LlmContextLine { speaker: string; text: string; t_ms: number }
export interface LlmRequest { user: UserProfile; context: LlmContextLine[]; target_segment_id: string; rule_class: AddressClass }

/** Transport LLM injecté (non fourni ici : aucune clé/réseau dans ce dépôt). */
export interface LlmAddressClassifier { classify(req: LlmRequest, signal: AbortSignal): Promise<unknown> }

export interface LlmVerdict { cls: AddressClass; score: number; reason_codes: string[]; evidence_spans: string[] }

const CLASSES: AddressClass[] = ['DIRECT_CERTAIN', 'DIRECT_PROBABLE', 'MENTION_SIMPLE', 'GROUPE', 'HORS_SUJET'];

export const LLM_JSON_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['cls', 'score', 'reason_codes', 'evidence_spans'],
  properties: {
    cls: { enum: CLASSES }, score: { type: 'number', minimum: 0, maximum: 1 },
    reason_codes: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    evidence_spans: { type: 'array', items: { type: 'string' }, maxItems: 4 },
  },
} as const;

export function buildPrompt(req: LlmRequest): { system: string; user: string } {
  const ctx = req.context.map((l) => `[${(l.t_ms / 1000).toFixed(1)}s] ${l.speaker}: ${l.text}`).join('\n');
  return {
    system: `Tu classes si le DERNIER énoncé sollicite directement ${req.user.first}. Réponds par un unique objet JSON conforme au schéma. ` +
      `Classes: DIRECT_CERTAIN (appel explicite et demande), DIRECT_PROBABLE, MENTION_SIMPLE (nom évoqué sans sollicitation), GROUPE, HORS_SUJET. ` +
      `Une mention (« Liam a dit… ») n'est jamais une sollicitation. Une demande annulée n'est pas une sollicitation. ` +
      `evidence_spans doit contenir des extraits EXACTS (copiés mot pour mot) du contexte. Ne devine pas : en cas de doute, score bas. (moteur ${ENGINE_VERSION})`,
    user: `Schéma: ${JSON.stringify(LLM_JSON_SCHEMA)}\nContexte:\n${ctx}`,
  };
}

/** Valide la sortie du LLM. Toute violation → null : la sortie est ignorée, jamais « réparée ». */
export function parseVerdict(raw: unknown, contextText: string): LlmVerdict | null {
  let o: unknown = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { return null; } }
  if (typeof o !== 'object' || o === null) return null;
  const r = o as Record<string, unknown>;
  if (Object.keys(r).some((k) => !['cls', 'score', 'reason_codes', 'evidence_spans'].includes(k))) return null;
  if (typeof r.cls !== 'string' || !CLASSES.includes(r.cls as AddressClass)) return null;
  if (typeof r.score !== 'number' || !(r.score >= 0 && r.score <= 1)) return null;
  if (!Array.isArray(r.reason_codes) || !r.reason_codes.every((x) => typeof x === 'string') || r.reason_codes.length > 8) return null;
  if (!Array.isArray(r.evidence_spans) || !r.evidence_spans.every((x) => typeof x === 'string') || r.evidence_spans.length > 4) return null;
  const direct = r.cls === 'DIRECT_CERTAIN' || r.cls === 'DIRECT_PROBABLE';
  // Anti-hallucination : un verdict « direct » doit citer au moins un extrait réellement présent dans le contexte.
  if (direct && (r.evidence_spans.length === 0 || !r.evidence_spans.every((sp) => sp.length > 0 && contextText.includes(sp)))) return null;
  if (!direct && !r.evidence_spans.every((sp) => contextText.includes(sp))) return null;
  return { cls: r.cls as AddressClass, score: r.score, reason_codes: r.reason_codes as string[], evidence_spans: r.evidence_spans as string[] };
}
