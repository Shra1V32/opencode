import { Effect, Schema } from "effect"
import { Route } from "../route/client"
import { Auth } from "../route/auth"
import { Endpoint } from "../route/endpoint"
import { Framing } from "../route/framing"
import { Protocol } from "../route/protocol"
import {
  LLMEvent,
  Usage,
  type FinishReason,
  type JsonSchema,
  type LLMRequest,
  type MediaPart,
  type ProviderMetadata,
  type TextPart,
  type ToolCallPart,
  type ToolDefinition,
  type ToolContent,
} from "../schema"
import { JsonObject, optionalArray, ProviderShared } from "./shared"
import { GeminiToolSchema } from "./utils/gemini-tool-schema"
import { Lifecycle } from "./utils/lifecycle"
import { ToolSchemaProjection } from "./utils/tool-schema"

const ADAPTER = "gemini"
const MEDIA_MIMES = new Set<string>(ProviderShared.MEDIA_MIMES)
export const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

// =============================================================================
// Request Body Schema (Interactions API)
// =============================================================================
const GeminiTextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
})

const GeminiMediaContent = Schema.Struct({
  type: Schema.Literals(["image", "audio", "video", "document"]),
  mime_type: Schema.String,
  data: Schema.String,
})

const GeminiContentItem = Schema.Union([GeminiTextContent, GeminiMediaContent])

const GeminiUserInputStep = Schema.Struct({
  type: Schema.Literal("user_input"),
  content: Schema.Array(GeminiContentItem),
})

const GeminiModelOutputStep = Schema.Struct({
  type: Schema.Literal("model_output"),
  content: Schema.Array(GeminiTextContent),
})

const GeminiThoughtStep = Schema.Struct({
  type: Schema.Literal("thought"),
  summary: Schema.optional(Schema.Array(GeminiTextContent)),
  signature: Schema.optional(Schema.String),
})

const GeminiFunctionCallStep = Schema.Struct({
  type: Schema.Literal("function_call"),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.Unknown,
})

const GeminiFunctionResultStep = Schema.Struct({
  type: Schema.Literal("function_result"),
  call_id: Schema.String,
  name: Schema.String,
  result: Schema.Unknown,
})

const GeminiStep = Schema.Union([
  GeminiUserInputStep,
  GeminiModelOutputStep,
  GeminiThoughtStep,
  GeminiFunctionCallStep,
  GeminiFunctionResultStep,
])

const GeminiFunctionTool = Schema.Struct({
  type: Schema.Literal("function"),
  name: Schema.String,
  description: Schema.String,
  parameters: Schema.optional(JsonObject),
})

const GeminiGenerationConfig = Schema.Struct({
  max_output_tokens: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
  top_k: Schema.optional(Schema.Number),
  stop_sequences: optionalArray(Schema.String),
})

const GeminiBodyFields = {
  model: Schema.String,
  input: Schema.Array(GeminiStep),
  system_instruction: Schema.optional(Schema.String),
  tools: optionalArray(GeminiFunctionTool),
  generation_config: Schema.optional(GeminiGenerationConfig),
  stream: Schema.optional(Schema.Boolean),
}
const GeminiBody = Schema.Struct(GeminiBodyFields)
export type GeminiBody = Schema.Schema.Type<typeof GeminiBody>

// =============================================================================
// Stream Event Schema (Interactions API)
// =============================================================================
const GeminiUsageMetadata = Schema.Struct({
  total_input_tokens: Schema.optional(Schema.Number),
  total_output_tokens: Schema.optional(Schema.Number),
  total_cached_tokens: Schema.optional(Schema.Number),
  total_thought_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number),
})

const GeminiInteractionCreatedEvent = Schema.Struct({
  event_type: Schema.Literal("interaction.created"),
  interaction: Schema.Struct({
    id: Schema.optional(Schema.String),
    status: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
  }),
})

const GeminiInteractionStatusUpdateEvent = Schema.Struct({
  event_type: Schema.Literal("interaction.status_update"),
  interaction_id: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
})

const GeminiStepStartStep = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  name: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.Unknown),
})

const GeminiStepStartEvent = Schema.Struct({
  event_type: Schema.Literal("step.start"),
  index: Schema.Number,
  step: GeminiStepStartStep,
})

const GeminiThoughtDelta = Schema.Struct({
  type: Schema.Literal("thought_summary"),
  content: Schema.optional(
    Schema.Struct({
      text: Schema.optional(Schema.String),
      type: Schema.optional(Schema.String),
    }),
  ),
  text: Schema.optional(Schema.String),
})

const GeminiThoughtSignatureDelta = Schema.Struct({
  type: Schema.Literal("thought_signature"),
  signature: Schema.String,
})

const GeminiTextDelta = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
})

const GeminiArgumentsDelta = Schema.Struct({
  type: Schema.Literal("arguments_delta"),
  arguments: Schema.String,
})

const GeminiStepDeltaEvent = Schema.Struct({
  event_type: Schema.Literal("step.delta"),
  index: Schema.Number,
  delta: Schema.Union([
    GeminiThoughtDelta,
    GeminiThoughtSignatureDelta,
    GeminiTextDelta,
    GeminiArgumentsDelta,
    JsonObject,
  ]),
})

const GeminiStepStopEvent = Schema.Struct({
  event_type: Schema.Literal("step.stop"),
  index: Schema.Number,
})

const GeminiInteractionCompletedEvent = Schema.Struct({
  event_type: Schema.Literal("interaction.completed"),
  interaction: Schema.Struct({
    id: Schema.optional(Schema.String),
    status: Schema.optional(Schema.String),
    usage: Schema.optional(GeminiUsageMetadata),
  }),
})

const GeminiErrorEvent = Schema.Struct({
  event_type: Schema.Literal("error"),
  error: Schema.Struct({
    message: Schema.String,
    code: Schema.optional(Schema.String),
  }),
})

const GeminiUnknownEvent = Schema.Struct({
  event_type: Schema.optional(Schema.String),
})

const GeminiEvent = Schema.Union([
  GeminiInteractionCreatedEvent,
  GeminiInteractionStatusUpdateEvent,
  GeminiStepStartEvent,
  GeminiStepDeltaEvent,
  GeminiStepStopEvent,
  GeminiInteractionCompletedEvent,
  GeminiErrorEvent,
  GeminiUnknownEvent,
])
type GeminiEvent = Schema.Schema.Type<typeof GeminiEvent>

interface ParserState {
  readonly status?: string
  readonly finishReason?: FinishReason
  readonly hasToolCalls: boolean
  readonly nextToolCallId: number
  readonly usage?: Usage
  readonly lifecycle: Lifecycle.State
  readonly reasoningSignature?: string
  readonly currentStepType?: string
  readonly activeToolCall?: {
    readonly id: string
    readonly name: string
    readonly arguments: string
  }
}

// =============================================================================
// Request Lowering
// =============================================================================
const lowerTool = (tool: ToolDefinition, inputSchema: JsonSchema) => ({
  type: "function" as const,
  name: tool.name,
  description: tool.description,
  parameters: GeminiToolSchema.convert(inputSchema),
})

const lowerUserContent = Effect.fn("Gemini.lowerUserContent")(function* (part: TextPart | MediaPart) {
  if (part.type === "text") return { type: "text" as const, text: part.text }
  const media = yield* ProviderShared.validateMedia("Gemini", part, MEDIA_MIMES)
  const type = media.mime.startsWith("image/")
    ? ("image" as const)
    : media.mime.startsWith("audio/")
      ? ("audio" as const)
      : media.mime.startsWith("video/")
        ? ("video" as const)
        : ("document" as const)
  return { type, mime_type: media.mime, data: media.base64 }
})

const googleMetadata = (metadata: Record<string, unknown>): ProviderMetadata => ({ google: metadata })

const thoughtSignature = (providerMetadata: ProviderMetadata | undefined) => {
  const google = providerMetadata?.google
  return ProviderShared.isRecord(google) && typeof google.thoughtSignature === "string"
    ? google.thoughtSignature
    : undefined
}

const lowerMessages = Effect.fn("Gemini.lowerMessages")(function* (request: LLMRequest) {
  const steps: Array<Schema.Schema.Type<typeof GeminiStep>> = []

  for (const message of request.messages) {
    if (message.role === "system") {
      const part = yield* ProviderShared.wrappedSystemUpdate("Gemini", message)
      const previous = steps.at(-1)
      if (previous?.type === "user_input") {
        steps[steps.length - 1] = {
          type: "user_input",
          content: [...previous.content, { type: "text", text: part.text }],
        }
      } else {
        steps.push({ type: "user_input", content: [{ type: "text", text: part.text }] })
      }
      continue
    }

    if (message.role === "user") {
      const content: Array<Schema.Schema.Type<typeof GeminiContentItem>> = []
      for (const part of message.content) {
        if (!ProviderShared.supportsContent(part, ["text", "media"]))
          return yield* ProviderShared.unsupportedContent("Gemini", "user", ["text", "media"])
        content.push(yield* lowerUserContent(part))
      }
      steps.push({ type: "user_input", content })
      continue
    }

    if (message.role === "assistant") {
      for (const part of message.content) {
        if (!ProviderShared.supportsContent(part, ["text", "reasoning", "tool-call"]))
          return yield* ProviderShared.unsupportedContent("Gemini", "assistant", ["text", "reasoning", "tool-call"])
        if (part.type === "text") {
          steps.push({ type: "model_output", content: [{ type: "text", text: part.text }] })
          continue
        }
        if (part.type === "reasoning") {
          const sig = thoughtSignature(part.providerMetadata)
          steps.push({
            type: "thought",
            ...(part.text ? { summary: [{ type: "text", text: part.text }] } : {}),
            ...(sig ? { signature: sig } : {}),
          })
          continue
        }
        if (part.type === "tool-call") {
          let args = part.input
          if (typeof args === "string") {
            try {
              args = JSON.parse(args)
            } catch {
              args = {}
            }
          }
          steps.push({
            type: "function_call",
            id: part.id,
            name: part.name,
            arguments: args ?? {},
          })
          continue
        }
      }
      continue
    }

    function formatToolResult(resText: string) {
      if (resText.startsWith("{") && resText.endsWith("}")) {
        try {
          return JSON.parse(resText)
        } catch {
          // fallback
        }
      }
      return { output: resText }
    }

    for (const part of message.content) {
      if (!ProviderShared.supportsContent(part, ["tool-result"]))
        return yield* ProviderShared.unsupportedContent("Gemini", "tool", ["tool-result"])
      const resText =
        part.result.type !== "content"
          ? ProviderShared.toolResultText(part)
          : (part.result.value as ReadonlyArray<ToolContent>)
              .filter((item): item is Extract<ToolContent, { type: "text" }> => item.type === "text")
              .map((item) => item.text)
              .join("\n")
      steps.push({
        type: "function_result",
        call_id: part.id,
        name: part.name,
        result: formatToolResult(resText),
      })
      if (part.result.type === "content") {
        const content = part.result.value
        const userMediaContent: Array<Schema.Schema.Type<typeof GeminiContentItem>> = []
        for (const item of content) {
          if (item.type === "text") continue
          const media = yield* ProviderShared.validateToolFile("Gemini", item, MEDIA_MIMES)
          const type = media.mime.startsWith("image/")
            ? ("image" as const)
            : media.mime.startsWith("audio/")
              ? ("audio" as const)
              : media.mime.startsWith("video/")
                ? ("video" as const)
                : ("document" as const)
          userMediaContent.push({ type, mime_type: media.mime, data: media.base64 })
        }
        if (userMediaContent.length > 0) {
          steps.push({ type: "user_input", content: userMediaContent })
        }
      }
    }
  }

  return steps
})

const fromRequest = Effect.fn("Gemini.fromRequest")(function* (request: LLMRequest) {
  const toolsEnabled = request.tools.length > 0 && request.toolChoice?.type !== "none"
  const generation = request.generation
  const toolSchemaCompatibility = request.model.compatibility?.toolSchema
  const generationConfig = {
    max_output_tokens: generation?.maxTokens,
    temperature: generation?.temperature,
    top_p: generation?.topP,
    top_k: generation?.topK,
    stop_sequences: generation?.stop,
  }

  return {
    model: request.model.id,
    input: yield* lowerMessages(request),
    system_instruction:
      request.system.length === 0 ? undefined : ProviderShared.joinText(request.system),
    tools: toolsEnabled
      ? request.tools.map((tool) =>
          lowerTool(tool, ToolSchemaProjection.modelCompatibility(tool.inputSchema, toolSchemaCompatibility)),
        )
      : undefined,
    generation_config: Object.values(generationConfig).some((value) => value !== undefined)
      ? generationConfig
      : undefined,
    stream: true,
  }
})

// =============================================================================
// Stream Parsing
// =============================================================================
const mapUsage = (usage: Schema.Schema.Type<typeof GeminiUsageMetadata> | undefined) => {
  if (!usage) return undefined
  const totalInput = usage.total_input_tokens
  const totalOutput = usage.total_output_tokens
  const cached = usage.total_cached_tokens
  const reasoning = usage.total_thought_tokens
  const total = usage.total_tokens

  const nonCached = ProviderShared.subtractTokens(totalInput, cached)

  return new Usage({
    inputTokens: totalInput,
    outputTokens: totalOutput,
    nonCachedInputTokens: nonCached,
    cacheReadInputTokens: cached,
    reasoningTokens: reasoning,
    totalTokens: ProviderShared.totalTokens(totalInput, totalOutput, total),
    providerMetadata: { google: usage },
  })
}

const finish = (state: ParserState): ReadonlyArray<LLMEvent> =>
  state.finishReason || state.usage
    ? (() => {
        const events: LLMEvent[] = []
        const lifecycle = state.reasoningSignature
          ? Lifecycle.reasoningEnd(
              state.lifecycle,
              events,
              "reasoning-0",
              googleMetadata({ thoughtSignature: state.reasoningSignature }),
            )
          : state.lifecycle
        Lifecycle.finish(lifecycle, events, {
          reason: state.finishReason ?? (state.hasToolCalls ? "tool-calls" : "stop"),
          usage: state.usage,
        })
        return events
      })()
    : []
const step = (state: ParserState, event: GeminiEvent) => {
  const events: LLMEvent[] = []
  let nextState = state

  if ("event_type" in event && event.event_type) {
    if (event.event_type === "error" && "error" in event && event.error) {
      return ProviderShared.eventError(`google/${ADAPTER}`, event.error.message)
    }

    if (event.event_type === "interaction.completed" && "interaction" in event && event.interaction) {
      const usage = mapUsage(event.interaction.usage) ?? state.usage
      const status = event.interaction.status
      let finishReason: FinishReason = "stop"
      if (status === "completed") {
        finishReason = state.hasToolCalls ? "tool-calls" : "stop"
      } else if (status === "requires_action") {
        finishReason = "tool-calls"
      } else if (status === "incomplete") {
        finishReason = "length"
      } else if (status === "failed" || status === "cancelled") {
        finishReason = "error"
      }
      nextState = { ...nextState, usage, status, finishReason }
    }

    if (event.event_type === "step.start" && "step" in event && event.step) {
      const stepObj = event.step as Record<string, any>
      const stepType = stepObj.type
      let lifecycle = nextState.lifecycle
      let reasoningSignature = nextState.reasoningSignature

      if (stepObj.signature && typeof stepObj.signature === "string") {
        reasoningSignature = stepObj.signature
      }

      if (stepType === "thought") {
        lifecycle = Lifecycle.reasoningStart(
          lifecycle,
          events,
          "reasoning-0",
          reasoningSignature ? googleMetadata({ thoughtSignature: reasoningSignature }) : undefined,
        )
      }

      nextState = { ...nextState, currentStepType: stepType, lifecycle, reasoningSignature }
      if (stepType === "function_call") {
        const nextToolCallId = nextState.nextToolCallId
        const id = stepObj.id ?? stepObj.call_id ?? `tool_${nextToolCallId}`
        const name = stepObj.name ?? stepObj.function_call?.name ?? ""
        const rawArgs =
          stepObj.arguments ?? stepObj.args ?? stepObj.function_call?.arguments ?? stepObj.function_call?.args
        const initialArgs =
          typeof rawArgs === "string"
            ? rawArgs
            : rawArgs && typeof rawArgs === "object" && Object.keys(rawArgs).length > 0
              ? JSON.stringify(rawArgs)
              : ""
        nextState = {
          ...nextState,
          nextToolCallId: nextToolCallId + 1,
          activeToolCall: {
            id,
            name,
            arguments: initialArgs,
          },
        }
      }
    }

    if (event.event_type === "step.delta" && "delta" in event && event.delta) {
      const delta = event.delta as Record<string, any>
      let lifecycle = nextState.lifecycle
      let reasoningSignature = nextState.reasoningSignature

      if (delta.type === "thought_signature" && typeof delta.signature === "string") {
        reasoningSignature = delta.signature
        nextState = { ...nextState, reasoningSignature }
      }

      if (delta.type === "thought_summary") {
        const text = delta.content?.text ?? delta.text ?? ""
        if (text) {
          lifecycle = Lifecycle.reasoningDelta(
            lifecycle,
            events,
            "reasoning-0",
            text,
            reasoningSignature ? googleMetadata({ thoughtSignature: reasoningSignature }) : undefined,
          )
          nextState = { ...nextState, lifecycle }
        }
      }

      if (delta.type === "text") {
        const text = delta.text ?? delta.content?.text ?? ""
        if (text) {
          lifecycle = Lifecycle.reasoningEnd(
            lifecycle,
            events,
            "reasoning-0",
            reasoningSignature ? googleMetadata({ thoughtSignature: reasoningSignature }) : undefined,
          )
          lifecycle = Lifecycle.textDelta(lifecycle, events, "text-0", text)
          nextState = { ...nextState, lifecycle }
        }
      }

      if (nextState.activeToolCall) {
        const active = nextState.activeToolCall
        const deltaName = delta.name ?? delta.function_call?.name
        const name = deltaName && typeof deltaName === "string" ? deltaName : active.name
        const deltaArgs =
          delta.arguments ??
          delta.args ??
          delta.arguments_delta ??
          delta.function_call?.arguments ??
          delta.function_call?.args
        let args = active.arguments
        if (typeof deltaArgs === "string") {
          if (args.startsWith("{") && args.endsWith("}") && deltaArgs.startsWith("{")) {
            args = deltaArgs
          } else {
            args += deltaArgs
          }
        } else if (deltaArgs && typeof deltaArgs === "object") {
          args = JSON.stringify(deltaArgs)
        }
        nextState = {
          ...nextState,
          activeToolCall: {
            id: active.id,
            name,
            arguments: args,
          },
        }
      }
    }

    if (event.event_type === "step.stop") {
      let lifecycle = nextState.lifecycle
      let reasoningSignature = nextState.reasoningSignature

      if (nextState.currentStepType === "thought") {
        lifecycle = Lifecycle.reasoningEnd(
          lifecycle,
          events,
          "reasoning-0",
          reasoningSignature ? googleMetadata({ thoughtSignature: reasoningSignature }) : undefined,
        )
        nextState = { ...nextState, lifecycle }
      }

      if (nextState.currentStepType === "function_call" && nextState.activeToolCall) {
        lifecycle = Lifecycle.reasoningEnd(
          lifecycle,
          events,
          "reasoning-0",
          reasoningSignature ? googleMetadata({ thoughtSignature: reasoningSignature }) : undefined,
        )
        lifecycle = Lifecycle.stepStart(lifecycle, events)
        let parsedInput: unknown = {}
        if (nextState.activeToolCall.arguments) {
          try {
            parsedInput = JSON.parse(nextState.activeToolCall.arguments)
          } catch {
            parsedInput = nextState.activeToolCall.arguments
          }
        }
        events.push(
          LLMEvent.toolCall({
            id: nextState.activeToolCall.id,
            name: nextState.activeToolCall.name,
            input: parsedInput,
            providerMetadata: reasoningSignature
              ? googleMetadata({ thoughtSignature: reasoningSignature })
              : undefined,
          }),
        )
        nextState = {
          ...nextState,
          lifecycle,
          hasToolCalls: true,
          activeToolCall: undefined,
        }
      }
    }
  }

  return Effect.succeed([nextState, events] as const)
}

// =============================================================================
// Protocol And Gemini Route
// =============================================================================
/**
 * The Gemini protocol — request body construction, body schema, and the
 * streaming-event state machine.
 */
export const protocol = Protocol.make({
  id: ADAPTER,
  body: {
    schema: GeminiBody,
    from: fromRequest,
  },
  stream: {
    event: Protocol.jsonEvent(GeminiEvent),
    initial: () => ({ hasToolCalls: false, nextToolCallId: 0, lifecycle: Lifecycle.initial() }),
    step,
    terminal: (event) => "event_type" in event && event.event_type === "interaction.completed",
    onHalt: finish,
  },
})

export const route = Route.make({
  id: ADAPTER,
  provider: "google",
  protocol,
  endpoint: Endpoint.path(() => "/interactions", {
    baseURL: DEFAULT_BASE_URL,
  }),
  headers: () => ({
    "api-revision": "2026-05-20",
  }),
  auth: Auth.none,
  framing: Framing.sse,
})

export * as Gemini from "./gemini"
