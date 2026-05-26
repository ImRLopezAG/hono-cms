import { type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type SettingsShellProps = {
  /** Small uppercase group label rendered above the title (e.g. "SYSTEM"). */
  eyebrow: string;
  /** Page title rendered as the section heading. */
  title: string;
  /** Short description rendered below the title. */
  subtitle?: ReactNode;
  /** Optional primary action (typically a Button) rendered top-right. */
  action?: ReactNode;
  /** Optional id used to wire aria-labelledby for the section. */
  titleId?: string;
  /** Page body. */
  children: ReactNode;
  /** Optional extra classes merged onto the outer <section>. */
  className?: string;
};

/**
 * Editorial settings page shell shared across the System, Schema and
 * Organisation groups. Mirrors the layout already established by the
 * visualizer / Content / Health pages: prose-style max width, headline row
 * separated from the body by a thin border-bottom, and a top-right action
 * slot.
 *
 * All styling is Tailwind utility classes. The token palette lives in CSS
 * variables (`--color-*`) consumed via Tailwind's arbitrary value syntax so
 * the shell tracks light/dark/system themes set on the document root.
 */
export function SettingsShell(props: SettingsShellProps): ReactElement {
  const titleId = props.titleId ?? toTitleId(props.title);
  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        "flex flex-col gap-[18px] font-[Inter_Variable,Inter,system-ui,sans-serif] text-[#32324d]",
        props.className
      )}
    >
      <header className="grid grid-cols-[1fr_auto] items-end gap-6 border-b border-[#eaeaef] pb-4">
        <div>
          <p className="m-0 mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8e8ea9]">
            {props.eyebrow}
          </p>
          <h1
            id={titleId}
            className="m-0 text-[28px] font-bold leading-[1.1] tracking-[-0.02em] text-[#32324d]"
          >
            {props.title}
          </h1>
          {props.subtitle ? (
            <p className="mt-2 mb-0 max-w-[56ch] text-[13px] leading-[1.5] text-[#666687]">
              {props.subtitle}
            </p>
          ) : null}
        </div>
        {props.action ? (
          <div className="inline-flex items-center gap-2">{props.action}</div>
        ) : null}
      </header>
      <div className="flex flex-col gap-4">{props.children}</div>
    </section>
  );
}

function toTitleId(title: string): string {
  return `settings-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-title`;
}
