/**
 * Provider-neutral human conversation orchestration. Adapters supply protocol
 * and provenance hooks; this coordinator owns policy gating, replay/in-flight
 * suppression, best-effort ack ordering, routing/target preparation, one PI
 * invocation and one reply transition.
 */
export function createImConversationCoordinator<TInput, TPrepared, TRun>(hooks: {
  acknowledge(input: TInput): Promise<void>;
  alreadyHandled(input: TInput): boolean;
  dedupeKey(input: TInput): string;
  policy(input: TInput): string;
  prepare(input: TInput): TPrepared;
  reply(input: TInput, run: TRun): Promise<{ reason: string; replied: boolean }>;
  run(input: TInput, prepared: TPrepared): Promise<TRun>;
  text(run: TRun): string;
}) {
  const inFlight = new Set<string>();
  return {
    async handle(input: TInput): Promise<{ reason: string; replied: boolean }> {
      const policy = hooks.policy(input);
      if (policy) return { reason: policy, replied: false };
      const key = hooks.dedupeKey(input);
      if (inFlight.has(key)) return { reason: "duplicate_reply_in_flight", replied: false };
      inFlight.add(key);
      try {
        if (hooks.alreadyHandled(input)) return { reason: "duplicate_reply", replied: false };
        // Provider adapters must make acknowledgement best-effort; completion
        // here only establishes ordering before the potentially slow PI turn.
        await hooks.acknowledge(input);
        const prepared = hooks.prepare(input);
        const run = await hooks.run(input, prepared);
        if (hooks.text(run).trim() === "") return { reason: "empty_agent_reply", replied: false };
        return hooks.reply(input, run);
      } finally {
        inFlight.delete(key);
      }
    }
  };
}
