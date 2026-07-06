import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { decodeJsonResult, formatSchemaError } from "@t3tools/shared/schemaJson";

export interface NormalizedForgejoPullRequestRecord {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: Option.Option<DateTime.Utc>;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

const decodeJson = decodeJsonResult(Schema.Unknown);
const decodeDateTime = Schema.decodeUnknownExit(Schema.DateTimeUtcFromString);

export const formatForgejoJsonDecodeError = formatSchemaError;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function recordField(value: unknown, field: string): Record<string, unknown> | null {
  return asRecord(asRecord(value)?.[field]);
}

function stringField(value: unknown, ...fields: ReadonlyArray<string>): string | null {
  const record = asRecord(value);
  if (!record) return null;

  for (const field of fields) {
    const raw = record[field];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed;
  }

  return null;
}

function numberField(value: unknown, ...fields: ReadonlyArray<string>): number | null {
  const record = asRecord(value);
  if (!record) return null;

  for (const field of fields) {
    const raw = record[field];
    if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
    if (typeof raw !== "string") continue;
    const parsed = Number(raw.trim());
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }

  return null;
}

function booleanField(value: unknown, ...fields: ReadonlyArray<string>): boolean | null {
  const record = asRecord(value);
  if (!record) return null;

  for (const field of fields) {
    const raw = record[field];
    if (typeof raw === "boolean") return raw;
  }

  return null;
}

function branchNameFromLabel(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) return null;
  const ownerBranch = /^[^:]+:(.+)$/u.exec(trimmed);
  return ownerBranch?.[1]?.trim() || trimmed;
}

function parseDateTimeOption(value: unknown): Option.Option<DateTime.Utc> {
  if (typeof value !== "string" || value.trim().length === 0) {
    return Option.none();
  }
  const decoded = decodeDateTime(value);
  return Exit.isSuccess(decoded) ? Option.some(decoded.value) : Option.none();
}

function nestedStringField(
  value: unknown,
  path: ReadonlyArray<string>,
  ...fields: ReadonlyArray<string>
): string | null {
  let current: unknown = value;
  for (const segment of path) {
    current = asRecord(current)?.[segment];
  }
  return stringField(current, ...fields);
}

function repositoryNameWithOwner(value: unknown): string | null {
  return stringField(value, "full_name", "fullName", "nameWithOwner") ?? null;
}

function repositoryOwnerLogin(value: unknown): string | null {
  const owner = recordField(value, "owner");
  const login = stringField(owner, "login", "username", "name");
  if (login) return login;
  return repositoryNameWithOwner(value)?.split("/")[0]?.trim() || null;
}

function pullRequestItems(value: unknown): ReadonlyArray<unknown> {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  const values = record?.values;
  if (Array.isArray(values)) return values;
  const items = record?.items;
  if (Array.isArray(items)) return items;
  const data = record?.data;
  if (Array.isArray(data)) return data;
  return [];
}

function normalizeState(record: Record<string, unknown>): "open" | "closed" | "merged" {
  const state = stringField(record, "state")?.toLowerCase();
  const merged =
    booleanField(record, "merged", "has_merged", "hasMerged") === true ||
    stringField(record, "merged_at", "mergedAt") !== null ||
    state === "merged";
  if (merged) return "merged";
  if (state === "closed") return "closed";
  return "open";
}

function normalizeForgejoPullRequestRecord(
  value: unknown,
): NormalizedForgejoPullRequestRecord | null {
  const record = asRecord(value);
  if (!record) return null;

  const number = numberField(record, "number", "id", "index");
  const title = stringField(record, "title");
  const url =
    stringField(record, "html_url", "htmlUrl", "url") ??
    nestedStringField(record, ["links", "html"], "href");
  const base = recordField(record, "base");
  const head = recordField(record, "head");
  const baseRefName =
    stringField(record, "baseRefName", "base_branch", "baseBranch") ??
    stringField(base, "ref", "name", "label");
  const headRefName =
    stringField(record, "headRefName", "head_branch", "headBranch") ??
    branchNameFromLabel(stringField(head, "ref", "name", "label"));

  if (number === null || title === null || url === null || baseRefName === null || !headRefName) {
    return null;
  }

  const headRepository = recordField(head, "repo") ?? recordField(record, "headRepository");
  const baseRepository = recordField(base, "repo") ?? recordField(record, "baseRepository");
  const headRepositoryNameWithOwner = repositoryNameWithOwner(headRepository);
  const baseRepositoryNameWithOwner = repositoryNameWithOwner(baseRepository);
  const isCrossRepository =
    headRepositoryNameWithOwner && baseRepositoryNameWithOwner
      ? headRepositoryNameWithOwner.toLowerCase() !== baseRepositoryNameWithOwner.toLowerCase()
      : undefined;
  const headRepositoryOwnerLogin = repositoryOwnerLogin(headRepository);

  return {
    number,
    title,
    url,
    baseRefName,
    headRefName,
    state: normalizeState(record),
    updatedAt: parseDateTimeOption(record.updated_at ?? record.updatedAt),
    ...(typeof isCrossRepository === "boolean" ? { isCrossRepository } : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
  };
}

export function decodeForgejoPullRequestListJson(
  raw: string,
): Result.Result<
  ReadonlyArray<NormalizedForgejoPullRequestRecord>,
  Cause.Cause<Schema.SchemaError>
> {
  const result = decodeJson(raw);
  if (Result.isFailure(result)) return Result.fail(result.failure);

  const pullRequests: NormalizedForgejoPullRequestRecord[] = [];
  for (const entry of pullRequestItems(result.success)) {
    const normalized = normalizeForgejoPullRequestRecord(entry);
    if (normalized) pullRequests.push(normalized);
  }

  return Result.succeed(pullRequests);
}

export function decodeForgejoPullRequestJson(
  raw: string,
): Result.Result<NormalizedForgejoPullRequestRecord, Cause.Cause<Schema.SchemaError>> {
  const result = decodeJson(raw);
  if (Result.isFailure(result)) return Result.fail(result.failure);

  const normalized = normalizeForgejoPullRequestRecord(result.success);
  if (normalized) return Result.succeed(normalized);

  return Result.fail(
    Cause.fail(
      new Schema.SchemaError(
        new SchemaIssue.InvalidValue(Option.none(), {
          message: "Invalid Forgejo pull request JSON.",
        }),
      ),
    ),
  );
}
