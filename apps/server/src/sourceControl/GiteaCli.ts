import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { type SourceControlRepositoryVisibility, type VcsError } from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  decodeGiteaPullRequestJson,
  decodeGiteaPullRequestListJson,
  type NormalizedGiteaPullRequestRecord,
} from "./giteaPullRequests.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LIST_PULL_REQUEST_LIMIT = 50;

const giteaCliExecutionErrorContext = {
  operation: Schema.Literal("execute"),
  command: Schema.Literal("tea"),
  cwd: Schema.String,
  cause: Schema.Defect(),
};

const giteaCliDecodeErrorContext = {
  command: Schema.Literal("tea"),
  cwd: Schema.String,
  cause: Schema.Defect(),
};

export class GiteaCliUnavailableError extends Schema.TaggedErrorClass<GiteaCliUnavailableError>()(
  "GiteaCliUnavailableError",
  giteaCliExecutionErrorContext,
) {
  get detail(): string {
    return "Gitea CLI (`tea`) is required but not available on PATH.";
  }

  override get message(): string {
    return `Gitea CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class GiteaCliAuthenticationError extends Schema.TaggedErrorClass<GiteaCliAuthenticationError>()(
  "GiteaCliAuthenticationError",
  giteaCliExecutionErrorContext,
) {
  get detail(): string {
    return "Gitea CLI is not authenticated. Run `tea login add` and retry.";
  }

  override get message(): string {
    return `Gitea CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class GiteaPullRequestNotFoundError extends Schema.TaggedErrorClass<GiteaPullRequestNotFoundError>()(
  "GiteaPullRequestNotFoundError",
  {
    ...giteaCliExecutionErrorContext,
    reference: Schema.String,
  },
) {
  get detail(): string {
    return `Pull request ${this.reference} was not found. Check the PR number or URL and try again.`;
  }

  override get message(): string {
    return `Gitea CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class GiteaCliCommandError extends Schema.TaggedErrorClass<GiteaCliCommandError>()(
  "GiteaCliCommandError",
  giteaCliExecutionErrorContext,
) {
  get detail(): string {
    return "Gitea CLI command failed.";
  }

  override get message(): string {
    return `Gitea CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class GiteaPullRequestListDecodeError extends Schema.TaggedErrorClass<GiteaPullRequestListDecodeError>()(
  "GiteaPullRequestListDecodeError",
  {
    ...giteaCliDecodeErrorContext,
    operation: Schema.Literal("listPullRequests"),
  },
) {
  get detail(): string {
    return "Gitea CLI returned invalid PR list JSON.";
  }

  override get message(): string {
    return `Gitea CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class GiteaPullRequestDecodeError extends Schema.TaggedErrorClass<GiteaPullRequestDecodeError>()(
  "GiteaPullRequestDecodeError",
  {
    ...giteaCliDecodeErrorContext,
    operation: Schema.Literal("getPullRequest"),
    reference: Schema.String,
  },
) {
  get detail(): string {
    return "Gitea CLI returned invalid pull request JSON.";
  }

  override get message(): string {
    return `Gitea CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class GiteaRepositoryDecodeError extends Schema.TaggedErrorClass<GiteaRepositoryDecodeError>()(
  "GiteaRepositoryDecodeError",
  {
    ...giteaCliDecodeErrorContext,
    operation: Schema.Literals(["getRepositoryCloneUrls", "createRepository", "getDefaultBranch"]),
    repository: Schema.optional(Schema.String),
  },
) {
  get detail(): string {
    return "Gitea CLI returned invalid repository JSON.";
  }

  override get message(): string {
    return `Gitea CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export const GiteaCliError = Schema.Union([
  GiteaCliUnavailableError,
  GiteaCliAuthenticationError,
  GiteaPullRequestNotFoundError,
  GiteaCliCommandError,
  GiteaPullRequestListDecodeError,
  GiteaPullRequestDecodeError,
  GiteaRepositoryDecodeError,
]);
export type GiteaCliError = typeof GiteaCliError.Type;
export const isGiteaCliError = Schema.is(GiteaCliError);

export interface GiteaRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export type GiteaPullRequestSummary = NormalizedGiteaPullRequestRecord;

export class GiteaCli extends Context.Service<
  GiteaCli,
  {
    readonly execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly stdin?: string;
      readonly timeoutMs?: number;
    }) => Effect.Effect<VcsProcess.VcsProcessOutput, GiteaCliError>;

    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly state: "open" | "closed" | "merged" | "all";
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<NormalizedGiteaPullRequestRecord>, GiteaCliError>;

    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
    }) => Effect.Effect<NormalizedGiteaPullRequestRecord, GiteaCliError>;

    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly repository: string;
    }) => Effect.Effect<GiteaRepositoryCloneUrls, GiteaCliError>;

    readonly createRepository: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly visibility: SourceControlRepositoryVisibility;
    }) => Effect.Effect<GiteaRepositoryCloneUrls, GiteaCliError>;

    readonly createPullRequest: (input: {
      readonly cwd: string;
      readonly baseBranch: string;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly target?: SourceControlProvider.SourceControlRefSelector;
      readonly title: string;
      readonly bodyFile: string;
    }) => Effect.Effect<void, GiteaCliError>;

    readonly getDefaultBranch: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string | null, GiteaCliError>;

    readonly checkoutPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly force?: boolean;
    }) => Effect.Effect<void, GiteaCliError>;
  }
>()("t3/sourceControl/GiteaCli") {}

const RawGiteaRepositorySchema = Schema.Struct({
  full_name: Schema.optional(Schema.String),
  owner: Schema.optional(
    Schema.Union([
      Schema.String,
      Schema.Struct({
        login: Schema.optional(Schema.String),
        name: Schema.optional(Schema.String),
        username: Schema.optional(Schema.String),
      }),
    ]),
  ),
  name: Schema.optional(Schema.String),
  html_url: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  clone_url: Schema.optional(Schema.String),
  ssh_url: Schema.optional(Schema.String),
  ssh: Schema.optional(Schema.String),
  default_branch: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeRawGiteaRepository = Schema.decodeEffect(
  Schema.fromJsonString(RawGiteaRepositorySchema),
);

function fromVcsError(
  context: {
    readonly operation: "execute";
    readonly command: "tea";
    readonly cwd: string;
  },
  error: VcsError,
): GiteaCliError {
  if (
    error._tag === "VcsProcessSpawnError" &&
    error.cause instanceof PlatformError.PlatformError &&
    error.cause.reason._tag === "NotFound" &&
    error.cause.reason.pathOrDescriptor !== context.cwd &&
    error.cause.reason.syscall !== "chdir"
  ) {
    return new GiteaCliUnavailableError({ ...context, cause: error });
  }

  if (error._tag === "VcsProcessExitError") {
    if (error.failureKind === "authentication") {
      return new GiteaCliAuthenticationError({ ...context, cause: error });
    }
    if (error.failureKind === "not-found") {
      return new GiteaCliCommandError({ ...context, cause: error });
    }
  }

  return new GiteaCliCommandError({ ...context, cause: error });
}

function pullRequestFromVcsError(
  context: {
    readonly operation: "execute";
    readonly command: "tea";
    readonly cwd: string;
    readonly reference: string;
  },
  error: VcsError,
): GiteaCliError {
  if (error._tag === "VcsProcessExitError" && error.failureKind === "not-found") {
    return new GiteaPullRequestNotFoundError({ ...context, cause: error });
  }
  return fromVcsError(context, error);
}

function parseRepositoryPath(repository: string): {
  readonly owner: string;
  readonly name: string;
} {
  const parts = repository
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return {
    owner: parts[0] ?? "",
    name: parts.slice(1).join("/") || parts[1] || repository.trim(),
  };
}

function repositoryApiPath(repository: string): string {
  const { owner, name } = parseRepositoryPath(repository);
  return `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function normalizePullRequestReference(reference: string): string {
  const trimmed = reference.trim().replace(/^#/, "");
  const match = /(?:pulls|pull|pull-requests|pullrequest)\/(\d+)(?:[/?#].*)?$/iu.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function normalizeHeadSelector(input: {
  readonly headSelector: string;
  readonly source?: SourceControlProvider.SourceControlRefSelector;
}): string {
  return input.source?.refName ?? SourceControlProvider.normalizeSourceBranch(input.headSelector);
}

function createHeadSelector(input: {
  readonly headSelector: string;
  readonly source?: SourceControlProvider.SourceControlRefSelector;
}): string {
  const refName = normalizeHeadSelector(input);
  return input.source?.owner ? `${input.source.owner}:${refName}` : refName;
}

function giteaListState(state: "open" | "closed" | "merged" | "all"): "open" | "closed" | "all" {
  return state === "merged" ? "closed" : state;
}

function normalizeDefaultBranch(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function repositoryOwnerName(
  owner: Schema.Schema.Type<typeof RawGiteaRepositorySchema>["owner"],
): string | null {
  if (typeof owner === "string") {
    return trimOptionalString(owner);
  }
  return (
    trimOptionalString(owner?.login) ??
    trimOptionalString(owner?.name) ??
    trimOptionalString(owner?.username)
  );
}

function repositoryNameWithOwner(
  raw: Schema.Schema.Type<typeof RawGiteaRepositorySchema>,
  fallbackRepository: string,
): string {
  const fullName = trimOptionalString(raw.full_name);
  if (fullName) return fullName;

  const owner = repositoryOwnerName(raw.owner);
  const name = trimOptionalString(raw.name);
  return owner && name ? `${owner}/${name}` : fallbackRepository;
}

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawGiteaRepositorySchema>,
  fallbackRepository = "",
): GiteaRepositoryCloneUrls {
  return {
    nameWithOwner: repositoryNameWithOwner(raw, fallbackRepository),
    url:
      trimOptionalString(raw.clone_url) ??
      trimOptionalString(raw.html_url) ??
      trimOptionalString(raw.url) ??
      "",
    sshUrl: trimOptionalString(raw.ssh_url) ?? trimOptionalString(raw.ssh) ?? "",
  };
}

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;

  const run = (
    input: Parameters<GiteaCli["Service"]["execute"]>[0],
    mapError: (error: VcsError) => GiteaCliError,
  ) =>
    process
      .run({
        operation: "GiteaCli.execute",
        command: "tea",
        args: input.args,
        cwd: input.cwd,
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
      .pipe(Effect.mapError(mapError));

  const execute: GiteaCli["Service"]["execute"] = (input) =>
    run(input, (error) =>
      fromVcsError({ operation: "execute", command: "tea", cwd: input.cwd }, error),
    );

  const executePullRequest = (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly args: ReadonlyArray<string>;
  }) =>
    run(input, (error) =>
      pullRequestFromVcsError(
        {
          operation: "execute",
          command: "tea",
          cwd: input.cwd,
          reference: input.reference,
        },
        error,
      ),
    );

  const decodeRepository = (input: {
    readonly raw: string;
    readonly cwd: string;
    readonly operation: "getRepositoryCloneUrls" | "createRepository" | "getDefaultBranch";
    readonly repository?: string;
  }) =>
    decodeRawGiteaRepository(input.raw).pipe(
      Effect.mapError(
        (cause) =>
          new GiteaRepositoryDecodeError({
            operation: input.operation,
            command: "tea",
            cwd: input.cwd,
            ...(input.repository ? { repository: input.repository } : {}),
            cause,
          }),
      ),
    );

  const getRepositoryCloneUrls: GiteaCli["Service"]["getRepositoryCloneUrls"] = (input) =>
    execute({
      cwd: input.cwd,
      args: ["api", repositoryApiPath(input.repository)],
    }).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.flatMap((raw) =>
        decodeRepository({
          raw,
          cwd: input.cwd,
          operation: "getRepositoryCloneUrls",
          repository: input.repository,
        }),
      ),
      Effect.map((raw) => normalizeRepositoryCloneUrls(raw, input.repository)),
    );

  return GiteaCli.of({
    execute,
    listPullRequests: (input) => {
      const requestedLimit = input.limit ?? 20;
      const fetchLimit = Math.max(requestedLimit, DEFAULT_LIST_PULL_REQUEST_LIMIT);
      const headRefName = normalizeHeadSelector(input);
      return execute({
        cwd: input.cwd,
        args: [
          "api",
          `/repos/{owner}/{repo}/pulls?state=${giteaListState(input.state)}&limit=${fetchLimit}`,
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => decodeGiteaPullRequestListJson(raw)).pipe(
                Effect.flatMap((decoded) => {
                  if (!Result.isSuccess(decoded)) {
                    return Effect.fail(
                      new GiteaPullRequestListDecodeError({
                        operation: "listPullRequests",
                        command: "tea",
                        cwd: input.cwd,
                        cause: decoded.failure,
                      }),
                    );
                  }

                  const matching = decoded.success.filter(
                    (item) =>
                      item.headRefName === headRefName &&
                      (input.state === "all" || item.state === input.state),
                  );
                  return Effect.succeed(matching.slice(0, requestedLimit));
                }),
              ),
        ),
      );
    },
    getPullRequest: (input) => {
      const reference = normalizePullRequestReference(input.reference);
      return executePullRequest({
        cwd: input.cwd,
        reference,
        args: ["api", `/repos/{owner}/{repo}/pulls/${reference}`],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.sync(() => decodeGiteaPullRequestJson(raw)).pipe(
            Effect.flatMap((decoded) => {
              if (!Result.isSuccess(decoded)) {
                return Effect.fail(
                  new GiteaPullRequestDecodeError({
                    operation: "getPullRequest",
                    command: "tea",
                    cwd: input.cwd,
                    reference,
                    cause: decoded.failure,
                  }),
                );
              }

              return Effect.succeed(decoded.success);
            }),
          ),
        ),
      );
    },
    getRepositoryCloneUrls,
    createRepository: (input) => {
      const { owner, name } = parseRepositoryPath(input.repository);
      return execute({
        cwd: input.cwd,
        args: [
          "repos",
          "create",
          "--name",
          name,
          "--owner",
          owner,
          ...(input.visibility === "private" ? ["--private"] : []),
          "--output",
          "json",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? getRepositoryCloneUrls({ cwd: input.cwd, repository: input.repository })
            : decodeRepository({
                raw,
                cwd: input.cwd,
                operation: "createRepository",
                repository: input.repository,
              }).pipe(Effect.map((repo) => normalizeRepositoryCloneUrls(repo, input.repository))),
        ),
      );
    },
    createPullRequest: (input) =>
      fileSystem.readFileString(input.bodyFile).pipe(
        Effect.mapError(
          (cause) =>
            new GiteaCliCommandError({
              operation: "execute",
              command: "tea",
              cwd: input.cwd,
              cause,
            }),
        ),
        Effect.flatMap((body) =>
          execute({
            cwd: input.cwd,
            args: ["api", "--method", "POST", "/repos/{owner}/{repo}/pulls", "--data", "@-"],
            stdin: JSON.stringify({
              base: input.target?.refName ?? input.baseBranch,
              head: createHeadSelector(input),
              title: input.title,
              body,
            }),
          }),
        ),
        Effect.asVoid,
      ),
    getDefaultBranch: (input) =>
      execute({
        cwd: input.cwd,
        args: ["api", "/repos/{owner}/{repo}"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeRepository({
            raw,
            cwd: input.cwd,
            operation: "getDefaultBranch",
          }),
        ),
        Effect.map((repo) => normalizeDefaultBranch(repo.default_branch)),
      ),
    checkoutPullRequest: (input) =>
      executePullRequest({
        cwd: input.cwd,
        reference: normalizePullRequestReference(input.reference),
        args: ["pr", "checkout", normalizePullRequestReference(input.reference)],
      }).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(GiteaCli, make);
