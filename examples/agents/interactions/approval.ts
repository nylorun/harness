import { middleware } from "@nylorun/harness";

/** Candidate review is the policy layer; services and tools do not self-authorize writes. */
export function approvalFor(...names: readonly string[]) {
  return middleware(async (_request, next) => {
    const response = await next();
    for (const call of response.toolCalls()) {
      if (names.includes(call.name)) {
        response.requireInteraction(call.id, {
          kind: "approval",
          prompt: `Approve ${call.name}?\n\n${JSON.stringify(call.args)}`,
        });
      }
    }
    return response;
  });
}
