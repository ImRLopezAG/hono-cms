import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { type ReactElement } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { type AuthSessionRecord } from "../../lib/api-client";
import { authSessionsFromQuery } from "./query-helpers";
import { SettingsShell } from "./SettingsShell";
import { useClient } from "./shared";

export function SessionsView(): ReactElement {
  const client = useClient();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["auth-sessions"], queryFn: () => client.authSessions() });
  const sessions = authSessionsFromQuery(query.data);
  const revokeMutation = useMutation({
    mutationFn: (session: AuthSessionRecord) => {
      const token = sessionRevokeToken(session);
      if (!token) throw new Error("Session token is required to revoke this session.");
      return client.revokeAuthSession(token);
    },
    onMutate: async (session) => {
      await queryClient.cancelQueries({ queryKey: ["auth-sessions"] });
      const previous = queryClient.getQueryData<{ items: AuthSessionRecord[] }>(["auth-sessions"]);
      queryClient.setQueryData<{ items: AuthSessionRecord[] }>(["auth-sessions"], (current) => ({
        items: removeAuthSession(current?.items ?? sessions, session.id)
      }));
      return { previous };
    },
    onSuccess: () => {
      toast.success("Session revoked.");
    },
    onError: (e, _session, context) => {
      if (context?.previous) queryClient.setQueryData(["auth-sessions"], context.previous);
      toast.error(e instanceof Error ? e.message : "Failed to revoke session.");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["auth-sessions"] });
    }
  });
  const revokeOthersMutation = useMutation({
    mutationFn: () => client.revokeOtherAuthSessions(),
    onSuccess: () => {
      queryClient.setQueryData<{ items: AuthSessionRecord[] }>(["auth-sessions"], (current) => ({
        items: (current?.items ?? sessions).filter((session) => session.current)
      }));
      queryClient.invalidateQueries({ queryKey: ["auth-sessions"] });
      toast.success("All other sessions revoked.");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to revoke other sessions.");
    }
  });

  return (
    <SettingsShell
      eyebrow="System"
      title="Sessions"
      subtitle="Active administrator sessions."
      action={
        <Button
          type="button"
          variant="outline"
          onClick={() => revokeOthersMutation.mutate()}
          disabled={revokeOthersMutation.isPending}
        >
          <RotateCcw size={15} /> Revoke others
        </Button>
      }
    >
      <div className="rounded-lg border border-[#eaeaef] bg-white overflow-hidden shadow-sm">
        <table className="w-full text-[13px]">
          <thead className="border-b border-[#eaeaef] bg-[#f6f6f9]">
            <tr>
              <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8e8ea9]">Session</th>
              <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8e8ea9]">Device</th>
              <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8e8ea9]">Last active</th>
              <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8e8ea9]">Expires</th>
              <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8e8ea9]" />
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session.id} className="border-b border-[#eaeaef] last:border-b-0 hover:bg-[#f6f6f9]">
                <td className="px-5 py-3 font-mono text-[12px] text-[#32324d]">
                  <div className="flex items-center gap-2">
                    <span>{session.id}</span>
                    {session.current ? <Badge variant="outline" className="text-[10px]">Current</Badge> : null}
                  </div>
                </td>
                <td className="px-5 py-3 text-[#32324d]">
                  <div className="flex flex-col gap-0.5">
                    <span>{session.device ?? session.userAgent ?? "Unknown device"}</span>
                    {session.ipAddress ? (
                      <span className="text-[11px] text-[#8e8ea9]">{session.ipAddress}</span>
                    ) : null}
                  </div>
                </td>
                <td className="px-5 py-3 text-[#8e8ea9]">{session.updatedAt ?? session.createdAt ?? "Unknown"}</td>
                <td className="px-5 py-3 text-[#8e8ea9]">{session.expiresAt ?? "Managed by auth provider"}</td>
                <td className="px-5 py-3 text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-red-600 hover:text-red-700 hover:bg-red-50"
                    onClick={() => revokeMutation.mutate(session)}
                    disabled={session.current || revokeMutation.isPending || !sessionRevokeToken(session)}
                  >
                    Revoke
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sessions.length === 0 && (
          <p className="px-5 py-9 text-center text-[13px] text-[#8e8ea9]">
            No active sessions were reported by the auth provider.
          </p>
        )}
      </div>
    </SettingsShell>
  );
}

export function sessionRevokeToken(session: AuthSessionRecord): string | null {
  return session.token ?? session.id ?? null;
}

export function removeAuthSession(sessions: AuthSessionRecord[], id: string): AuthSessionRecord[] {
  return sessions.filter((session) => session.id !== id);
}
