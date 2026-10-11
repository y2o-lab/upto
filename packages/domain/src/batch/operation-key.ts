import { z } from "zod";

import { environmentSchema, hashSchema, stageSchema, type BatchEnvironment } from "./contracts.js";

const keySchema = z.strictObject({
  environment: environmentSchema,
  stage: stageSchema,
  logicalEntityId: z.string().min(1).max(512),
  inputHash: hashSchema,
  model: z.string().max(128),
  promptVersion: z.string().min(1).max(128),
  schemaVersion: z.string().min(1).max(128),
});
export type OperationKeyInput = z.infer<typeof keySchema>;

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function operationKey(input: OperationKeyInput): Promise<string> {
  const value = keySchema.parse(input);
  return digest(
    JSON.stringify([
      "operation-v1",
      value.environment,
      value.stage,
      value.logicalEntityId,
      value.inputHash,
      value.model,
      value.promptVersion,
      value.schemaVersion,
    ]),
  );
}

export async function workflowInstanceId(
  environment: BatchEnvironment,
  workId: string,
  resumeGeneration: number,
): Promise<string> {
  environmentSchema.parse(environment);
  z.string().min(1).max(512).parse(workId);
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(resumeGeneration);
  return `work-${await digest(JSON.stringify(["workflow-v1", environment, workId, resumeGeneration]))}`;
}
