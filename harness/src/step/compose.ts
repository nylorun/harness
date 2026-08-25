import type { StepMiddleware } from "../types/middleware.js";
import type { ObserveEvent } from "../types/shared.js";
import { StepContext } from "./context.js";

export async function runMiddleware(
  middleware: readonly StepMiddleware[],
  context: StepContext,
  terminal: () => Promise<void>,
  observe: (event: ObserveEvent) => void,
): Promise<void> {
  try {
    for (const item of middleware) {
      if (context.currentTripwire) return;
      observe({
        type: "middleware.before",
        turnId: context.input.turnId,
        stepId: context.input.stepId,
        attributes: { middlewareId: item.id },
      });
      const lease = context.beforeModelFacade();
      try {
        await item.beforeModel?.(lease.value);
      } catch (error) {
        context.tripwire({
          code: "middleware.before-failed",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        lease.revoke();
      }
    }
    if (context.currentTripwire) return;

    const around = middleware.filter((item) => item.aroundModel);
    const dispatch = async (index: number): Promise<void> => {
      if (index === around.length) return terminal();
      const item = around[index]!;
      const lease = context.afterModelFacade();
      let returned = false;
      let nextPromise: Promise<void> | undefined;
      observe({
        type: "middleware.around.entered",
        turnId: context.input.turnId,
        stepId: context.input.stepId,
        attributes: { middlewareId: item.id },
      });
      try {
        let handlerError: unknown;
        try {
          await item.aroundModel!(lease.value, () => {
            if (returned) throw new Error(`Middleware '${item.id}' called next() after returning`);
            if (nextPromise)
              throw new Error(`Middleware '${item.id}' called next() more than once`);
            nextPromise = dispatch(index + 1);
            return nextPromise;
          });
        } catch (error) {
          handlerError = error;
        } finally {
          returned = true;
          lease.revoke();
        }

        if (!nextPromise)
          throw handlerError ?? new Error(`Middleware '${item.id}' must call next() exactly once`);

        // Always join the actual dispatch, including fire-and-forget `void next()`.
        let nextError: unknown;
        try {
          await nextPromise;
        } catch (error) {
          nextError = error;
        }
        if (handlerError) throw handlerError;
        if (nextError) throw nextError;
      } catch (error) {
        context.tripwire({
          code: "middleware.around-failed",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        lease.revoke();
        observe({
          type: "middleware.around.completed",
          turnId: context.input.turnId,
          stepId: context.input.stepId,
          attributes: { middlewareId: item.id },
        });
      }
    };
    await dispatch(0);
  } finally {
    context.seal();
  }
}
