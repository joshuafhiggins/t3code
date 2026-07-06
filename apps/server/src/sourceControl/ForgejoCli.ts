import * as FileSystem from "effect/FileSystem";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  TrimmedNonEmptyString,
  type SourceControlRepositoryVisibility,
  type VcsError,
} from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  decodeForgejoPullRequestJson,
  decodeForgejoPullRequestListJson,
  type NormalizedForgejoPullRequestRecord,
} from "./forgejoPullRequests.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const FORGEJO_COMMAND = "forgejo-cli";

const forgejoCliExecutionErrorContext = {
  operation: Schema.Literal("execute"),
  command: Schema.Literal(FORGEJO_COMMAND),
  cwd: Schema.String,
  cause: Schema.Defect(),
};

const forgejoCliDecodeErrorContext = {
  command: Schema.Literal(FORGEJO_COMMAND),
  cwd: Schema.String,
  cause: Schema.Defect(),
};

export class ForgejoCliUnavailableError extends Schema.TaggedErrorClass<ForgejoCliUnavailableError>()(
  "ForgejoCliUnavailableError",
  forgejoCliExecutionErrorContext,
) {
  get detail(): string {
    return "Forgejo CLI (`forgejo-cli`) is required but not available on PATH.";
  }

  override get message(): string {
    return `Forgejo CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class ForgejoCliAuthenticationError extends Schema.TaggedErrorClass<ForgejoCliAuthenticationError>()(
  "ForgejoCliAuthenticationError",
  forgejoCliExecutionErrorContext,
) {
  get detail(): string {
    return "Forgejo CLI is not authenticated. Run `forgejo-cli auth login` and retry.";
  }

  override get message(): string {
    return `Forgejo CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class ForgejoPullRequestNotFoundError extends Schema.TaggedErrorClass<ForgejoPullRequestNotFoundError>()(
  "ForgejoPullRequestNotFoundError",
  {
    ...forgejoCliExecutionErrorContext,
    reference: Schema.String,
  },
) {
  get detail(): string {
    return `Pull request ${this.reference} was not found. Check the PR number or URL and try again.`;
  }

  override get message(): string {
    return `Forgejo CLI failed in ${this.operation}: ${this.detail}`;
  }

  static fromVcsError(
    context: {
      readonly operation: "execute";
      readonly command: typeof FORGEJO_COMMAND;
      readonly cwd: string;
      readonly reference: string;
    },
    error: VcsError,
  ): ForgejoCliError {
    if (error._tag === "VcsProcessExitError") {
      const detail = error.detail.toLowerCase();
      if (
        error.failureKind === "not-found" ||
        detail.includes("not found") ||
        detail.includes("404")
      ) {
        return new ForgejoPullRequestNotFoundError({ ...context, cause: error });
      }
    }

    return ForgejoCliCommandError.fromVcsError(
      {
        operation: context.operation,
        command: context.command,
        cwd: context.cwd,
      },
      error,
    );
  }
}

export class ForgejoCliCommandError extends Schema.TaggedErrorClass<ForgejoCliCommandError>()(
  "ForgejoCliCommandError",
  forgejoCliExecutionErrorContext,
) {
  get detail(): string {
    return "Forgejo CLI command failed.";
  }

  override get message(): string {
    return `Forgejo CLI failed in ${this.operation}: ${this.detail}`;
  }

  static fromVcsError(
    context: {
      readonly operation: "execute";
      readonly command: typeof FORGEJO_COMMAND;
      readonly cwd: string;
    },
    error: VcsError,
  ): ForgejoCliError {
    return Match.valueTags(error, {
      VcsProcessSpawnError: (cause) => new ForgejoCliUnavailableError({ ...context, cause }),
      VcsProcessExitError: (cause) =>
        cause.failureKind === "authentication"
          ? new ForgejoCliAuthenticationError({ ...context, cause })
          : new ForgejoCliCommandError({ ...context, cause }),
      VcsProcessTimeoutError: (cause) => new ForgejoCliCommandError({ ...context, cause }),
      VcsProcessStdinWriteError: (cause) => new ForgejoCliCommandError({ ...context, cause }),
      VcsProcessOutputReadError: (cause) => new ForgejoCliCommandError({ ...context, cause }),
      VcsProcessOutputLimitError: (cause) => new ForgejoCliCommandError({ ...context, cause }),
      VcsProcessMissingExitCodeError: (cause) => new ForgejoCliCommandError({ ...context, cause }),
      VcsRepositoryDetectionError: (cause) => new ForgejoCliCommandError({ ...context, cause }),
      VcsUnsupportedOperationError: (cause) => new ForgejoCliCommandError({ ...context, cause }),
    });
  }
}

export class ForgejoPullRequestListDecodeError extends Schema.TaggedErrorClass<ForgejoPullRequestListDecodeError>()(
  "ForgejoPullRequestListDecodeError",
  {
    ...forgejoCliDecodeErrorContext,
    operation: Schema.Literal("listPullRequests"),
  },
) {
  get detail(): string {
    return "Forgejo CLI returned invalid PR list JSON.";
  }

  override get message(): string {
    return `Forgejo CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class ForgejoPullRequestDecodeError extends Schema.TaggedErrorClass<ForgejoPullRequestDecodeError>()(
  "ForgejoPullRequestDecodeError",
  {
    ...forgejoCliDecodeErrorContext,
    operation: Schema.Literal("getPullRequest"),
    reference: Schema.String,
  },
) {
  get detail(): string {
    return "Forgejo CLI returned invalid pull request JSON.";
  }

  override get message(): string {
    return `Forgejo CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class ForgejoRepositoryDecodeError extends Schema.TaggedErrorClass<ForgejoRepositoryDecodeError>()(
  "ForgejoRepositoryDecodeError",
  {
    ...forgejoCliDecodeErrorContext,
    operation: Schema.Literals(["getRepositoryCloneUrls", "createRepository", "getDefaultBranch"]),
    repository: Schema.optional(Schema.String),
  },
) {
  get detail(): string {
    return "Forgejo CLI returned invalid repository JSON.";
  }

  override get message(): string {
    return `Forgejo CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class ForgejoUserDecodeError extends Schema.TaggedErrorClass<ForgejoUserDecodeError>()(
  "ForgejoUserDecodeError",
  {
    ...forgejoCliDecodeErrorContext,
    operation: Schema.Literal("createRepository"),
  },
) {
  get detail(): string {
    return "Forgejo CLI returned invalid user JSON.";
  }

  override get message(): string {
    return `Forgejo CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class ForgejoPullRequestBodyReadError extends Schema.TaggedErrorClass<ForgejoPullRequestBodyReadError>()(
  "ForgejoPullRequestBodyReadError",
  {
    command: Schema.Literal(FORGEJO_COMMAND),
    cwd: Schema.String,
    bodyFile: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return "Failed to read pull request body file.";
  }

  override get message(): string {
    return `Forgejo CLI failed in createPullRequest: ${this.detail}`;
  }
}

export const ForgejoCliError = Schema.Union([
  ForgejoCliUnavailableError,
  ForgejoCliAuthenticationError,
  ForgejoPullRequestNotFoundError,
  ForgejoCliCommandError,
  ForgejoPullRequestListDecodeError,
  ForgejoPullRequestDecodeError,
  ForgejoRepositoryDecodeError,
  ForgejoUserDecodeError,
  ForgejoPullRequestBodyReadError,
]);
export type ForgejoCliError = typeof ForgejoCliError.Type;
export const isForgejoCliError = Schema.is(ForgejoCliError);

export interface ForgejoRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export class ForgejoCli extends Context.Service<
  ForgejoCli,
  {
    readonly execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly stdin?: string;
      readonly timeoutMs?: number;
    }) => Effect.Effect<VcsProcess.VcsProcessOutput, ForgejoCliError>;

    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly state: "open" | "closed" | "merged" | "all";
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<NormalizedForgejoPullRequestRecord>, ForgejoCliError>;

    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
    }) => Effect.Effect<NormalizedForgejoPullRequestRecord, ForgejoCliError>;

    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly repository: string;
    }) => Effect.Effect<ForgejoRepositoryCloneUrls, ForgejoCliError>;

    readonly createRepository: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly visibility: SourceControlRepositoryVisibility;
    }) => Effect.Effect<ForgejoRepositoryCloneUrls, ForgejoCliError>;

    readonly createPullRequest: (input: {
      readonly cwd: string;
      readonly baseBranch: string;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly target?: SourceControlProvider.SourceControlRefSelector;
      readonly title: string;
      readonly bodyFile: string;
    }) => Effect.Effect<void, ForgejoCliError>;

    readonly getDefaultBranch: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string | null, ForgejoCliError>;

    readonly checkoutPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly force?: boolean;
    }) => Effect.Effect<void, ForgejoCliError>;
  }
>()("t3/sourceControl/ForgejoCli") {}

const RawForgejoRepositorySchema = Schema.Struct({
  full_name: Schema.optional(TrimmedNonEmptyString),
  fullName: Schema.optional(TrimmedNonEmptyString),
  nameWithOwner: Schema.optional(TrimmedNonEmptyString),
  name: Schema.optional(TrimmedNonEmptyString),
  html_url: Schema.optional(TrimmedNonEmptyString),
  htmlUrl: Schema.optional(TrimmedNonEmptyString),
  url: Schema.optional(TrimmedNonEmptyString),
  clone_url: Schema.optional(TrimmedNonEmptyString),
  cloneUrl: Schema.optional(TrimmedNonEmptyString),
  ssh_url: Schema.optional(TrimmedNonEmptyString),
  sshUrl: Schema.optional(TrimmedNonEmptyString),
  default_branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  defaultBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  owner: Schema.optional(
    Schema.Struct({
      login: Schema.optional(TrimmedNonEmptyString),
      username: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
});

const RawForgejoUserSchema = Schema.Struct({
  login: TrimmedNonEmptyString,
});

const decodeForgejoRepository = Schema.decodeEffect(
  Schema.fromJsonString(RawForgejoRepositorySchema),
);
const decodeForgejoUser = Schema.decodeEffect(Schema.fromJsonString(RawForgejoUserSchema));

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function parseRepositoryPath(repository: string): {
  readonly owner: string | null;
  readonly name: string;
  readonly nameWithOwner: string;
} {
  const parts = repository
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const owner = parts.length > 1 ? (parts[0] ?? null) : null;
  const name = parts.at(-1) ?? repository.trim();
  return {
    owner,
    name,
    nameWithOwner: owner ? `${owner}/${name}` : name,
  };
}

function encodeRepositoryPath(repository: string): string {
  const { owner, name } = parseRepositoryPath(repository);
  if (!owner) return repository.trim();
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function normalizeChangeRequestId(reference: string): string {
  const trimmed = reference.trim().replace(/^#/, "");
  const urlMatch = /(?:pulls|pull|pull-requests)\/(\d+)(?:\D.*)?$/iu.exec(trimmed);
  return urlMatch?.[1] ?? trimmed;
}

function sourceRefName(input: {
  readonly headSelector: string;
  readonly source?: SourceControlProvider.SourceControlRefSelector;
}): string {
  return input.source?.refName ?? SourceControlProvider.sourceBranch(input);
}

function toForgejoListState(state: "open" | "closed" | "merged" | "all"): string {
  switch (state) {
    case "open":
      return "open";
    case "closed":
    case "merged":
      return "closed";
    case "all":
      return "all";
  }
}

function matchesRequestedState(
  pullRequest: NormalizedForgejoPullRequestRecord,
  state: "open" | "closed" | "merged" | "all",
): boolean {
  switch (state) {
    case "all":
      return true;
    case "closed":
      return pullRequest.state === "closed";
    case "merged":
      return pullRequest.state === "merged";
    case "open":
      return pullRequest.state === "open";
  }
}

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawForgejoRepositorySchema>,
  fallbackRepository: string,
): ForgejoRepositoryCloneUrls {
  const fallback = parseRepositoryPath(fallbackRepository);
  const ownerLogin = raw.owner?.login ?? raw.owner?.username ?? fallback.owner;
  const nameWithOwner =
    trimToNull(raw.full_name) ??
    trimToNull(raw.fullName) ??
    trimToNull(raw.nameWithOwner) ??
    (ownerLogin && raw.name ? `${ownerLogin}/${raw.name}` : fallback.nameWithOwner);
  const url =
    trimToNull(raw.html_url) ??
    trimToNull(raw.htmlUrl) ??
    trimToNull(raw.url) ??
    trimToNull(raw.clone_url) ??
    `https://codeberg.org/${nameWithOwner}`;
  const sshUrl =
    trimToNull(raw.ssh_url) ?? trimToNull(raw.sshUrl) ?? deriveSshUrlFromWebUrl(url, nameWithOwner);

  return {
    nameWithOwner,
    url,
    sshUrl,
  };
}

function deriveSshUrlFromWebUrl(url: string, nameWithOwner: string): string {
  try {
    const parsed = new URL(url);
    return `git@${parsed.host}:${nameWithOwner}.git`;
  } catch {
    return `git@codeberg.org:${nameWithOwner}.git`;
  }
}

function decodeRepositoryJson(input: {
  readonly raw: string;
  readonly operation: "getRepositoryCloneUrls" | "createRepository" | "getDefaultBranch";
  readonly cwd: string;
  readonly repository?: string;
}) {
  return decodeForgejoRepository(input.raw).pipe(
    Effect.mapError(
      (cause) =>
        new ForgejoRepositoryDecodeError({
          operation: input.operation,
          command: FORGEJO_COMMAND,
          cwd: input.cwd,
          ...(input.repository ? { repository: input.repository } : {}),
          cause,
        }),
    ),
  );
}

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;

  const execute: ForgejoCli["Service"]["execute"] = (input) =>
    process
      .run({
        operation: "ForgejoCli.execute",
        command: FORGEJO_COMMAND,
        args: input.args,
        cwd: input.cwd,
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
      .pipe(
        Effect.mapError((error) =>
          ForgejoCliCommandError.fromVcsError(
            { operation: "execute", command: FORGEJO_COMMAND, cwd: input.cwd },
            error,
          ),
        ),
      );

  const executePullRequest = (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly args: ReadonlyArray<string>;
  }) =>
    process
      .run({
        operation: "ForgejoCli.execute",
        command: FORGEJO_COMMAND,
        args: input.args,
        cwd: input.cwd,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      })
      .pipe(
        Effect.mapError((error) =>
          ForgejoPullRequestNotFoundError.fromVcsError(
            {
              operation: "execute",
              command: FORGEJO_COMMAND,
              cwd: input.cwd,
              reference: input.reference,
            },
            error,
          ),
        ),
      );

  const executeApi = (input: {
    readonly cwd: string;
    readonly method?: "GET" | "POST";
    readonly endpoint: string;
    readonly stdin?: string;
  }) =>
    execute({
      cwd: input.cwd,
      args: [
        "api",
        ...(input.method && input.method !== "GET" ? [input.method] : []),
        input.endpoint,
        ...(input.stdin !== undefined ? ["--input", "-"] : []),
      ],
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
    });

  return ForgejoCli.of({
    execute,
    listPullRequests: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "list",
          "--state",
          toForgejoListState(input.state),
          "--limit",
          String(input.limit ?? 20),
          "--json",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => decodeForgejoPullRequestListJson(raw)).pipe(
                Effect.flatMap((decoded) => {
                  if (!Result.isSuccess(decoded)) {
                    return Effect.fail(
                      new ForgejoPullRequestListDecodeError({
                        operation: "listPullRequests",
                        command: FORGEJO_COMMAND,
                        cwd: input.cwd,
                        cause: decoded.failure,
                      }),
                    );
                  }

                  const headRefName = sourceRefName(input);
                  return Effect.succeed(
                    decoded.success.filter(
                      (pullRequest) =>
                        pullRequest.headRefName === headRefName &&
                        matchesRequestedState(pullRequest, input.state),
                    ),
                  );
                }),
              ),
        ),
      ),
    getPullRequest: (input) => {
      const reference = normalizeChangeRequestId(input.reference);
      return executePullRequest({
        cwd: input.cwd,
        reference,
        args: ["pr", "view", reference, "--json"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.sync(() => decodeForgejoPullRequestJson(raw)).pipe(
            Effect.flatMap((decoded) => {
              if (!Result.isSuccess(decoded)) {
                return Effect.fail(
                  new ForgejoPullRequestDecodeError({
                    operation: "getPullRequest",
                    command: FORGEJO_COMMAND,
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
    getRepositoryCloneUrls: (input) =>
      executeApi({
        cwd: input.cwd,
        endpoint: `/repos/${encodeRepositoryPath(input.repository)}`,
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeRepositoryJson({
            raw,
            operation: "getRepositoryCloneUrls",
            cwd: input.cwd,
            repository: input.repository,
          }),
        ),
        Effect.map((repository) => normalizeRepositoryCloneUrls(repository, input.repository)),
      ),
    createRepository: (input) => {
      const repository = parseRepositoryPath(input.repository);
      const currentUser = executeApi({ cwd: input.cwd, endpoint: "/user" }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeForgejoUser(raw).pipe(
            Effect.mapError(
              (cause) =>
                new ForgejoUserDecodeError({
                  operation: "createRepository",
                  command: FORGEJO_COMMAND,
                  cwd: input.cwd,
                  cause,
                }),
            ),
          ),
        ),
        Effect.map((user) => user.login),
      );

      return currentUser.pipe(
        Effect.flatMap((login) => {
          const owner = repository.owner ?? login;
          const endpoint =
            owner.toLowerCase() === login.toLowerCase()
              ? "/user/repos"
              : `/orgs/${encodeURIComponent(owner)}/repos`;
          return executeApi({
            cwd: input.cwd,
            method: "POST",
            endpoint,
            stdin: JSON.stringify({
              name: repository.name,
              private: input.visibility === "private",
            }),
          });
        }),
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeRepositoryJson({
            raw,
            operation: "createRepository",
            cwd: input.cwd,
            repository: input.repository,
          }),
        ),
        Effect.map((createdRepository) =>
          normalizeRepositoryCloneUrls(createdRepository, input.repository),
        ),
      );
    },
    createPullRequest: (input) =>
      fileSystem.readFileString(input.bodyFile).pipe(
        Effect.mapError(
          (cause) =>
            new ForgejoPullRequestBodyReadError({
              command: FORGEJO_COMMAND,
              cwd: input.cwd,
              bodyFile: input.bodyFile,
              cause,
            }),
        ),
        Effect.flatMap((body) =>
          executeApi({
            cwd: input.cwd,
            method: "POST",
            endpoint: "/repos/{owner}/{repo}/pulls",
            stdin: JSON.stringify({
              base: input.target?.refName ?? input.baseBranch,
              head: sourceRefName(input),
              title: input.title,
              body,
            }),
          }),
        ),
        Effect.asVoid,
      ),
    getDefaultBranch: (input) =>
      executeApi({
        cwd: input.cwd,
        endpoint: "/repos/{owner}/{repo}",
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeRepositoryJson({ raw, operation: "getDefaultBranch", cwd: input.cwd }),
        ),
        Effect.map((repository) => repository.default_branch ?? repository.defaultBranch ?? null),
      ),
    checkoutPullRequest: (input) =>
      executePullRequest({
        cwd: input.cwd,
        reference: normalizeChangeRequestId(input.reference),
        args: ["pr", "checkout", normalizeChangeRequestId(input.reference)],
      }).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(ForgejoCli, make);
