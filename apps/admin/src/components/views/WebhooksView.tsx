import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "@tanstack/react-form";
import { RadioTower, RotateCcw, Send, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { type WebhookDelivery, type WebhookInput, type WebhookRecord } from "../../lib/api-client";
import { webhooksFromQuery } from "./query-helpers";
import { SettingsShell } from "./SettingsShell";
import { useClient } from "./shared";

type WebhookFormValues = {
  name: string;
  url: string;
  events: string;
  secret: string;
  enabled: boolean;
};

const URL_RE = /^https?:\/\/.+/i;

function defaultWebhookFormValues(selected: WebhookRecord | null): WebhookFormValues {
  return {
    name: selected?.name ?? "",
    url: selected?.url ?? "",
    events: selected?.events.join(", ") ?? "content.published",
    secret: "",
    enabled: selected?.enabled ?? true
  };
}

function webhookInputFromValues(values: WebhookFormValues): WebhookInput {
  const events = values.events
    .split(",")
    .map((event) => event.trim())
    .filter(Boolean);
  const secret = values.secret.trim();
  const input: WebhookInput = {
    name: values.name.trim(),
    url: values.url.trim(),
    events,
    enabled: values.enabled
  };
  if (secret) input.secret = secret;
  return input;
}

export function WebhooksView(): ReactElement {
  const client = useClient();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lastDelivery, setLastDelivery] = useState<WebhookDelivery | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["webhooks"], queryFn: () => client.webhooks() });
  const hooks = webhooksFromQuery(query.data);
  const selected = selectedWebhook(hooks, selectedId);
  const invalidateWebhooks = () => queryClient.invalidateQueries({ queryKey: ["webhooks"] });
  const createMutation = useMutation({
    mutationFn: (input: WebhookInput) => client.createWebhook(input),
    onSuccess: (hook) => {
      setSelectedId(hook.id);
      invalidateWebhooks();
      toast.success("Webhook created", { description: hook.name });
    },
    onError: (error) => {
      toast.error("Create webhook failed", { description: error instanceof Error ? error.message : "Try again" });
    }
  });
  const updateMutation = useMutation({
    mutationFn: (input: WebhookInput) => selected ? client.replaceWebhook(selected.id, input) : client.createWebhook(input),
    onSuccess: (hook) => {
      setSelectedId(hook.id);
      invalidateWebhooks();
      toast.success("Webhook saved", { description: hook.name });
    },
    onError: (error) => {
      toast.error("Save webhook failed", { description: error instanceof Error ? error.message : "Try again" });
    }
  });
  const toggleMutation = useMutation({
    mutationFn: (hook: WebhookRecord) => client.updateWebhook(hook.id, { enabled: !hook.enabled }),
    onSuccess: (hook) => {
      invalidateWebhooks();
      toast.success(hook.enabled ? "Webhook enabled" : "Webhook disabled");
    },
    onError: (error) => {
      toast.error("Toggle failed", { description: error instanceof Error ? error.message : "Try again" });
    }
  });
  const deleteMutation = useMutation({
    mutationFn: (hook: WebhookRecord) => client.deleteWebhook(hook.id),
    onSuccess: () => {
      setSelectedId(null);
      invalidateWebhooks();
      toast.success("Webhook deleted");
    },
    onError: (error) => {
      toast.error("Delete failed", { description: error instanceof Error ? error.message : "Try again" });
    }
  });
  const testMutation = useMutation({
    mutationFn: (hook: WebhookRecord) => client.testWebhook(hook.id),
    onSuccess: (delivery) => {
      setLastDelivery(delivery);
      if (selected) queryClient.invalidateQueries({ queryKey: ["webhook-deliveries", selected.id] });
      const ok = delivery.status === "success";
      const description = delivery.responseStatus ? `HTTP ${delivery.responseStatus}` : delivery.error ?? undefined;
      if (ok) toast.success("Test delivery succeeded", description ? { description } : undefined);
      else toast.error("Test delivery failed", description ? { description } : undefined);
    },
    onError: (error) => {
      toast.error("Test delivery failed", { description: error instanceof Error ? error.message : "Try again" });
    }
  });
  const deliveriesQuery = useInfiniteQuery({
    queryKey: ["webhook-deliveries", selected?.id],
    queryFn: ({ pageParam }) => selected ? client.webhookDeliveries(selected.id, { limit: 10, cursor: pageParam }) : Promise.resolve({ items: [] }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    enabled: Boolean(selected)
  });
  const retryDeliveryMutation = useMutation({
    mutationFn: (delivery: WebhookDelivery) => selected ? client.retryWebhookDelivery(selected.id, delivery.id) : Promise.reject(new Error("Select a webhook before retrying a delivery.")),
    onSuccess: (delivery) => {
      setLastDelivery(delivery);
      if (selected) {
        queryClient.invalidateQueries({ queryKey: ["webhook-deliveries", selected.id] });
        invalidateWebhooks();
      }
      const ok = delivery.status === "success";
      const description = delivery.responseStatus ? `HTTP ${delivery.responseStatus}` : delivery.error ?? undefined;
      if (ok) toast.success("Retry succeeded", description ? { description } : undefined);
      else toast.error("Retry failed", description ? { description } : undefined);
    },
    onError: (error) => {
      toast.error("Retry failed", { description: error instanceof Error ? error.message : "Try again" });
    }
  });
  const deliveries = deliveriesQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const busy = createMutation.isPending || updateMutation.isPending || toggleMutation.isPending || deleteMutation.isPending || testMutation.isPending || retryDeliveryMutation.isPending;

  const form = useForm({
    defaultValues: defaultWebhookFormValues(selected),
    onSubmit: async ({ value }) => {
      setSubmitError(null);
      const input = webhookInputFromValues(value);
      try {
        if (selected) await updateMutation.mutateAsync(input);
        else await createMutation.mutateAsync(input);
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : "Failed to save webhook");
      }
    }
  });

  // Re-seed form whenever the selected webhook changes (or switches to "new").
  useEffect(() => {
    form.reset(defaultWebhookFormValues(selected));
    setSubmitError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  return (
    <SettingsShell
      eyebrow="System"
      title="Webhooks"
      subtitle="HTTP callbacks triggered by content events."
      action={
        selected ? (
          <Button type="button" variant="outline" onClick={() => setSelectedId(null)} disabled={busy}>
            New webhook
          </Button>
        ) : undefined
      }
    >
      <div className="grid grid-cols-[320px_1fr] gap-6">
        {/* Left panel: list of existing webhooks */}
        <div className="rounded-lg border border-[#eaeaef] bg-white overflow-hidden shadow-sm">
          <div className="border-b border-[#eaeaef] px-4 py-3">
            <p className="text-[13px] font-semibold text-[#32324d]">Existing webhooks</p>
          </div>
          <div className="divide-y divide-[#eaeaef]">
            {hooks.map((hook) => (
              <button
                key={hook.id}
                type="button"
                onClick={() => setSelectedId(hook.id)}
                data-active={selected?.id === hook.id}
                className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[#f6f6f9] data-[active=true]:bg-[#f0f0ff] data-[active=true]:text-[#4945ff]"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <RadioTower size={15} className="shrink-0" />
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium truncate">{hook.name}</p>
                    <p className="text-[11px] text-[#8e8ea9] truncate">{hook.url}</p>
                  </div>
                </div>
                <span className={`text-[11px] shrink-0 ml-2 ${hook.enabled ? "text-[#328048]" : "text-[#8e8ea9]"}`}>
                  {hook.enabled ? "on" : "off"}
                </span>
              </button>
            ))}
            {hooks.length === 0 && (
              <p className="px-4 py-6 text-center text-[13px] text-[#8e8ea9]">No webhooks yet.</p>
            )}
          </div>
        </div>

        {/* Right panel: form to create/edit */}
        <div className="rounded-lg border border-[#eaeaef] bg-white overflow-hidden shadow-sm">
          <div className="flex items-center justify-between border-b border-[#eaeaef] px-6 py-4">
            <p className="text-[15px] font-semibold text-[#32324d]">{selected ? "Edit webhook" : "Create webhook"}</p>
            {selected && (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleMutation.mutate(selected)}
                  disabled={busy}
                >
                  <RotateCcw size={14} /> {selected.enabled ? "Disable" : "Enable"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => testMutation.mutate(selected)}
                  disabled={busy}
                >
                  <Send size={14} /> Test
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                  onClick={() => deleteMutation.mutate(selected)}
                  disabled={busy}
                >
                  <Trash2 size={14} /> Delete
                </Button>
              </div>
            )}
          </div>

          {/* One-time delivery status callout */}
          {(lastDelivery || selected?.lastDeliveryStatus) && (
            <div className="mx-6 mt-4 rounded-md border border-[#eaeaef] bg-[#f6f6f9] px-4 py-3">
              <p className="text-[12px] font-semibold uppercase tracking-wide text-[#8e8ea9] mb-0.5">Last delivery</p>
              <p className="text-[13px] font-medium text-[#32324d]">{lastDelivery?.status ?? selected?.lastDeliveryStatus}</p>
              <p className="text-[12px] text-[#8e8ea9]">
                {lastDelivery?.eventType ?? "last delivery"}{" "}
                {lastDelivery?.responseStatus ? `· HTTP ${lastDelivery.responseStatus}` : selected?.lastDeliveryAt ?? ""}
              </p>
            </div>
          )}

          <div className="p-6">
            <form
              id="webhook-form"
              className="flex flex-col gap-5"
              onSubmit={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void form.handleSubmit();
              }}
            >
              <form.Field
                name="name"
                validators={{
                  onChange: ({ value }) => (value.trim() ? undefined : "Required")
                }}
              >
                {(field) => (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="wh-name" className="text-[13px] font-medium text-[#32324d]">Name</Label>
                    <Input
                      id="wh-name"
                      name="name"
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.currentTarget.value)}
                    />
                    {field.state.meta.errors.length > 0 && (
                      <p className="text-[12px] text-red-600">{String(field.state.meta.errors[0])}</p>
                    )}
                  </div>
                )}
              </form.Field>

              <form.Field
                name="url"
                validators={{
                  onChange: ({ value }) => {
                    const trimmed = value.trim();
                    if (!trimmed) return "Required";
                    if (!URL_RE.test(trimmed)) return "Must start with http:// or https://";
                    return undefined;
                  }
                }}
              >
                {(field) => (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="wh-url" className="text-[13px] font-medium text-[#32324d]">Endpoint URL</Label>
                    <Input
                      id="wh-url"
                      name="url"
                      type="url"
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.currentTarget.value)}
                    />
                    {field.state.meta.errors.length > 0 && (
                      <p className="text-[12px] text-red-600">{String(field.state.meta.errors[0])}</p>
                    )}
                  </div>
                )}
              </form.Field>

              <form.Field
                name="events"
                validators={{
                  onChange: ({ value }) => {
                    const entries = value
                      .split(",")
                      .map((entry) => entry.trim())
                      .filter(Boolean);
                    if (entries.length === 0) return "At least one event is required";
                    return undefined;
                  }
                }}
              >
                {(field) => (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="wh-events" className="text-[13px] font-medium text-[#32324d]">Events</Label>
                    <Input
                      id="wh-events"
                      name="events"
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.currentTarget.value)}
                    />
                    {field.state.meta.errors.length > 0 ? (
                      <p className="text-[12px] text-red-600">{String(field.state.meta.errors[0])}</p>
                    ) : (
                      <p className="text-[12px] text-[#8e8ea9]">Comma-separated list (e.g. content.published, media.uploaded)</p>
                    )}
                  </div>
                )}
              </form.Field>

              <form.Field name="secret">
                {(field) => (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="wh-secret" className="text-[13px] font-medium text-[#32324d]">Secret</Label>
                    <Input
                      id="wh-secret"
                      name="secret"
                      type="password"
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.currentTarget.value)}
                      placeholder={selected?.hasSecret || selected?.secret ? "Leave blank to keep existing secret" : "Optional signing secret"}
                    />
                  </div>
                )}
              </form.Field>

              <form.Field name="enabled">
                {(field) => (
                  <div className="flex items-center gap-3">
                    <Switch
                      id="wh-enabled"
                      checked={field.state.value}
                      onCheckedChange={(checked) => field.handleChange(checked)}
                    />
                    <Label htmlFor="wh-enabled" className="text-[13px] font-medium text-[#32324d]">Enabled</Label>
                  </div>
                )}
              </form.Field>

              {submitError && (
                <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
                  {submitError}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-4 border-t border-[#eaeaef] mt-1">
                {selected && (
                  <Button type="button" variant="ghost" onClick={() => setSelectedId(null)} disabled={busy}>
                    Cancel
                  </Button>
                )}
                <Button type="submit" disabled={busy}>
                  {selected ? "Save" : "Create"}
                </Button>
              </div>
            </form>
          </div>

          {/* Deliveries section */}
          {selected && (
            <div className="border-t border-[#eaeaef] px-6 py-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-[13px] font-semibold text-[#32324d]">Deliveries</p>
                {deliveriesQuery.hasNextPage && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void deliveriesQuery.fetchNextPage()}
                    disabled={deliveriesQuery.isFetchingNextPage}
                  >
                    Load more
                  </Button>
                )}
              </div>
              <div className="divide-y divide-[#eaeaef] rounded-md border border-[#eaeaef] overflow-hidden">
                {deliveries.map((delivery) => (
                  <div key={delivery.id} className="flex items-center justify-between px-4 py-3 bg-white hover:bg-[#f6f6f9]">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[13px] font-medium text-[#32324d]">{delivery.status}</span>
                      <span className="text-[12px] text-[#8e8ea9]">{delivery.eventType} · {delivery.createdAt}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] text-[#8e8ea9]">
                        {delivery.responseStatus ? `HTTP ${delivery.responseStatus}` : delivery.error ?? "pending"}
                      </span>
                      {isRetryableWebhookDelivery(delivery) && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => retryDeliveryMutation.mutate(delivery)}
                          disabled={busy}
                        >
                          <RotateCcw size={13} /> Retry
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
                {!deliveries.length && (
                  <p className="px-4 py-6 text-center text-[13px] text-[#8e8ea9]">No deliveries recorded for this webhook.</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </SettingsShell>
  );
}

export function isRetryableWebhookDelivery(delivery: Pick<WebhookDelivery, "status">): boolean {
  return delivery.status === "failed";
}

export function webhookInputFromForm(form: FormData): WebhookInput {
  return {
    name: String(form.get("name") ?? "").trim(),
    url: String(form.get("url") ?? "").trim(),
    events: String(form.get("events") ?? "")
      .split(",")
      .map((event) => event.trim())
      .filter(Boolean),
    enabled: form.get("enabled") === "on",
    ...(String(form.get("secret") ?? "").trim() ? { secret: String(form.get("secret")).trim() } : {})
  };
}

export function selectedWebhook(hooks: WebhookRecord[], selectedId: string | null): WebhookRecord | null {
  if (!selectedId) return null;
  return hooks.find((hook) => hook.id === selectedId) ?? null;
}
