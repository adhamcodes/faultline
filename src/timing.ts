export interface CompletedInterval {
  name: string;
  startedAtMs: number;
  finishedAtMs: number;
}

export interface PairwiseOverlap {
  participants: [string, string];
  overlapMs: number;
  overlaps: boolean;
}

export interface TimingSummary {
  allIntervalsOverlap: boolean;
  maximumConcurrency: number;
  naiveSumDurationMs: number;
  wallClockMs: number;
  concurrentSavingsMs: number;
  pairwise: PairwiseOverlap[];
}

export function intervalOverlapMs(
  left: CompletedInterval,
  right: CompletedInterval,
): number {
  return Math.max(
    0,
    Math.min(left.finishedAtMs, right.finishedAtMs) -
      Math.max(left.startedAtMs, right.startedAtMs),
  );
}

export function maximumConcurrency(intervals: CompletedInterval[]): number {
  const points = intervals.flatMap((interval) => [
    { at: interval.startedAtMs, delta: 1 },
    { at: interval.finishedAtMs, delta: -1 },
  ]);

  // At equal timestamps, an ending interval is processed before a starting one.
  points.sort((left, right) => left.at - right.at || left.delta - right.delta);

  let active = 0;
  let maximum = 0;
  for (const point of points) {
    active += point.delta;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

export function summarizeTiming(
  intervals: CompletedInterval[],
  wallClockMs: number,
): TimingSummary {
  const pairwise: PairwiseOverlap[] = [];
  for (let leftIndex = 0; leftIndex < intervals.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < intervals.length;
      rightIndex += 1
    ) {
      const left = intervals[leftIndex];
      const right = intervals[rightIndex];
      const overlapMs = intervalOverlapMs(left, right);
      pairwise.push({
        participants: [left.name, right.name],
        overlapMs,
        overlaps: overlapMs > 0,
      });
    }
  }

  const naiveSumDurationMs = intervals.reduce(
    (sum, interval) => sum + interval.finishedAtMs - interval.startedAtMs,
    0,
  );
  const latestStart = Math.max(...intervals.map((item) => item.startedAtMs));
  const earliestFinish = Math.min(...intervals.map((item) => item.finishedAtMs));

  return {
    allIntervalsOverlap:
      intervals.length > 1 && latestStart < earliestFinish,
    maximumConcurrency: maximumConcurrency(intervals),
    naiveSumDurationMs,
    wallClockMs,
    concurrentSavingsMs: naiveSumDurationMs - wallClockMs,
    pairwise,
  };
}
