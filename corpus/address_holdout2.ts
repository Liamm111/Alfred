// Jeu de contrôle n°2, écrit après la correction des règles sur le jeu n°1 et exécuté UNE fois, sans réglage ensuite.
import type { AddressClass } from '../src/address/types.ts';
import type { Case, Turn } from './address_cases.ts';

const out: Case[] = [];
let n = 0;
function h(lang: Case['lang'], turns: Turn[], cls: AddressClass, alerts: number, urgent: number, target?: number): void {
  out.push({ id: `r${String(++n).padStart(2, '0')}`, cat: 'appel_explicite', lang, roster: 'default', turns, expect: { cls, alerts, urgent, ...(target !== undefined ? { target } : {}) } });
}
const P = 'prof', U = 'u-liam';
const C = 'DIRECT_CERTAIN', PR = 'DIRECT_PROBABLE', M = 'MENTION_SIMPLE', O = 'HORS_SUJET';

h('en', [[P, 'Liam, could you take the next question?']], C, 1, 1);
h('fr', [[P, 'Liam, tu prends la suite ?']], C, 1, 1);
h('fr', [[P, 'On passe à Liam pour la démonstration.']], C, 1, 1);
h('fr', [[P, 'Liam, ça marche pour toi ?']], C, 1, 1);
h('en', [[P, 'Liam, are you muted?']], C, 1, 1);
h('en', [[P, 'Did Liam send the notebook?']], M, 0, 0);
h('en', [[P, 'Let\'s welcome Liam who will present today.']], M, 0, 0);
h('fr', [[P, 'Liam, Liam, tu es là ?']], C, 1, 1);
h('en', [[P, 'Liam, can you unmute?']], C, 1, 1);
h('fr', [[P, 'Liam, ton micro est coupé.']], C, 1, 1);
h('en', [[P, 'Excuse me Liam, could you speak louder?']], C, 1, 1);
h('fr', [[P, 'Merci Liam de nous avoir rejoints.']], M, 0, 0);
h('fr', [[P, 'Liam, pour la question 4, je voulais ton avis.']], C, 1, 1);
h('fr', [[P, 'Alice a répondu, et Liam a complété.']], M, 0, 0);
h('fr', [[P, 'Qui d\'autre ? Liam ?']], C, 1, 1);
h('en', [[P, 'Is Liam ready to present?']], M, 0, 0);
h('en', [[P, 'Liam will present next week.']], M, 0, 0);
h('en', [[P, 'Liam can explain it better than me.']], M, 0, 0);
h('en', [[P, 'Liam could you repeat?']], C, 1, 1);
h('fr', [[P, 'Liam, tu peux répondre ?'], [P, 'Non, attends, Bob d\'abord.', 4000]], O, 0, 0, 1);
h('en', [[P, 'Liam, can you explain?'], [U, 'Sure, so basically it works like this.', 3000], [P, 'Thanks. Liam, and the second part?', 10000]], C, 2, 2, 2);
h('fr', [[P, 'Liam, tu peux répondre ?'], [P, 'Prends ton temps.', 5000]], O, 1, 1, 1);
h('mixed', [[P, 'Liam, peux-tu expliquer the second theorem ?']], C, 1, 1);
h('en', [[P, 'Hi everyone, Liam is joining late.']], M, 0, 0);
h('en', [[P, 'Alice said: "Liam, can you help?"']], M, 0, 0);
h('en', [[P, 'Liam, here is the question.']], PR, 1, 0);
h('en', [[P, 'Dear Liam, thanks for the email.']], M, 0, 0);
h('fr', [[P, 'Liam, c\'est bien toi qui as écrit ça ?']], C, 1, 1);
h('en', [[P, 'Liam: your thoughts?']], C, 1, 1);
h('en', [[P, 'So Liam...']], PR, 1, 0);
h('en', [[P, 'Hello Liam. Hello everyone.']], M, 0, 0);
h('fr', [[P, 'Monsieur Martin, pouvez-vous nous éclairer ?']], C, 1, 1);

export const HOLDOUT2_CASES: readonly Case[] = out;
