import { z } from "zod";

import type { ArticleSummary } from "../article.js";

import { referenceIdSchema } from "./contracts.js";
export const publicationInputSchema = z.strictObject({
  generationId: referenceIdSchema,
  finalResultId: referenceIdSchema,
  metrics: z.strictObject({
    bookmarks: z.number().int().min(0).max(2147483647),
    views: z.number().int().min(0).max(2147483647),
    score: z.number().int().min(0).max(2147483647),
  }),
});
export function storedSummaryJson(summary: ArticleSummary): Record<string, unknown> {
  return {
    difficulty: summary.difficulty,
    importance_score: summary.importanceScore,
    key_points: summary.keyPoints,
    one_line_summary: summary.oneLineSummary,
    summary: summary.summary,
    tags: summary.tags,
    title: summary.title,
    why_it_matters: summary.whyItMatters,
  };
}

export const publicationCandidateMetadataSchema = z.object({
  sourceId: referenceIdSchema,
  feedJobId: referenceIdSchema,
  bookmarks: z.number().int().min(0).max(2147483647),
  views: z.number().int().min(0).max(2147483647),
  score: z.number().int().min(0).max(2147483647),
});
