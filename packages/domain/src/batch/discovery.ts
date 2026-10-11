import { z } from "zod";

import { normalizeArticleUrl } from "../normalize-url.js";
import { calculateTrendScore } from "../score.js";
import { candidateExtractionMetadataSchema } from "./extraction.js";

export const discoveryCandidateSchema = z.strictObject({
  title: z.string().trim().min(1).max(2048),
  url: z
    .url()
    .max(4096)
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        (!url.port || url.port === "443")
      );
    }),
  publishedAt: z.date().nullable(),
  summaryText: candidateExtractionMetadataSchema.shape.summaryText,
  contentHtml: candidateExtractionMetadataSchema.shape.contentHtml,
  bookmarks: z.number().int().min(0).max(2147483647),
  views: z.number().int().min(0).max(2147483647),
});
export type DiscoveryCandidate = z.infer<typeof discoveryCandidateSchema> & {
  normalizedUrl: string;
  score: number;
};
export function prepareDiscoveryCandidates(
  raw: unknown[],
  limit: number,
  measuredAt: Date,
): DiscoveryCandidate[] {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isFinite(measuredAt.getTime())
  )
    throw new Error("DISCOVERY_LIMIT_INVALID");
  const result: DiscoveryCandidate[] = [];
  const seen = new Set<string>();
  for (const value of raw.slice(0, 100)) {
    const parsed = discoveryCandidateSchema.safeParse(value);
    if (!parsed.success) continue;
    try {
      const normalizedUrl = normalizeArticleUrl(parsed.data.url);
      if (seen.has(normalizedUrl)) continue;
      seen.add(normalizedUrl);
      const ageHours = parsed.data.publishedAt
        ? (measuredAt.getTime() - parsed.data.publishedAt.getTime()) / 3600000
        : 0;
      const score = Math.min(
        2147483647,
        Math.round(
          calculateTrendScore({
            bookmarks: parsed.data.bookmarks,
            views: parsed.data.views,
            ageHours,
          }),
        ),
      );
      result.push({ ...parsed.data, normalizedUrl, score });
      if (result.length >= limit) break;
    } catch {
      /* Invalid individual URLs do not fail the whole feed. */
    }
  }
  return result;
}
