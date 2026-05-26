import { useQuery } from "@tanstack/react-query";
import { type ReactElement } from "react";
import type { AdminHealthReport } from "../../lib/api-client";
import { healthReportFromQuery } from "./query-helpers";
import { SettingsShell } from "./SettingsShell";
import { useClient } from "./shared";

type SubsystemCheck = AdminHealthReport["checks"][string];

export function HealthView(): ReactElement {
  const client = useClient();
  const query = useQuery({ queryKey: ["health"], queryFn: () => client.health() });
  const report = healthReportFromQuery(query.data);
  const checks = report ? Object.entries(report.checks) : [];
  const okCount = checks.filter(([, check]) => check.status === "ok").length;
  const failCount = checks.length - okCount;
  const overall = !report ? "warn" : failCount === 0 ? "ready" : "fail";
  const overallLabel = !report ? "Unavailable" : failCount === 0 ? "Healthy" : `${failCount} failing`;
  const subtitle = report
    ? `${checks.length} subsystem${checks.length === 1 ? "" : "s"} monitored · version ${report.version} · uptime ${formatUptime(report.uptime_seconds)}`
    : "Readiness checks could not be retrieved.";

  return (
    <SettingsShell
      eyebrow="System"
      title="Health"
      subtitle={subtitle}
      action={<OverallBadge state={overall} label={overallLabel} />}
    >
      {checks.length === 0 ? (
        <p className="text-sm text-[#8e8ea9]">Readiness checks are not available.</p>
      ) : (
        <div className="rounded-lg border border-[#eaeaef] bg-white overflow-hidden shadow-sm">
          <table className="w-full text-[13px] border-collapse" aria-label="Subsystem readiness checks">
            <thead>
              <tr className="border-b border-[#eaeaef] bg-[#f6f6f9]">
                <th scope="col" className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8e8ea9]">Subsystem</th>
                <th scope="col" className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8e8ea9]">Status</th>
                <th scope="col" className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8e8ea9]">Latency</th>
                <th scope="col" className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8e8ea9]">Detail</th>
              </tr>
            </thead>
            <tbody>
              {checks.map(([name, check]) => (
                <SubsystemRow key={name} name={name} check={check} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsShell>
  );
}

function OverallBadge({ state, label }: { state: string; label: string }): ReactElement {
  const isOk = state === "ready";
  const isWarn = state === "warn";
  const className = isOk
    ? "inline-flex items-center gap-1.5 rounded-full bg-[#c6f0c2] px-2.5 py-0.5 text-[11px] font-medium text-[#328048]"
    : isWarn
      ? "inline-flex items-center gap-1.5 rounded-full bg-[#fce9d0] px-2.5 py-0.5 text-[11px] font-medium text-[#d9822b]"
      : "inline-flex items-center gap-1.5 rounded-full bg-red-100 px-2.5 py-0.5 text-[11px] font-medium text-red-700";
  return (
    <span className={className} aria-label={`Overall status: ${label}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />
      {label}
    </span>
  );
}

function SubsystemRow(props: { name: string; check: SubsystemCheck }): ReactElement {
  const ok = props.check.status === "ok";
  const statusLabel = ok ? "OK" : "Failing";
  const latency = props.check.latency_ms != null ? `${props.check.latency_ms} ms` : "—";
  const detail = props.check.error ?? (ok ? "Healthy" : "Unknown error");
  const badgeClass = ok
    ? "inline-flex items-center gap-1.5 rounded-full bg-[#c6f0c2] px-2.5 py-0.5 text-[11px] font-medium text-[#328048]"
    : "inline-flex items-center gap-1.5 rounded-full bg-[#fce9d0] px-2.5 py-0.5 text-[11px] font-medium text-[#d9822b]";
  return (
    <tr className="border-b border-[#eaeaef] last:border-b-0 hover:bg-[#f6f6f9] align-middle">
      <td className="px-5 py-3 font-medium text-[#32324d]">{props.name}</td>
      <td className="px-5 py-3 whitespace-nowrap">
        <span className={badgeClass} aria-label={`${props.name} ${statusLabel}`}>
          <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />
          {statusLabel}
        </span>
      </td>
      <td className="px-5 py-3 tabular-nums text-[#666687]">{latency}</td>
      <td className="px-5 py-3 font-mono text-[12px] text-[#666687]">{detail}</td>
    </tr>
  );
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
