import { norm } from '../merge/text.ts';

const set = (s: string) => new Set(s.split(/\s+/).filter(Boolean).map(norm));

export const INTERJECTIONS = set('hey hi hello ok okay so alors dis salut bonjour et and now right well bon allez donc maintenant eh he yo');
export const SECOND_PERSON = set('tu toi te ton ta tes you your yours');
export const IMPERATIVE_VERBS = set('pair discuss discutez travaillez work try essayez open ouvrez look regardez write ecrivez calculate calculez compute solve resolvez find trouvez list give donnez choose choisissez commencez begin peux pourrais pourrait veux voudrais explique expliquer presente presenter raconte montre dis partage reponds repondre donne lis lance commence continue vas can could would will please explain share tell show walk answer read start go describe summarize resume resumer');
export const INFINITIVE_MARKERS = set('to de d pour able pouvoir');
export const THANKS = ['merci', 'thanks', 'thank you', 'thank', 'bravo', 'well done', 'bien joue', 'good job', 'great job'].map(norm);
export const GREETING = ['hey', 'hi', 'hello', 'salut', 'bonjour', 'bonsoir', 'welcome', 'bienvenue', 'good morning'].map(norm);
export const CUE_PHRASES = ['next up', 'on t attend', 'on vous attend', 'we are waiting', 'we re waiting', 'c est ton tour', 'a ton tour', 'a toi', 'ton avis', 'your turn', 'over to you', 'go ahead', 'what do you think', 'vas y', 'qu en penses', 'tu en penses', 'do you', 'est ce que tu', 'tu peux', 'tu pourrais'].map(norm);
export const THIRD_PERSON_VERBS = set('peut doit va veut sait pourra devra a est avait etait dit disait pense pensait propose proposait montre montrait presente presentait a eu sera fera says said is was has had thinks thought showed shows suggested suggests mentioned wrote ecrit');
export const MENTION_PREPS = set('de d avec chez sur about with from by selon comme as of tell dis demande ask thanks merci');
export const GROUP_PHRASES = ['tout le monde', 'everyone', 'everybody', 'quelqu un', 'someone', 'anyone', 'anybody', 'vous tous', 'any questions', 'des questions', 'who can', 'qui peut', 'qui veut', 'des volontaires', 'volunteers', 'la classe', 'guys', 'les amis', 'personne n'].map(norm);
export const INDIRECT = ['j aimerais que', 'j aimerais entendre', 'i d like', 'i would like', 'i wonder if', 'je me demande si', 'i want to hear from', 'j voudrais entendre'].map(norm);
/** Modaux juste avant le nom (« Could Liam… ») ou juste après (« Liam pourrait-il… ») : demande polie à la 3e personne. */
export const INDIRECT_BEFORE = set('could would can will should');
export const INDIRECT_AFTER = set('pourrait pourriez serait voudrait could would should devrait');
export const CANCEL = ['laisse tomber', 'laissez tomber', 'oublie ca', 'oubliez ca', 'pas la peine', 'never mind', 'nevermind', 'forget it', 'scratch that', 'finalement non', 'non finalement', 'en fait non', 'actually no', 'on laisse'].map(norm);
export const REDIRECT_MARKERS = set('non plutot rather instead sorry pardon no');
export const REDIRECT_PHRASES = ['je veux dire', 'i mean', 'plutot'].map(norm);

export function hasPhrase(normText: string, phrases: string[]): string | null {
  const padded = ` ${normText} `;
  for (const p of phrases) if (padded.includes(` ${p} `)) return p;
  return null;
}

/** Modaux anglais : après un nom sans virgule, ce sont des énoncés à la 3e personne sauf si « you » suit. */
export const EN_MODALS_STATEMENT = set('will can shall must may might');
export const SPEECH_VERBS = set('said says asked asks dit demande disait repondu answered wrote ecrit replied');
export const HANDOVER = ['on passe a', 'je passe la parole a', 'passons la parole a', 'la parole est a', 'i pass the floor to', 'handing over to', 'hand over to', 'over to', 'floor is yours'].map(norm);
export const HONORIFICS = set('monsieur m mr mister madame mme mrs ms mlle dr docteur professeur prof pr');
