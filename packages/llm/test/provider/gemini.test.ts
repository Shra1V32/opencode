import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMError, Message, ToolCallPart, Usage } from "../../src"
import { Auth, LLMClient } from "../../src/route"
import * as Gemini from "../../src/protocols/gemini"
import { ProviderShared } from "../../src/protocols/shared"
import { it } from "../lib/effect"
import { fixedResponse } from "../lib/http"
import { sseEvents, sseRaw } from "../lib/sse"

const model = Gemini.route
  .with({
    endpoint: { baseURL: "https://generativelanguage.test/v1beta/" },
    auth: Auth.header("x-goog-api-key", "test"),
  })
  .model({ id: "gemini-2.5-flash" })

const request = LLM.request({
  id: "req_1",
  model,
  system: "You are concise.",
  prompt: "Say hello.",
  generation: { maxTokens: 20, temperature: 0 },
})

describe("Gemini route", () => {
  it.effect("prepares Gemini target", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(request)

      expect(prepared.body).toEqual({
        model: "gemini-2.5-flash",
        input: [{ type: "user_input", content: [{ type: "text", text: "Say hello." }] }],
        system_instruction: "You are concise.",
        generation_config: { max_output_tokens: 20, temperature: 0 },
        stream: true,
      })
    }),
  )

  it.effect("lowers chronological system updates to wrapped user text in order", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<Gemini.GeminiBody>(
        LLM.request({
          model,
          messages: [Message.user("Before."), Message.system("Update."), Message.assistant("After.")],
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          type: "user_input",
          content: [
            { type: "text", text: "Before." },
            { type: "text", text: "<system-update>\nUpdate.\n</system-update>" },
          ],
        },
        { type: "model_output", content: [{ type: "text", text: "After." }] },
      ])
    }),
  )

  it.effect("prepares multimodal user input and tool history", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          id: "req_tool_result",
          model,
          tools: [
            {
              name: "lookup",
              description: "Lookup data",
              inputSchema: { type: "object", properties: { query: { type: "string" } } },
            },
          ],
          toolChoice: { type: "tool", name: "lookup" },
          messages: [
            Message.user([
              { type: "text", text: "What is in this image?" },
              { type: "media", mediaType: "image/png", data: "AAECAw==" },
            ]),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: { query: "weather" } })]),
            Message.tool({ id: "call_1", name: "lookup", result: { forecast: "sunny" } }),
          ],
        }),
      )

      expect(prepared.body).toEqual({
        model: "gemini-2.5-flash",
        input: [
          {
            type: "user_input",
            content: [
              { type: "text", text: "What is in this image?" },
              { type: "image", mime_type: "image/png", data: "AAECAw==" },
            ],
          },
          {
            type: "function_call",
            id: "call_1",
            name: "lookup",
            arguments: { query: "weather" },
          },
          {
            type: "function_result",
            call_id: "call_1",
            name: "lookup",
            result: { forecast: "sunny" },
          },
        ],
        tools: [
          {
            type: "function",
            name: "lookup",
            description: "Lookup data",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
        ],
        stream: true,
      })
    }),
  )

  it.effect("continues image tool results as inline vision input without base64 text", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<Gemini.GeminiBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_image", name: "read", input: { path: "pixel.png" } })]),
            Message.tool({
              id: "call_image",
              name: "read",
              result: {
                type: "content",
                value: [
                  { type: "text", text: "Image read successfully" },
                  { type: "file", uri: "data:image/png;base64,AAECAw==", mime: "image/png", name: "pixel.png" },
                ],
              },
            }),
          ],
        }),
      )

      expect(prepared.body.input).toEqual([
        { type: "function_call", id: "call_image", name: "read", arguments: { path: "pixel.png" } },
        { type: "function_result", call_id: "call_image", name: "read", result: { output: "Image read successfully" } },
        { type: "user_input", content: [{ type: "image", mime_type: "image/png", data: "AAECAw==" }] },
      ])
      expect(JSON.stringify(prepared.body.input)).not.toContain('"content":"AAECAw=="')
    }),
  )

  it.effect("strips matching data URLs to raw base64 inlineData", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<Gemini.GeminiBody>(
        LLM.request({
          model,
          messages: [
            Message.user({ type: "media", mediaType: "image/png", data: "data:image/png;base64,AAEC" }),
            Message.tool({
              id: "call_image",
              name: "read",
              result: {
                type: "content",
                value: [{ type: "file", uri: "data:image/jpeg;base64,/9j/", mime: "image/jpeg" }],
              },
            }),
          ],
        }),
      )
      expect(prepared.body.input).toEqual([
        { type: "user_input", content: [{ type: "image", mime_type: "image/png", data: "AAEC" }] },
        { type: "function_result", call_id: "call_image", name: "read", result: { output: "" } },
        { type: "user_input", content: [{ type: "image", mime_type: "image/jpeg", data: "/9j/" }] },
      ])
    }),
  )

  for (const [name, media] of [
    ["mismatched data URL MIME", { mediaType: "image/png", data: "data:image/jpeg;base64,/9j/" }],
    ["malformed base64", { mediaType: "image/png", data: "%%%=" }],
    ["unsupported SVG", { mediaType: "image/svg+xml", data: "PHN2Zz4=" }],
  ] as const)
    it.effect(`rejects ${name}`, () =>
      Effect.gen(function* () {
        const error = yield* LLMClient.prepare(
          LLM.request({ model, messages: [Message.user({ type: "media", ...media })] }),
        ).pipe(Effect.flip)
        expect(error.message).toMatch(/does not support|does not match|valid base64/)
      }),
    )

  it.effect("rejects oversized image input", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.prepare(
        LLM.request({
          model,
          messages: [
            Message.user({
              type: "media",
              mediaType: "image/png",
              data: "A".repeat(ProviderShared.MAX_MEDIA_ENCODED_BYTES + 4),
            }),
          ],
        }),
      ).pipe(Effect.flip)
      expect(error.message).toContain("encoded limit")
    }),
  )

  it.effect("omits tools when tool choice is none", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          id: "req_no_tools",
          model,
          prompt: "Say hello.",
          tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
          toolChoice: { type: "none" },
        }),
      )

      expect(prepared.body).toEqual({
        model: "gemini-2.5-flash",
        input: [{ type: "user_input", content: [{ type: "text", text: "Say hello." }] }],
        stream: true,
      })
    }),
  )

  it.effect("sanitizes integer enums, dangling required, untyped arrays, and scalar object keys", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          id: "req_schema_patch",
          model,
          prompt: "Use the tool.",
          tools: [
            {
              name: "lookup",
              description: "Lookup data",
              inputSchema: {
                type: "object",
                required: ["status", "missing"],
                properties: {
                  status: { type: "integer", enum: [1, 2] },
                  tags: { type: "array" },
                  name: { type: "string", properties: { ignored: { type: "string" } }, required: ["ignored"] },
                },
              },
            },
          ],
        }),
      )

      expect(prepared.body).toMatchObject({
        tools: [
          {
            type: "function",
            name: "lookup",
            parameters: {
              type: "object",
              required: ["status"],
              properties: {
                status: { type: "string", enum: ["1", "2"] },
                tags: { type: "array", items: { type: "string" } },
                name: { type: "string" },
              },
            },
          },
        ],
      })
    }),
  )

  it.effect("parses text, reasoning, and usage stream fixtures", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        {
          event_type: "step.start",
          index: 0,
          step: { type: "thought" },
        },
        {
          event_type: "step.delta",
          index: 0,
          delta: { type: "thought_summary", content: { text: "thinking" } },
        },
        {
          event_type: "step.stop",
          index: 0,
        },
        {
          event_type: "step.start",
          index: 1,
          step: { type: "model_output" },
        },
        {
          event_type: "step.delta",
          index: 1,
          delta: { type: "text", text: "Hello" },
        },
        {
          event_type: "step.delta",
          index: 1,
          delta: { type: "text", text: "!" },
        },
        {
          event_type: "step.stop",
          index: 1,
        },
        {
          event_type: "interaction.completed",
          interaction: {
            status: "completed",
            usage: {
              total_input_tokens: 5,
              total_output_tokens: 3,
              total_cached_tokens: 1,
              total_thought_tokens: 1,
              total_tokens: 7,
            },
          },
        },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.text).toBe("Hello!")
      expect(response.reasoning).toBe("thinking")
      expect(response.usage).toMatchObject({
        inputTokens: 5,
        outputTokens: 3,
        nonCachedInputTokens: 4,
        cacheReadInputTokens: 1,
        reasoningTokens: 1,
        totalTokens: 7,
      })
      const usage = new Usage({
        inputTokens: 5,
        outputTokens: 3,
        nonCachedInputTokens: 4,
        cacheReadInputTokens: 1,
        reasoningTokens: 1,
        totalTokens: 7,
        providerMetadata: {
          google: {
            total_input_tokens: 5,
            total_output_tokens: 3,
            total_cached_tokens: 1,
            total_thought_tokens: 1,
            total_tokens: 7,
          },
        },
      })
      expect(response.events).toEqual([
        { type: "step-start", index: 0 },
        { type: "reasoning-start", id: "reasoning-0" },
        { type: "reasoning-delta", id: "reasoning-0", text: "thinking" },
        { type: "reasoning-end", id: "reasoning-0" },
        { type: "text-start", id: "text-0" },
        { type: "text-delta", id: "text-0", text: "Hello" },
        { type: "text-delta", id: "text-0", text: "!" },
        { type: "text-end", id: "text-0" },
        { type: "step-finish", index: 0, reason: "stop", usage, providerMetadata: undefined },
        {
          type: "finish",
          reason: "stop",
          usage,
        },
      ])
    }),
  )

  it.effect("preserves thoughtSignature for reasoning and tool-call continuation", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        {
          event_type: "step.start",
          index: 0,
          step: { type: "thought" },
        },
        {
          event_type: "step.delta",
          index: 0,
          delta: { type: "thought_summary", content: { text: "thinking" } },
        },
        {
          event_type: "step.delta",
          index: 0,
          delta: { type: "thought_signature", signature: "thought_sig" },
        },
        {
          event_type: "step.stop",
          index: 0,
        },
        {
          event_type: "step.start",
          index: 1,
          step: { id: "tool_0", type: "function_call", name: "lookup" },
        },
        {
          event_type: "step.delta",
          index: 1,
          delta: { type: "arguments_delta", arguments: '{"query":"weather"}' },
        },
        {
          event_type: "step.stop",
          index: 1,
        },
        {
          event_type: "interaction.completed",
          interaction: { status: "requires_action" },
        },
      )
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, {
          tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
        }),
      ).pipe(Effect.provide(fixedResponse(body)))
      const reasoning = response.events.find((event) => event.type === "reasoning-start")
      const reasoningEnd = response.events.find((event) => event.type === "reasoning-end")
      const toolCall = response.events.find((event) => event.type === "tool-call")

      expect(reasoning).toEqual({
        type: "reasoning-start",
        id: "reasoning-0",
        providerMetadata: undefined,
      })
      expect(reasoningEnd).toEqual({
        type: "reasoning-end",
        id: "reasoning-0",
        providerMetadata: { google: { thoughtSignature: "thought_sig" } },
      })
      expect(toolCall).toMatchObject({ providerMetadata: { google: { thoughtSignature: "thought_sig" } } })
      expect(response.events.findIndex((event) => event.type === "reasoning-end")).toBeLessThan(
        response.events.findIndex((event) => event.type === "tool-call"),
      )

      const prepared = yield* LLMClient.prepare<Gemini.GeminiBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              { type: "reasoning", text: "thinking", providerMetadata: reasoningEnd?.providerMetadata },
              ToolCallPart.make({
                id: "tool_0",
                name: "lookup",
                input: { query: "weather" },
                providerMetadata: toolCall?.providerMetadata,
              }),
            ]),
          ],
        }),
      )
      expect(prepared.body.input).toEqual([
        { type: "thought", summary: [{ type: "text", text: "thinking" }], signature: "thought_sig" },
        { type: "function_call", id: "tool_0", name: "lookup", arguments: { query: "weather" } },
      ])
    }),
  )

  it.effect("emits streamed tool calls and maps finish reason", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        {
          event_type: "step.start",
          index: 0,
          step: { id: "tool_0", type: "function_call", name: "lookup" },
        },
        {
          event_type: "step.delta",
          index: 0,
          delta: { type: "arguments_delta", arguments: '{"query":"weather"}' },
        },
        {
          event_type: "step.stop",
          index: 0,
        },
        {
          event_type: "interaction.completed",
          interaction: {
            status: "requires_action",
            usage: { total_input_tokens: 5, total_output_tokens: 1 },
          },
        },
      )
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, {
          tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
        }),
      ).pipe(Effect.provide(fixedResponse(body)))
      const usage = new Usage({
        inputTokens: 5,
        outputTokens: 1,
        nonCachedInputTokens: 5,
        cacheReadInputTokens: undefined,
        reasoningTokens: undefined,
        totalTokens: 6,
        providerMetadata: { google: { total_input_tokens: 5, total_output_tokens: 1 } },
      })

      expect(response.toolCalls).toEqual([
        {
          type: "tool-call",
          id: "tool_0",
          name: "lookup",
          input: { query: "weather" },
          providerExecuted: undefined,
          providerMetadata: undefined,
        },
      ])
      expect(response.events).toEqual([
        { type: "step-start", index: 0 },
        {
          type: "tool-call",
          id: "tool_0",
          name: "lookup",
          input: { query: "weather" },
          providerExecuted: undefined,
          providerMetadata: undefined,
        },
        { type: "step-finish", index: 0, reason: "tool-calls", usage, providerMetadata: undefined },
        {
          type: "finish",
          reason: "tool-calls",
          usage,
        },
      ])
    }),
  )

  it.effect("assigns unique ids to multiple streamed tool calls", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        {
          event_type: "step.start",
          index: 0,
          step: { id: "tool_0", type: "function_call", name: "lookup" },
        },
        {
          event_type: "step.delta",
          index: 0,
          delta: { type: "arguments_delta", arguments: '{"query":"weather"}' },
        },
        {
          event_type: "step.stop",
          index: 0,
        },
        {
          event_type: "step.start",
          index: 1,
          step: { id: "tool_1", type: "function_call", name: "lookup" },
        },
        {
          event_type: "step.delta",
          index: 1,
          delta: { type: "arguments_delta", arguments: '{"query":"news"}' },
        },
        {
          event_type: "step.stop",
          index: 1,
        },
        {
          event_type: "interaction.completed",
          interaction: { status: "requires_action" },
        },
      )
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, {
          tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
        }),
      ).pipe(Effect.provide(fixedResponse(body)))

      expect(response.toolCalls).toEqual([
        { type: "tool-call", id: "tool_0", name: "lookup", input: { query: "weather" } },
        { type: "tool-call", id: "tool_1", name: "lookup", input: { query: "news" } },
      ])
      expect(response.events.at(-1)).toMatchObject({ type: "finish", reason: "tool-calls" })
    }),
  )

  it.effect("maps length and content-filter finish reasons", () =>
    Effect.gen(function* () {
      const length = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({ event_type: "interaction.completed", interaction: { status: "incomplete" } }),
          ),
        ),
      )
      const filtered = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({ event_type: "interaction.completed", interaction: { status: "failed" } }),
          ),
        ),
      )

      expect(length.events.map((event) => event.type)).toEqual(["step-start", "step-finish", "finish"])
      expect(length.events.at(-1)).toMatchObject({ type: "finish", reason: "length" })
      expect(filtered.events.map((event) => event.type)).toEqual(["step-start", "step-finish", "finish"])
      expect(filtered.events.at(-1)).toMatchObject({ type: "finish", reason: "error" })
    }),
  )

  it.effect("leaves total usage undefined when component counts are missing", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({
              event_type: "interaction.completed",
              interaction: { status: "completed", usage: { total_thought_tokens: 1 } },
            }),
          ),
        ),
      )

      expect(response.usage).toMatchObject({ reasoningTokens: 1 })
      expect(response.usage?.totalTokens).toBeUndefined()
    }),
  )

  it.effect("fails invalid stream events", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseRaw("data: {not json}"))),
        Effect.flip,
      )

      expect(error).toBeInstanceOf(LLMError)
      expect(error.reason).toMatchObject({ _tag: "InvalidProviderOutput" })
      expect(error.message).toContain("Invalid google/gemini stream event")
    }),
  )

  it.effect("rejects unsupported assistant media content", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.prepare(
        LLM.request({
          id: "req_media",
          model,
          messages: [Message.assistant({ type: "media", mediaType: "image/png", data: "AAECAw==" })],
        }),
      ).pipe(Effect.flip)

      expect(error.message).toContain(
        "Gemini assistant messages only support text, reasoning, and tool-call content for now",
      )
    }),
  )
})
