import { norm } from '../merge/text.ts';
import { lev, phoneticKey } from '../stt/glossary.ts';
import { splitSentences } from '../stt/segmenter.ts';
import { CANCEL, CUE_PHRASES, GREETING, EN_MODALS_STATEMENT, GROUP_PHRASES, HANDOVER, HONORIFICS, IMPERATIVE_VERBS, INFINITIVE_MARKERS, THANKS, INDIRECT, INDIRECT_AFTER, INDIRECT_BEFORE, INTERJECTIONS, MENTION_PREPS, REDIRECT_MARKERS, REDIRECT_PHRASES, SECOND_PERSON, SPEECH_VERBS, THIRD_PERSON_VERBS, hasPhrase } from './patterns.ts';
import { ENGINE_VERSION, type AddressClass, type Decision, type Participant, type ReasonCode, type Uncertainty, type UserProfile } from './types.ts';

interface Tok { raw: string; n: string; base: string; possessive: boolean; after: string; i: number }

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  const re = /([\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*)([^\p{L}\p{N}\s]*)/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const raw = m[1]!;
    const poss = /['’]s$/i.test(raw);
    const base = poss ? raw.replace(/['’]s$/i, '') : raw;
    out.push({ raw, n: norm(raw), base: norm(base), possessive: poss, after: m[2] ?? '', i: out.length });
  }
  return out;
}

const RANK: Record<AddressClass, number> = { DIRECT_CERTAIN: 5, DIRECT_PROBABLE: 4, MENTION_SIMPLE: 3, GROUPE: 2, HORS_SUJET: 1 };

export interface RuleContext { user: UserProfile; roster: Participant[]; speaker_id: string | null; stt_confidence: number; provisional: boolean }
export interface RuleOutput { decision: Decision; signals: { cancel: boolean; redirect_other: boolean; has_user_hit: boolean; cues: boolean; group: boolean } }

type HitKind = 'exact' | 'alias' | 'phonetic';
function nameKind(tok: Tok, user: UserProfile): HitKind | null {
  const first = norm(user.first);
  if (tok.base === first) return 'exact';
  if (user.aliases.some((a) => norm(a) === tok.base)) return 'alias';
  if (tok.base.length >= 3 && tok.base[0] === first[0] && ((phoneticKey(tok.base) === phoneticKey(first) && lev(tok.base, first) <= 2) || (tok.base.length >= 4 && lev(tok.base, first) <= 1))) return 'phonetic';
  return null;
}

function analyseSentence(sent: string, c: RuleContext): { cls: AddressClass; score: number; reasons: ReasonCode[]; unc: Uncertainty[]; spans: string[]; cancel: boolean; redirect: boolean; hit: boolean; cues: boolean; group: boolean } {
  const toks = tokenize(sent);
  const nText = toks.map((t) => t.n).join(' ');
  const reasons: ReasonCode[] = [], unc: Uncertainty[] = [], spans: string[] = [];
  const otherFirsts = new Set(c.roster.filter((p) => p.id !== c.user.id).map((p) => norm(p.first)));
  const sameFirstOthers = c.roster.filter((p) => p.id !== c.user.id && norm(p.first) === norm(c.user.first));
  const cancel = hasPhrase(nText, CANCEL) !== null;
  const group = hasPhrase(nText, GROUP_PHRASES) !== null;
  const q = /\?/.test(sent);
  // Un verbe d'ordre n'est un indice que s'il n'est ni participe passé (« expliqué ») ni infinitif (« to answer »).
  const isImp = (t: Tok) => IMPERATIVE_VERBS.has(t.n) && !/é(e|s|es)?$/i.test(t.raw) && !(toks[t.i - 1] && INFINITIVE_MARKERS.has(toks[t.i - 1]!.n));
  const cuesTok = toks.some((t) => SECOND_PERSON.has(t.n) || isImp(t)) || hasPhrase(nText, CUE_PHRASES) !== null;
  const thanks = hasPhrase(nText, THANKS) !== null, greeting = hasPhrase(nText, GREETING) !== null;
  const cues = q || cuesTok;
  let best: { cls: AddressClass; score: number; reasons: ReasonCode[]; unc: Uncertainty[]; spans: string[] } | null = null;
  let redirect = false, anyHit = false;

  for (const t of toks) {
    // Nom de famille précédé d'une civilité (« Monsieur Martin ») = l'utilisateur lui-même.
    const kind: HitKind | null = nameKind(t, c.user) ?? (c.user.last && t.base === norm(c.user.last) && toks[t.i - 1] && HONORIFICS.has(toks[t.i - 1]!.n) ? 'exact' : null);
    if (!kind) continue;
    // Autre participant explicitement désigné par son nom de famille ou initiale ? (« Liam Dupont », « Liam D. »)
    const next = toks[t.i + 1], prev = toks[t.i - 1];
    if (next && c.roster.some((p) => p.id !== c.user.id && norm(p.first) === t.base && p.last && (norm(p.last) === next.n || (next.n.length === 1 && norm(p.last)[0] === next.n)))) {
      best = pick(best, { cls: 'HORS_SUJET', score: 0.9, reasons: ['OTHER_PARTICIPANT_NAMED'], unc: [], spans: [`${t.raw} ${next.raw}`] }); continue;
    }
    const surnameMatch = !!(next && c.user.last && (next.n === norm(c.user.last) || (next.n.length === 1 && next.n === norm(c.user.last)[0])));
    const startVoc = t.i === 0 || (t.i === 1 && INTERJECTIONS.has(toks[0]!.n)) || (t.i === 2 && INTERJECTIONS.has(toks[0]!.n) && INTERJECTIONS.has(toks[1]!.n));
    const punctVoc = /[,:—]/.test(t.after), qAfter = /[?!…]/.test(t.after);
    const commaAfter = punctVoc || qAfter;
    const endVoc = !next && !!prev && /,/.test(prev.after);
    const midVoc = !!prev && /,/.test(prev.after) && /,/.test(t.after);
    const youAfter = !!toks[t.i + 2] && SECOND_PERSON.has(toks[t.i + 2]!.n);
    const nextThird = !!next && !commaAfter && (THIRD_PERSON_VERBS.has(next.n) || (EN_MODALS_STATEMENT.has(next.n) && !youAfter));
    // Discours rapporté : « Alice said: "Liam, can you help?" » n'est pas un appel.
    const before = sent.slice(0, Math.max(0, sent.indexOf(t.raw)));
    const reported = /["“«]/.test(before) && toks.slice(0, t.i).some((x) => SPEECH_VERBS.has(x.n));
    const handover = hasPhrase(nText, HANDOVER) !== null && !!prev && !commaAfter;
    const prepBefore = !!prev && !startVoc && (MENTION_PREPS.has(prev.n) || prev.raw === 'à' || prev.raw === 'À');
    const span = sent.slice(Math.max(0, sent.indexOf(t.raw)), sent.indexOf(t.raw) + t.raw.length + (next ? 1 + next.raw.length : 0));
    anyHit = true;
    const r: ReasonCode[] = [kind === 'exact' ? 'NAME_EXACT' : kind === 'alias' ? 'NAME_ALIAS' : 'NAME_PHONETIC'];
    const u: Uncertainty[] = [];
    let cls: AddressClass; let score: number;

    // Nom phonétique seul (« Lian ») : n'est pris en compte que s'il est clairement un vocatif avec une demande.
    // « Liam, … » / « Liam ? » / « , Liam ? » : appel. « Where is Liam? » ou « Liam always answers » : pas un appel.
    const isVoc = !t.possessive && !nextThird && !prepBefore &&
      ((startVoc && (punctVoc || qAfter || !next || cues || surnameMatch)) || endVoc || midVoc || (punctVoc && cues && !startVoc));
    if (kind === 'phonetic' && !(isVoc && cues)) continue;

    if (t.possessive) { cls = 'MENTION_SIMPLE'; score = 0.9; r.push('POSSESSIVE_MENTION'); }
    else if (reported) { cls = 'MENTION_SIMPLE'; score = 0.85; r.push('REPORTED_SPEECH'); }
    else if (nextThird) { cls = 'MENTION_SIMPLE'; score = 0.9; r.push('THIRD_PERSON_MENTION'); }
    else if (handover) { cls = 'DIRECT_CERTAIN'; score = 0.9; r.push('HANDOVER'); }
    else if (hasPhrase(nText, INDIRECT) !== null && !commaAfter) { cls = 'DIRECT_PROBABLE'; score = 0.72; r.push('INDIRECT_REQUEST'); }
    else if (prepBefore && !commaAfter) { cls = 'MENTION_SIMPLE'; score = 0.85; r.push('PREPOSITION_MENTION'); }
    else if (((prev && INDIRECT_BEFORE.has(prev.n)) || (next && INDIRECT_AFTER.has(next.n) && !youAfter)) && !commaAfter) { cls = 'DIRECT_PROBABLE'; score = 0.72; r.push('INDIRECT_REQUEST'); }
    else if (isVoc && !cues && thanks) { cls = 'MENTION_SIMPLE'; score = 0.75; r.push('GRATITUDE'); }
    else if (isVoc && !cues && greeting) { cls = 'MENTION_SIMPLE'; score = 0.75; r.push('GREETING'); }
    else if (isVoc) {
      r.push('VOCATIVE');
      if (cues) {
        cls = 'DIRECT_CERTAIN'; score = 0.95; r.push('IMPERATIVE_OR_QUESTION');
        if (toks.some((x) => SECOND_PERSON.has(x.n))) r.push('SECOND_PERSON');
        if (q) r.push('QUESTION_MARK');
      } else { cls = 'DIRECT_PROBABLE'; score = 0.7; }
    } else { cls = 'MENTION_SIMPLE'; score = 0.6; r.push('UNCLASSIFIED_MENTION'); u.push('UNCLASSIFIED_MENTION'); }

    if (kind === 'phonetic') { u.push('PHONETIC_ONLY'); if (cls === 'DIRECT_CERTAIN') { cls = 'DIRECT_PROBABLE'; score = 0.65; } }
    if ((cls === 'DIRECT_CERTAIN' || cls === 'DIRECT_PROBABLE') && sameFirstOthers.length && !surnameMatch) {
      r.push('AMBIGUOUS_NAME'); u.push('AMBIGUOUS_NAME'); if (cls === 'DIRECT_CERTAIN') { cls = 'DIRECT_PROBABLE'; score = 0.7; }
    }
    if ((cls === 'DIRECT_CERTAIN' || cls === 'DIRECT_PROBABLE') && toks.some((x) => x.i !== t.i && otherFirsts.has(x.base) && nameKind(x, c.user) === null && (/,/.test(x.after) || x.i <= 2))) r.push('MULTI_ADDRESSEE');
    // Redirection « Liam— non, Alice, … » ou « plutôt Alice »
    const after = toks.slice(t.i + 1, t.i + 5);
    const redirIdx = after.findIndex((x) => REDIRECT_MARKERS.has(x.n));
    if ((redirIdx >= 0 && after.slice(redirIdx).some((x) => otherFirsts.has(x.base))) || (hasPhrase(nText, REDIRECT_PHRASES) !== null && toks.some((x) => otherFirsts.has(x.base) && x.i > t.i))) redirect = true;
    best = pick(best, { cls, score, reasons: r, unc: u, spans: [span] });
  }

  if (!best) {
    // « Pardon, Alice, c'est à toi » : redirection vers un autre participant, sans citer l'utilisateur.
    const mk = toks.findIndex((x) => REDIRECT_MARKERS.has(x.n));
    if (mk >= 0 && toks.some((x) => x.i > mk && otherFirsts.has(x.base) && (x.i <= mk + 2 || /,/.test(x.after)))) redirect = true;
    // Réunion à deux : une question à la 2e personne ne peut viser que l'utilisateur (reste PROBABLE, jamais urgent).
    if (!group && c.roster.length === 2 && c.speaker_id !== null && c.speaker_id !== c.user.id && c.roster.some((p) => p.id === c.speaker_id) && q && toks.some((x) => SECOND_PERSON.has(x.n) || isImp(x)))
      return { cls: 'DIRECT_PROBABLE', score: 0.7, reasons: ['SECOND_PERSON', 'QUESTION_MARK'], unc: [], spans: [], cancel, redirect, hit: false, cues, group };
    if (group) return { cls: 'GROUPE', score: 0.8, reasons: ['GROUP_MARKER'], unc: [], spans: [], cancel, redirect, hit: false, cues, group };
    const reasons2: ReasonCode[] = ['NO_NAME'];
    const unc2: Uncertainty[] = cues && (q || cuesTok) && toks.some((x) => SECOND_PERSON.has(x.n) || isImp(x)) && q ? ['UNNAMED_SECOND_PERSON'] : [];
    return { cls: 'HORS_SUJET', score: 0.8, reasons: reasons2, unc: unc2, spans: [], cancel, redirect, hit: false, cues, group };
  }
  if (group && best.cls === 'MENTION_SIMPLE') best.reasons.push('GROUP_MARKER');
  return { ...best, cancel, redirect, hit: anyHit, cues, group };
}

function pick<T extends { cls: AddressClass; score: number }>(a: T | null, b: T): T { return !a || RANK[b.cls] > RANK[a.cls] || (RANK[b.cls] === RANK[a.cls] && b.score > a.score) ? b : a; }

export function classify(segmentId: string, text: string, c: RuleContext): RuleOutput {
  const sents = splitSentences(text);
  let best: ReturnType<typeof analyseSentence> | null = null;
  let cancel = false, redirect = false, hit = false, cues = false, group = false;
  for (const s of sents.length ? sents : [text]) {
    const a = analyseSentence(s, c);
    cancel ||= a.cancel; redirect ||= a.redirect; hit ||= a.hit; cues ||= a.cues; group ||= a.group;
    best = pick(best, a);
  }
  const b = best!;
  let { cls, score } = b; const reasons = [...b.reasons]; const unc = [...b.unc];
  const direct = cls === 'DIRECT_CERTAIN' || cls === 'DIRECT_PROBABLE';

  if (direct && (cancel || redirect)) {
    // Annulation / redirection dans le même énoncé : l'appel n'est plus valable.
    cls = 'HORS_SUJET'; score = 0.85; reasons.push(redirect ? 'REDIRECTED' : 'CANCELLED');
  } else if (direct && c.stt_confidence < 0.6 && !c.provisional) {
    if (cls === 'DIRECT_CERTAIN') { cls = 'DIRECT_PROBABLE'; score = Math.min(score, 0.6); }
    reasons.push('LOW_STT_CONFIDENCE'); unc.push('LOW_STT_CONFIDENCE');
  }
  if (c.provisional && direct) unc.push('PROVISIONAL_TEXT');
  return {
    decision: { segment_id: segmentId, cls, score, reasons: [...new Set(reasons)], uncertainty: [...new Set(unc)], evidence_spans: b.spans, engine_version: ENGINE_VERSION },
    signals: { cancel, redirect_other: redirect, has_user_hit: hit, cues, group },
  };
}
