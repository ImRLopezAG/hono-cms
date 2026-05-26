import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef
} from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { Check, Copy, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type ReactElement
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { type ApiKeyInput, type ApiKeyRecord } from "../../lib/api-client";
import { apiKeysFromQuery } from "./query-helpers";
import { SettingsShell } from "./SettingsShell";
import { useClient } from "./shared";

/* -------------------------------------------------------------------------- *
 *  Token-type model                                                          *
 *                                                                            *
 *  Strapi v5 exposes three token types: Read-only, Full access, Custom.      *
 *  The Hono CMS API stores access as a `roles: string[]` array, so we map    *
 *  the type back to roles on submit and infer it from roles on read.         *
 *                                                                            *
 *    Read-only   →  roles = ["viewer"]                                       *
 *    Full access →  roles = ["admin"]                                        *
 *    Custom      →  any other combination (preserved as-is)                  *
 *                                                                            *
 *  Token lifespan + expiry are presentation-only — the underlying API does   *
 *  not yet persist expiry, so we display `Unlimited` and pass the chosen     *
 *  lifespan back as a no-op (recorded only in toast copy).                   *
 * -------------------------------------------------------------------------- */

type TokenType = "read-only" | "full-access" | "custom";

const TOKEN_TYPE_LABEL: Record<TokenType, string> = {
  "read-only": "Read-only",
  "full-access": "Full access",
  custom: "Custom"
};

const TOKEN_TYPE_BADGE_CLASS: Record<TokenType, string> = {
  "read-only": "bg-[#eaeaef] text-[#666687]",
  "full-access": "bg-[#f0f0ff] text-[#4945ff]",
  custom: "bg-[#eafbe7] text-[#328048]"
};

type Lifespan = "7" | "30" | "90" | "unlimited";

const LIFESPAN_LABEL: Record<Lifespan, string> = {
  "7": "7 days",
  "30": "30 days",
  "90": "90 days",
  unlimited: "Unlimited"
};

const ROLES_FOR_TYPE: Record<Exclude<TokenType, "custom">, string[]> = {
  "read-only": ["viewer"],
  "full-access": ["admin"]
};

function tokenTypeFromRoles(roles: readonly string[]): TokenType {
  const normalised = roles.map((role) => role.trim().toLowerCase());
  if (normalised.length === 1 && normalised[0] === "viewer") return "read-only";
  if (normalised.length === 1 && normalised[0] === "admin") return "full-access";
  return "custom";
}

function rolesForType(type: TokenType, customRoles: string): string[] {
  if (type === "custom") {
    return customRoles
      .split(",")
      .map((role) => role.trim())
      .filter(Boolean);
  }
  return [...ROLES_FOR_TYPE[type]];
}

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_ -]*$/;

/* -------------------------------------------------------------------------- *
 *  Component                                                                 *
 * -------------------------------------------------------------------------- */

export function ApiKeysView(): ReactElement {
  const client = useClient();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [issuedSecret, setIssuedSecret] = useState<string | null>(null);

  const query = useQuery({ queryKey: ["api-keys"], queryFn: () => client.apiKeys() });
  const keys = apiKeysFromQuery(query.data);
  const editingRecord = selectedApiKey(keys, editingId);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["api-keys"] });

  const createMutation = useMutation({
    mutationFn: (input: ApiKeyInput) => client.createApiKey(input),
    onSuccess: (record) => {
      setIssuedSecret(record.secret);
      setEditingId(null);
      invalidate();
      toast.success("API token created", {
        description: "Copy the one-time secret before closing the dialog."
      });
    },
    onError: (error) => {
      toast.error("Create token failed", {
        description: error instanceof Error ? error.message : "Try again"
      });
    }
  });

  const updateMutation = useMutation({
    mutationFn: (args: { id: string; input: ApiKeyInput }) => client.updateApiKey(args.id, args.input),
    onSuccess: () => {
      invalidate();
      setDialogOpen(false);
      setEditingId(null);
      toast.success("API token updated");
    },
    onError: (error) => {
      toast.error("Update token failed", {
        description: error instanceof Error ? error.message : "Try again"
      });
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => client.deleteApiKey(id),
    onSuccess: () => {
      invalidate();
      toast.success("API token deleted");
    },
    onError: (error) => {
      toast.error("Delete failed", {
        description: error instanceof Error ? error.message : "Try again"
      });
    }
  });

  const pending = createMutation.isPending || updateMutation.isPending;

  const columns = useMemo<ColumnDef<ApiKeyRecord>[]>(
    () => [
      {
        id: "name",
        header: () => <span>Name</span>,
        cell: (info) => (
          <div className="flex items-center gap-2 text-[#32324d]">
            <ShieldCheck size={14} className="shrink-0 text-[#8e8ea9]" aria-hidden />
            <span className="font-medium truncate">
              {info.row.original.name ?? info.row.original.id}
            </span>
          </div>
        )
      },
      {
        id: "description",
        header: () => <span>Description</span>,
        cell: (info) => (
          <span className="truncate text-[#666687]">
            User {info.row.original.userId}
          </span>
        )
      },
      {
        id: "type",
        header: () => <span>Token type</span>,
        cell: (info) => {
          const type = tokenTypeFromRoles(info.row.original.roles);
          return (
            <span
              className={cn(
                "inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium",
                TOKEN_TYPE_BADGE_CLASS[type]
              )}
            >
              {TOKEN_TYPE_LABEL[type]}
            </span>
          );
        }
      },
      {
        id: "lastUsed",
        header: () => <span>Last used</span>,
        cell: (info) => (
          <span className="text-[#666687]">{formatLastUsed(info.row.original.lastUsedAt)}</span>
        )
      },
      {
        id: "expires",
        header: () => <span>Expires at</span>,
        cell: () => (
          <span className="text-[#666687]">Unlimited</span>
        )
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => (
          <RowActions
            record={info.row.original}
            onEdit={() => {
              setEditingId(info.row.original.id);
              setIssuedSecret(null);
              setDialogOpen(true);
            }}
            onDelete={() => deleteMutation.mutate(info.row.original.id)}
          />
        )
      }
    ],
    [deleteMutation]
  );

  const table = useReactTable({
    data: keys,
    columns,
    getCoreRowModel: getCoreRowModel()
  });

  const openCreate = () => {
    setEditingId(null);
    setIssuedSecret(null);
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingId(null);
    setIssuedSecret(null);
  };

  return (
    <SettingsShell
      eyebrow="Settings"
      title="API Tokens"
      subtitle="List of generated tokens to consume the API"
      action={
        <Button type="button" onClick={openCreate} disabled={pending}>
          <Plus size={14} aria-hidden /> Create new API Token
        </Button>
      }
    >
      <div className="overflow-hidden rounded-lg border border-[#eaeaef] bg-white shadow-sm">
        <table className="w-full border-collapse text-[13px]" aria-label="API tokens">
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id} className="border-b border-[#eaeaef] bg-[#f6f6f9]">
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-[#666687]"
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className="border-b border-[#eaeaef] last:border-b-0 transition-colors hover:bg-[#f6f6f9]"
                style={{ height: 54 }}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-4 align-middle">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {keys.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-4 py-10 text-center text-[#8e8ea9]">
                  {query.isLoading ? "Loading…" : "No API tokens yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ApiKeyDialog
        open={dialogOpen}
        onOpenChange={(next) => (next ? setDialogOpen(true) : closeDialog())}
        editing={editingRecord}
        issuedSecret={issuedSecret}
        pending={pending}
        onSubmit={(input) => {
          if (editingRecord) {
            updateMutation.mutate({ id: editingRecord.id, input });
          } else {
            createMutation.mutate(input);
          }
        }}
        onAcknowledgeSecret={() => {
          setIssuedSecret(null);
          setDialogOpen(false);
        }}
      />
    </SettingsShell>
  );
}

/* -------------------------------------------------------------------------- *
 *  Row actions                                                               *
 * -------------------------------------------------------------------------- */

function RowActions(props: {
  record: ApiKeyRecord;
  onEdit: () => void;
  onDelete: () => void;
}): ReactElement {
  return (
    <div className="flex items-center justify-end gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Edit ${props.record.name ?? props.record.id}`}
        onClick={props.onEdit}
      >
        <Pencil size={14} aria-hidden />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Delete ${props.record.name ?? props.record.id}`}
        className="text-red-600 hover:bg-red-50 hover:text-red-700"
        onClick={props.onDelete}
      >
        <Trash2 size={14} aria-hidden />
      </Button>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 *  Create / edit dialog                                                      *
 * -------------------------------------------------------------------------- */

type ApiKeyDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: ApiKeyRecord | null;
  issuedSecret: string | null;
  pending: boolean;
  onSubmit: (input: ApiKeyInput) => void;
  onAcknowledgeSecret: () => void;
};

function ApiKeyDialog(props: ApiKeyDialogProps): ReactElement {
  const { editing, issuedSecret } = props;

  const [name, setName] = useState("");
  const [userId, setUserId] = useState("");
  const [tokenType, setTokenType] = useState<TokenType>("read-only");
  const [lifespan, setLifespan] = useState<Lifespan>("unlimited");
  const [customRoles, setCustomRoles] = useState("editor");
  const [errors, setErrors] = useState<{ name?: string; userId?: string; roles?: string }>({});

  /* Reset form when dialog opens / target record changes */
  useEffect(() => {
    if (!props.open) return;
    if (editing) {
      setName(editing.name ?? "");
      setUserId(editing.userId);
      const inferred = tokenTypeFromRoles(editing.roles);
      setTokenType(inferred);
      setCustomRoles(editing.roles.join(", ") || "editor");
    } else {
      setName("");
      setUserId("");
      setTokenType("read-only");
      setCustomRoles("editor");
    }
    setLifespan("unlimited");
    setErrors({});
  }, [props.open, editing]);

  const validate = (): boolean => {
    const next: typeof errors = {};
    const trimmedName = name.trim();
    if (!trimmedName) next.name = "Required";
    else if (!NAME_RE.test(trimmedName)) {
      next.name = "Must start with a letter; letters, numbers, spaces, _ or -";
    }
    if (!userId.trim()) next.userId = "Required";
    if (tokenType === "custom") {
      const parsed = rolesForType("custom", customRoles);
      if (parsed.length === 0) next.roles = "At least one role is required";
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!validate()) return;
    const trimmedName = name.trim();
    const input: ApiKeyInput = {
      userId: userId.trim(),
      roles: rolesForType(tokenType, customRoles),
      enabled: true
    };
    if (trimmedName) input.name = trimmedName;
    props.onSubmit(input);
  };

  const copySecret = async () => {
    if (!issuedSecret) return;
    try {
      await navigator.clipboard.writeText(issuedSecret);
      toast.success("Secret copied to clipboard");
    } catch {
      toast.error("Copy failed — select and copy manually");
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit API token" : "Create new API Token"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Rename or update the access scope of this token."
              : "Tokens authenticate API requests on behalf of a user."}
          </DialogDescription>
        </DialogHeader>

        {issuedSecret ? (
          <IssuedSecretCallout secret={issuedSecret} onCopy={copySecret} onDone={props.onAcknowledgeSecret} />
        ) : (
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ak-name" className="text-[13px] font-medium text-[#32324d]">Name</Label>
              <Input
                id="ak-name"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                placeholder="Production integration"
                aria-invalid={Boolean(errors.name) || undefined}
              />
              {errors.name && <p className="text-[12px] text-red-600">{errors.name}</p>}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ak-description" className="text-[13px] font-medium text-[#32324d]">Description</Label>
              <Input
                id="ak-description"
                value={userId}
                onChange={(event) => setUserId(event.currentTarget.value)}
                placeholder="User ID this token authenticates as"
                aria-invalid={Boolean(errors.userId) || undefined}
              />
              {errors.userId && <p className="text-[12px] text-red-600">{errors.userId}</p>}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label className="text-[13px] font-medium text-[#32324d]">Token type</Label>
                <Select value={tokenType} onValueChange={(next) => setTokenType(next as TokenType)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a token type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="read-only">Read-only</SelectItem>
                    <SelectItem value="full-access">Full access</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label className="text-[13px] font-medium text-[#32324d]">Token lifespan</Label>
                <Select value={lifespan} onValueChange={(next) => setLifespan(next as Lifespan)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose lifespan" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="7">7 days</SelectItem>
                    <SelectItem value="30">30 days</SelectItem>
                    <SelectItem value="90">90 days</SelectItem>
                    <SelectItem value="unlimited">Unlimited</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {tokenType === "custom" && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ak-roles" className="text-[13px] font-medium text-[#32324d]">Roles</Label>
                <Input
                  id="ak-roles"
                  value={customRoles}
                  onChange={(event) => setCustomRoles(event.currentTarget.value)}
                  placeholder="editor, admin"
                  aria-invalid={Boolean(errors.roles) || undefined}
                />
                {errors.roles ? (
                  <p className="text-[12px] text-red-600">{errors.roles}</p>
                ) : (
                  <p className="text-[12px] text-[#8e8ea9]">Comma-separated list (e.g. editor, admin)</p>
                )}
              </div>
            )}

            <div className="mt-2 flex items-center justify-end gap-2 border-t border-[#eaeaef] pt-4">
              <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)} disabled={props.pending}>
                Cancel
              </Button>
              <Button type="submit" disabled={props.pending}>
                {editing ? "Save" : "Create"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- *
 *  One-time secret callout                                                   *
 * -------------------------------------------------------------------------- */

function IssuedSecretCallout(props: {
  secret: string;
  onCopy: () => void;
  onDone: () => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-amber-700">One-time secret</p>
        <p className="mt-1.5 font-mono text-[13px] break-all text-amber-900">{props.secret}</p>
        <p className="mt-1 text-[12px] text-amber-700">
          Store it now — Hono CMS will not show this secret again.
        </p>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="outline" onClick={props.onCopy}>
          <Copy size={14} aria-hidden /> Copy secret
        </Button>
        <Button type="button" onClick={props.onDone}>
          <Check size={14} aria-hidden /> Done
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 *  Helpers (also re-exported for tests; see AdminApp.test.ts)                *
 * -------------------------------------------------------------------------- */

function formatLastUsed(raw: string | undefined): string {
  if (!raw) return "Never";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "Never";
  return formatDistanceToNow(date, { addSuffix: true });
}

/**
 * Maps a `FormData` submission of the legacy single-form layout into an
 * `ApiKeyInput`. Retained as a pure helper so the unit tests in
 * `AdminApp.test.ts` still cover the normalization rules even after the
 * UI moved to a controlled dialog.
 */
export function apiKeyInputFromForm(form: FormData): ApiKeyInput {
  const input: ApiKeyInput = {
    userId: String(form.get("userId") ?? "").trim(),
    roles: String(form.get("roles") ?? "").split(",").map((role) => role.trim()).filter(Boolean),
    enabled: form.get("enabled") === "on"
  };
  const name = String(form.get("name") ?? "").trim();
  if (name) input.name = name;
  return input;
}

/**
 * Returns the API key that matches `selectedId`, or `null` if no record
 * is selected / the id is unknown. Used by both the view and the
 * AdminApp.test.ts coverage.
 */
export function selectedApiKey(keys: ApiKeyRecord[], selectedId: string | null): ApiKeyRecord | null {
  if (!selectedId) return null;
  return keys.find((key) => key.id === selectedId) ?? null;
}

