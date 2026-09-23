import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { AgentManifest, HookPoint } from "@/studio-types";

/** How often a hook point runs, so the cost of each hook is visible. */
export function hookFrequency(hook: HookPoint): string {
  return hook.scope === "turn" ? "once per turn" : "every model call";
}

export function AgentManifestPanel({
  agent,
}: Readonly<{ agent: AgentManifest }>) {
  const tools = agent.manifest.capabilities.flatMap(
    (capability) => capability.tools ?? [],
  );
  const hooks = agent.manifest.capabilities.flatMap((capability) =>
    (capability.hooks ?? []).map((hook) => ({ capability: capability.id, hook })),
  );
  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-4">
        <section>
          <h3 className="text-sm font-medium">ID</h3>
          <p className="mt-2 font-mono text-xs">{agent.id}</p>
        </section>
        <Separator />
        <section>
          <h3 className="text-sm font-medium">Name</h3>
          <p className="mt-2 text-sm">{agent.name}</p>
        </section>
        <Separator />
        <section>
          <h3 className="text-sm font-medium">Capabilities</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {agent.manifest.capabilities.length === 0 ? (
              <li className="text-muted-foreground">None declared</li>
            ) : (
              agent.manifest.capabilities.map((capability) => (
                <li key={capability.id} className="font-mono text-xs">
                  {capability.id}
                </li>
              ))
            )}
          </ul>
        </section>
        <Separator />
        <section>
          <h3 className="text-sm font-medium">Hooks</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {hooks.length === 0 ? (
              <li className="text-muted-foreground">None registered</li>
            ) : (
              hooks.map(({ capability, hook }) => (
                <li key={`${capability}:${hook.at}:${hook.scope}`}>
                  <span className="font-mono text-xs">{capability}</span>
                  <span>
                    {" "}
                    · {hook.at} {hook.scope}
                  </span>
                  <span className="text-muted-foreground">
                    {" "}
                    — {hookFrequency(hook)}
                  </span>
                </li>
              ))
            )}
          </ul>
        </section>
        <Separator />
        <section>
          <h3 className="text-sm font-medium">Tools</h3>
          <ul className="mt-2 space-y-2 text-sm">
            {tools.length === 0 ? (
              <li className="text-muted-foreground">None declared</li>
            ) : (
              tools.map((tool) => (
                <li key={tool.name}>
                  <span className="font-mono text-xs">{tool.name}</span>
                  {tool.description === undefined ? null : (
                    <span className="text-muted-foreground">
                      {" "}
                      — {tool.description}
                    </span>
                  )}
                </li>
              ))
            )}
          </ul>
        </section>
      </div>
    </ScrollArea>
  );
}
