// A test Worker for money-workerd.test.ts: runs the providers' exact-money reading (parseProviderJson, then
// usdToMicros) inside workerd itself, for each token posted, and reports what the runtime gave the reviver.
import { parseProviderJson, usdToMicros } from "@sbgpu/providers";

/** Each token's outcome: its micros, or the refusal's error name and message. */
export function readTokens(tokens: readonly string[]): (number | string)[] {
  return tokens.map((token) => {
    try {
      return usdToMicros((parseProviderJson(`{"price":${token}}`) as { price: number }).price);
    } catch (e) {
      return `${(e as Error).name}: ${(e as Error).message}`;
    }
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const tokens = (await request.json()) as string[];
    // (the runtime's own reviver context, straight: what the rule depends on)
    const sources: unknown[] = [];
    JSON.parse(`[${tokens.join(",")}]`, (key: string, value: unknown, context?: { source?: unknown }) => {
      if (typeof value === "number") sources.push(context?.source);
      return value;
    });
    return Response.json({ sources, results: readTokens(tokens) });
  },
};
