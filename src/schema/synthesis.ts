import { z } from 'zod';

export const SYNTH_PROMPT_VERSION = 'synthesize-v1';

/**
 * Spec 13. The hard five-item cap and the annotation-per-change contract are
 * schema facts, not prompt requests. `index` points into the change list the
 * model was shown; code maps it to a change_id and rejects out-of-range.
 */
export const WeeklySynthesis = z.object({
  annotations: z.array(z.object({
    index: z.number().int().min(0),
    implication: z.string().min(1).max(300),
    so_what: z.string().min(1).max(300),
    confidence: z.enum(['high', 'medium', 'low']),
  })).max(20),
  digest_markdown: z.string().min(1).max(4000),
  top: z.array(z.object({
    index: z.number().int().min(0),
    headline: z.string().min(1).max(120),
  })).max(5),
});

export type WeeklySynthesisData = z.infer<typeof WeeklySynthesis>;
