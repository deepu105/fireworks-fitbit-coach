// Live provider smoke test. Sends fixture measurements, not account data.
// Run: node scripts/test-fireworks.mjs
import { existsSync, readFileSync } from 'node:fs';
import { createFireworks } from '@ai-sdk/fireworks';
import { streamText, stepCountIs, tool } from 'ai';
import { z } from 'zod';

for (const path of ['.env.local', '.env']) if (existsSync(path)) process.loadEnvFile(path);
const apiKey = process.env.FIREWORKS_API_KEY?.trim();
const model = process.env.FIREWORKS_MODEL?.trim();
if (!apiKey || !model) throw new Error('Configure FIREWORKS_API_KEY and FIREWORKS_MODEL.');
const source = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
const system = source.match(/export const WELLBEING_PROMPT = `([\s\S]*?)`;/)?.[1];
if (!system) throw new Error('Could not read the application prompt.');
const latest = { date: '2026-10-28', steps: 4300, activeMinutes: 20, sleepMinutes: 365, restingHeartRate: 63 };
const report = { date: latest.date, timeZone: 'Europe/Amsterdam', latest,
  baseline: { steps: { value: 7000, days: 7 }, activeMinutes: { value: 30, days: 7 }, sleepMinutes: { value: 445, days: 7 }, restingHeartRate: { value: 60, days: 7 } },
  warnings: ['Smoke test: these are fixture measurements, not a real health account.'] };
let toolCalls = 0;
try {
  const result = streamText({
    model: createFireworks({ apiKey })(model), system,
    prompt: 'Use this fixture Fitbit summary to suggest a few practical things to try today.',
    tools: { getDailyFitbitSummary: tool({ description: 'Return the fixture daily health report.', inputSchema: z.object({}).strict(), execute: async () => { ++toolCalls; return report; } }) },
    prepareStep: ({ stepNumber }) => ({ toolChoice: stepNumber === 0 ? { type: 'tool', toolName: 'getDailyFitbitSummary' } : 'none' }),
    stopWhen: stepCountIs(2), maxOutputTokens: 1536, providerOptions: { fireworks: { thinking: { type: "disabled" } } }, maxRetries: 0, abortSignal: AbortSignal.timeout(55000),
    onError: () => {},
  });
  let text = '';
  for await (const part of result.fullStream) {
    if (part.type === 'error') throw part.error;
    if (part.type === 'text-delta') text += part.text;
  }
  const steps = await result.steps;
  if (toolCalls !== 1 || steps.length !== 2 || !text.trim() || steps.at(-1)?.finishReason !== "stop") throw new Error('Expected one forced tool call, two model steps, and a streamed answer.');
  console.log(JSON.stringify({ passed: true, model, toolCalls, modelSteps: steps.length, answerCharacters: text.length, finishReasons: steps.map((step) => step.finishReason), usage: await result.totalUsage }, null, 2));
} catch (error) {
  // Do not print raw provider errors or request headers.
  console.error(JSON.stringify({ passed: false, statusCode: error?.statusCode ?? null, errorType: error?.name ?? 'Error' }));
  process.exitCode = 1;
}
