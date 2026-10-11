import type { DbClient } from "@upto/db";

import { DiscoveryRepository, OperationRepository, ResultRepository } from "@upto/db/collector";
import { operationKey, prepareDiscoveryCandidates, type StageRequest } from "@upto/domain/batch";
import { createHash } from "node:crypto";

import type { CollectorHttpServices } from "../http/handler.js";

import { fetchFeedItems, feedEndpointUrl, type FeedTarget } from "../feeds.js";
import { createSafeFetcher } from "../http/safe-fetch.js";
export function createDiscoveryStage(options: {
  db: DbClient;
  cursorKey: Uint8Array;
  feeds: ReadonlyMap<string, FeedTarget>;
  configVersion: string;
  executorVersion: string;
  promptVersion: string;
  schemaVersion: string;
  fetcher?: typeof fetch;
}) {
  const feeds = new Map(Array.from(options.feeds, ([id, feed]) => [id, { ...feed }]));
  for (const version of [
    options.configVersion,
    options.executorVersion,
    options.promptVersion,
    options.schemaVersion,
  ])
    if (!version || version.length > 128) throw new Error("DISCOVERY_CONFIG_INVALID");
  for (const [id, feed] of feeds) {
    if (!id || id.length > 128 || !feed.name || feed.name.length > 128)
      throw new Error("DISCOVERY_CONFIG_INVALID");
    for (const address of [
      feed.siteUrl,
      feedEndpointUrl(feed),
      ...(feed.kind === "hacker-news" ? [feed.itemUrlPrefix] : []),
    ]) {
      const url = new URL(address);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        (url.port && url.port !== "443")
      )
        throw new Error("DISCOVERY_CONFIG_INVALID");
    }
  }
  const repository = new DiscoveryRepository(options.db, options.cursorKey);
  const operations = new OperationRepository(options.db);
  const results = new ResultRepository(options.db);
  const fetcher = options.fetcher ?? createSafeFetcher();
  async function resolve(request: StageRequest) {
    if (
      request.stage !== "discovery" ||
      request.configVersion !== options.configVersion ||
      request.executorVersion !== options.executorVersion
    )
      throw new Error("DISCOVERY_CONFIG_CONFLICT");
    const feed = feeds.get(request.feedId);
    if (!feed) throw new Error("DISCOVERY_CONFIG_CONFLICT");
    const scheduledAt = new Date(request.scheduledAt);
    const inputHash = createHash("sha256")
      .update(
        JSON.stringify([
          request.feedId,
          scheduledAt.toISOString(),
          request.maxItems,
          [
            feed.kind,
            feed.name,
            feed.siteUrl,
            feedEndpointUrl(feed),
            feed.kind === "hacker-news" ? feed.itemUrlPrefix : "",
          ],
          request.configVersion,
          options.promptVersion,
          options.schemaVersion,
        ]),
      )
      .digest("hex");
    const identity = {
      environment: request.environment,
      stage: "discovery" as const,
      logicalEntityId: `${request.feedId}/${scheduledAt.toISOString()}`,
      inputHash,
      model: "",
      promptVersion: options.promptVersion,
      schemaVersion: options.schemaVersion,
    };
    const binding = {
      environment: request.environment,
      jobId: request.jobId,
      feedId: request.feedId,
      scheduledAt,
      inputHash,
      configVersion: request.configVersion,
      executorVersion: request.executorVersion,
    };
    await repository.authorize(binding);
    return { identity, binding, feed };
  }
  const execute: CollectorHttpServices["execute"] = async (request, context) => {
    context.assertTimeLeft();
    const value = await resolve(request);
    if ((await operationKey(value.identity)) !== request.operationKey)
      throw new Error("OPERATION_INPUT_CONFLICT");
    context.assertTimeLeft();
    await repository.reserve({
      ...value.binding,
      sourceName: value.feed.name,
      siteUrl: value.feed.siteUrl,
      feedUrl: feedEndpointUrl(value.feed),
    });
    const claim = await operations.claim({
      ...value.identity,
      operationKey: request.operationKey,
      owner: context.auth.requestId,
      leaseMs: 360000,
    });
    if (claim.status === "succeeded") {
      const result = await results.read(request.environment, claim.resultId);
      if (result?.output.kind !== "stage" || result.output.response.stage !== "discovery")
        throw new Error("RESULT_REFERENCE_MISMATCH");
      return result.output.response;
    }
    if (claim.status === "uncertain")
      return { status: "failed", errorCode: "DISCOVERY_OUTCOME_UNKNOWN", retryable: false };
    if (claim.status === "not_found") throw new Error("DISCOVERY_SLOT_CONFLICT");
    if (claim.status !== "claimed") return claim;
    let fetched;
    try {
      if (request.stage !== "discovery") throw new Error("DISCOVERY_CONFIG_CONFLICT");
      fetched = await fetchFeedItems(value.feed, request.maxItems, (input, init) =>
        fetcher(input, { ...init, signal: context.signal }),
      );
    } catch {
      context.assertTimeLeft();
      if (context.signal.aborted) throw new Error("REQUEST_DEADLINE_EXCEEDED");
      await operations.fail(claim.fence, "DISCOVERY_FETCH_FAILED");
      return { status: "failed", errorCode: "DISCOVERY_FETCH_FAILED", retryable: false };
    }
    context.assertTimeLeft();
    if (context.signal.aborted) throw new Error("REQUEST_DEADLINE_EXCEEDED");
    if (request.stage !== "discovery") throw new Error("DISCOVERY_CONFIG_CONFLICT");
    const items = prepareDiscoveryCandidates(fetched, request.maxItems, value.binding.scheduledAt);
    return repository.save(claim.fence, {
      binding: value.binding,
      identity: value.identity,
      promptVersion: options.promptVersion,
      schemaVersion: options.schemaVersion,
      items,
    });
  };
  return { resolve, execute };
}
