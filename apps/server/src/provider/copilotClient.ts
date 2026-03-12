import type { CopilotClient, CopilotClientOptions } from "@github/copilot-sdk";

type CopilotSdkModule = typeof import("@github/copilot-sdk");

let copilotSdkModulePromise: Promise<CopilotSdkModule> | undefined;

export interface CopilotClientInput {
	readonly cwd?: string;
	readonly cliPath?: string;
	readonly githubToken?: string;
}

function toMessage(error: unknown): string {
	return error instanceof Error && error.message.trim().length > 0
		? error.message
		: String(error);
}

export async function loadCopilotSdk(): Promise<CopilotSdkModule> {
	copilotSdkModulePromise ??= import("@github/copilot-sdk").catch((error) => {
		copilotSdkModulePromise = undefined;
		throw new Error(`Failed to load GitHub Copilot SDK: ${toMessage(error)}`, {
			cause: error,
		});
	});

	return copilotSdkModulePromise;
}

export function createCopilotClientOptions(
	input: CopilotClientInput = {},
): CopilotClientOptions {
	return {
		...(input.cwd ? { cwd: input.cwd } : {}),
		...(input.cliPath ? { cliPath: input.cliPath } : {}),
		...(input.githubToken
			? { githubToken: input.githubToken, useLoggedInUser: false }
			: {}),
	};
}

export async function createCopilotClient(
	input: CopilotClientInput = {},
): Promise<CopilotClient> {
	const { CopilotClient } = await loadCopilotSdk();
	return new CopilotClient(createCopilotClientOptions(input));
}
