import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeJsonResult, formatSchemaError } from "@t3tools/shared/schemaJson";

export interface NormalizedGiteaPullRequestRecord {
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

const decodeJsonArray = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeJsonValue = decodeJsonResult(Schema.Unknown);
const decodeDateTime = Schema.decodeUnknownOption(Schema.DateTimeUtcFromString);

export const formatGiteaJsonDecodeError = formatSchemaError;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function dateTimeOption(value: unknown): Option.Option<DateTime.Utc> {
  const raw = trimmedString(value);
  return raw === null ? Option.none() : decodeDateTime(raw);
}

function branchRefName(value: unknown): string | null {
  const direct = trimmedString(value);
  if (direct !== null) return direct;

  const branch = record(value);
  return (
    trimmedString(branch?.ref) ??
    trimmedString(branch?.name) ??
    trimmedString(branch?.label)?.split(":").at(-1)?.trim() ??
    null
  );
}

function branchRepositoryName(value: unknown): string | null {
  const branch = record(value);
  const repository = record(branch?.repo);
  return (
    trimmedString(repository?.full_name) ??
    trimmedString(repository?.fullName) ??
    trimmedString(repository?.nameWithOwner) ??
    null
  );
}

function ownerFromNameWithOwner(value: string | null): string | null {
  const [owner] = value?.split("/") ?? [];
  return trimmedString(owner);
}

function normalizeGiteaState(input: {
  readonly state: string | null;
  readonly merged: boolean | null;
  readonly mergedAt: string | null;
}): "open" | "closed" | "merged" {
  const state = input.state?.toLowerCase();
  if (input.merged === true || input.mergedAt !== null || state === "merged") {
    return "merged";
  }
  if (state === "closed") {
    return "closed";
  }
  return "open";
}

function normalizeGiteaPullRequestRecord(value: unknown): NormalizedGiteaPullRequestRecord | null {
  const raw = record(value);
  if (raw === null) return null;

  const number = positiveInt(raw.index) ?? positiveInt(raw.number);
  const title = trimmedString(raw.title);
  const url = trimmedString(raw.html_url) ?? trimmedString(raw.url);
  const baseRefName = branchRefName(raw.base);
  const headRefName = branchRefName(raw.head);
  if (
    number === null ||
    title === null ||
    url === null ||
    baseRefName === null ||
    headRefName === null
  ) {
    return null;
  }

  const headRepositoryNameWithOwner = branchRepositoryName(raw.head);
  const headRepositoryOwnerLogin = ownerFromNameWithOwner(headRepositoryNameWithOwner);
  const baseRepositoryNameWithOwner = branchRepositoryName(raw.base);
  const isCrossRepository =
    headRepositoryNameWithOwner !== null && baseRepositoryNameWithOwner !== null
      ? headRepositoryNameWithOwner.toLowerCase() !== baseRepositoryNameWithOwner.toLowerCase()
      : undefined;

  return {
    number,
    title,
    url,
    baseRefName,
    headRefName,
    state: normalizeGiteaState({
      state: trimmedString(raw.state),
      merged: typeof raw.merged === "boolean" ? raw.merged : null,
      mergedAt: trimmedString(raw.merged_at),
    }),
    updatedAt: dateTimeOption(raw.updated ?? raw.updated_at),
    ...(typeof isCrossRepository === "boolean" ? { isCrossRepository } : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
  };
}

export function decodeGiteaPullRequestListJson(
  raw: string,
): Result.Result<ReadonlyArray<NormalizedGiteaPullRequestRecord>, Cause.Cause<unknown>> {
  const result = decodeJsonArray(raw);
  if (Result.isFailure(result)) {
    return Result.fail(result.failure);
  }

  const pullRequests: NormalizedGiteaPullRequestRecord[] = [];
  for (const entry of result.success) {
    const normalized = normalizeGiteaPullRequestRecord(entry);
    if (normalized !== null) {
      pullRequests.push(normalized);
    }
  }
  return Result.succeed(pullRequests);
}

export function decodeGiteaPullRequestJson(
  raw: string,
): Result.Result<NormalizedGiteaPullRequestRecord, Cause.Cause<unknown>> {
  const result = decodeJsonValue(raw);
  if (Result.isFailure(result)) {
    return Result.fail(result.failure);
  }

  const normalized = normalizeGiteaPullRequestRecord(result.success);
  return normalized === null
    ? Result.fail(Cause.fail(new Error("Gitea pull request JSON is missing required fields.")))
    : Result.succeed(normalized);
}
