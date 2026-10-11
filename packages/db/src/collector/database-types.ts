import type { DbClient } from "../client.js";
export type DbTransaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
