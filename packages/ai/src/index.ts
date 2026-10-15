import { z } from 'zod';

/** Annotated solicitation example (PRD §12.2). Corpora must be synthetic or authorised — never private content. */
export const attentionExampleSchema = z.object({
  id: z.string(),
  origin: z.literal('synthetic'),
  lang: z.enum(['fr', 'en', 'mixed']),
  category: z.enum(['DIRECT_EXPLICIT', 'DIRECT_VARIANT', 'INDIRECT_REQUEST', 'MENTION_ONLY', 'GROUP_INSTRUCTION', 'AMBIGUOUS_SECOND_PERSON', 'NON_ADDRESSED_QUESTION', 'NEGATED_OR_QUOTED']),
  alias: z.string(),
  utterance: z.string(),
  expectedUrgent: z.boolean(),
});
export type AttentionExample = z.infer<typeof attentionExampleSchema>;

export function parseJsonl<T>(raw: string, schema: z.ZodType<T>): T[] {
  return raw.split('\n').filter((l) => l.trim()).map((l, i) => {
    const r = schema.safeParse(JSON.parse(l));
    if (!r.success) throw new Error(`corpus line ${i + 1} invalid: ${r.error.issues.map((x) => x.path.join('.')).join(',')}`);
    return r.data;
  });
}
