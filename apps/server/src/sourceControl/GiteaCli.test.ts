import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, afterEach, describe, expect, vi } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcessExitError } from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GiteaCli from "./GiteaCli.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const mockRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();

const supportLayer = Layer.mergeAll(
  Layer.mock(VcsProcess.VcsProcess)({
    run: mockRun,
  }),
  NodeServices.layer,
);
const layer = Layer.mergeAll(GiteaCli.layer.pipe(Layer.provide(supportLayer)), supportLayer);

afterEach(() => {
  mockRun.mockReset();
});

describe("GiteaCli.layer", () => {
  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              number: 42,
              title: "Add Gitea provider",
              html_url: "https://gitea.example.test/owner/repo/pulls/42",
              state: "open",
              updated_at: "2026-01-02T00:00:00.000Z",
              base: { ref: "main", repo: { full_name: "owner/repo" } },
              head: { ref: "feature/gitea", repo: { full_name: "fork/repo" } },
            }),
          ),
        ),
      );

      const gitea = yield* GiteaCli.GiteaCli;
      const result = yield* gitea.getPullRequest({
        cwd: "/repo",
        reference: "42",
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add Gitea provider",
        url: "https://gitea.example.test/owner/repo/pulls/42",
        baseRefName: "main",
        headRefName: "feature/gitea",
        state: "open",
        updatedAt: Option.some(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z")),
        isCrossRepository: true,
        headRepositoryNameWithOwner: "fork/repo",
        headRepositoryOwnerLogin: "fork",
      });
      expect(mockRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "tea",
          cwd: "/repo",
          args: ["api", "/repos/{owner}/{repo}/pulls/42"],
        }),
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("filters pull request lists by source branch after decoding", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 40,
                title: "Other branch",
                html_url: "https://gitea.example.test/owner/repo/pulls/40",
                base: { ref: "main" },
                head: { ref: "feature/other" },
              },
              {
                number: 41,
                title: "Matching branch",
                html_url: "https://gitea.example.test/owner/repo/pulls/41",
                base: { ref: "main" },
                head: { ref: "feature/gitea" },
                merged: true,
              },
            ]),
          ),
        ),
      );

      const gitea = yield* GiteaCli.GiteaCli;
      const result = yield* gitea.listPullRequests({
        cwd: "/repo",
        headSelector: "owner:feature/gitea",
        state: "merged",
        limit: 10,
      });

      assert.deepStrictEqual(
        result.map((item) => item.number),
        [41],
      );
      expect(mockRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "tea",
          cwd: "/repo",
          args: ["api", "/repos/{owner}/{repo}/pulls?state=closed&limit=50"],
        }),
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates pull requests through tea api without placing the body in argv", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));
      const fileSystem = yield* FileSystem.FileSystem;
      const bodyFile = yield* fileSystem.makeTempFileScoped({ prefix: "gitea-pr-body-" });
      yield* fileSystem.writeFileString(bodyFile, "Generated body");

      const gitea = yield* GiteaCli.GiteaCli;
      yield* gitea.createPullRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "owner:feature/gitea",
        title: "Provider PR",
        bodyFile,
      });

      expect(mockRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "tea",
          cwd: "/repo",
          args: ["api", "--method", "POST", "/repos/{owner}/{repo}/pulls", "--data", "@-"],
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          stdin: JSON.stringify({
            base: "main",
            head: "feature/gitea",
            title: "Provider PR",
            body: "Generated body",
          }),
        }),
      );
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("creates repositories under an explicit owner", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              full_name: "owner/repo",
              html_url: "https://gitea.example.test/owner/repo",
              clone_url: "https://gitea.example.test/owner/repo.git",
              ssh_url: "git@gitea.example.test:owner/repo.git",
            }),
          ),
        ),
      );

      const gitea = yield* GiteaCli.GiteaCli;
      const result = yield* gitea.createRepository({
        cwd: "/repo",
        repository: "owner/repo",
        visibility: "private",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "owner/repo",
        url: "https://gitea.example.test/owner/repo.git",
        sshUrl: "git@gitea.example.test:owner/repo.git",
      });
      expect(mockRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "tea",
          cwd: "/repo",
          args: [
            "repos",
            "create",
            "--name",
            "repo",
            "--owner",
            "owner",
            "--private",
            "--output",
            "json",
          ],
        }),
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("surfaces a friendly error when the pull request is not found", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GiteaCli.execute",
        command: "tea",
        cwd: "/repo",
        exitCode: 1,
        detail: "404 pull request not found",
        failureKind: "not-found",
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const gitea = yield* GiteaCli.GiteaCli;
      const error = yield* gitea
        .getPullRequest({
          cwd: "/repo",
          reference: "4888",
        })
        .pipe(Effect.flip);

      assert.equal(error.message.includes("Pull request 4888 was not found"), true);
      assert.strictEqual(error._tag, "GiteaPullRequestNotFoundError");
      assert.strictEqual(error.command, "tea");
      assert.strictEqual(error.cwd, "/repo");
      assert.strictEqual(error.cause, cause);
    }).pipe(Effect.provide(layer)),
  );
});
