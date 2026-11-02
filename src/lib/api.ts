import { streamText, stepCountIs, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { errorResponse, json, privateHeaders, PublicError, readJson, requireSameOrigin, requireSession } from "./http";
import type { FitbitReport } from "./fitbit/report";

type Dependencies = {
  getSession: () => Promise<{ user: { sub: string } } | null>;
  getAppOrigin: () => string;
  status: () => Promise<{ connected: boolean; needsPermissions: boolean; multipleAccounts: boolean }>;
  report: (signal: AbortSignal) => Promise<FitbitReport>;
  connect: (request: Request) => Promise<Response>;
  disconnect: () => Promise<void>;
  getModel: () => LanguageModel;
};

export const WELLBEING_PROMPT = `You provide concise daily wellbeing suggestions from a Fitbit summary.
Call getDailyFitbitSummary before writing any text. Use only its numeric data, dates, and warnings.
Address the user directly. Compare the latest completed day to the preceding seven-day personal averages, stating how many days have readings. Those averages describe recent measurements, not a healthy target.
Give 2-3 concrete, gentle suggestions for today tied to the available measurements, such as short movement breaks or a consistent sleep routine. Keep the answer under 300 words.
Use Markdown with short headings, paragraphs, and bullet points. Include: observations, suggestions for today, and data limits. Use straight quotes and avoid em dashes. Do not use marketing language, metaphors, rhetorical questions, or dramatic claims.
These are wearable estimates. Missing readings are unknown, not zero. Zero activity may mean the device was not worn. Sleep belongs to its recorded local end date. Active minutes mean MODERATE plus VIGOROUS minutes, not weighted Active Zone Minutes. The report timezone chooses the cutoff date; source readings keep their recorded local calendar dates, including travel.
Do not diagnose or predict disease, interpret resting heart rate as a clinical finding, prescribe treatment, suggest medication changes, weight-loss targets, or intense exercise. Do not infer age, pregnancy, fitness level, injury, illness, or medical history.
If data is incomplete, state that limitation and avoid claims about the missing metric. Do not invent metrics, universal step goals, or a recommendation to exercise harder. Use exact dates and distinguish the report period from today.`;

export function createApi(dependencies: Dependencies) {
  async function run(action: () => Promise<Response>) {
    try { return await action(); }
    catch (error) { return errorResponse(error); }
  }
  async function authorize(request: Request, mutation = false) {
    await requireSession(dependencies.getSession);
    if (mutation) requireSameOrigin(request, dependencies.getAppOrigin());
  }
  return {
    status: (request: Request) => run(async () => {
      await authorize(request);
      return json(await dependencies.status());
    }),
    report: (request: Request) => run(async () => {
      await authorize(request);
      return json(await dependencies.report(request.signal));
    }),
    connect: (request: Request) => run(async () => {
      await authorize(request, true);
      const response = await dependencies.connect(request);
      // A POST must become a GET at the provider's authorization page. Preserve
      // the SDK response headers, including its transaction cookies.
      return new Response(null, { status: 303, headers: response.headers });
    }),
    disconnect: (request: Request) => run(async () => {
      await authorize(request, true);
      await dependencies.disconnect();
      return json({ disconnected: true });
    }),
    advice: (request: Request) => run(async () => {
      await authorize(request, true);
      const body = z.object({ shareWithFireworks: z.literal(true) }).strict().safeParse(await readJson(request));
      if (!body.success) throw new PublicError("CONSENT_REQUIRED", "Choose to share your Fitbit summary with Fireworks before generating advice.", 400);
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(55_000)]);

      // Refresh the data and obtain the Fitbit token before streaming begins,
      // while the Auth0 SDK can still persist any updated session cookies.
      // Never accept metrics, account IDs, credentials, or prompts from the client.
      const report = await dependencies.report(signal);
      const result = streamText({
        model: dependencies.getModel(),
        system: WELLBEING_PROMPT,
        prompt: `Use my Fitbit summary to suggest a few practical things I can do today. The report covers ${report.date}; its cutoff uses ${report.timeZone}. Readings retain their recorded local dates.`,
        tools: {
          getDailyFitbitSummary: tool({
            description: "Read the signed-in user's normalized Fitbit summary for the latest complete day and seven prior days.",
            inputSchema: z.object({}).strict(),
            execute: async () => report,
          }),
        },
        prepareStep: ({ stepNumber }) => ({
          toolChoice: stepNumber === 0 ? { type: "tool", toolName: "getDailyFitbitSummary" } : "none",
        }),
        stopWhen: stepCountIs(2),
        maxOutputTokens: 1_536,
        providerOptions: { fireworks: { thinking: { type: "disabled" } } },
        maxRetries: 0,
        abortSignal: signal,
        onError: () => { /* Raw provider errors may contain health data or secrets. */ },
      });
      return result.toUIMessageStreamResponse({
        headers: privateHeaders,
        sendReasoning: false,
        onError: () => "Fireworks could not generate your suggestions. Check model access and account credit, then try again.",
      });
    }),
  };
}
