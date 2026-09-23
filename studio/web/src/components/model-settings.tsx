import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type HostModelView =
  | { configured: false }
  | {
      configured: true;
      provider: string;
      model: string;
      authType: "api_key" | "oauth";
      baseUrl?: string;
    };

type Catalog = {
  providers: { id: string; name: string; models: { id: string; name: string }[] }[];
};

const runtime = (path: string, init?: RequestInit) =>
  fetch(location.origin + "/_studio/runtime" + path, init);

export function ModelSettings() {
  const [status, setStatus] = useState<HostModelView | undefined>();
  const [catalog, setCatalog] = useState<Catalog>({ providers: [] });
  const [provider, setProvider] = useState("custom");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [modelResponse, catalogResponse] = await Promise.all([
          runtime("/v1/host/model"),
          runtime("/v1/host/models"),
        ]);
        if (!modelResponse.ok || !catalogResponse.ok)
          throw new Error("The Runtime did not return model settings.");
        const next = (await modelResponse.json()) as HostModelView;
        const listed = (await catalogResponse.json()) as Catalog;
        if (cancelled) return;
        setStatus(next);
        setCatalog(listed);
        if (next.configured) {
          setProvider(next.provider);
          setModel(next.model);
          setBaseUrl(next.baseUrl ?? "");
        } else if (listed.providers[0]) {
          setProvider(listed.providers[0].id);
          setModel(listed.providers[0].models[0]?.id ?? "");
        }
      } catch (cause) {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = catalog.providers.find((item) => item.id === provider);
  const custom = provider === "custom";

  async function save(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSaved("");
    setPending(true);
    const key = apiKey;
    try {
      const response = await runtime("/v1/host/model", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          idempotencyKey: crypto.randomUUID(),
          provider,
          model,
          ...(custom && baseUrl ? { baseUrl } : {}),
          auth: { type: "api_key", key },
        }),
      });
      const body = (await response.json()) as HostModelView & { message?: string };
      if (!response.ok) throw new Error(body.message ?? "The Runtime rejected the model provider.");
      if (JSON.stringify(body).includes(key))
        throw new Error("The Runtime returned the provider key.");
      setStatus(body);
      setApiKey("");
      setSaved(
        body.configured
          ? `Saved ${body.provider} / ${body.model}. The key stays in the Runtime vault.`
          : "Saved.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mx-auto w-full max-w-xl flex-1 overflow-auto p-8">
      <h1 className="text-2xl font-semibold">Model provider</h1>
      <p className="my-4 text-muted-foreground">
        {status?.configured
          ? `The Runtime calls ${status.provider} / ${status.model}${status.authType === "oauth" ? " with OAuth" : ""}. Replace the API key here. OAuth login stays in the terminal.`
          : "The Runtime stores this credential and uses it for model calls. It is not written into the project."}
      </p>
      <form className="grid gap-4" onSubmit={(event) => void save(event)}>
        <label className="grid gap-1 text-sm">
          Provider
          <select
            className="h-9 rounded-md border bg-transparent px-3"
            value={provider}
            onChange={(event) => {
              const next = event.target.value;
              setProvider(next);
              const match = catalog.providers.find((item) => item.id === next);
              setModel(match?.models[0]?.id ?? "");
              if (next !== "custom") setBaseUrl("");
            }}
          >
            {catalog.providers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
            <option value="custom">Custom OpenAI-compatible</option>
          </select>
        </label>
        {custom ? (
          <>
            <label className="grid gap-1 text-sm">
              Base URL
              <Input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://example.test/v1"
                required
              />
            </label>
            <label className="grid gap-1 text-sm">
              Model id
              <Input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                required
              />
            </label>
          </>
        ) : (
          <label className="grid gap-1 text-sm">
            Model
            <select
              className="h-9 rounded-md border bg-transparent px-3"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              required
            >
              {(selected?.models ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="grid gap-1 text-sm">
          API key
          <Input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            required
          />
        </label>
        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
        {saved ? <p className="text-sm text-muted-foreground">{saved}</p> : null}
        <Button type="submit" disabled={pending}>
          {pending ? "Saving" : status?.configured ? "Replace credential" : "Save credential"}
        </Button>
      </form>
    </section>
  );
}
