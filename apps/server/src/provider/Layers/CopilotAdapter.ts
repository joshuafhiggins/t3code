import crypto from "node:crypto";

import {
  CopilotClient,
  type CopilotSession,
  type MessageOptions,
  type PermissionRequestResult,
  type SessionConfig,
  type SessionEvent,
  approveAll,
} from "@github/copilot-sdk";
import {
  type ChatAttachment,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderRuntimeEventBase,
  type ProviderSession,
  type ProviderSessionStartInput,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ProviderTurnStartResult,
} from "@t3tools/contracts";
import { Effect, Layer, PubSub, Stream } from "effect";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { createCopilotClient } from "../copilotClient.ts";
import { CopilotAdapter, type CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";

const PROVIDER = "copilot" as const;

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
};

type UserInputResponse = {
  readonly answer: string;
  readonly wasFreeform: boolean;
};

type SessionState = {
  readonly client: CopilotClient;
  session: CopilotSession;
  startInput: ProviderSessionStartInput;
  providerSession: ProviderSession;
  activeTurnId: TurnId | undefined;
  readonly pendingPermissionCallbacks: Array<Deferred<PermissionRequestResult>>;
  readonly queuedPermissionRequestIds: Array<string>;
  readonly permissionByRequestId: Map<string, Deferred<PermissionRequestResult>>;
  readonly pendingUserInputCallbacks: Array<Deferred<UserInputResponse>>;
  readonly queuedUserInputRequestIds: Array<string>;
  readonly userInputByRequestId: Map<string, Deferred<UserInputResponse>>;
};

export interface CopilotAdapterLiveOptions {}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function toMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback;
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function asTurnId(turnId: string): TurnId {
  return TurnId.makeUnsafe(turnId);
}

function asRuntimeItemId(itemId: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(itemId);
}

function asRuntimeRequestId(requestId: string): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(requestId);
}

function asEventId(value?: string): EventId {
  return EventId.makeUnsafe(value ?? crypto.randomUUID());
}

function toIsoDate(value?: string): string {
  return value && value.trim().length > 0 ? value : new Date().toISOString();
}

function extractResumeSessionId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const rawSessionId = (resumeCursor as { sessionId?: unknown }).sessionId;
  if (typeof rawSessionId !== "string") {
    return undefined;
  }
  const trimmed = rawSessionId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isSessionNotFoundError(cause: unknown): boolean {
  const message = toMessage(cause, "").toLowerCase();
  return message.includes("session not found");
}

function toPermissionResult(decision: ProviderApprovalDecision): PermissionRequestResult {
  switch (decision) {
    case "accept":
    case "acceptForSession":
      return { kind: "approved" };
    case "decline":
    case "cancel":
    default:
      return { kind: "denied-interactively-by-user" };
  }
}

function toRequestType(
  kind: unknown,
):
  | "command_execution_approval"
  | "file_change_approval"
  | "file_read_approval"
  | "dynamic_tool_call"
  | "unknown" {
  switch (kind) {
    case "shell":
      return "command_execution_approval";
    case "write":
      return "file_change_approval";
    case "read":
      return "file_read_approval";
    case "mcp":
    case "custom-tool":
    case "url":
    case "memory":
      return "dynamic_tool_call";
    default:
      return "unknown";
  }
}

function requestDetail(event: Extract<SessionEvent, { type: "permission.requested" }>): string {
  const request = event.data.permissionRequest;
  switch (request.kind) {
    case "shell":
      return request.fullCommandText;
    case "write":
      return request.fileName;
    case "read":
      return request.path;
    case "mcp":
      return `${request.serverName}:${request.toolName}`;
    case "url":
      return request.url;
    case "custom-tool":
      return request.toolName;
    case "memory":
      return request.subject;
    default:
      return "Permission requested";
  }
}

function toUserInputQuestions(
  event: Extract<SessionEvent, { type: "user_input.requested" }>,
): Array<{
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
}> {
  const options =
    event.data.choices && event.data.choices.length > 0
      ? event.data.choices.map((choice: string) => ({
          label: choice,
          description: choice,
        }))
      : [
          {
            label: event.data.allowFreeform === false ? "Answer required" : "Freeform response",
            description:
              event.data.allowFreeform === false
                ? "Select or provide the required answer."
                : "Provide any response text.",
          },
        ];
  return [
    {
      id: "response",
      header: "Agent question",
      question: event.data.question,
      options,
    },
  ];
}

function pairDeferred<T>(
  requestId: string,
  waiting: Array<Deferred<T>>,
  queuedIds: Array<string>,
  byId: Map<string, Deferred<T>>,
): void {
  const deferred = waiting.shift();
  if (deferred) {
    byId.set(requestId, deferred);
    return;
  }
  queuedIds.push(requestId);
}

function consumeDeferred<T>(
  waiting: Array<Deferred<T>>,
  queuedIds: Array<string>,
  byId: Map<string, Deferred<T>>,
): Deferred<T> {
  const deferred = makeDeferred<T>();
  const queuedRequestId = queuedIds.shift();
  if (queuedRequestId) {
    byId.set(queuedRequestId, deferred);
  } else {
    waiting.push(deferred);
  }
  return deferred;
}

function updateSessionTimestamp(state: SessionState): void {
  state.providerSession = {
    ...state.providerSession,
    updatedAt: new Date().toISOString(),
  };
}

function mapHistoryToTurns(
  threadId: ThreadId,
  events: ReadonlyArray<SessionEvent>,
): ProviderThreadSnapshot {
  const turns: Array<{ id: TurnId; items: Array<unknown> }> = [];
  let currentTurn: { id: TurnId; items: Array<unknown> } | null = null;

  for (const event of events) {
    if (event.type === "assistant.turn_start") {
      currentTurn = { id: asTurnId(event.data.turnId), items: [] };
      turns.push(currentTurn);
      continue;
    }
    if (currentTurn) {
      currentTurn.items.push(event);
      if (event.type === "assistant.turn_end" || event.type === "abort") {
        currentTurn = null;
      }
    }
  }

  return { threadId, turns };
}

const makeCopilotAdapter = (_options?: CopilotAdapterLiveOptions) =>
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;
    const sessions = new Map<ThreadId, SessionState>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const publishEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getSessionState = (threadId: ThreadId): SessionState => {
      const state = sessions.get(threadId);
      if (!state) {
        throw new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      return state;
    };

    const makeBase = (state: SessionState, event: SessionEvent): ProviderRuntimeEventBase => ({
      eventId: asEventId(event.id),
      provider: PROVIDER,
      threadId: state.providerSession.threadId,
      createdAt: toIsoDate(event.timestamp),
      ...(state.activeTurnId ? { turnId: state.activeTurnId } : {}),
    });

    const emitFromSessionEvent = (
      state: SessionState,
      event: SessionEvent,
    ): Effect.Effect<void, ProviderAdapterError> =>
      Effect.gen(function* () {
        updateSessionTimestamp(state);

        switch (event.type) {
          case "session.start":
          case "session.resume": {
            yield* publishEvent({
              ...makeBase(state, event),
              type: "session.started",
              payload: {
                message:
                  event.type === "session.resume"
                    ? "Resumed Copilot session"
                    : "Started Copilot session",
                resume: { sessionId: state.providerSession.threadId },
              },
            });
            yield* publishEvent({
              ...makeBase(state, event),
              type: "thread.started",
              payload: {
                providerThreadId: String(state.providerSession.threadId),
              },
            });
            yield* publishEvent({
              ...makeBase(state, event),
              type: "session.state.changed",
              payload: { state: "ready" },
            });
            return;
          }
          case "session.error": {
            const message =
              typeof event.data.message === "string" ? event.data.message : "Copilot session error";
            yield* publishEvent({
              ...makeBase(state, event),
              type: "session.state.changed",
              payload: { state: "error", reason: message },
            });
            yield* publishEvent({
              ...makeBase(state, event),
              type: "runtime.error",
              payload: { class: "provider_error", message },
            });
            return;
          }
          case "session.warning": {
            const message =
              typeof event.data.message === "string"
                ? event.data.message
                : "Copilot session warning";
            yield* publishEvent({
              ...makeBase(state, event),
              type: "runtime.warning",
              payload: { message },
            });
            return;
          }
          case "session.shutdown": {
            yield* publishEvent({
              ...makeBase(state, event),
              type: "session.exited",
              payload: {
                reason:
                  typeof event.data.errorReason === "string" ? event.data.errorReason : undefined,
                recoverable: true,
                exitKind: event.data.shutdownType === "error" ? "error" : "graceful",
              },
            });
            return;
          }
          case "assistant.turn_start": {
            state.activeTurnId = asTurnId(event.data.turnId);
            state.providerSession = {
              ...state.providerSession,
              activeTurnId: state.activeTurnId,
              status: "running",
              updatedAt: new Date().toISOString(),
            };
            yield* publishEvent({
              ...makeBase(state, event),
              turnId: state.activeTurnId,
              type: "turn.started",
              payload: {
                model: state.providerSession.model,
              },
            });
            return;
          }
          case "assistant.reasoning_delta": {
            yield* publishEvent({
              ...makeBase(state, event),
              itemId: asRuntimeItemId(event.data.reasoningId),
              type: "content.delta",
              payload: {
                streamKind: "reasoning_text",
                delta: event.data.deltaContent,
              },
            });
            return;
          }
          case "assistant.message_delta": {
            yield* publishEvent({
              ...makeBase(state, event),
              itemId: asRuntimeItemId(event.data.messageId),
              type: "content.delta",
              payload: {
                streamKind: "assistant_text",
                delta: event.data.deltaContent,
              },
            });
            return;
          }
          case "assistant.message": {
            yield* publishEvent({
              ...makeBase(state, event),
              itemId: asRuntimeItemId(event.data.messageId),
              type: "item.completed",
              payload: {
                itemType: "assistant_message",
                title: "Assistant message",
                detail: event.data.content,
                data: event.data,
              },
            });
            return;
          }
          case "assistant.turn_end": {
            const turnId = asTurnId(event.data.turnId);
            state.activeTurnId = undefined;
            state.providerSession = {
              ...state.providerSession,
              activeTurnId: undefined,
              status: "ready",
              updatedAt: new Date().toISOString(),
            };
            yield* publishEvent({
              ...makeBase(state, event),
              turnId,
              type: "turn.completed",
              payload: { state: "completed" },
            });
            return;
          }
          case "abort": {
            const turnId = state.activeTurnId;
            state.activeTurnId = undefined;
            state.providerSession = {
              ...state.providerSession,
              activeTurnId: undefined,
              status: "ready",
              updatedAt: new Date().toISOString(),
            };
            yield* publishEvent({
              ...makeBase(state, event),
              ...(turnId ? { turnId } : {}),
              type: "turn.aborted",
              payload: { reason: event.data.reason },
            });
            return;
          }
          case "permission.requested": {
            pairDeferred(
              event.data.requestId,
              state.pendingPermissionCallbacks,
              state.queuedPermissionRequestIds,
              state.permissionByRequestId,
            );
            yield* publishEvent({
              ...makeBase(state, event),
              requestId: asRuntimeRequestId(event.data.requestId),
              type: "request.opened",
              payload: {
                requestType: toRequestType(event.data.permissionRequest.kind),
                detail: requestDetail(event),
                args: event.data.permissionRequest,
              },
            });
            return;
          }
          case "permission.completed": {
            yield* publishEvent({
              ...makeBase(state, event),
              requestId: asRuntimeRequestId(event.data.requestId),
              type: "request.resolved",
              payload: {
                requestType: "unknown",
                decision: event.data.result.kind,
                resolution: event.data.result,
              },
            });
            return;
          }
          case "user_input.requested": {
            pairDeferred(
              event.data.requestId,
              state.pendingUserInputCallbacks,
              state.queuedUserInputRequestIds,
              state.userInputByRequestId,
            );
            yield* publishEvent({
              ...makeBase(state, event),
              requestId: asRuntimeRequestId(event.data.requestId),
              type: "user-input.requested",
              payload: { questions: toUserInputQuestions(event) },
            });
            return;
          }
          case "user_input.completed": {
            yield* publishEvent({
              ...makeBase(state, event),
              requestId: asRuntimeRequestId(event.data.requestId),
              type: "user-input.resolved",
              payload: { answers: {} },
            });
            return;
          }
          default:
            return;
        }
      }).pipe(
        Effect.matchEffect({
          onFailure: (cause: unknown) =>
            Effect.fail(
              toRequestError(state.providerSession.threadId, `event:${event.type}`, cause),
            ),
          onSuccess: () => Effect.void,
        }),
      );

    const buildAttachments = (
      attachments: ReadonlyArray<ChatAttachment> | undefined,
    ): MessageOptions["attachments"] => {
      if (!attachments || attachments.length === 0) {
        return undefined;
      }

      const mapped = attachments.flatMap((attachment) => {
        const resolvedPath = resolveAttachmentPath({ stateDir, attachment });
        if (!resolvedPath) {
          return [];
        }
        return [
          {
            type: "file" as const,
            path: resolvedPath,
            displayName: attachment.name,
          },
        ];
      });

      return mapped.length > 0 ? mapped : undefined;
    };

    const makeSessionConfigBase = (threadId: ThreadId, input: ProviderSessionStartInput) => {
      const copilotOptions = input.providerOptions?.copilot;
      const runtimeMode = input.runtimeMode;

      return {
        clientName: "t3code",
        ...(input.model ? { model: input.model } : {}),
        ...(input.modelOptions?.copilot?.reasoningEffort
          ? { reasoningEffort: input.modelOptions.copilot.reasoningEffort }
          : {}),
        ...(input.cwd ? { workingDirectory: input.cwd } : {}),
        ...(copilotOptions?.configDir ? { configDir: copilotOptions.configDir } : {}),
        onPermissionRequest:
          runtimeMode === "full-access"
            ? approveAll
            : () =>
                consumeDeferred(
                  getSessionState(threadId).pendingPermissionCallbacks,
                  getSessionState(threadId).queuedPermissionRequestIds,
                  getSessionState(threadId).permissionByRequestId,
                ).promise,
        onUserInputRequest: () =>
          consumeDeferred(
            getSessionState(threadId).pendingUserInputCallbacks,
            getSessionState(threadId).queuedUserInputRequestIds,
            getSessionState(threadId).userInputByRequestId,
          ).promise,
        streaming: true,
      };
    };

    const makeSessionConfig = (
      threadId: ThreadId,
      input: ProviderSessionStartInput,
    ): SessionConfig => ({
      sessionId: String(threadId),
      ...makeSessionConfigBase(threadId, input),
    });

    const makeResumeSessionConfig = (threadId: ThreadId, input: ProviderSessionStartInput) =>
      makeSessionConfigBase(threadId, input);

    const makeClient = (input: ProviderSessionStartInput): CopilotClient => {
      const copilotOptions = input.providerOptions?.copilot;
      return createCopilotClient({
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(copilotOptions?.cliPath ? { cliPath: copilotOptions.cliPath } : {}),
        ...(copilotOptions?.githubToken ? { githubToken: copilotOptions.githubToken } : {}),
      });
    };

    const attachSessionHandlers = (state: SessionState): void => {
      state.session.on((event: SessionEvent) => {
        void Effect.runPromise(publishEventFromSessionEvent(state, event));
      });
    };

    const resumeMissingSession = async (
      state: SessionState,
      overrides?: Partial<Pick<ProviderSessionStartInput, "cwd" | "model" | "modelOptions">>,
    ): Promise<void> => {
      const resumeSessionId =
        extractResumeSessionId(state.providerSession.resumeCursor) ?? state.session.sessionId;
      const nextStartInput: ProviderSessionStartInput = {
        ...state.startInput,
        ...(overrides?.cwd !== undefined ? { cwd: overrides.cwd } : {}),
        ...(overrides?.model !== undefined ? { model: overrides.model } : {}),
        ...(overrides?.modelOptions !== undefined ? { modelOptions: overrides.modelOptions } : {}),
      };

      await state.session.disconnect().catch(() => undefined);
      state.session = await state.client.resumeSession(
        resumeSessionId,
        makeResumeSessionConfig(state.providerSession.threadId, nextStartInput),
      );
      state.startInput = nextStartInput;
      state.providerSession = {
        ...state.providerSession,
        ...(nextStartInput.cwd ? { cwd: nextStartInput.cwd } : {}),
        ...(nextStartInput.model ? { model: nextStartInput.model } : {}),
        resumeCursor: { sessionId: state.session.sessionId },
        updatedAt: new Date().toISOString(),
      };
      attachSessionHandlers(state);
    };

    const publishEventFromSessionEvent = (state: SessionState, event: SessionEvent) =>
      emitFromSessionEvent(state, event).pipe(
        Effect.matchEffect({
          onFailure: (cause: unknown) =>
            publishEvent({
              eventId: asEventId(),
              provider: PROVIDER,
              threadId: state.providerSession.threadId,
              createdAt: new Date().toISOString(),
              type: "runtime.error",
              payload: {
                class: "provider_error",
                message: toMessage(cause, `Failed to process Copilot event ${event.type}`),
              },
            }),
          onSuccess: () => Effect.void,
        }),
      );

    const startSession: CopilotAdapterShape["startSession"] = (input) =>
      Effect.tryPromise({
        try: async () => {
          const existing = sessions.get(input.threadId);
          if (existing) {
            return existing.providerSession;
          }

          const client = makeClient(input);
          const sessionConfig = makeSessionConfig(input.threadId, input);
          const resumeSessionId = extractResumeSessionId(input.resumeCursor);
          const session = input.resumeCursor
            ? await client.resumeSession(
                resumeSessionId ?? String(input.threadId),
                makeResumeSessionConfig(input.threadId, input),
              )
            : await client.createSession(sessionConfig);

          const now = new Date().toISOString();
          const providerSession: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.model ? { model: input.model } : {}),
            threadId: input.threadId,
            resumeCursor: { sessionId: session.sessionId },
            createdAt: now,
            updatedAt: now,
          };

          const state: SessionState = {
            client,
            session,
            startInput: input,
            providerSession,
            activeTurnId: undefined,
            pendingPermissionCallbacks: [],
            queuedPermissionRequestIds: [],
            permissionByRequestId: new Map(),
            pendingUserInputCallbacks: [],
            queuedUserInputRequestIds: [],
            userInputByRequestId: new Map(),
          };

          sessions.set(input.threadId, state);
          attachSessionHandlers(state);

          return providerSession;
        },
        catch: (cause) => toRequestError(input.threadId, "startSession", cause),
      });

    const sendTurn: CopilotAdapterShape["sendTurn"] = (input) =>
      Effect.tryPromise({
        try: async () => {
          const state = getSessionState(input.threadId);

          const attemptSend = async (): Promise<TurnId> => {
            if (input.model && input.model !== state.providerSession.model) {
              await state.session.setModel(input.model);
              state.providerSession = {
                ...state.providerSession,
                model: input.model,
                updatedAt: new Date().toISOString(),
              };
              state.startInput = {
                ...state.startInput,
                model: input.model,
                ...(input.modelOptions !== undefined ? { modelOptions: input.modelOptions } : {}),
              };
            }

            const turnStarted = makeDeferred<TurnId>();
            const unsubscribe = state.session.on("assistant.turn_start", (event: SessionEvent) => {
              if (event.type !== "assistant.turn_start") {
                return;
              }
              if (state.activeTurnId) {
                turnStarted.resolve(state.activeTurnId);
                unsubscribe();
                return;
              }
              const turnId = asTurnId(event.data.turnId);
              state.activeTurnId = turnId;
              turnStarted.resolve(turnId);
              unsubscribe();
            });

            try {
              const attachments = buildAttachments(input.attachments);
              const messageOptions: MessageOptions = {
                prompt: input.input ?? "",
                attachments: attachments ?? [],
              };

              await state.session.send(messageOptions);
              return await Promise.race([
                turnStarted.promise,
                new Promise<TurnId>((_, reject) => {
                  setTimeout(
                    () => reject(new Error("Timed out waiting for Copilot turn start")),
                    10_000,
                  );
                }),
              ]);
            } catch (cause) {
              unsubscribe();
              throw cause;
            }
          };

          let turnId: TurnId;
          try {
            turnId = await attemptSend();
          } catch (cause) {
            if (!isSessionNotFoundError(cause)) {
              throw cause;
            }
            await resumeMissingSession(state, {
              model: input.model ?? state.providerSession.model,
              modelOptions: input.modelOptions,
            });
            turnId = await attemptSend();
          }

          state.providerSession = {
            ...state.providerSession,
            activeTurnId: turnId,
            status: "running",
            updatedAt: new Date().toISOString(),
          };

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: state.providerSession.resumeCursor,
          } satisfies ProviderTurnStartResult;
        },
        catch: (cause) => toRequestError(input.threadId, "sendTurn", cause),
      });

    const interruptTurn: CopilotAdapterShape["interruptTurn"] = (threadId) =>
      Effect.tryPromise({
        try: async () => {
          const state = getSessionState(threadId);
          await state.session.abort();
        },
        catch: (cause) => toRequestError(threadId, "interruptTurn", cause),
      });

    const respondToRequest: CopilotAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.sync(() => {
        const state = getSessionState(threadId);
        const deferred = state.permissionByRequestId.get(String(requestId));
        if (!deferred) {
          throw toRequestError(
            threadId,
            "respondToRequest",
            new Error("Unknown pending permission request"),
          );
        }
        state.permissionByRequestId.delete(String(requestId));
        deferred.resolve(toPermissionResult(decision));
      }).pipe(Effect.mapError((cause) => toRequestError(threadId, "respondToRequest", cause)));

    const respondToUserInput: CopilotAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.sync(() => {
        const state = getSessionState(threadId);
        const deferred = state.userInputByRequestId.get(String(requestId));
        if (!deferred) {
          throw toRequestError(
            threadId,
            "respondToUserInput",
            new Error("Unknown pending user input request"),
          );
        }
        state.userInputByRequestId.delete(String(requestId));
        const responseValue = Object.values(answers).find((value) => typeof value === "string");
        const answer = typeof responseValue === "string" ? responseValue : "";
        deferred.resolve({ answer, wasFreeform: true });
      }).pipe(Effect.mapError((cause) => toRequestError(threadId, "respondToUserInput", cause)));

    const stopSession: CopilotAdapterShape["stopSession"] = (threadId) =>
      Effect.tryPromise({
        try: async () => {
          const state = getSessionState(threadId);
          sessions.delete(threadId);
          await state.session.disconnect();
          await state.client.stop();
        },
        catch: (cause) => toRequestError(threadId, "stopSession", cause),
      });

    const listSessions: CopilotAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (entry) => entry.providerSession));

    const hasSession: CopilotAdapterShape["hasSession"] = (threadId) =>
      Effect.succeed(sessions.has(threadId));

    const readThread: CopilotAdapterShape["readThread"] = (threadId) =>
      Effect.tryPromise({
        try: async () => {
          const state = getSessionState(threadId);
          const history = await state.session.getMessages();
          return mapHistoryToTurns(threadId, history);
        },
        catch: (cause) => toRequestError(threadId, "readThread", cause),
      });

    const rollbackThread: CopilotAdapterShape["rollbackThread"] = (_threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: "Copilot SDK rollback is not implemented.",
        }),
      );

    const stopAll: CopilotAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.keys()), (threadId) => stopSession(threadId), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.asVoid);

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies CopilotAdapterShape;
  });

export const CopilotAdapterLive = Layer.effect(CopilotAdapter, makeCopilotAdapter());

export function makeCopilotAdapterLive(options?: CopilotAdapterLiveOptions) {
  return Layer.effect(CopilotAdapter, makeCopilotAdapter(options));
}
