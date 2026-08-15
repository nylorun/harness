import { diagnostic, NyloBuildError } from "../diagnostics.js";
import { resolveCredential, type ResolvedCredential } from "./credentials.js";

export const OPENROUTER_VARIABLE = "OPENROUTER_API_KEY";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Creators whose own API speaks `POST /chat/completions`. A creator absent from this table is not
 * unsupported by the catalog — it is unsupported *directly*, and OpenRouter still serves it.
 *
 * Anthropic Messages and Google `generateContent` are deliberately missing: they are different
 * wire shapes, not different hosts, and pretending otherwise would fail a first run with a protocol
 * error instead of a diagnostic naming the fix.
 */
const DIRECT: Readonly<Record<string, Readonly<{ baseUrl: string; variable: string }>>> = Object.freeze({
  openai: { baseUrl: "https://api.openai.com/v1", variable: "OPENAI_API_KEY" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", variable: "GROQ_API_KEY" },
  mistralai: { baseUrl: "https://api.mistral.ai/v1", variable: "MISTRAL_API_KEY" },
  deepseek: { baseUrl: "https://api.deepseek.com", variable: "DEEPSEEK_API_KEY" },
  xai: { baseUrl: "https://api.x.ai/v1", variable: "XAI_API_KEY" },
  togethercomputer: { baseUrl: "https://api.together.xyz/v1", variable: "TOGETHER_API_KEY" }
});

export type ResolvedModel = Readonly<{
  /** The identity as written in `agent/agent.ts`, unchanged. */
  model: string;
  /** The identity sent upstream. OpenRouter takes `creator/model` verbatim; a direct API takes the suffix. */
  upstreamModel: string;
  baseUrl: string;
  route: "openrouter" | "direct";
  credential: ResolvedCredential;
}>;

/**
 * Turns a creator-native catalog identity into a provider call.
 *
 * OpenRouter is preferred whenever its credential resolves: it is the path the hosted gateway
 * takes, so it is the local configuration with the least parity risk, and one key covers the whole
 * catalog. Which source answered is reported; the value never is.
 *
 * Catalog membership is hosted state and is not checked here. A model a builder can reach with her
 * own key, but which the catalog does not carry, runs locally and is refused at hosted readiness —
 * by the phase that owns the authority to know.
 */
export async function resolveModel(
  model: string,
  options: Readonly<{ projectRoot: string; env?: Readonly<Record<string, string | undefined>>; baseUrl?: string }>
): Promise<ResolvedModel> {
  const separator = model.indexOf("/");
  const creator = separator > 0 ? model.slice(0, separator) : "";
  const suffix = separator > 0 ? model.slice(separator + 1) : "";

  const openrouter = await resolveCredential([OPENROUTER_VARIABLE], options);
  if (openrouter !== undefined) {
    return Object.freeze({
      model,
      upstreamModel: model,
      baseUrl: options.baseUrl ?? OPENROUTER_BASE_URL,
      route: "openrouter",
      credential: openrouter
    });
  }

  const direct = DIRECT[creator];
  if (direct === undefined) {
    throw new NyloBuildError(
      diagnostic(
        "NYLO_RUN_PROVIDER_UNSUPPORTED",
        "run",
        "error",
        "agent/agent.ts",
        `No credential found for "${model}", and ${creator === "" ? "the model identity" : `"${creator}"`} has no directly supported API.`,
        `Set ${OPENROUTER_VARIABLE} in your environment or .env — one OpenRouter key serves every model in the catalog.`
      )
    );
  }

  const credential = await resolveCredential([direct.variable], options);
  if (credential === undefined) {
    throw new NyloBuildError(
      diagnostic(
        "NYLO_RUN_CREDENTIAL_MISSING",
        "run",
        "error",
        ".env",
        `No provider credential found for "${model}".`,
        `Set ${direct.variable} for a direct call, or ${OPENROUTER_VARIABLE} to route through OpenRouter.`
      )
    );
  }

  return Object.freeze({
    model,
    upstreamModel: suffix,
    baseUrl: options.baseUrl ?? direct.baseUrl,
    route: "direct",
    credential
  });
}
