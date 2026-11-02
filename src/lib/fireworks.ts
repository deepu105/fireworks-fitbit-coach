import "server-only";
import { createFireworks } from "@ai-sdk/fireworks";
import { ConfigurationError } from "./config";

export function getFireworksModel() {
  const apiKey = process.env.FIREWORKS_API_KEY?.trim();
  const model = process.env.FIREWORKS_MODEL?.trim();
  if (!apiKey || !model) {
    throw new ConfigurationError("Set FIREWORKS_API_KEY and FIREWORKS_MODEL in .env.local.");
  }
  const fireworks = createFireworks({ apiKey });
  return fireworks(model);
}
