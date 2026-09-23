/**
 * Deterministic demo run for the TUI.
 *
 * The demo drives the real `BenchmarkEngine` with a scripted provider, so the
 * PTY/rendering checks exercise the same events, scheduling, retries, and
 * cooldowns as a live run without any network access or credentials. Failures
 * are keyed to fixture indexes rather than wall-clock time: two runs produce the
 * same outcome sequence, only at different wall-clock speeds.
 */
import {
  BenchmarkEngine,
  type ChatCompletionRequestPayload,
  type CompletionProvider,
  type EngineClock,
  type EngineEventSink,
  type EngineFixture,
  type EngineRunResult,
  type NormalizedCompletion,
  type PreflightEvaluation,
  type ProviderResult,
} from "@mmstar/benchmark";
import type { ExecutionConfig } from "@mmstar/config";

export const DEMO_RUN_ID = "demo-run-0001";
export const DEMO_FIXTURE_COUNT = 8;
const DEMO_CATEGORIES = ["biology", "chemistry", "math", "physics"] as const;

export function demoEvaluations(): PreflightEvaluation[] {
  return [
    {
      evaluationId: "alpha::high",
      modelAlias: "alpha",
      openRouterId: "demo/alpha-vision",
      reasoningMode: "high",
      rateLimitGroup: "g-alpha",
      provider: null,
      reasoning: { effort: "high" },
    },
    {
      evaluationId: "alpha::low",
      modelAlias: "alpha",
      openRouterId: "demo/alpha-vision",
      reasoningMode: "low",
      rateLimitGroup: "g-alpha",
      provider: null,
      reasoning: { effort: "low" },
    },
    {
      evaluationId: "beta::default",
      modelAlias: "beta",
      openRouterId: "demo/beta-vision",
      reasoningMode: "default",
      rateLimitGroup: "g-beta",
      provider: null,
      reasoning: null,
    },
  ];
}

export function demoFixtures(count: number): EngineFixture[] {
  return Array.from({ length: Math.max(0, Math.floor(count)) }, (_, index) => ({
    fixtureId: `demo-${index}`,
    category: DEMO_CATEGORIES[index % DEMO_CATEGORIES.length] ?? "unknown",
    expectedAnswer: "A",
    prompt: {
      fixtureId: `demo-${index}`,
      question: `Demo question ${index}: choose the best option.`,
      image: { mediaType: "image/png" as const, base64: "aGVsbG8=" },
    },
  }));
}

interface DemoResponseInput {
  model: string;
  effort: string;
  index: number;
  firstAttempt: boolean;
  rateLimitRetryAfterMs: number;
}

/** Pure scripted response so demo behavior is deterministic and inspectable. */
export function demoResponseFor(input: DemoResponseInput): ProviderResult<NormalizedCompletion> {
  const { model, effort, index, firstAttempt, rateLimitRetryAfterMs } = input;
  if (model === "demo/alpha-vision" && index === 2 && firstAttempt) {
    return failure("rate_limit", "demo rate limit", { retryAfterMs: rateLimitRetryAfterMs });
  }
  if (model === "demo/beta-vision" && index === 5) {
    return failure("timeout", "demo timeout");
  }
  if (model === "demo/beta-vision" && index === 7) {
    return failure("content_filter", "demo content filter", { httpStatus: 400 });
  }
  const provider = model === "demo/beta-vision" ? "demo-provider-b" : "demo-provider-a";
  return {
    ok: true,
    value: {
      responseId: `demo-${model}-${index}`,
      modelUsed: model,
      upstreamProvider: provider,
      finishReason: "stop",
      // Expected answer is always A: even indexes score correct, odd incorrect.
      responseText: index % 2 === 0 ? "A" : "B",
      usage: {
        promptTokens: 100 + index,
        completionTokens: 5,
        totalTokens: 105 + index,
        reasoningTokens: effort === "high" ? 20 : null,
      },
      cost: { kind: "reported", usd: (index + 1) * 0.0001 },
      rawResponse: null,
    },
  };
}

function failure(
  category: "rate_limit" | "timeout" | "content_filter" | "cancelled",
  message: string,
  overrides: { retryAfterMs?: number; httpStatus?: number | null } = {},
): ProviderResult<NormalizedCompletion> {
  return {
    ok: false,
    failure: {
      category,
      message,
      httpStatus: overrides.httpStatus ?? null,
      retryAfterMs: overrides.retryAfterMs ?? null,
    },
    rawResponse: null,
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export function demoProvider(options: {
  latencyMs?: number;
  rateLimitRetryAfterMs?: number;
}): CompletionProvider {
  const latencyMs = options.latencyMs ?? 25;
  const rateLimitRetryAfterMs = options.rateLimitRetryAfterMs ?? 600;
  const attempted = new Set<string>();
  return async (payload: ChatCompletionRequestPayload, control) => {
    await delay(latencyMs, control.signal);
    if (control.signal.aborted) {
      return failure("cancelled", "demo cancellation");
    }
    const effort = payload.reasoning?.effort ?? "default";
    const index = questionIndex(payload);
    const key = `${payload.model}#${effort}#${index}`;
    const firstAttempt = !attempted.has(key);
    attempted.add(key);
    return demoResponseFor({
      model: payload.model,
      effort,
      index,
      firstAttempt,
      rateLimitRetryAfterMs,
    });
  };
}

function questionIndex(payload: ChatCompletionRequestPayload): number {
  for (const part of payload.messages[0]?.content ?? []) {
    if (part.type !== "text") continue;
    const match = /Demo question (\d+)/.exec(part.text);
    if (match?.[1] !== undefined) return Number.parseInt(match[1], 10);
  }
  return -1;
}

export interface DemoEngineOptions {
  fixtureCount?: number;
  latencyMs?: number;
  rateLimitRetryAfterMs?: number;
  maxRetries?: number;
  maxConcurrentGroups?: number;
  sink?: EngineEventSink;
  clock?: EngineClock;
}

export function demoExecution(overrides: Partial<ExecutionConfig> = {}): ExecutionConfig {
  return {
    maxConcurrentGroups: 2,
    maxRetries: 1,
    requestTimeoutMs: 5_000,
    maxRequestsPerMinute: null,
    resultsRoot: "results",
    ...overrides,
  };
}

export function createDemoEngine(options: DemoEngineOptions = {}): BenchmarkEngine {
  return new BenchmarkEngine({
    runId: DEMO_RUN_ID,
    evaluations: demoEvaluations(),
    fixtures: demoFixtures(options.fixtureCount ?? DEMO_FIXTURE_COUNT),
    execution: demoExecution({
      maxConcurrentGroups: options.maxConcurrentGroups ?? 2,
      maxRetries: options.maxRetries ?? 1,
    }),
    provider: demoProvider({
      latencyMs: options.latencyMs ?? 25,
      rateLimitRetryAfterMs: options.rateLimitRetryAfterMs ?? 600,
    }),
    random: () => 0.5,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.sink === undefined ? {} : { sink: options.sink }),
  });
}

export async function runDemo(options: DemoEngineOptions = {}): Promise<EngineRunResult> {
  const engine = createDemoEngine(options);
  return engine.run();
}
