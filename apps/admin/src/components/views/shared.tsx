import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomValue } from "jotai";
import { Activity, Image as ImageIcon, KeyRound, Settings } from "lucide-react";
import { useMemo, type ReactElement, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createAdminApiClient, type AdminCollectionName, type AdminSchemaMetadata, type MediaRecord } from "../../lib/api-client";
import { authTokenAtom, mediaPickerStateAtom } from "../../state/admin-atoms";
import { mediaFromQuery } from "./query-helpers";

export type { CommandPaletteRoute } from "../CommandPalette";
export { CommandPalette } from "../CommandPalette";

export const CONTENT_PAGE_SIZE = 50;

export const EDITOR_HOTKEYS = {
  save: "Mod+S",
  publish: "Mod+Shift+P"
} as const;

export const SHELL_HOTKEYS = {
  commandPalette: "Mod+K"
} as const;

export function UnsavedChangesDialog(props: { open: boolean; onStay(): void; onLeave(): void }): ReactElement {
  return (
    <Dialog open={props.open}>
      <DialogContent className="unsaved-dialog">
        <DialogHeader>
          <DialogTitle>Unsaved changes</DialogTitle>
          <DialogDescription>Save or discard your edits before leaving this workspace.</DialogDescription>
        </DialogHeader>
        <div className="dialog-actions">
          <Button type="button" variant="outline" onClick={props.onStay}>Stay</Button>
          <Button className="danger-action" type="button" variant="outline" onClick={props.onLeave}>Leave anyway</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function Header(): ReactElement {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [token, setToken] = useAtom(authTokenAtom);
  const signOut = () => {
    setToken(null);
    queryClient.clear();
    void navigate({ to: "/login", replace: true });
  };
  return (
    <header className="topbar" aria-label="Workspace header">
      <div />
      <div className="session-actions">
        <Badge className="session-pill" variant="outline"><KeyRound size={16} aria-hidden /> {token ? "Admin token active" : "Signed out"}</Badge>
        {token && <Button type="button" variant="outline" size="sm" onClick={signOut}>Sign out</Button>}
      </div>
    </header>
  );
}

export function NavLink(props: { to: "/content" | "/media" | "/settings/health" | "/settings/audit-log" | "/settings/webhooks" | "/settings/api-keys" | "/settings/sessions" | "/settings/content-types" | "/settings/i18n" | "/organization/settings" | "/organization/members" | "/organization/invitations"; icon: ReactNode; label: string; collapsed: boolean }): ReactElement {
  return <Link to={props.to} className="nav-button" activeProps={{ className: "nav-button active" }}>{props.icon}{!props.collapsed && <span>{props.label}</span>}</Link>;
}

export function DashboardPanel(props: { title: string; children: ReactNode }): ReactElement {
  return (
    <section className="rounded-lg border border-[#eaeaef] bg-white overflow-hidden">
      <div className="flex items-center justify-between border-b border-[#eaeaef] px-5 py-3 min-h-[56px]">
        <h2>{props.title}</h2>
        <Settings size={18} />
      </div>
      {props.children}
    </section>
  );
}

export function StatusTile(props: { name: string; ok: boolean; detail: string }): ReactElement {
  return <article className={props.ok ? "status-tile ok" : "status-tile error"}><Activity size={18} /><strong>{props.name}</strong><span>{props.detail}</span></article>;
}

export function useClient(): ReturnType<typeof createAdminApiClient> {
  const token = useAtomValue(authTokenAtom);
  return useMemo(() => createAdminApiClient(undefined, token), [token]);
}

export function collectionMetadata(schema: AdminSchemaMetadata, collectionName: AdminCollectionName) {
  return schema.collections[collectionName] ?? {
    name: collectionName,
    fields: {},
    options: {}
  };
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function MediaPickerModal(): ReactElement {
  const [picker, setPicker] = useAtom(mediaPickerStateAtom);
  const client = useClient();
  const query = useQuery({
    queryKey: ["media", "picker"],
    queryFn: () => client.listMedia(),
    enabled: picker.open
  });
  const media: MediaRecord[] = mediaFromQuery(query.data);
  const closePicker = (assetId: string | null) => {
    picker.resolve?.(assetId);
    setPicker({ open: false, fieldId: null, resolve: null });
  };

  return (
    <Dialog open={picker.open} onOpenChange={(open) => { if (!open) closePicker(null); }}>
      <DialogContent className="media-picker-dialog">
        <DialogHeader>
          <DialogTitle>Select media asset</DialogTitle>
          <DialogDescription>{picker.fieldId ? `Choose an asset for ${picker.fieldId}.` : "Choose an asset from the media library."}</DialogDescription>
        </DialogHeader>
        <div className="media-picker-grid" aria-label="Media picker assets">
          {media.map((item) => (
            <button key={item.id} type="button" className="media-picker-item" onClick={() => closePicker(item.id)}>
              <div className="media-preview">{item.contentType?.startsWith("image/") ? <img src={item.url} alt={item.filename} /> : <ImageIcon size={28} />}</div>
              <div className="media-meta">
                <strong>{item.filename}</strong>
                <span>{formatBytes(item.size)} · {item.contentType ?? "file"}</span>
                <small>{item.id}</small>
              </div>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
