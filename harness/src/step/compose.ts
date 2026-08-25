import type { BoundMiddleware, StepResponse } from "../types/middleware.js";
import type { ObserveEvent } from "../types/shared.js";
import { isBrandedResponse, StepContext } from "./context.js";

export async function runMiddleware(
  middleware: readonly BoundMiddleware[],
  context: StepContext,
  terminal: () => Promise<StepResponse>,
  observe: (event: ObserveEvent) => void,
): Promise<StepResponse> {
  const dispatch = async (index: number): Promise<StepResponse> => {
    if (context.currentTripwire) return context.tripwire(context.currentTripwire);
    if (index === middleware.length) return terminal();

    const item = middleware[index]!;
    const lease = context.requestFacade(item.id);
    let returned = false;
    let nextPromise: Promise<StepResponse> | undefined;
    observe({
      type: "middleware.entered",
      turnId: context.input.turnId,
      stepId: context.input.stepId,
      attributes: { middlewareId: item.id },
    });
    try {
      let handlerError: unknown;
      let result: unknown;
      try {
        result = await item.handle(lease.value, () => {
          if (returned) throw new Error(`Middleware '${item.id}' called next() after returning`);
          if (nextPromise) throw new Error(`Middleware '${item.id}' called next() more than once`);
          lease.revokeMutators();
          nextPromise = dispatch(index + 1);
          return nextPromise;
        });
      } catch (error) {
        handlerError = error;
      } finally {
        returned = true;
        lease.revokeMutators();
      }

      let inner: StepResponse | undefined;
      if (nextPromise) {
        try {
          inner = await nextPromise;
        } catch (error) {
          handlerError ??= error;
        }
      }

      if (handlerError) {
        if (/called next\(\) more than once/.test(message(handlerError))) {
          return context.tripwire({
            code: "middleware.next-called-twice",
            message: message(handlerError),
            scope: "session",
          });
        }
        return context.tripwire({
          code: "middleware.failed",
          message: message(handlerError),
        });
      }

      if (inner) {
        if (result !== inner) {
          return context.tripwire({
            code: "middleware.invalid-response",
            message: `Middleware '${item.id}' must return the StepResponse from next()`,
            scope: "session",
          });
        }
        return inner;
      }

      if (!isBrandedResponse(result)) {
        return context.tripwire({
          code: "middleware.invalid-response",
          message: `Middleware '${item.id}' must return a branded StepResponse`,
          scope: "session",
        });
      }
      return result;
    } finally {
      observe({
        type: "middleware.completed",
        turnId: context.input.turnId,
        stepId: context.input.stepId,
        attributes: { middlewareId: item.id },
      });
    }
  };

  try {
    return await dispatch(0);
  } finally {
    context.seal();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
