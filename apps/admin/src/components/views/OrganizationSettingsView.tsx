import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { type ReactElement } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type OrganizationUpdateInput } from "../../lib/api-client";
import { organizationFromQuery } from "./query-helpers";
import { SettingsShell } from "./SettingsShell";
import { useClient } from "./shared";

export function OrganizationSettingsView(): ReactElement {
  const client = useClient();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["organization"], queryFn: () => client.organization() });
  const organization = organizationFromQuery(query.data);
  const mutation = useMutation({
    mutationFn: (input: OrganizationUpdateInput) => client.updateOrganization(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organization"] });
      toast.success("Organization settings saved.");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to save organization settings.");
    }
  });

  return (
    <SettingsShell
      eyebrow="Organisation"
      title="Settings"
      subtitle="Workspace identity and plan metadata shown across the admin console and shared with downstream integrations."
      action={
        <Button type="submit" form="organization-form" disabled={!organization || mutation.isPending}>
          <Save size={15} /> Save changes
        </Button>
      }
    >
      <div className="grid grid-cols-[320px_1fr] gap-6">
        {/* Left summary card */}
        <div className="rounded-lg border border-[#eaeaef] bg-white overflow-hidden shadow-sm">
          <div className="border-b border-[#eaeaef] px-4 py-3">
            <p className="text-[13px] font-semibold text-[#32324d]">Workspace</p>
          </div>
          <dl className="divide-y divide-[#eaeaef]">
            <div className="px-4 py-3">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#8e8ea9]">Slug</dt>
              <dd className="mt-1 text-[13px] text-[#32324d]">{organization?.slug ?? <span className="text-[#8e8ea9]">not configured</span>}</dd>
            </div>
            <div className="px-4 py-3">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#8e8ea9]">Plan</dt>
              <dd className="mt-1 text-[13px] text-[#32324d]">{organization?.plan ?? <span className="text-[#8e8ea9]">not configured</span>}</dd>
            </div>
          </dl>
        </div>

        {/* Right edit card */}
        <div className="rounded-lg border border-[#eaeaef] bg-white overflow-hidden shadow-sm" aria-label="Organization settings">
          <div className="flex items-center justify-between border-b border-[#eaeaef] px-6 py-4">
            <p className="text-[15px] font-semibold text-[#32324d]">Organization settings</p>
          </div>
          {organization ? (
            <form
              id="organization-form"
              className="flex flex-col gap-5 p-6"
              key={organization.id}
              onSubmit={(event) => {
                event.preventDefault();
                mutation.mutate(organizationInputFromForm(new FormData(event.currentTarget)));
              }}
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="org-name" className="text-[13px] font-medium text-[#32324d]">Name</Label>
                <Input id="org-name" name="name" defaultValue={organization.name} required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="org-slug" className="text-[13px] font-medium text-[#32324d]">Slug</Label>
                <Input id="org-slug" name="slug" defaultValue={organization.slug} required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="org-plan" className="text-[13px] font-medium text-[#32324d]">Plan</Label>
                <Input id="org-plan" name="plan" defaultValue={organization.plan ?? ""} placeholder="team" />
              </div>
            </form>
          ) : (
            <p className="px-6 py-8 text-center text-[13px] text-[#8e8ea9]">Organization settings are not available for this workspace.</p>
          )}
        </div>
      </div>
    </SettingsShell>
  );
}

export function organizationInputFromForm(form: FormData): OrganizationUpdateInput {
  const input: OrganizationUpdateInput = {
    name: String(form.get("name") ?? "").trim(),
    slug: String(form.get("slug") ?? "").trim()
  };
  const plan = String(form.get("plan") ?? "").trim();
  if (plan) input.plan = plan;
  return input;
}
