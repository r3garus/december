export const config = {
  aiSdk: {
    baseUrl: process.env.AI_BASE_URL || "https://api.gptclubapi.xyz/openai/v1",
    apiKey:
      process.env.AI_API_KEY ||
      process.env.OPENROUTER_API_KEY ||
      process.env.OPENAI_API_KEY ||
      "",
    model: process.env.AI_MODEL || "gpt-5.3-codex",
    temperature: Number(process.env.AI_TEMPERATURE || "0.15"),
    maxRetries: Number(process.env.AI_MAX_RETRIES || "2"),
    minQualityScore: Number(process.env.AI_MIN_QUALITY_SCORE || "80"),
    maxCriticRounds: Number(process.env.AI_MAX_CRITIC_ROUNDS || "2"),
  },
} as const;
