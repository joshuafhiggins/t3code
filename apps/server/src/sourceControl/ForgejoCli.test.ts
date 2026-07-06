// @effect-diagnostics nodeBuiltinImport:off
import { assert, it, afterEach, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ForgejoCli from "./ForgejoCli.ts";

const mockedRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const layer = it.layer(
  ForgejoCli.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(VcsProcess.VcsProcess)({
          run: mockedRun,
        }),
        NodeServices.layer,
      ),
    ),
  ),
);

function processOutput(stdout: string): VcsProcess.VcsProcessOutput {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

afterEach(() => {
  mockedRun.mockReset();
});

layer("ForgejoCli.layer", (it) => {
  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            encodeUnknownJson({
              number: 42,
              title: "Add Forgejo provider",
              html_url: "https://codeberg.org/pingdotgg/t3code/pulls/42",
              base: {
                ref: "main",
                repo: { full_name: "pingdotgg/t3code" },
              },
              head: {
                ref: "feature/forgejo",
                repo: {
                  full_name: "octocat/t3code",
                  owner: { login: "octocat" },
                },
              },
              state: "open",
            }),
          ),
        ),
      );

      const forgejo = yield* ForgejoCli.ForgejoCli;
      const result = yield* forgejo.getPullRequest({
        cwd: "/repo",
        reference: "42",
      });

      assert.deepStrictEqual(
        {
          number: result.number,
          title: result.title,
          url: result.url,
          baseRefName: result.baseRefName,
          headRefName: result.headRefName,
          state: result.state,
          isCrossRepository: result.isCrossRepository,
          headRepositoryNameWithOwner: result.headRepositoryNameWithOwner,
          headRepositoryOwnerLogin: result.headRepositoryOwnerLogin,
        },
        {
          number: 42,
          title: "Add Forgejo provider",
          url: "https://codeberg.org/pingdotgg/t3code/pulls/42",
          baseRefName: "main",
          headRefName: "feature/forgejo",
          state: "open",
          isCrossRepository: true,
          headRepositoryNameWithOwner: "octocat/t3code",
          headRepositoryOwnerLogin: "octocat",
        },
      );
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "forgejo-cli",
          cwd: "/repo",
          args: ["pr", "view", "42", "--json"],
        }),
      );
    }),
  );

  it.effect("filters listed pull requests by head branch and requested state", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            encodeUnknownJson([
              {
                number: 41,
                title: "Wrong branch",
                html_url: "https://codeberg.org/pingdotgg/t3code/pulls/41",
                base: { ref: "main" },
                head: { ref: "feature/other" },
                state: "open",
              },
              {
                number: 42,
                title: "Right branch",
                html_url: "https://codeberg.org/pingdotgg/t3code/pulls/42",
                base: { ref: "main" },
                head: { ref: "feature/forgejo" },
                state: "open",
              },
            ]),
          ),
        ),
      );

      const forgejo = yield* ForgejoCli.ForgejoCli;
      const result = yield* forgejo.listPullRequests({
        cwd: "/repo",
        headSelector: "feature/forgejo",
        state: "open",
        limit: 10,
      });

      assert.deepStrictEqual(
        result.map((pullRequest) => pullRequest.number),
        [42],
      );
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ["pr", "list", "--state", "open", "--limit", "10", "--json"],
        }),
      );
    }),
  );

  it.effect("reads repository clone URLs through the Forgejo API", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            encodeUnknownJson({
              full_name: "pingdotgg/t3code",
              html_url: "https://codeberg.org/pingdotgg/t3code",
              clone_url: "https://codeberg.org/pingdotgg/t3code.git",
              ssh_url: "git@codeberg.org:pingdotgg/t3code.git",
              default_branch: "main",
            }),
          ),
        ),
      );

      const forgejo = yield* ForgejoCli.ForgejoCli;
      const result = yield* forgejo.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "pingdotgg/t3code",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "pingdotgg/t3code",
        url: "https://codeberg.org/pingdotgg/t3code",
        sshUrl: "git@codeberg.org:pingdotgg/t3code.git",
      });
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "forgejo-cli",
          args: ["api", "/repos/pingdotgg/t3code"],
        }),
      );
    }),
  );

  it.effect("creates pull requests without placing the body in argv", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));
      const bodyDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "forgejo-pr-body-"));
      const bodyFile = NodePath.join(bodyDir, "body.md");
      NodeFS.writeFileSync(bodyFile, "Generated body", "utf8");

      const forgejo = yield* ForgejoCli.ForgejoCli;
      yield* forgejo.createPullRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "owner:feature/forgejo",
        title: "Provider PR",
        bodyFile,
      });

      const call = mockedRun.mock.calls[0]?.[0];
      expect(call).toEqual(
        expect.objectContaining({
          command: "forgejo-cli",
          cwd: "/repo",
          args: ["api", "POST", "/repos/{owner}/{repo}/pulls", "--input", "-"],
        }),
      );
      expect(call?.args).not.toContain("Generated body");
      assert.deepStrictEqual(decodeUnknownJson(call?.stdin ?? "{}"), {
        base: "main",
        head: "feature/forgejo",
        title: "Provider PR",
        body: "Generated body",
      });
    }),
  );
});
