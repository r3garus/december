export const config = {
  aiSdk: {
    baseUrl: process.env.AI_BASE_URL || "https://api.gptclubapi.xyz/openai/v1",
    apiKey: process.env.AI_API_KEY || "",
    model: process.env.AI_MODEL || "gpt-5.3-codex",
    temperature: Number(process.env.AI_TEMPERATURE || "0.2"),
  },
} as const;
