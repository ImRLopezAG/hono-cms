import type {
  HookRegistry,
  LifecycleHookContext,
  LifecycleHookEvent,
  LifecycleHookHandler
} from "./types";

type Key = `${LifecycleHookEvent}:${string}`;

function key(event: LifecycleHookEvent, collection: string | "*"): Key {
  return `${event}:${collection}` as Key;
}

export function createHookRegistry(): HookRegistry {
  const handlers = new Map<Key, LifecycleHookHandler[]>();

  return {
    on(event, collection, handler) {
      const k = key(event, collection);
      let list = handlers.get(k);
      if (!list) {
        list = [];
        handlers.set(k, list);
      }
      list.push(handler);
      return () => {
        const current = handlers.get(k);
        if (!current) return;
        const idx = current.indexOf(handler);
        if (idx >= 0) current.splice(idx, 1);
        if (current.length === 0) handlers.delete(k);
      };
    },

    async run(event, collection, input, ctx: LifecycleHookContext) {
      let payload = input;
      const lists = [handlers.get(key(event, collection)) ?? [], handlers.get(key(event, "*")) ?? []];
      for (const list of lists) {
        for (const handler of list) {
          const next = await handler(payload, ctx);
          if (next && typeof next === "object") payload = next;
        }
      }
      return payload;
    }
  };
}
