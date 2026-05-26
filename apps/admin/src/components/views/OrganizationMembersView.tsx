import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, Trash2 } from "lucide-react";
import { type ReactElement } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type OrganizationMember } from "../../lib/api-client";
import { organizationMembersFromQuery } from "./query-helpers";
import { SettingsShell } from "./SettingsShell";
import { useClient } from "./shared";

export function OrganizationMembersView(): ReactElement {
  const client = useClient();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["organization-members"], queryFn: () => client.organizationMembers() });
  const members = organizationMembersFromQuery(query.data);
  const updateMutation = useMutation({
    mutationFn: (input: { id: string; role: string; status: OrganizationMember["status"] }) => client.updateOrganizationMember(input.id, { role: input.role, status: input.status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organization-members"] });
      toast.success("Member updated.");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to update member.");
    }
  });
  const removeMutation = useMutation({
    mutationFn: (member: OrganizationMember) => client.removeOrganizationMember(member.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organization-members"] });
      toast.success("Member removed.");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to remove member.");
    }
  });

  return (
    <SettingsShell
      eyebrow="Organisation"
      title="Members"
      subtitle="Workspace members, their roles, and status. Updates apply across content, media, and API audiences."
    >
      <div className="rounded-lg border border-[#eaeaef] bg-white overflow-hidden shadow-sm" aria-label="Organization members">
        <div className="divide-y divide-[#eaeaef]">
          {members.map((member) => (
            <article
              key={member.id}
              className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 px-5 py-4 hover:bg-[#f6f6f9]"
            >
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="text-[13px] font-medium text-[#32324d] truncate">{member.name ?? member.email}</span>
                <span className="text-[12px] text-[#666687] truncate">{member.email}</span>
                <span className="text-[11px] uppercase tracking-[0.06em] text-[#8e8ea9]">{member.status}</span>
              </div>
              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const input = memberInputFromForm(member.id, new FormData(event.currentTarget));
                  updateMutation.mutate(input);
                }}
              >
                <Input className="h-9 w-40 text-[13px]" name="role" defaultValue={member.role} aria-label={`Role for ${member.email}`} />
                <Select name="status" defaultValue={member.status}>
                  <SelectTrigger aria-label={`Status for ${member.email}`} className="h-9 w-32 text-[13px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">active</SelectItem>
                    <SelectItem value="pending">pending</SelectItem>
                    <SelectItem value="disabled">disabled</SelectItem>
                  </SelectContent>
                </Select>
                <Button type="submit" variant="outline" size="sm" disabled={updateMutation.isPending}><Save size={14} /> Save</Button>
              </form>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-red-600 hover:text-red-700 hover:bg-red-50"
                onClick={() => removeMutation.mutate(member)}
                disabled={removeMutation.isPending}
              >
                <Trash2 size={14} /> Remove
              </Button>
            </article>
          ))}
          {!members.length && (
            <p className="px-5 py-8 text-center text-[13px] text-[#8e8ea9]">No organization members found.</p>
          )}
        </div>
      </div>
    </SettingsShell>
  );
}

export function memberInputFromForm(id: string, form: FormData): { id: string; role: string; status: OrganizationMember["status"] } {
  const status = String(form.get("status") ?? "active");
  return {
    id,
    role: String(form.get("role") ?? "").trim(),
    status: status === "pending" || status === "disabled" ? status : "active"
  };
}
