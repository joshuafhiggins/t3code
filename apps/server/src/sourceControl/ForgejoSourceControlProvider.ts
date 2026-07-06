import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SourceControlProviderError, type ChangeRequest } from "@t3tools/contracts";

import * as ForgejoCli from "./ForgejoCli.ts";
import type { NormalizedForgejoPullRequestRecord } from "./forgejoPullRequests.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  combinedAuthOutput,
  firstSafeAuthLine,
  matchFirst,
  parseCliHost,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
  type SourceControlUnknownRemoteRefinementInput,
} from "./SourceControlProviderDiscovery.ts";

function toChangeRequest(summary: NormalizedForgejoPullRequestRecord): ChangeRequest {
  return {
    provider: "forgejo",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state,
    updatedAt: summary.updatedAt ?? Option.none(),
    ...(summary.isCrossRepository !== undefined
      ? { isCrossRepository: summary.isCrossRepository }
      : {}),
    ...(summary.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: summary.headRepositoryNameWithOwner }
      : {}),
    ...(summary.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: summary.headRepositoryOwnerLogin }
      : {}),
  };
}

function parseForgejoAuth(input: SourceControlAuthProbeInput) {
  const output = combinedAuthOutput(input);
  const account = matchFirst(output, [
    /Logged in to .* as\s+([^\s(]+)/iu,
    /Authenticated as\s+([^\s(]+)/iu,
    /account:\s*([^\s(]+)/iu,
    /user(?:name)?:\s*([^\s(]+)/iu,
  ]);
  const host =
    matchFirst(output, [
      /Logged in to\s+([^\s]+)\s+as/iu,
      /host(?:name)?:\s*([^\s]+)/iu,
      /instance:\s*([^\s]+)/iu,
    ]) ?? parseCliHost(output);

  if (account) {
    return providerAuth({ status: "authenticated", account, host });
  }

  if (input.exitCode !== 0) {
    return providerAuth({
      status: "unauthenticated",
      host,
      detail:
        firstSafeAuthLine(output) ?? "Run `forgejo-cli auth login` to authenticate Forgejo CLI.",
    });
  }

  return providerAuth({
    status: "unknown",
    host,
    detail: firstSafeAuthLine(output) ?? "Forgejo CLI auth status could not be parsed.",
  });
}

function refineUnknownForgejoRemote(input: SourceControlUnknownRemoteRefinementInput) {
  const host = input.context.provider.name.toLowerCase();
  const auth = parseForgejoAuth(input.auth);
  const authHost = Option.getOrNull(auth.host)?.toLowerCase();
  if (auth.status !== "authenticated" || authHost !== host) {
    return null;
  }

  return {
    kind: "forgejo",
    name: host === "codeberg.org" ? "Codeberg" : "Forgejo Self-Hosted",
    baseUrl: input.context.provider.baseUrl,
  } as const;
}

export const discovery = {
  type: "cli",
  kind: "forgejo",
  label: "Forgejo",
  executable: "forgejo-cli",
  versionArgs: ["--version"],
  authArgs: ["auth", "status"],
  parseAuth: parseForgejoAuth,
  refineUnknownRemote: refineUnknownForgejoRemote,
  installHint:
    "Install Forgejo CLI (`forgejo-cli`) from the forgejo-cli project, then run `forgejo-cli auth login` for your Forgejo or Codeberg host.",
} satisfies SourceControlCliDiscoverySpec;

export const make = Effect.gen(function* () {
  const forgejo = yield* ForgejoCli.ForgejoCli;

  return SourceControlProvider.SourceControlProvider.of({
    kind: "forgejo",
    listChangeRequests: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return forgejo
        .listPullRequests({
          cwd: input.cwd,
          headSelector: input.headSelector,
          ...(source ? { source } : {}),
          state: input.state,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(
          Effect.map((items) => items.map(toChangeRequest)),
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "forgejo",
                operation: "listChangeRequests",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        );
    },
    getChangeRequest: (input) =>
      forgejo.getPullRequest(input).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "forgejo",
              operation: "getChangeRequest",
              command: error.command,
              cwd: input.cwd,
              reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.reference,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    createChangeRequest: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return forgejo
        .createPullRequest({
          cwd: input.cwd,
          baseBranch: input.baseRefName,
          headSelector: input.headSelector,
          ...(source ? { source } : {}),
          ...(input.target ? { target: input.target } : {}),
          title: input.title,
          bodyFile: input.bodyFile,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "forgejo",
                operation: "createChangeRequest",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        );
    },
    getRepositoryCloneUrls: (input) =>
      forgejo.getRepositoryCloneUrls(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "forgejo",
              operation: "getRepositoryCloneUrls",
              command: error.command,
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    createRepository: (input) =>
      forgejo.createRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "forgejo",
              operation: "createRepository",
              command: error.command,
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    getDefaultBranch: (input) =>
      forgejo.getDefaultBranch(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "forgejo",
              operation: "getDefaultBranch",
              command: error.command,
              cwd: input.cwd,
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    checkoutChangeRequest: (input) =>
      forgejo.checkoutPullRequest(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "forgejo",
              operation: "checkoutChangeRequest",
              command: error.command,
              cwd: input.cwd,
              reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.reference,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
  });
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make);
