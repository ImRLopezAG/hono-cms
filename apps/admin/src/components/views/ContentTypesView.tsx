import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { Link } from "@tanstack/react-router";
import {
  AlignLeft,
  Calendar,
  CalendarClock,
  Clock,
  Code2,
  Copy,
  FileText,
  Hash,
  Image as ImageIcon,
  Link as LinkIcon,
  List,
  Lock,
  Mail,
  Plus,
  Save,
  Settings as SettingsIcon,
  Sparkles,
  Table2,
  ToggleLeft,
  Trash2,
  Type
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactElement } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { AdminApiError, type AdminSchemaField, type AdminSchemaMetadata, type ContentTypeInput } from "../../lib/api-client";
import { useRail2Slot } from "./AppFrame";
import { NewCollectionTypeDialog } from "./NewCollectionTypeDialog";
import { editorMutationErrorMessage, emptySchemaMetadata } from "./query-helpers";
import { useClient } from "./shared";

type ContentTypeFieldKind = AdminSchemaField["kind"];
type ContentTypeFieldDraft = {
  id: string;
  name: string;
  kind: ContentTypeFieldKind;
  required: boolean;
  unique: boolean;
  localized: boolean;
  private: boolean;
  min: string;
  max: string;
  int: boolean;
  values: string;
  multiple: boolean;
  target: string;
  targetField: string;
  cardinality: string;
  inverse: string;
  onDelete: string;
};

export function ContentTypesView(): ReactElement {
  const client = useClient();
  const queryClient = useQueryClient();
  const formRef = useRef<HTMLFormElement>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [lastWrite, setLastWrite] = useState<{ title: string; details: readonly string[]; source?: string } | null>(null);
  const [addFieldOpen, setAddFieldOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [pendingNewName, setPendingNewName] = useState<{ name: string; draftAndPublish: boolean } | null>(null);
  const query = useQuery({ queryKey: ["content-types"], queryFn: () => client.contentTypes() });
  const fallback = { collections: emptySchemaMetadata().collections, capabilities: { writable: false, mode: "read-only" } };
  const data = query.data ?? fallback;
  const collections = Object.values(data.collections);
  const selected = selectedName ? data.collections[selectedName] ?? null : null;
  const writable = data.capabilities.writable;
  const invalidateContentTypes = () => {
    queryClient.invalidateQueries({ queryKey: ["content-types"] });
    queryClient.invalidateQueries({ queryKey: ["schema"] });
  };
  const saveMutation = useMutation({
    mutationFn: (input: ContentTypeInput) => selected ? client.updateContentType(selected.name, input) : client.createContentType(input),
    onSuccess: (result) => {
      setSelectedName(result.collection.name);
      setLastWrite(contentTypeWriteSummary(result));
      invalidateContentTypes();
      toast.success(selected ? `Content type "${result.collection.name}" saved.` : `Content type "${result.collection.name}" created.`);
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to save content type.");
    }
  });
  const deleteMutation = useMutation({
    mutationFn: (name: string) => client.deleteContentType(name),
    onSuccess: (_, name) => {
      // Drop the form selection so we don't keep rendering edit state for a
      // collection that no longer exists.
      setSelectedName(null);
      setLastWrite(null);
      setDeleteDialogOpen(false);
      invalidateContentTypes();
      toast.success(`Deleted "${name}".`);
    },
    onError: (error: unknown, name) => {
      setDeleteDialogOpen(false);
      if (error instanceof AdminApiError && error.status === 404) {
        toast.error(`Collection "${name}" was already removed.`);
        invalidateContentTypes();
        setSelectedName(null);
        return;
      }
      toast.error(error instanceof Error ? error.message : `Failed to delete "${name}".`);
    }
  });
  const draft = selected ? contentTypeInputFromCollection(selected) : defaultContentTypeInput();
  const [fieldDrafts, setFieldDrafts] = useState(() => contentTypeFieldDraftsFromFields(draft.fields));
  const [optionsJson, setOptionsJson] = useState(() => JSON.stringify(draft.options ?? {}, null, 2));
  const [nameDraft, setNameDraft] = useState(draft.name);
  const [draftAndPublish, setDraftAndPublish] = useState(draft.options?.draftAndPublish === true);
  useEffect(() => {
    setFieldDrafts(contentTypeFieldDraftsFromFields(draft.fields));
    setOptionsJson(JSON.stringify(draft.options ?? {}, null, 2));
    setNameDraft(draft.name);
    setDraftAndPublish(draft.options?.draftAndPublish === true);
  }, [draft.name, selectedName]);

  // Apply Strapi-style dialog selections once the form is in create mode.
  useEffect(() => {
    if (!pendingNewName || selected) return;
    setNameDraft(pendingNewName.name);
    setDraftAndPublish(pendingNewName.draftAndPublish);
    setPendingNewName(null);
  }, [pendingNewName, selected]);
  const fieldCollections = collections.map((collection) => collection.name);
  const updateField = (id: string, patch: Partial<ContentTypeFieldDraft>) => {
    setFieldDrafts((current) => current.map((field) => field.id === id ? { ...field, ...patch } : field));
  };
  const addFieldOfKind = (kind: ContentTypeFieldKind) => {
    setFieldDrafts((current) => {
      const draft = emptyContentTypeFieldDraft(`field_${current.length + 1}`);
      draft.kind = kind;
      return [...current, draft];
    });
    setAddFieldOpen(false);
  };
  const removeField = (id: string) => setFieldDrafts((current) => current.length > 1 ? current.filter((field) => field.id !== id) : current);
  const [localSaveError, setLocalSaveError] = useState<string | null>(null);
  const optionsParse = parseContentTypeOptions(optionsJson);
  const fieldValidation = validateContentTypeFieldDrafts(fieldDrafts);
  const previewInput = contentTypeInputFromDraftState(nameDraft, fieldValidation.valid ? fieldDrafts : [], optionsParse.options, draftAndPublish);
  const changePreview = contentTypeChangePreview(selected ? contentTypeInputFromCollection(selected) : null, previewInput);
  const generationPreview = contentTypeGenerationPreview(previewInput);
  const saveError = localSaveError ?? optionsParse.error ?? fieldValidation.error ?? editorMutationErrorMessage(saveMutation.error);

  useHotkeys([
    { hotkey: "Mod+S", callback: () => formRef.current?.requestSubmit(), options: { enabled: writable && !saveMutation.isPending } }
  ], { preventDefault: true, stopPropagation: true, requireReset: true });

  /* Rail 2 — collection tree (Strapi mirror). */
  const rail2 = useMemo(
    () => (
      <ContentTypesRail2
        collections={collections}
        selectedName={selectedName}
        onSelect={(name) => { setSelectedName(name); setLastWrite(null); }}
        onCreate={() => { setCreateDialogOpen(true); }}
        writable={writable}
      />
    ),
    [collections, selectedName, writable]
  );
  useRail2Slot(rail2);

  const titleText = selected ? selected.name : nameDraft.trim() || "New content type";

  return (
    <section
      aria-labelledby="hcms-ct-builder-title"
      className="flex flex-col gap-0 px-10 py-8 font-[Inter_Variable,Inter,system-ui,sans-serif] text-[#32324d]"
    >
      {/* Header: eyebrow + title + actions */}
      <header className="grid grid-cols-[1fr_auto] items-end gap-6 border-b border-[#eaeaef] pb-4">
        <div>
          <p className="m-0 mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8e8ea9]">
            Content-Type Builder
          </p>
          <h1
            id="hcms-ct-builder-title"
            className="m-0 text-[28px] font-bold leading-[1.1] tracking-[-0.02em] text-[#32324d]"
          >
            {titleText}
          </h1>
          <p className="mt-2 mb-0 max-w-[64ch] text-[13px] leading-[1.5] text-[#666687]">
            {writable
              ? "Define your data model. Changes are written immediately to the host."
              : "Content-Type Builder is read-only in this environment."}
          </p>
        </div>
        <div className="inline-flex items-center gap-2">
          {selected && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Content type settings"
              title="Content type settings"
            >
              <SettingsIcon size={15} />
            </Button>
          )}
          {selected && writable && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDeleteDialogOpen(true)}
              disabled={deleteMutation.isPending}
              aria-label="Delete content type"
              title={`Delete ${selected.name}`}
              data-testid="delete-content-type"
              className="border-[#fecaca] text-[#b91c1c] hover:bg-[#fef2f2] hover:text-[#991b1b]"
            >
              <Trash2 size={15} /> Delete
            </Button>
          )}
          <Button
            type="submit"
            form="content-type-form"
            disabled={!writable || saveMutation.isPending}
          >
            <Save size={15} /> {selected ? "Save" : "Create"}
          </Button>
        </div>
      </header>

      {/* Tabs: Form | Visualizer */}
      <div className="mt-4 flex items-center gap-0 border-b border-[#eaeaef]">
        <span
          aria-current="page"
          className="relative -mb-px inline-flex items-center gap-1.5 border-b-2 border-[#4945ff] px-4 py-2.5 text-[13px] font-semibold text-[#4945ff]"
        >
          Form
        </span>
        <Link
          to="/settings/content-types/visualizer"
          className="relative -mb-px inline-flex items-center gap-1.5 border-b-2 border-transparent px-4 py-2.5 text-[13px] font-medium text-[#666687] no-underline transition-colors hover:text-[#32324d]"
        >
          Visualizer
        </Link>
      </div>

      {/* Banners */}
      {!writable && (
        <div className="mt-4 rounded-md border border-[#fef3c7] bg-[#fffbeb] px-4 py-3 text-[13px] text-[#92400e]">
          Content-Type Builder is read-only in this environment.
        </div>
      )}

      {saveError && (
        <div
          className="mt-4 rounded-md border border-[#fecaca] bg-[#fff0f0] px-4 py-3 text-[13px] text-[#b91c1c]"
          role="alert"
        >
          {saveError}
        </div>
      )}

      {lastWrite && (
        <div className="mt-4 rounded-md border border-[#bbf7d0] bg-[#f0fdf4] px-4 py-3 flex flex-col gap-1">
          <p className="text-[13px] font-semibold text-[#166534]">{lastWrite.title}</p>
          {lastWrite.details.map((detail) => (
            <p key={detail} className="text-[12px] text-[#16a34a]">{detail}</p>
          ))}
          <p className="text-[11px] text-[#4ade80]">
            Dev artifacts and migrations are reported by the host writer.
          </p>
          {lastWrite.source && (
            <pre className="mt-2 rounded bg-[#dcfce7] px-3 py-2 text-[11px] font-mono text-[#14532d] overflow-auto">
              {lastWrite.source}
            </pre>
          )}
        </div>
      )}

      {/* Form panel */}
      <div className="mt-6 rounded-lg border border-[#eaeaef] bg-white shadow-sm">
        <div className="px-6 py-5">
          <div className="flex items-baseline justify-between border-b border-[#eaeaef] pb-3">
            <p className="text-[15px] font-semibold text-[#32324d]">
              {selected ? `Edit: ${selected.name}` : "New content type"}
            </p>
            <p className="text-[12px] text-[#8e8ea9]">
              {writable ? "Development writer enabled" : "Read-only schema view"}
            </p>
          </div>

          <form
            ref={formRef}
            id="content-type-form"
            className="mt-5 flex flex-col gap-5"
            key={selected?.name ?? "new"}
            onSubmit={(event) => {
              event.preventDefault();
              setLocalSaveError(null);
              let input: ContentTypeInput;
              try {
                input = contentTypeInputFromForm(new FormData(event.currentTarget));
              } catch (error) {
                setLocalSaveError(error instanceof Error ? error.message : "Content type input is invalid.");
                return;
              }
              saveMutation.mutate(input);
            }}
          >
            {/* Name field */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[13px] font-medium text-[#32324d]" htmlFor="ct-name">Name</label>
              <Input
                id="ct-name"
                name="name"
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
                required
                disabled={!writable && !selected}
              />
            </div>

            {/* Draft and publish toggle */}
            <div className="flex items-center justify-between rounded-lg border border-[#eaeaef] px-4 py-3">
              <div>
                <p className="text-[13px] font-medium text-[#32324d]">Draft and publish</p>
                <p className="text-[12px] text-[#8e8ea9]">Adds draft/published workflow to records</p>
              </div>
              <Switch
                name="draftAndPublish"
                checked={draftAndPublish}
                onCheckedChange={(checked) => setDraftAndPublish(checked)}
                disabled={!writable}
              />
            </div>

            <input type="hidden" name="fieldRows" value={JSON.stringify(fieldDrafts)} />

            {/* Fields section */}
            <div className="rounded-lg border border-[#eaeaef] overflow-hidden">
              <div className="flex items-center justify-between border-b border-[#eaeaef] bg-[#f6f6f9] px-4 py-3">
                <p className="text-[13px] font-semibold text-[#32324d]">
                  Fields <span className="text-[#8e8ea9] font-normal">({fieldDrafts.length})</span>
                </p>
              </div>
              <div className="divide-y divide-[#eaeaef]">
                {fieldDrafts.map((field) => (
                  <div key={field.id} className="flex flex-col gap-3 px-4 py-4">
                    <div className="grid grid-cols-[1fr_180px] gap-3">
                      <div className="flex flex-col gap-1">
                        <label className="text-[12px] font-medium text-[#32324d]">Field name</label>
                        <Input
                          value={field.name}
                          onChange={(event) => updateField(field.id, { name: event.target.value })}
                          disabled={!writable}
                          required
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[12px] font-medium text-[#32324d]">Type</label>
                        <select
                          className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                          value={field.kind}
                          onChange={(event) => updateField(field.id, { kind: event.target.value as ContentTypeFieldKind })}
                          disabled={!writable}
                        >
                          {CONTENT_TYPE_FIELD_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                        </select>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-4 text-[12px] text-[#32324d]">
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" checked={field.required} onChange={(event) => updateField(field.id, { required: event.target.checked })} disabled={!writable} className="rounded" />
                        Required
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" checked={field.unique} onChange={(event) => updateField(field.id, { unique: event.target.checked })} disabled={!writable} className="rounded" />
                        Unique
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" checked={field.localized} onChange={(event) => updateField(field.id, { localized: event.target.checked })} disabled={!writable} className="rounded" />
                        Localized
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" checked={field.private} onChange={(event) => updateField(field.id, { private: event.target.checked })} disabled={!writable} className="rounded" />
                        Private
                      </label>
                    </div>

                    {(field.kind === "string" || field.kind === "number") && (
                      <div className="grid grid-cols-2 gap-3">
                        <div className="flex flex-col gap-1">
                          <label className="text-[12px] font-medium text-[#32324d]">Min</label>
                          <Input type="number" value={field.min} onChange={(event) => updateField(field.id, { min: event.target.value })} disabled={!writable} />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-[12px] font-medium text-[#32324d]">Max</label>
                          <Input type="number" value={field.max} onChange={(event) => updateField(field.id, { max: event.target.value })} disabled={!writable} />
                        </div>
                        {field.kind === "number" && (
                          <label className="flex items-center gap-1.5 text-[12px] text-[#32324d] cursor-pointer col-span-2">
                            <input type="checkbox" checked={field.int} onChange={(event) => updateField(field.id, { int: event.target.checked })} disabled={!writable} className="rounded" />
                            Integer
                          </label>
                        )}
                      </div>
                    )}

                    {field.kind === "enum" && (
                      <div className="flex flex-col gap-1">
                        <label className="text-[12px] font-medium text-[#32324d]">Values</label>
                        <Input value={field.values} onChange={(event) => updateField(field.id, { values: event.target.value })} disabled={!writable} placeholder="draft, published, archived" />
                      </div>
                    )}

                    {field.kind === "media" && (
                      <label className="flex items-center gap-1.5 text-[12px] text-[#32324d] cursor-pointer">
                        <input type="checkbox" checked={field.multiple} onChange={(event) => updateField(field.id, { multiple: event.target.checked })} disabled={!writable} className="rounded" />
                        Multiple assets
                      </label>
                    )}

                    {field.kind === "uid" && (
                      <div className="flex flex-col gap-1">
                        <label className="text-[12px] font-medium text-[#32324d]">Target field</label>
                        <Input value={field.targetField} onChange={(event) => updateField(field.id, { targetField: event.target.value })} disabled={!writable} placeholder="title" />
                      </div>
                    )}

                    {field.kind === "relation" && (
                      <div className="grid grid-cols-2 gap-3">
                        <div className="flex flex-col gap-1">
                          <label className="text-[12px] font-medium text-[#32324d]">Target</label>
                          <select
                            className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                            value={field.target}
                            onChange={(event) => updateField(field.id, { target: event.target.value })}
                            disabled={!writable}
                          >
                            <option value="">Choose collection</option>
                            {fieldCollections.map((name) => <option key={name} value={name}>{name}</option>)}
                          </select>
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-[12px] font-medium text-[#32324d]">Cardinality</label>
                          <select
                            className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                            value={field.cardinality}
                            onChange={(event) => updateField(field.id, { cardinality: event.target.value })}
                            disabled={!writable}
                          >
                            {CONTENT_TYPE_RELATION_CARDINALITIES.map((cardinality) => <option key={cardinality} value={cardinality}>{cardinality}</option>)}
                          </select>
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-[12px] font-medium text-[#32324d]">Inverse</label>
                          <Input value={field.inverse} onChange={(event) => updateField(field.id, { inverse: event.target.value })} disabled={!writable} />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-[12px] font-medium text-[#32324d]">Delete</label>
                          <select
                            className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                            value={field.onDelete}
                            onChange={(event) => updateField(field.id, { onDelete: event.target.value })}
                            disabled={!writable}
                          >
                            <option value="">default</option>
                            <option value="cascade">cascade</option>
                            <option value="restrict">restrict</option>
                            <option value="set_null">set_null</option>
                          </select>
                        </div>
                      </div>
                    )}

                    <div className="flex justify-end">
                      <Button type="button" variant="ghost" size="sm" onClick={() => removeField(field.id)} disabled={!writable || fieldDrafts.length === 1}>
                        <Trash2 size={14} /> Remove
                      </Button>
                    </div>
                  </div>
                ))}
                {/* Strapi-style trigger to open the field-type picker dialog. */}
                <button
                  type="button"
                  onClick={() => setAddFieldOpen(true)}
                  disabled={!writable}
                  className="flex w-full items-center justify-center gap-1.5 px-4 py-3 text-[13px] font-semibold text-[#4945ff] transition-colors hover:bg-[#f0f0ff] disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="Add another field"
                >
                  <Plus size={15} aria-hidden /> Add another field to this collection type
                </button>
              </div>
            </div>

            {/* Advanced options */}
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-1.5 text-[13px] font-medium text-[#32324d]">
                <Code2 size={14} /> Advanced options JSON
              </label>
              <Textarea name="options" rows={5} value={optionsJson} onChange={(event) => setOptionsJson(event.target.value)} readOnly={!writable} />
            </div>

            {/* Change preview */}
            <div
              className={`rounded-lg border px-4 py-3 text-[13px] ${
                changePreview.risk === "high"
                  ? "border-[#fecaca] bg-[#fef2f2] text-[#991b1b]"
                  : changePreview.risk === "medium"
                  ? "border-[#fed7aa] bg-[#fff7ed] text-[#92400e]"
                  : "border-[#bbf7d0] bg-[#f0fdf4] text-[#166534]"
              }`}
              aria-live="polite"
            >
              <p className="font-semibold">{changePreview.title}</p>
              {changePreview.details.map((detail) => (
                <p key={detail} className="mt-1 text-[12px]">{detail}</p>
              ))}
            </div>

            {/* Generation preview */}
            <section className="rounded-lg border border-[#eaeaef] overflow-hidden" aria-label="Generated API preview">
              <div className="flex items-center justify-between border-b border-[#eaeaef] bg-[#f6f6f9] px-4 py-3">
                <p className="text-[13px] font-semibold text-[#32324d]">Generated API preview</p>
                <p className="text-[12px] text-[#8e8ea9]">{generationPreview.artifacts.join(" + ")}</p>
              </div>
              <div className="divide-y divide-[#eaeaef] px-4 py-3">
                <ol className="flex flex-col gap-2 pb-3" aria-label="Generation workflow">
                  {generationPreview.steps.map((step) => (
                    <li key={step.title} className="flex flex-col gap-0.5">
                      <p className="text-[12px] font-semibold text-[#32324d]">{step.title}</p>
                      <p className="text-[12px] text-[#8e8ea9]">{step.detail}</p>
                    </li>
                  ))}
                </ol>
                <div className="pt-3 flex flex-col gap-3">
                  <GeneratedSnippet label="SDK" value={generationPreview.sdk} />
                  <GeneratedSnippet label="REST API" value={generationPreview.api} />
                  <GeneratedSnippet label="Next steps" value={generationPreview.integration} />
                </div>
              </div>
            </section>
          </form>
        </div>
      </div>

      <AddFieldDialog
        open={addFieldOpen}
        onOpenChange={setAddFieldOpen}
        onPick={addFieldOfKind}
      />

      <NewCollectionTypeDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        existingNames={collections.map((c) => c.name)}
        onContinue={({ name, draftAndPublish: draftAndPublishChoice }) => {
          setSelectedName(null);
          setLastWrite(null);
          setPendingNewName({ name, draftAndPublish: draftAndPublishChoice });
        }}
      />

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete content type</AlertDialogTitle>
            <AlertDialogDescription>
              {selected
                ? `This permanently removes the "${selected.name}" collection from your schema, including its generated file on disk. Existing records in storage stay intact, but the API and admin UI will no longer expose them.`
                : "Select a collection to delete."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!selected || deleteMutation.isPending}
              onClick={() => {
                if (selected) deleteMutation.mutate(selected.name);
              }}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete collection"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Rail 2 — collection-type tree                                              */
/* -------------------------------------------------------------------------- */

function ContentTypesRail2(props: {
  collections: readonly AdminSchemaMetadata["collections"][string][];
  selectedName: string | null;
  onSelect: (name: string) => void;
  onCreate: () => void;
  writable: boolean;
}): ReactElement {
  return (
    <div className="flex h-full flex-col gap-4 px-2 py-2">
      <div className="flex flex-col gap-1">
        <p className="px-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-[#8e8ea9]">
          Collection types
        </p>
        <ul className="m-0 flex flex-col gap-px px-0">
          {props.collections.map((collection) => {
            const active = props.selectedName === collection.name;
            return (
              <li key={collection.name} className="list-none">
                <button
                  type="button"
                  onClick={() => props.onSelect(collection.name)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-8 w-full items-center gap-2 rounded-[4px] px-3 text-[13px] text-[#666687] transition-colors",
                    "hover:bg-[#f6f6f9] hover:text-[#32324d]",
                    active && "bg-[#f0f0ff] font-medium text-[#4945ff] hover:bg-[#f0f0ff] hover:text-[#4945ff]"
                  )}
                >
                  <Table2 size={14} aria-hidden className={cn("shrink-0 text-[#8e8ea9]", active && "text-[#4945ff]")} />
                  <span className="truncate">{collection.name}</span>
                </button>
              </li>
            );
          })}
          {props.collections.length === 0 && (
            <li className="list-none px-3 py-2 text-[12px] text-[#8e8ea9]">No collections yet.</li>
          )}
        </ul>
      </div>
      <div className="mt-auto px-2">
        <button
          type="button"
          onClick={props.onCreate}
          disabled={!props.writable}
          className="flex w-full items-center justify-start gap-1.5 rounded-[4px] px-2 py-2 text-[13px] font-semibold text-[#4945ff] transition-colors hover:bg-[#f0f0ff] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus size={14} aria-hidden /> Create new collection type
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Add-field dialog — Strapi field-type picker                                */
/* -------------------------------------------------------------------------- */

type FieldKindCard = {
  kind: ContentTypeFieldKind;
  label: string;
  description: string;
  Icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
};

type FieldKindCategory = {
  label: string;
  cards: readonly FieldKindCard[];
};

const FIELD_KIND_CATEGORIES: readonly FieldKindCategory[] = [
  {
    label: "Text",
    cards: [
      { kind: "string", label: "Text", description: "Small or long text like title or description", Icon: Type },
      { kind: "richtext", label: "Rich text", description: "A rich-text editor with formatting options", Icon: AlignLeft }
    ]
  },
  {
    label: "Date",
    cards: [
      { kind: "date", label: "Date", description: "Day-precision date value", Icon: Calendar },
      { kind: "datetime", label: "Date & time", description: "Date with hour, minute and second", Icon: CalendarClock },
      { kind: "time", label: "Time", description: "Time without date", Icon: Clock }
    ]
  },
  {
    label: "Relations",
    cards: [
      { kind: "relation", label: "Relation", description: "Connect this collection to another one", Icon: LinkIcon }
    ]
  },
  {
    label: "Number",
    cards: [
      { kind: "number", label: "Number", description: "Numbers (integer, big integer, decimal, float)", Icon: Hash }
    ]
  },
  {
    label: "Media",
    cards: [
      { kind: "media", label: "Media", description: "Files like images, videos, etc.", Icon: ImageIcon }
    ]
  },
  {
    label: "Other",
    cards: [
      { kind: "boolean", label: "Boolean", description: "Yes or no, 1 or 0, true or false", Icon: ToggleLeft },
      { kind: "enum", label: "Enumeration", description: "List of values, then pick one", Icon: List },
      { kind: "json", label: "JSON", description: "Data in JSON format", Icon: Code2 },
      { kind: "uid", label: "UID", description: "Unique identifier", Icon: Sparkles },
      { kind: "email", label: "Email", description: "Email field with validation", Icon: Mail },
      { kind: "password", label: "Password", description: "Password field with encryption", Icon: Lock },
      { kind: "text", label: "Text", description: "Small text without formatting", Icon: FileText },
      { kind: "url", label: "URL", description: "Link to an external resource", Icon: LinkIcon }
    ]
  }
];

function AddFieldDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (kind: ContentTypeFieldKind) => void;
}): ReactElement {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="max-w-[900px] sm:max-w-[900px]"
        aria-describedby="add-field-description"
      >
        <DialogHeader>
          <DialogTitle className="text-[18px] font-bold text-[#32324d]">
            Select a field for your collection type
          </DialogTitle>
          <DialogDescription id="add-field-description" className="text-[13px] text-[#666687]">
            Pick a field type to add to your collection. Configure its options after it is added.
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-5 overflow-y-auto py-1">
          {FIELD_KIND_CATEGORIES.map((category) => (
            <section key={category.label} aria-labelledby={`field-cat-${category.label.toLowerCase()}`}>
              <p
                id={`field-cat-${category.label.toLowerCase()}`}
                className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8e8ea9]"
              >
                {category.label}
              </p>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                {category.cards.map((card) => (
                  <button
                    key={card.kind}
                    type="button"
                    onClick={() => props.onPick(card.kind)}
                    className="group flex items-start gap-3 rounded-md border border-[#eaeaef] bg-white p-4 text-left transition-colors hover:border-[#4945ff] hover:bg-[#f6f6ff]"
                  >
                    <span className="mt-0.5 inline-flex shrink-0 items-center justify-center rounded-md bg-[#f0f0ff] p-1.5 text-[#4945ff] group-hover:bg-[#dcdcff]">
                      <card.Icon size={16} aria-hidden />
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-[13px] font-semibold text-[#32324d]">{card.label}</span>
                      <span className="text-[11px] leading-snug text-[#8e8ea9]">{card.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GeneratedSnippet(props: { label: string; value: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await copyGeneratedSnippet(props.value);
    setCopied(true);
    globalThis.setTimeout(() => setCopied(false), 1_500);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <p className="text-[12px] font-semibold text-[#32324d]">{props.label}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => { void copy(); }} aria-label={`Copy ${props.label} preview`}>
          <Copy size={14} /> {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="rounded bg-[#f6f6f9] px-3 py-2.5 text-[11px] font-mono text-[#32324d] overflow-auto whitespace-pre-wrap border border-[#eaeaef]">{props.value}</pre>
    </div>
  );
}

export async function copyGeneratedSnippet(value: string, clipboard: Pick<Clipboard, "writeText"> | undefined = globalThis.navigator?.clipboard): Promise<void> {
  if (!clipboard?.writeText) throw new Error("Clipboard is not available.");
  await clipboard.writeText(value);
}

const CONTENT_TYPE_FIELD_KINDS = ["string", "text", "richtext", "number", "boolean", "datetime", "date", "time", "json", "email", "url", "password", "uid", "enum", "media", "relation"] as const satisfies readonly ContentTypeFieldKind[];
const CONTENT_TYPE_RELATION_CARDINALITIES = ["one", "many", "one-to-one", "many-to-one", "one-to-many", "many-to-many"] as const;

export function contentTypeInputFromForm(form: FormData): ContentTypeInput {
  const name = String(form.get("name") ?? "").trim();
  const fieldRows = String(form.get("fieldRows") ?? "");
  const fields = fieldRows
    ? contentTypeFieldsFromDrafts(parseContentTypeFieldDrafts(fieldRows))
    : parseJsonObject(String(form.get("fields") ?? "{}"));
  const options = parseJsonObject(String(form.get("options") ?? "{}"));
  if (form.get("draftAndPublish") === "on") options.draftAndPublish = true;
  else if ("draftAndPublish" in options) delete options.draftAndPublish;
  return {
    name,
    fields: fields as ContentTypeInput["fields"],
    options
  };
}

export function contentTypeFieldDraftsFromFields(fields: ContentTypeInput["fields"]): ContentTypeFieldDraft[] {
  const entries = Object.entries(fields);
  if (!entries.length) return [emptyContentTypeFieldDraft("title")];
  return entries.map(([name, field]) => ({
    ...emptyContentTypeFieldDraft(name),
    id: name,
    name,
    kind: field.kind,
    required: field.required === true,
    unique: field.unique === true,
    localized: field.localized === true,
    private: field.private === true,
    min: field.min === undefined ? "" : String(field.min),
    max: field.max === undefined ? "" : String(field.max),
    int: field.int === true,
    values: field.values?.join(", ") ?? "",
    multiple: field.multiple === true,
    target: field.target ?? "",
    targetField: field.targetField ?? "",
    cardinality: field.cardinality ?? "one",
    inverse: field.inverse ?? "",
    onDelete: field.onDelete ?? ""
  }));
}

export function contentTypeFieldsFromDrafts(drafts: readonly ContentTypeFieldDraft[]): ContentTypeInput["fields"] {
  const validation = validateContentTypeFieldDrafts(drafts);
  if (!validation.valid) throw new Error(validation.error);
  return drafts.reduce<ContentTypeInput["fields"]>((fields, draft) => {
    const name = draft.name.trim();
    const field: Record<string, unknown> = { kind: draft.kind };
    if (draft.required) field.required = true;
    if (draft.unique) field.unique = true;
    if (draft.localized) field.localized = true;
    if (draft.private) field.private = true;
    const min = optionalNumber(draft.min);
    const max = optionalNumber(draft.max);
    if ((draft.kind === "string" || draft.kind === "number") && min !== undefined) field.min = min;
    if ((draft.kind === "string" || draft.kind === "number") && max !== undefined) field.max = max;
    if (draft.kind === "number" && draft.int) field.int = true;
    if (draft.kind === "enum") field.values = enumValuesFromDraft(draft.values);
    if (draft.kind === "media" && draft.multiple) field.multiple = true;
    if (draft.kind === "uid" && draft.targetField.trim()) field.targetField = draft.targetField.trim();
    if (draft.kind === "relation") {
      field.target = draft.target.trim();
      field.cardinality = draft.cardinality || "one";
      if (draft.inverse.trim()) field.inverse = draft.inverse.trim();
      if (draft.onDelete) field.onDelete = draft.onDelete;
    }
    fields[name] = field as ContentTypeInput["fields"][string];
    return fields;
  }, {});
}

export function validateContentTypeFieldDrafts(drafts: readonly Partial<ContentTypeFieldDraft>[]): { valid: true; error: null } | { valid: false; error: string } {
  const seen = new Set<string>();
  for (const draft of drafts) {
    const name = draft.name?.trim() ?? "";
    if (!name) return { valid: false, error: "Every content type field needs a name." };
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return { valid: false, error: `Field name must be a valid TypeScript identifier: ${name}.` };
    if (seen.has(name)) return { valid: false, error: `Duplicate field name: ${name}.` };
    seen.add(name);

    const min = optionalNumber(draft.min ?? "");
    const max = optionalNumber(draft.max ?? "");
    if ((draft.min?.trim() || "") && min === undefined) return { valid: false, error: `${name} min must be a number.` };
    if ((draft.max?.trim() || "") && max === undefined) return { valid: false, error: `${name} max must be a number.` };
    if (min !== undefined && max !== undefined && min > max) return { valid: false, error: `${name} min cannot be greater than max.` };

    if (draft.kind === "enum") {
      const values = enumValuesFromDraft(draft.values ?? "");
      if (!values.length) return { valid: false, error: `${name} enum needs at least one value.` };
      if (new Set(values).size !== values.length) return { valid: false, error: `${name} enum values must be unique.` };
    }
    if (draft.kind === "uid") {
      const targetField = draft.targetField?.trim() ?? "";
      if (targetField && !drafts.some((candidate) => candidate.name?.trim() === targetField)) {
        return { valid: false, error: `${name} UID target field must reference another field in this content type.` };
      }
    }
    if (draft.kind === "relation") {
      if (!draft.target?.trim()) return { valid: false, error: `${name} relation needs a target collection.` };
      if (draft.inverse?.trim() && !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(draft.inverse.trim())) return { valid: false, error: `${name} relation inverse must be a valid TypeScript identifier.` };
    }
  }
  return { valid: true, error: null };
}

export type ContentTypeChangePreview = {
  risk: "low" | "medium" | "high";
  title: string;
  details: readonly string[];
};

export function contentTypeChangePreview(before: ContentTypeInput | null, after: ContentTypeInput): ContentTypeChangePreview {
  if (!before) {
    return {
      risk: "low",
      title: "Create schema artifact",
      details: [`Create ${after.name || "new collection"} with ${Object.keys(after.fields).length} field${Object.keys(after.fields).length === 1 ? "" : "s"}.`]
    };
  }

  const details: string[] = [];
  const beforeFields = before.fields;
  const afterFields = after.fields;
  const beforeNames = new Set(Object.keys(beforeFields));
  const afterNames = new Set(Object.keys(afterFields));
  let risk: ContentTypeChangePreview["risk"] = "low";

  for (const name of beforeNames) {
    if (!afterNames.has(name)) {
      details.push(`Remove field ${name}.`);
      risk = "high";
      continue;
    }
    const beforeField = beforeFields[name];
    const afterField = afterFields[name];
    if (!beforeField || !afterField) continue;
    if (beforeField.kind !== afterField.kind) {
      details.push(`Change ${name} from ${beforeField.kind} to ${afterField.kind}.`);
      risk = "high";
    }
    if (beforeField.required !== true && afterField.required === true) {
      details.push(`Make ${name} required.`);
      if (risk === "low") risk = "medium";
    }
    if (beforeField.unique !== true && afterField.unique === true) {
      details.push(`Add unique constraint to ${name}.`);
      if (risk === "low") risk = "medium";
    }
  }

  for (const name of afterNames) {
    if (!beforeNames.has(name)) details.push(`Add ${name} (${afterFields[name]?.kind ?? "field"}).`);
  }

  if ((before.options?.draftAndPublish === true) !== (after.options?.draftAndPublish === true)) {
    details.push(after.options?.draftAndPublish === true ? "Enable draft/publish workflow." : "Disable draft/publish workflow.");
    if (risk === "low") risk = "medium";
  }

  if (before.name !== after.name) {
    details.unshift(`Rename collection ${before.name} to ${after.name || "unnamed"}.`);
    risk = "high";
  }

  return {
    risk,
    title: risk === "high" ? "High-risk schema change" : risk === "medium" ? "Review schema change" : "Schema change preview",
    details: details.length ? details : ["No schema changes detected."]
  };
}

export type ContentTypeGenerationPreview = {
  artifacts: readonly string[];
  steps: readonly {
    title: string;
    detail: string;
  }[];
  sdk: string;
  api: string;
  integration: string;
};

export function contentTypeGenerationPreview(input: ContentTypeInput): ContentTypeGenerationPreview {
  const collectionName = input.name || "new-collection";
  const typeName = pascalCase(collectionName);
  const fields = Object.entries(input.fields);
  const sdkFields = fields.length
    ? fields.map(([name, field]) => `  ${name}${field.required ? "" : "?"}: ${typeForPreviewField(field)};`).join("\n")
    : "  // Add fields to preview generated types.";
  const sdk = [
    `export type ${typeName}Input = {`,
    sdkFields,
    "};",
    "",
    `client.${camelCase(collectionName)}.findMany({`,
    "  filters: {},",
    "  sort: '-updatedAt'",
    "});",
    `client.${camelCase(collectionName)}.create(input satisfies ${typeName}Input);`
  ].join("\n");
  const api = [
    `GET /api/${collectionName}`,
    `POST /api/${collectionName}`,
    `GET /api/${collectionName}/:id`,
    `PUT /api/${collectionName}/:id`,
    `DELETE /api/${collectionName}/:id`,
    ...(input.options?.draftAndPublish === true ? [
      `POST /api/${collectionName}/:id/publish`,
      `POST /api/${collectionName}/:id/unpublish`,
      `POST /api/${collectionName}/:id/schedule`
    ] : [])
  ].join("\n");
  const integration = [
    "# after save",
    "bunx hono-cms doctor",
    "bunx hono-cms schema check-sdk --schema ./src/schema.ts --out ./src/generated/sdk.ts",
    "bunx hono-cms schema check-openapi --schema ./src/schema.ts --out ./src/generated/openapi.json",
    "bunx hono-cms schema plan --schema ./src/schema.ts --state ./.hono-cms/schema-state.json",
    "",
    `// import { type ${typeName}Input } from './generated/sdk';`,
    `// POST /api/${collectionName} accepts ${typeName}Input`
  ].join("\n");
  return {
    artifacts: ["collection source", "typed SDK", "OpenAPI schema", "database schema"],
    steps: [
      {
        title: "1. Write schema source",
        detail: `Save ${collectionName} as a generated collection module.`
      },
      {
        title: "2. Refresh contracts",
        detail: `Regenerate SDK and OpenAPI contracts for ${typeName}.`
      },
      {
        title: "3. Plan persistence",
        detail: "Generate database schema and review the migration plan."
      },
      {
        title: "4. Verify before deploy",
        detail: "Run doctor and drift checks before shipping the content type."
      }
    ],
    sdk,
    api,
    integration
  };
}

function typeForPreviewField(field: ContentTypeInput["fields"][string]): string {
  if (field.kind === "number") return "number";
  if (field.kind === "boolean") return "boolean";
  if (field.kind === "json") return "unknown";
  if (field.kind === "enum" && field.values?.length) return field.values.map((value) => JSON.stringify(value)).join(" | ");
  if (field.kind === "media" && field.multiple) return "string[]";
  if (field.kind === "relation") {
    const many = field.cardinality === "many" || field.cardinality === "one-to-many" || field.cardinality === "many-to-many";
    return many ? "string[]" : "string";
  }
  return "string";
}

function pascalCase(value: string): string {
  const words = wordsFromIdentifier(value);
  return words.length ? words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("") : "GeneratedCollection";
}

function camelCase(value: string): string {
  const typeName = pascalCase(value);
  return typeName.charAt(0).toLowerCase() + typeName.slice(1);
}

function wordsFromIdentifier(value: string): string[] {
  return value.split(/[^A-Za-z0-9]+/).filter(Boolean).map((word) => word.toLowerCase());
}

function contentTypeInputFromDraftState(name: string, drafts: readonly ContentTypeFieldDraft[], parsedOptions: Record<string, unknown>, draftAndPublish: boolean): ContentTypeInput {
  const options = { ...parsedOptions };
  if (draftAndPublish) options.draftAndPublish = true;
  else if ("draftAndPublish" in options) delete options.draftAndPublish;
  return {
    name: name.trim(),
    fields: contentTypeFieldsFromDrafts(drafts),
    options
  };
}

export function parseContentTypeOptions(value: string): { options: Record<string, unknown>; error: string | null } {
  try {
    return { options: parseJsonObject(value), error: null };
  } catch (error) {
    return {
      options: {},
      error: error instanceof Error ? error.message : "Advanced options must be a JSON object."
    };
  }
}

function contentTypeInputFromCollection(collection: AdminSchemaMetadata["collections"][string]): ContentTypeInput {
  return {
    name: collection.name,
    fields: collection.fields,
    options: collection.options
  };
}

export function contentTypeWriteSummary(result: {
  collection: { name: string };
  source?: string;
  path?: string;
  artifacts?: readonly string[];
  migrations?: readonly string[];
  message?: string;
}): { title: string; details: readonly string[]; source?: string } {
  const details = [
    result.path,
    ...(result.artifacts ?? []),
    ...(result.migrations ?? [])
  ].filter((item): item is string => Boolean(item));
  const summary: { title: string; details: readonly string[]; source?: string } = {
    title: result.message ?? "Schema written",
    details: details.length ? details : [result.collection.name]
  };
  if (result.source) summary.source = result.source;
  return summary;
}

function defaultContentTypeInput(): ContentTypeInput {
  return {
    name: "",
    fields: {
      title: { kind: "string", required: true }
    },
    options: {}
  };
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value || "{}") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object.");
  return parsed as Record<string, unknown>;
}

function parseContentTypeFieldDrafts(value: string): ContentTypeFieldDraft[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Expected content type field rows.");
  return parsed.map((item, index) => ({ ...emptyContentTypeFieldDraft(`field_${index + 1}`), ...(item && typeof item === "object" ? item : {}) }));
}

function optionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : undefined;
}

function enumValuesFromDraft(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function emptyContentTypeFieldDraft(name: string): ContentTypeFieldDraft {
  return {
    id: `${name}-${Math.random().toString(36).slice(2)}`,
    name,
    kind: "string",
    required: false,
    unique: false,
    localized: false,
    private: false,
    min: "",
    max: "",
    int: false,
    values: "",
    multiple: false,
    target: "",
    targetField: "",
    cardinality: "one",
    inverse: "",
    onDelete: ""
  };
}
