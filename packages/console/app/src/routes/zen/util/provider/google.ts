import { ProviderHelper } from "./provider"

/*
{
  promptTokenCount: 11453,
  candidatesTokenCount: 71,
  totalTokenCount: 11625,
  cachedContentTokenCount: 8100,
  promptTokensDetails: [
    {modality: "TEXT",tokenCount: 11453}
  ],
  cacheTokensDetails: [
    {modality: "TEXT",tokenCount: 8100}
  ],
  thoughtsTokenCount: 101
}
*/

type Usage = {
  total_input_tokens?: number
  total_output_tokens?: number
  total_cached_tokens?: number
  total_thought_tokens?: number
  total_tokens?: number
}

export const googleHelper: ProviderHelper = ({ providerModel: _providerModel }) => ({
  format: "google",
  modifyUrl: (providerApi: string, _isStream?: boolean) => `${providerApi}/interactions`,
  modifyHeaders: (headers: Headers, apiKey: string, _stickyId: string) => {
    headers.set("x-goog-api-key", apiKey)
    headers.set("api-revision", "2026-05-20")
  },
  modifyBody: (body: Record<string, any>) => {
    return body
  },
  createBinaryStreamDecoder: () => undefined,
  createUsageParser: () => {
    let usage: Usage

    return {
      parse: (chunk: string) => {
        if (!chunk.startsWith("data: ")) return

        let json
        try {
          json = JSON.parse(chunk.slice(6)) as { interaction?: { usage?: Usage }; event_type?: string }
        } catch {
          return
        }

        if (!json.interaction?.usage) return
        usage = json.interaction.usage
      },
      retrieve: () => usage,
    }
  },
  extractUsage: (response: any) => response.interaction?.usage ?? response.usageMetadata,
  normalizeUsage: (usage: Usage) => {
    const inputTokens = usage.total_input_tokens ?? 0
    const outputTokens = usage.total_output_tokens ?? 0
    const reasoningTokens = usage.total_thought_tokens ?? 0
    const cacheReadTokens = usage.total_cached_tokens ?? 0
    return {
      inputTokens: inputTokens - cacheReadTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheWrite5mTokens: undefined,
      cacheWrite1hTokens: undefined,
    }
  },
})
