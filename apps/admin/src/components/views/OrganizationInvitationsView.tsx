import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, RotateCcw, Send } from "lucide-react";
import { type ReactElement } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type OrganizationInvitation, type OrganizationInvitationInput } from "../../lib/api-client";
import { organizationInvitationsFromQuery } from "./query-helpers";
import { SettingsShell } from "./SettingsShell";
import { useClient } from "./shared";

export function OrganizationInvitationsView(): ReactElement {
  const client = useClient();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["organization-invitations"], queryFn: () => client.organizationInvitations() });
  const invitations = organizationInvitationsFromQuery(query.data);
  const createMutation = useMutation({
    mutationFn: (input: OrganizationInvitationInput) => client.createOrganizationInvitation(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organization-invitations"] });
      toast.success("Invitation sent.");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to send invitation.");
    }
  });
  const revokeMutation = useMutation({
    mutationFn: (invitation: OrganizationInvitation) => client.revokeOrganizationInvitation(invitation.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organization-invitations"] });
      toast.success("Invitation revoked.");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to revoke invitation.");
    }
  });

  return (
    <SettingsShell
      eyebrow="Organisation"
      title="Invitations"
      subtitle="Send and revoke pending invitations. Recipients accept by email and inherit the role assigned here."
      action={
        <Button type="submit" form="invitation-form" disabled={createMutation.isPending}>
          <Send size={15} /> Invite member
        </Button>
      }
    >
      <div className="grid grid-cols-[320px_1fr] gap-6">
        {/* Left: existing invitations */}
        <div className="rounded-lg border border-[#eaeaef] bg-white overflow-hidden shadow-sm">
          <div className="border-b border-[#eaeaef] px-4 py-3">
            <p className="text-[13px] font-semibold text-[#32324d]">Pending invitations</p>
          </div>
          <div className="divide-y divide-[#eaeaef]">
            {invitations.map((invitation) => (
              <article key={invitation.id} className="flex items-center gap-3 px-4 py-3 hover:bg-[#f6f6f9]">
                <Mail size={15} className="shrink-0 text-[#8e8ea9]" aria-hidden />
                <div className="flex min-w-0 flex-1 flex-col">
                  <strong className="text-[13px] font-medium text-[#32324d] truncate">{invitation.email}</strong>
                  <span className="text-[12px] text-[#666687] truncate">{invitation.role}</span>
                  <span className="text-[11px] text-[#8e8ea9]">{invitation.expiresAt ?? "no expiry"}</span>
                </div>
                <em className="not-italic text-[11px] uppercase tracking-[0.06em] text-[#666687]">{invitation.status}</em>
              </article>
            ))}
            {!invitations.length && (
              <p className="px-4 py-6 text-center text-[13px] text-[#8e8ea9]">No invitations found.</p>
            )}
          </div>
        </div>

        {/* Right: invite + revoke */}
        <div className="rounded-lg border border-[#eaeaef] bg-white overflow-hidden shadow-sm" aria-label="Organization invitations">
          <div className="flex items-center justify-between border-b border-[#eaeaef] px-6 py-4">
            <p className="text-[15px] font-semibold text-[#32324d]">Invite member</p>
          </div>
          <form
            id="invitation-form"
            className="flex flex-col gap-5 p-6"
            onSubmit={(event) => {
              event.preventDefault();
              createMutation.mutate(invitationInputFromForm(new FormData(event.currentTarget)));
              event.currentTarget.reset();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inv-email" className="text-[13px] font-medium text-[#32324d]">Email</Label>
              <Input id="inv-email" name="email" type="email" required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inv-role" className="text-[13px] font-medium text-[#32324d]">Role</Label>
              <Input id="inv-role" name="role" defaultValue="editor" required />
            </div>
          </form>
          {invitations.some((invitation) => invitation.status === "pending") && (
            <div className="border-t border-[#eaeaef] px-6 py-4">
              <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-[#8e8ea9]">Revoke pending</p>
              <div className="flex flex-wrap gap-2">
                {invitations.filter((invitation) => invitation.status === "pending").map((invitation) => (
                  <Button
                    key={invitation.id}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => revokeMutation.mutate(invitation)}
                    disabled={revokeMutation.isPending}
                  >
                    <RotateCcw size={14} /> Revoke {invitation.email}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </SettingsShell>
  );
}

export function invitationInputFromForm(form: FormData): OrganizationInvitationInput {
  return {
    email: String(form.get("email") ?? "").trim(),
    role: String(form.get("role") ?? "").trim()
  };
}
