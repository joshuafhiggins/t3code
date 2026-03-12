import { CopilotClient, type CopilotClientOptions } from "@github/copilot-sdk";

export interface CopilotClientInput {
  readonly cwd?: string;
  readonly cliPath?: string;
  readonly githubToken?: string;
}

export function createCopilotClientOptions(input: CopilotClientInput = {}): CopilotClientOptions {
  return {
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.cliPath ? { cliPath: input.cliPath } : {}),
    ...(input.githubToken ? { githubToken: input.githubToken, useLoggedInUser: false } : {}),
  };
}

export function createCopilotClient(input: CopilotClientInput = {}): CopilotClient {
  return new CopilotClient(createCopilotClientOptions(input));
}
