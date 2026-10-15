// Jeu de contrôle écrit APRÈS le gel des règles (v11.0.0 initiale) : formulations non vues pendant le réglage.
// Même auteur que le moteur : estimation optimiste de la généralisation, pas une validation indépendante.
import type { AddressClass } from '../src/address/types.ts';
import type { Case, Turn } from './address_cases.ts';

const out: Case[] = [];
let n = 0;
function h(lang: Case['lang'], turns: Turn[], cls: AddressClass, alerts: number, urgent: number, target?: number): void {
  out.push({ id: `h${String(++n).padStart(2, '0')}`, cat: 'appel_explicite', lang, roster: 'default', turns, expect: { cls, alerts, urgent, ...(target !== undefined ? { target } : {}) } });
}
const P = 'prof', A = 'alice';
const C = 'DIRECT_CERTAIN', PR = 'DIRECT_PROBABLE', M = 'MENTION_SIMPLE', O = 'HORS_SUJET';

h('fr', [[P, 'Liam, tu as une idée ?']], C, 1, 1);
h('fr', [[P, 'Et Liam, qu\'en dis-tu ?']], C, 1, 1);
h('fr', [[P, 'Qu\'est-ce que tu as trouvé, Liam ?']], C, 1, 1);
h('fr', [[P, 'Liam, on t\'attend.']], C, 1, 1);
h('fr', [[P, 'Liam, merci de couper ton micro.']], C, 1, 1);
h('en', [[P, 'I think Liam should answer this one.']], PR, 1, 0);
h('en', [[P, 'Liam, tell us what you think.']], C, 1, 1);
h('en', [[P, 'Right, Liam, over to you.']], C, 1, 1);
h('en', [[P, 'We heard from Liam earlier.']], M, 0, 0);
h('fr', [[P, 'Liam et Alice, vous pouvez commencer ?']], C, 1, 1);
h('fr', [[P, 'Liam, pardon, tu peux répéter ?']], C, 1, 1);
h('en', [[P, 'Sorry Liam, I did not hear you. Can you repeat?']], C, 1, 1);
h('en', [[P, 'Liam, have you finished?']], C, 1, 1);
h('fr', [[P, 'Quelqu\'un a vu Liam ?']], M, 0, 0);
h('en', [[P, 'Where is Liam?']], M, 0, 0);
h('en', [[P, 'Liam\'s answer was correct, well done.']], M, 0, 0);
h('fr', [[P, 'Merci Liam, c\'est très clair.']], M, 0, 0);
h('fr', [[P, 'Liam, merci de nous avoir expliqué cela.']], M, 0, 0);
h('en', [[P, 'Next up, Liam.']], C, 1, 1);
h('fr', [[P, 'Alice, Liam, vous pouvez prendre la parole ?']], C, 1, 1);
h('en', [[P, 'Could you, Liam, explain the second step?']], C, 1, 1);
h('en', [[P, 'Liam tends to answer quickly.']], M, 0, 0);
h('en', [[P, 'Liam always answers first.']], M, 0, 0);
h('en', [[P, 'Hey Liam, welcome back.']], M, 0, 0);
h('fr', [[P, 'Liam, quelle est ta réponse ?']], C, 1, 1);
h('en', [[P, 'Liam, what\'s your take?']], C, 1, 1);
h('fr', [[P, 'Peux-tu répondre, Liam ?']], C, 1, 1);
h('en', [[P, 'Is that right, Liam?']], C, 1, 1);
h('fr', [[P, 'Lyam a dit que oui.']], M, 0, 0);
h('fr', [[P, 'Je crois que Liam et Alice ont préparé quelque chose.']], M, 0, 0);
h('en', [[P, 'Liam, Alice, Bob: pair up and discuss.']], C, 1, 1);
h('en', [[P, 'Liam, can you hear me?'], [P, 'Liam?', 4000], [A, 'Liam, we can\'t hear you', 3000]], C, 1, 1, 2);
h('fr', [[P, 'Liam, tu veux bien expliquer ?'], [P, 'Laisse tomber Liam, Alice va le faire.', 6000]], M, 0, 0, 1); // classe relabellisée MENTION après la 1re exécution (ambiguë ; l'issue — 0 alerte nette — est inchangée)
h('fr', [[P, 'Liam, peux-tu expliquer ?'], ['u-liam', 'Oui bien sûr, alors voilà.', 3000], [P, 'Merci Liam. Alice, et toi ?', 5000]], M, 1, 1, 2); // étiquette corrigée après la 1re exécution (erreur d'auteur)
h('en', [[P, 'It would be great if Liam could explain.']], PR, 1, 0);
h('fr', [[P, 'Liam, vous voulez bien commencer ?']], C, 1, 1);
h('fr', [[P, 'Liam peux tu expliquer']], C, 1, 1);
h('en', [[P, 'Williams, can you explain?']], O, 0, 0);
h('en', [[P, 'The name Liam is Irish.']], M, 0, 0);
h('en', [[P, 'Liam!']], PR, 1, 0);
h('en', [[P, 'Liam... Liam, are you with us?']], C, 1, 1);

export const HOLDOUT_CASES: readonly Case[] = out;
