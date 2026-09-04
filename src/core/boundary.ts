import type { SituationContext, SituationHandler } from "@mozaik-ai/core";

export type ParticipantBusinessHandler = (
  context: SituationContext,
) => void | Promise<void>;

export function withParticipantBoundary(
  specification: SituationHandler["specification"],
  businessHandler: ParticipantBusinessHandler,
  onFailure: (context: SituationContext, error: unknown) => void,
): SituationHandler {
  return {
    specification,
    processor: {
      apply(context) {
        try {
          const result = businessHandler(context);
          if (result instanceof Promise) {
            void result.catch((error: unknown) => onFailure(context, error));
          }
        } catch (error) {
          onFailure(context, error);
        }
      },
    },
  };
}
