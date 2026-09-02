import { config } from "dotenv";

config();

export function providerConfig(): Readonly<{
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  headers?: Readonly<Record<string, string>>;
}> {
  const provider = process.env.NYLO_PROVIDER?.trim();
  const model = process.env.NYLO_MODEL?.trim();
  const baseUrl = process.env.NYLO_BASE_URL?.trim();
  const apiKey = process.env.NYLO_API_KEY?.trim();
  if (!provider || !model || !baseUrl || !apiKey) {
    throw new Error(
      "Set NYLO_PROVIDER, NYLO_MODEL, NYLO_BASE_URL, and NYLO_API_KEY in .env before starting the agent server.",
    );
  }
  return {
    provider,
    model,
    baseUrl,
    apiKey,
    ...(process.env.NYLO_HEADERS_JSON === undefined
      ? {}
      : { headers: headers(process.env.NYLO_HEADERS_JSON) }),
  };
}

function headers(value: string): Readonly<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      "NYLO_HEADERS_JSON must be a JSON object of string headers.",
      { cause: error },
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((item) => typeof item !== "string")
  )
    throw new Error(
      "NYLO_HEADERS_JSON must be a JSON object of string headers.",
    );
  return parsed as Readonly<Record<string, string>>;
}
