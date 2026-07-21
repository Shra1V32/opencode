import { Effect, Schema } from "effect"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Websearch query" }),
  numResults: Schema.optional(Schema.Number).annotate({
    description: "Number of search results to return (default: 8)",
  }),
})

export const GoogleSearchTool = Tool.define(
  "googleSearch",
  Effect.gen(function* () {
    return {
      description: "Search the web using Google Search",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.metadata({
            title: `Google Web Search "${params.query}"`,
            metadata: { provider: "google", query: params.query, numResults: params.numResults },
          })

          yield* ctx.ask({
            permission: "websearch",
            patterns: [params.query],
            always: ["*"],
            metadata: {
              query: params.query,
              numResults: params.numResults,
              provider: "google",
            },
          })

          return {
            output: "Google Search is handled natively by the provider.",
            title: `Google Web Search: ${params.query}`,
            metadata: { provider: "google", query: params.query, numResults: params.numResults },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
