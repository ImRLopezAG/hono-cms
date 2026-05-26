import { useEffect, useId, useMemo, useState, type ReactElement } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

/**
 * Strapi mirror: clicking "Create new collection type" in Rail 2 opens this
 * Dialog before the form pane enters create mode. The Dialog captures the
 * Display name, auto-derives a kebab-case API ID, and lets the operator
 * toggle Draft & Publish. On Continue, the parent enters create mode with
 * the chosen API ID and draftAndPublish prefilled.
 */

export type NewCollectionTypeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingNames: readonly string[];
  onContinue: (input: { name: string; draftAndPublish: boolean }) => void;
};

const COLLECTION_NAME_RE = /^[a-z][a-z0-9-]*$/;

export function slugifyDisplayName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase()
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "");
}

export function pluralizeName(value: string): string {
  if (!value) return value;
  if (value.endsWith("s")) return value;
  if (value.endsWith("y") && !/[aeiou]y$/.test(value)) return `${value.slice(0, -1)}ies`;
  return `${value}s`;
}

export function validateCollectionApiId(
  value: string,
  existingNames: readonly string[]
): { ok: true } | { ok: false; reason: string } {
  if (!value) return { ok: false, reason: "API ID is required." };
  if (!COLLECTION_NAME_RE.test(value)) {
    return {
      ok: false,
      reason: "API ID must be kebab-case and start with a lowercase letter (a-z, 0-9, -)."
    };
  }
  if (existingNames.includes(value)) {
    return { ok: false, reason: `Collection "${value}" already exists.` };
  }
  return { ok: true };
}

export function NewCollectionTypeDialog({
  open,
  onOpenChange,
  existingNames,
  onContinue
}: NewCollectionTypeDialogProps): ReactElement {
  const titleId = useId();
  const descId = useId();
  const [displayName, setDisplayName] = useState("");
  const [apiIdSingular, setApiIdSingular] = useState("");
  const [apiIdPlural, setApiIdPlural] = useState("");
  const [apiIdTouched, setApiIdTouched] = useState(false);
  const [draftAndPublish, setDraftAndPublish] = useState(true);

  // Reset state on every fresh open so leftover values don't bleed in.
  useEffect(() => {
    if (open) {
      setDisplayName("");
      setApiIdSingular("");
      setApiIdPlural("");
      setApiIdTouched(false);
      setDraftAndPublish(true);
    }
  }, [open]);

  // Auto-derive API IDs from display name until the operator edits them.
  useEffect(() => {
    if (apiIdTouched) return;
    const singular = slugifyDisplayName(displayName);
    setApiIdSingular(singular);
    setApiIdPlural(singular ? pluralizeName(singular) : "");
  }, [displayName, apiIdTouched]);

  const validation = useMemo(
    () => validateCollectionApiId(apiIdPlural, existingNames),
    [apiIdPlural, existingNames]
  );

  const canContinue = displayName.trim().length > 0 && validation.ok;

  const handleContinue = () => {
    if (!canContinue) return;
    onContinue({ name: apiIdPlural, draftAndPublish });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[520px]"
        aria-labelledby={titleId}
        aria-describedby={descId}
      >
        <DialogHeader>
          <DialogTitle id={titleId}>Create a collection type</DialogTitle>
          <DialogDescription id={descId}>
            Give your new collection a display name. The API IDs auto-derive from it; edit them if you need a different shape.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-1 py-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-ct-display-name" className="text-[13px] font-semibold text-[#32324d]">
              Display name
            </Label>
            <Input
              id="new-ct-display-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.currentTarget.value)}
              placeholder="Article"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-ct-api-singular" className="text-[13px] font-semibold text-[#32324d]">
                API ID (singular)
              </Label>
              <Input
                id="new-ct-api-singular"
                value={apiIdSingular}
                onChange={(event) => {
                  setApiIdSingular(event.currentTarget.value);
                  setApiIdTouched(true);
                }}
                placeholder="article"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-ct-api-plural" className="text-[13px] font-semibold text-[#32324d]">
                API ID (plural)
              </Label>
              <Input
                id="new-ct-api-plural"
                value={apiIdPlural}
                onChange={(event) => {
                  setApiIdPlural(event.currentTarget.value);
                  setApiIdTouched(true);
                }}
                placeholder="articles"
              />
            </div>
          </div>

          {!validation.ok && apiIdPlural.length > 0 ? (
            <p className="text-[12px] text-red-600">{validation.reason}</p>
          ) : (
            <p className="text-[12px] text-[#666687]">
              The plural API ID becomes the REST path: <code className="rounded bg-[#f6f6f9] px-1 py-0.5">/api/{apiIdPlural || "<plural>"}</code>
            </p>
          )}

          <div className="flex items-start gap-3 rounded-md border border-[#eaeaef] bg-[#f6f6f9] px-4 py-3">
            <div className="flex-1">
              <div className="text-[13px] font-semibold text-[#32324d]">Draft &amp; publish</div>
              <div className="text-[12px] text-[#666687]">Add draft / published workflow to records. Recommended for editorial content.</div>
            </div>
            <Switch
              id="new-ct-draft-and-publish"
              checked={draftAndPublish}
              onCheckedChange={setDraftAndPublish}
              aria-label="Draft and publish"
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleContinue}
            disabled={!canContinue}
            className="bg-[#4945ff] hover:bg-[#7b79ff]"
          >
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
