import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GiteaCli from "./GiteaCli.ts";
import * as GiteaSourceControlProvider from "./GiteaSourceControlProvider.ts";

function makeProvider(gitea: Partial<GiteaCli.GiteaCli["Service"]>) {
  return GiteaSourceControlProvider.make.pipe(Effect.provide(Layer.mock(GiteaCli.GiteaCli)(gitea)));
}

it.effect("maps Gitea PR summaries into provider-neutral change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequest: () =>
        Effect.succeed({
          number: 42,
          title: "Add Gitea provider",
          url: "https://gitea.example.test/owner/repo/pulls/42",
          baseRefName: "main",
          headRefName: "feature/source-control",
          state: "open",
          updatedAt: Option.none(),
          isCrossRepository: true,
          headRepositoryNameWithOwner: "fork/repo",
          headRepositoryOwnerLogin: "fork",
        }),
    });

    const changeRequest = yield* provider.getChangeRequest({
      cwd: "/repo",
      reference: "42",
    });

    assert.deepStrictEqual(changeRequest, {
      provider: "gitea",
      number: 42,
      title: "Add Gitea provider",
      url: "https://gitea.example.test/owner/repo/pulls/42",
      baseRefName: "main",
      headRefName: "feature/source-control",
      state: "open",
      updatedAt: Option.none(),
      isCrossRepository: true,
      headRepositoryNameWithOwner: "fork/repo",
      headRepositoryOwnerLogin: "fork",
    });
  }),
);

it.effect("creates Gitea PRs through provider-neutral input names", () =>
  Effect.gen(function* () {
    let createInput: Parameters<GiteaCli.GiteaCli["Service"]["createPullRequest"]>[0] | null = null;
    const provider = yield* makeProvider({
      createPullRequest: (input) => {
        createInput = input;
        return Effect.void;
      },
    });

    yield* provider.createChangeRequest({
      cwd: "/repo",
      baseRefName: "main",
      headSelector: "owner:feature/provider",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });

    assert.deepStrictEqual(createInput, {
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "owner:feature/provider",
      source: {
        owner: "owner",
        refName: "feature/provider",
      },
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });
  }),
);

it("parses authenticated Gitea whoami JSON", () => {
  const auth = GiteaSourceControlProvider.discovery.parseAuth({
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout: JSON.stringify({
      login: "gitea-user",
      html_url: "https://forge.example.test/gitea-user",
    }),
    stderr: "",
  });

  assert.deepStrictEqual(
    {
      status: auth.status,
      account: auth.account,
      host: auth.host,
    },
    {
      status: "authenticated",
      account: Option.some("gitea-user"),
      host: Option.some("forge.example.test"),
    },
  );
});

it("refines unknown Gitea remotes when tea is authenticated for the remote host", () => {
  const provider = GiteaSourceControlProvider.discovery.refineUnknownRemote?.({
    cwd: "/repo",
    context: {
      provider: {
        kind: "unknown",
        name: "forge.example.test",
        baseUrl: "https://forge.example.test",
      },
      remoteName: "origin",
      remoteUrl: "https://forge.example.test/group/project.git",
    },
    auth: {
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout: JSON.stringify({
        login: "gitea-user",
        html_url: "https://forge.example.test/gitea-user",
      }),
      stderr: "",
    },
  });

  assert.deepStrictEqual(provider, {
    kind: "gitea",
    name: "Gitea Self-Hosted",
    baseUrl: "https://forge.example.test",
  });
});
