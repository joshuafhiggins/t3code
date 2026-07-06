import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";

function makeProvider(forgejo: Partial<ForgejoCli.ForgejoCli["Service"]>) {
  return ForgejoSourceControlProvider.make.pipe(
    Effect.provide(Layer.mock(ForgejoCli.ForgejoCli)(forgejo)),
  );
}

it.effect("maps Forgejo PR summaries into provider-neutral change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequest: () =>
        Effect.succeed({
          number: 42,
          title: "Add Forgejo provider",
          url: "https://codeberg.org/pingdotgg/t3code/pulls/42",
          baseRefName: "main",
          headRefName: "feature/source-control",
          state: "open",
          updatedAt: Option.none(),
          isCrossRepository: true,
          headRepositoryNameWithOwner: "fork/t3code",
          headRepositoryOwnerLogin: "fork",
        }),
    });

    const changeRequest = yield* provider.getChangeRequest({
      cwd: "/repo",
      reference: "42",
    });

    assert.deepStrictEqual(changeRequest, {
      provider: "forgejo",
      number: 42,
      title: "Add Forgejo provider",
      url: "https://codeberg.org/pingdotgg/t3code/pulls/42",
      baseRefName: "main",
      headRefName: "feature/source-control",
      state: "open",
      updatedAt: Option.none(),
      isCrossRepository: true,
      headRepositoryNameWithOwner: "fork/t3code",
      headRepositoryOwnerLogin: "fork",
    });
  }),
);

it.effect("adds repository context while retaining Forgejo CLI causes", () =>
  Effect.gen(function* () {
    const cause = new ForgejoCli.ForgejoCliCommandError({
      operation: "execute",
      command: "forgejo-cli",
      cwd: "/repo",
      cause: new Error("raw upstream detail that should remain in the cause"),
    });
    const provider = yield* makeProvider({
      createRepository: () => Effect.fail(cause),
    });

    const error = yield* provider
      .createRepository({
        cwd: "/repo",
        repository: "owner/repo",
        visibility: "private",
      })
      .pipe(Effect.flip);

    assert.deepStrictEqual(
      {
        provider: error.provider,
        operation: error.operation,
        command: error.command,
        cwd: error.cwd,
        repository: error.repository,
        detail: error.detail,
      },
      {
        provider: "forgejo",
        operation: "createRepository",
        command: "forgejo-cli",
        cwd: "/repo",
        repository: "owner/repo",
        detail: "Forgejo CLI command failed.",
      },
    );
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message.includes("raw upstream detail"), false);
  }),
);
