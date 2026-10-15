// Corpus de régression du moteur d'interpellation (BLOC 11). Écrit à la main, FR/EN.
// ATTENTION : même auteur que les règles → mesure la cohérence interne et les régressions,
// PAS la généralisation à de vraies réunions. Les étiquettes suivent la politique, pas le comportement observé.
import type { AddressClass } from '../src/address/types.ts';

export type Category = 'appel_explicite' | 'nom_evoque' | 'groupe' | 'hors_sujet' | 'prenom_absent' | 'homophone' | 'question_indirecte' | 'plusieurs_liam' | 'annulee' | 'relance' | 'soi_meme' | 'stt_incertain' | 'code_switching';
export type RosterKind = 'default' | 'two_liams' | 'one_on_one';
/** [speaker, text, délai depuis le tour précédent (ms), confiance STT] */
export type Turn = [speaker: string, text: string, dt?: number, conf?: number];
export interface Case {
  id: string; cat: Category; lang: 'fr' | 'en' | 'mixed'; roster: RosterKind; turns: Turn[];
  expect: { cls: AddressClass; target?: number; alerts: number; urgent: number };
  /** Limite connue : l'étiquette est la vérité terrain, le moteur est attendu en échec ; exclu du critère de passage. */
  known_limit?: string;
}

const cases: Case[] = [];
const P = 'prof', A = 'alice', B = 'bob', U = 'u-liam';
let n = 0;
function add(cat: Category, lang: Case['lang'], turns: Turn[], cls: AddressClass, alerts: number, urgent: number, extra: Partial<Case> = {}): void {
  cases.push({ id: `c${String(++n).padStart(3, '0')}`, cat, lang, roster: 'default', turns, expect: { cls, alerts, urgent }, ...extra });
}
const direct = (cat: Case['cat'], lang: Case['lang'], text: string, extra: Partial<Case> = {}) => add(cat, lang, [[P, text]], 'DIRECT_CERTAIN', 1, 1, extra);
const probable = (cat: Case['cat'], lang: Case['lang'], text: string, extra: Partial<Case> = {}) => add(cat, lang, [[P, text]], 'DIRECT_PROBABLE', 1, 0, extra);
const mention = (lang: Case['lang'], text: string, extra: Partial<Case> = {}) => add('nom_evoque', lang, [[P, text]], 'MENTION_SIMPLE', 0, 0, extra);
const off = (cat: Case['cat'], lang: Case['lang'], text: string, extra: Partial<Case> = {}) => add(cat, lang, [[P, text]], 'HORS_SUJET', 0, 0, extra);
const group = (lang: Case['lang'], text: string) => add('groupe', lang, [[P, text]], 'GROUPE', 0, 0);

// --- appels explicites ---------------------------------------------------------------
for (const t of [
  'Liam, peux-tu nous expliquer la question 3 ?', 'Liam peux-tu répondre s\'il te plaît', 'Alors Liam, qu\'est-ce que tu en penses ?', 'Liam, à toi.',
  'Dis-nous Liam, comment tu as procédé ?', 'Liam, pourrais-tu partager ton écran ?', 'Salut Liam, tu peux nous présenter ta solution ?', 'Liam, tu m\'entends ?',
  'Bon, Liam, c\'est ton tour, vas-y.', 'Peux-tu lire le résultat, Liam ?', 'Liam, explique-nous la différence entre variance et écart-type.', 'Liam Martin, pouvez-vous nous donner votre avis ?',
  'Lyam, peux-tu répondre ?', 'Liam, si tu veux bien, résume le chapitre.', 'Liam ? Tu peux répondre ?',
]) direct('appel_explicite', 'fr', t);
for (const t of [
  'Liam, can you walk us through the proof?', 'Liam, could you share your screen please?', 'What do you think, Liam?', 'Over to you, Liam.', 'Liam, your turn.',
  'Hi Liam, would you mind explaining step two?', 'Liam, please read the second paragraph.', 'Okay Liam, go ahead.', 'Liam, do you have an answer?',
  'Can you summarise this for us, Liam?', 'Liam Martin, what is your answer to question four?', 'Let\'s hear from you, Liam. What did you get?',
]) direct('appel_explicite', 'en', t);

// --- nom évoqué (mention simple) --------------------------------------------------------
for (const t of [
  'Liam a dit tout à l\'heure que la variance diminue.', 'Comme Liam l\'a montré, la preuve fonctionne.', 'La diapositive de Liam est très claire.', 'J\'ai parlé avec Liam hier.',
  'Je pense que Liam avait raison.', 'On va reprendre l\'exemple de Liam.', 'Selon Liam, c\'est plus simple.', 'Liam est absent aujourd\'hui ?', 'Dis à Liam de se connecter.',
  'Liam est le prénom de mon cousin.', 'Demande à Liam, il a les notes.',
]) mention('fr', t);
for (const t of [
  'Liam said the result converges.', 'As Liam mentioned, we need more data.', 'Liam\'s slide has a typo.', 'I talked to Liam yesterday.', 'Thanks Liam for the notes.',
  'Tell Liam to join the call.', 'Is Liam here today?', 'Liam was right about the bound.', 'Ask Liam about the notebook.', 'Let\'s use Liam\'s example.', 'I agree with Liam.', 'Liam has shared the link.',
]) mention('en', t);

// --- groupe -----------------------------------------------------------------------------
for (const t of ['Tout le monde a compris ?', 'Quelqu\'un peut répondre à la question 2 ?', 'Des volontaires pour passer au tableau ?', 'Qui peut expliquer ce résultat ?']) group('fr', t);
for (const t of ['Any questions, everyone?', 'Who can explain this?', 'Could someone share their screen?', 'Does everybody see the slide?']) group('en', t);

// --- hors sujet -------------------------------------------------------------------------
for (const t of ['Passons à la diapositive suivante.', 'La variance est la moyenne des carrés des écarts.', 'Alice, peux-tu expliquer la question 3 ?', 'Je vais partager mon écran.', 'Bob, tu peux relire l\'énoncé ?'])
  off('hors_sujet', 'fr', t);
for (const t of ['Let\'s move on to the next topic.', 'The loss function is convex.', 'Bob, can you share your screen?', 'Carol, what is your answer?'])
  off('hors_sujet', 'en', t);

// --- prénom absent ----------------------------------------------------------------------
off('prenom_absent', 'fr', 'Peux-tu nous expliquer la question 3 ?');
off('prenom_absent', 'fr', 'Tu peux répondre à celle-là ?');
off('prenom_absent', 'en', 'Can you explain this to us?');
off('prenom_absent', 'en', 'What do you think about this one?');
add('prenom_absent', 'fr', [[P, 'Liam, peux-tu expliquer ?'], [P, 'Tu m\'entends ?', 8000]], 'HORS_SUJET', 1, 1, { expect: { cls: 'HORS_SUJET', target: 1, alerts: 1, urgent: 1 } });
add('prenom_absent', 'fr', [[P, 'Liam, peux-tu expliquer ?'], [P, 'Alors ? Tu peux répondre ?', 10000]], 'HORS_SUJET', 1, 1, { expect: { cls: 'HORS_SUJET', target: 1, alerts: 1, urgent: 1 } });
add('prenom_absent', 'en', [[P, 'Liam, can you explain?'], [P, 'Can you hear me?', 7000]], 'HORS_SUJET', 1, 1, { expect: { cls: 'HORS_SUJET', target: 1, alerts: 1, urgent: 1 } });
cases.push({ id: `c${String(++n).padStart(3, '0')}`, cat: 'prenom_absent', lang: 'en', roster: 'one_on_one', turns: [[P, 'Can you explain this to me?']], expect: { cls: 'DIRECT_PROBABLE', alerts: 1, urgent: 0 } });
cases.push({ id: `c${String(++n).padStart(3, '0')}`, cat: 'prenom_absent', lang: 'fr', roster: 'one_on_one', turns: [[P, 'Peux-tu me réexpliquer ça ?']], expect: { cls: 'DIRECT_PROBABLE', alerts: 1, urgent: 0 } });
off('prenom_absent', 'fr', 'Celui qui n\'a pas encore parlé, peux-tu répondre ?');

// --- homophones / variantes ----------------------------------------------------------------
probable('homophone', 'fr', 'Liame, peux-tu répondre ?');
probable('homophone', 'en', 'Lian, can you explain?');
off('homophone', 'fr', 'Le lien est dans le chat.');
off('homophone', 'fr', 'Lillian a posé une question.');
off('homophone', 'fr', 'Lia, peux-tu répondre ?');
off('homophone', 'en', 'Leo, can you answer?');
off('homophone', 'en', 'Please follow the link in the chat.');
off('homophone', 'fr', 'Lionel, tu peux relire ?');
probable('homophone', 'fr', 'Lien, peux-tu répondre ?', { known_limit: 'STT « Lien » pour « Liam » (distance 2) : non détecté sans alias configuré' });
direct('homophone', 'fr', 'Lyam, tu peux continuer ?');

// --- questions indirectes -----------------------------------------------------------------
probable('question_indirecte', 'fr', 'J\'aimerais que Liam nous explique la question 3.');
probable('question_indirecte', 'fr', 'Liam pourrait-il nous expliquer la question ?');
probable('question_indirecte', 'fr', 'Je me demande si Liam pourrait répondre.');
probable('question_indirecte', 'fr', 'J\'aimerais entendre Liam sur ce point.');
probable('question_indirecte', 'en', 'I wonder if Liam could tell us more.');
probable('question_indirecte', 'en', 'Could Liam share his screen?');
probable('question_indirecte', 'en', 'Would Liam be able to share the notebook?');
probable('question_indirecte', 'en', 'I\'d like to hear from Liam on this.');
mention('fr', 'On pourrait demander à Liam ?', { cat: 'question_indirecte' });
mention('en', 'Is Liam able to answer question 3?', { cat: 'question_indirecte' });

// --- plusieurs Liam ------------------------------------------------------------------------
const tl = (cat: Case['cat'], lang: Case['lang'], text: string, cls: AddressClass, alerts: number, urgent: number, extra: Partial<Case> = {}) =>
  cases.push({ id: `c${String(++n).padStart(3, '0')}`, cat, lang, roster: 'two_liams', turns: [[P, text]], expect: { cls, alerts, urgent }, ...extra });
tl('plusieurs_liam', 'fr', 'Liam, peux-tu expliquer ?', 'DIRECT_PROBABLE', 1, 0);
tl('plusieurs_liam', 'en', 'Liam, can you explain?', 'DIRECT_PROBABLE', 1, 0);
tl('plusieurs_liam', 'fr', 'Liam Martin, peux-tu expliquer ?', 'DIRECT_CERTAIN', 1, 1);
tl('plusieurs_liam', 'fr', 'Liam M., peux-tu expliquer ?', 'DIRECT_CERTAIN', 1, 1);
tl('plusieurs_liam', 'en', 'Liam Martin, what is your answer?', 'DIRECT_CERTAIN', 1, 1);
tl('plusieurs_liam', 'en', 'Liam Dupont, can you explain?', 'HORS_SUJET', 0, 0);
tl('plusieurs_liam', 'fr', 'Liam D., peux-tu expliquer ?', 'HORS_SUJET', 0, 0);
tl('plusieurs_liam', 'fr', 'Liam Dupont a dit que c\'est faux.', 'HORS_SUJET', 0, 0);
tl('plusieurs_liam', 'fr', 'Liam a dit que c\'est faux.', 'MENTION_SIMPLE', 0, 0);
tl('plusieurs_liam', 'en', 'Liam said it converges.', 'MENTION_SIMPLE', 0, 0);

// --- phrases annulées ------------------------------------------------------------------------
off('annulee', 'fr', 'Liam, peux-tu expliquer... non laisse tomber.');
off('annulee', 'fr', 'Liam, peux-tu... Ah non, finalement non, Alice, vas-y.');
off('annulee', 'en', 'Liam, can you... actually no, never mind.');
off('annulee', 'en', 'Liam, no sorry, Alice, can you explain?');
off('annulee', 'fr', 'Laisse tomber.');
add('annulee', 'fr', [[P, 'Liam, peux-tu expliquer la question 3 ?'], [P, 'Non finalement, laisse tomber, on continue.', 6000]], 'HORS_SUJET', 0, 0, { expect: { cls: 'HORS_SUJET', target: 1, alerts: 0, urgent: 0 } });
add('annulee', 'en', [[P, 'Liam, can you explain?'], [P, 'Never mind, I\'ll ask Alice instead.', 5000]], 'HORS_SUJET', 0, 0, { expect: { cls: 'HORS_SUJET', target: 1, alerts: 0, urgent: 0 } });
add('annulee', 'fr', [[P, 'Liam, tu peux répondre ?'], [P, 'Pardon, Alice, c\'est à toi.', 4000]], 'HORS_SUJET', 0, 0, { expect: { cls: 'HORS_SUJET', target: 1, alerts: 0, urgent: 0 } });
add('annulee', 'fr', [[P, 'Liam, peux-tu expliquer ?'], [P, 'Oublie ça, je vais le faire moi-même.', 5000]], 'HORS_SUJET', 0, 0, { expect: { cls: 'HORS_SUJET', target: 1, alerts: 0, urgent: 0 } });
add('annulee', 'en', [[P, 'Liam, can you explain?'], [P, 'Forget it, we are out of time.', 9000]], 'HORS_SUJET', 0, 0, { expect: { cls: 'HORS_SUJET', target: 1, alerts: 0, urgent: 0 } });
// non annulée : « n'oublie pas » ne doit PAS annuler
direct('annulee', 'fr', 'Liam, n\'oublie pas de nous expliquer la question 3, tu peux ?');

// --- relances / déduplication ------------------------------------------------------------------
add('relance', 'fr', [[P, 'Liam ?'], [P, 'Liam, tu es là ?', 5000], [P, 'Liam, tu m\'entends ?', 5000]], 'DIRECT_CERTAIN', 1, 1, { expect: { cls: 'DIRECT_CERTAIN', target: 2, alerts: 1, urgent: 1 } });
add('relance', 'fr', [[P, 'Liam, peux-tu répondre ?'], [P, 'Alors Liam ?', 3000]], 'DIRECT_CERTAIN', 1, 1, { expect: { cls: 'DIRECT_CERTAIN', target: 1, alerts: 1, urgent: 1 } });
add('relance', 'en', [[P, 'Liam, can you answer?'], [P, 'Liam, are you there?', 4000], [P, 'Hello Liam?', 4000]], 'DIRECT_CERTAIN', 1, 1, { expect: { cls: 'DIRECT_CERTAIN', target: 2, alerts: 1, urgent: 1 } });
add('relance', 'fr', [[P, 'Liam, peux-tu répondre ?'], [A, 'Liam, tu as la parole.', 4000]], 'DIRECT_CERTAIN', 1, 1, { expect: { cls: 'DIRECT_CERTAIN', target: 1, alerts: 1, urgent: 1 } });
add('relance', 'fr', [[P, 'Liam, peux-tu répondre ?'], [U, 'Oui, alors la réponse est trois.', 4000], [P, 'Liam, et la suivante ?', 30000]], 'DIRECT_CERTAIN', 2, 2, { expect: { cls: 'DIRECT_CERTAIN', target: 2, alerts: 2, urgent: 2 } });
add('relance', 'en', [[P, 'Liam, can you answer?'], [U, 'Yes, the answer is three.', 5000], [P, 'Liam, and the next one?', 20000]], 'DIRECT_CERTAIN', 2, 2, { expect: { cls: 'DIRECT_CERTAIN', target: 2, alerts: 2, urgent: 2 } });
add('relance', 'fr', [[P, 'Liam, peux-tu répondre ?'], [P, 'Liam, peux-tu répondre à la question suivante ?', 70000]], 'DIRECT_CERTAIN', 2, 2, { expect: { cls: 'DIRECT_CERTAIN', target: 1, alerts: 2, urgent: 2 } });
add('relance', 'fr', [[P, 'Liam, peux-tu répondre ?'], [P, 'Tu peux répondre ?', 6000], [P, 'Tu es là ?', 6000]], 'HORS_SUJET', 1, 1, { expect: { cls: 'HORS_SUJET', target: 2, alerts: 1, urgent: 1 } });
add('relance', 'fr', [[P, 'Liam, tu peux expliquer ?'], [B, 'Moi je veux bien répondre.', 3000], [P, 'Non, Liam, toi, tu peux expliquer ?', 4000]], 'DIRECT_CERTAIN', 1, 1, { expect: { cls: 'DIRECT_CERTAIN', target: 2, alerts: 1, urgent: 1 } });
add('relance', 'en', [[P, 'Liam, can you explain?'], [P, 'Liam, can you explain step two?', 3000], [P, 'Liam?', 3000], [P, 'Liam, are you there?', 3000]], 'DIRECT_CERTAIN', 1, 1, { expect: { cls: 'DIRECT_CERTAIN', target: 3, alerts: 1, urgent: 1 } });

// --- soi-même ------------------------------------------------------------------------------------
add('soi_meme', 'fr', [[U, 'Je m\'appelle Liam, enchanté.']], 'HORS_SUJET', 0, 0);
add('soi_meme', 'en', [[U, 'Liam Martin, present. Can you hear me?']], 'HORS_SUJET', 0, 0);

// --- STT incertain ---------------------------------------------------------------------------------
add('stt_incertain', 'fr', [[P, 'Liam, peux-tu répondre ?', 0, 0.4]], 'DIRECT_PROBABLE', 1, 0);
add('stt_incertain', 'en', [[P, 'Liam, can you explain?', 0, 0.45]], 'DIRECT_PROBABLE', 1, 0);
add('stt_incertain', 'fr', [[P, 'Liam a dit que c\'est faux.', 0, 0.4]], 'MENTION_SIMPLE', 0, 0);

// --- code switching ----------------------------------------------------------------------------------
direct('code_switching', 'mixed', 'Liam, can you share ton écran please ?');
direct('code_switching', 'mixed', 'Liam, tu peux explain the proof ?');
mention('mixed', 'Liam said que la variance diminue.', { cat: 'code_switching' });
probable('code_switching', 'mixed', 'Alice, Bob, Liam, vous avez cinq minutes pour discuter.');
direct('code_switching', 'mixed', 'Alice, Bob, Liam, can you each give an example?');
off('code_switching', 'mixed', 'Passons à la next slide please.');
off('code_switching', 'mixed', 'Présents : Alice, Bob, Liam, Carol.', { expect: { cls: 'MENTION_SIMPLE', alerts: 0, urgent: 0 }, known_limit: 'appel de présence : la liste ressemble à un vocatif multiple' });

export const ADDRESS_CASES: readonly Case[] = cases;
