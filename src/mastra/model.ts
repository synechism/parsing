export function defaultModel(): string {
  if (process.env.MASTRA_MODEL) {
    return process.env.MASTRA_MODEL;
  }
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return "anthropic/deepseek-v4-flash";
  }
  return "openai/gpt-4o-mini";
}
