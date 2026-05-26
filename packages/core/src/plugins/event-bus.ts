import type { CMSEvents, PluginEvents } from "./types";

type Handler<E extends keyof CMSEvents> = (payload: CMSEvents[E]) => unknown | Promise<unknown>;

export function createEventBus(): PluginEvents {
  const handlers = new Map<keyof CMSEvents, Set<Handler<keyof CMSEvents>>>();

  return {
    on<E extends keyof CMSEvents>(event: E, handler: (payload: CMSEvents[E]) => unknown | Promise<unknown>) {
      let bucket = handlers.get(event);
      if (!bucket) {
        bucket = new Set();
        handlers.set(event, bucket);
      }
      bucket.add(handler as Handler<keyof CMSEvents>);
      return () => {
        const current = handlers.get(event);
        if (current) {
          current.delete(handler as Handler<keyof CMSEvents>);
          if (current.size === 0) handlers.delete(event);
        }
      };
    },

    async emit<E extends keyof CMSEvents>(event: E, payload: CMSEvents[E]): Promise<void> {
      const bucket = handlers.get(event);
      if (!bucket || bucket.size === 0) return;
      const snapshot = Array.from(bucket) as Array<Handler<E>>;
      const errors: unknown[] = [];
      await Promise.all(
        snapshot.map(async (handler) => {
          try {
            await handler(payload);
          } catch (err) {
            errors.push(err);
          }
        })
      );
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        const aggregate = new AggregateError(errors, `Event handler(s) for "${String(event)}" threw.`);
        throw aggregate;
      }
    }
  };
}
