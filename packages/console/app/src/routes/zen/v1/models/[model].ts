import type { APIEvent } from "@solidjs/start/server"
import { handler } from "~/routes/zen/util/handler"
import { parseGoogleVariant } from "~/routes/zen/util/variant"

export function POST(input: APIEvent) {
  return handler(input, {
    format: "google",
    modelList: "full",
    parseApiKey: (headers: Headers) => headers.get("x-goog-api-key") ?? undefined,
    parseModel: (url: string, body: any) => body?.model ?? url.split("/").pop()?.split(":")?.[0] ?? "",
    parseVariant: (url: string, body: any) => parseGoogleVariant(body),
    parseIsStream: (url: string, body: any) => body?.stream ?? true,
  })
}
