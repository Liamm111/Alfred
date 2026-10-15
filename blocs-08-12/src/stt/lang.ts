import { norm } from '../merge/text.ts';

const FR = new Set('le la les un une des du de et est que qui dans pour pas ne sur avec au aux ce cette ces nous vous ils elles je tu il elle on mais ou donc alors puis très plus comme par son sa ses notre votre leur oui non peut peux pouvez voici voilà être avoir fait faire dit c est qu a été sont étaient vais va vont allons fonction exemple question réponse expliquer pourquoi comment quand ton ta tes mon ma mes alors avec'.split(' ').map(norm));
const EN = new Set('the a an of and is are was were that which in for not on with this these those we you they he she it but or so then very more as by his her its our your their yes no can could would should will shall here there be have has had do does did going gonna let us example question answer explain why how when what'.split(' ').map(norm));
// Mots communs aux deux langues ou trop ambigus : ignorés pour ne pas biaiser.
const AMBIG = new Set(['a', 'on', 'est', 'son', 'pas', 'plus', 'as', 'type', 'but', 'or', 'me', 'no', 'des', 'an']);

export type Lang = 'fr' | 'en' | 'mixed' | 'unknown';

export function detectLang(text: string): { lang: Lang; fr: number; en: number } {
  let fr = 0, en = 0;
  for (const w of norm(text).split(' ')) {
    if (!w || AMBIG.has(w)) continue;
    const f = FR.has(w), e = EN.has(w);
    if (f && !e) fr++; else if (e && !f) en++;
  }
  const n = fr + en;
  if (n < 2) return { lang: 'unknown', fr, en };
  const minShare = Math.min(fr, en) / n;
  if (minShare >= 0.25 && Math.min(fr, en) >= 2) return { lang: 'mixed', fr, en };
  return { lang: fr >= en ? 'fr' : 'en', fr, en };
}
