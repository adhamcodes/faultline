import {
  SituationSpecification,
  type SituationContext,
} from "@mozaik-ai/core";

export class MatchingEvent extends SituationSpecification {
  constructor(
    private readonly predicate: (context: SituationContext) => boolean,
  ) {
    super();
  }

  isSatisfiedBy(context: SituationContext): boolean {
    return this.predicate(context);
  }
}
