import { forwardRef, type MouseEvent, type ReactElement } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from "../ui/popover";
import { cn } from "@/lib/utils";

/**
 * Twelve-step preset palette ported verbatim from chartdb's
 * `src/lib/colors.ts`. Keeping the exact hex values means designers can
 * recreate chartdb diagrams pixel-for-pixel.
 */
export const VISUALIZER_COLOR_OPTIONS = [
  "#ff6363",
  "#ff6b8a",
  "#c05dcf",
  "#b067e9",
  "#8a61f5",
  "#7175fa",
  "#8eb7ff",
  "#42e0c0",
  "#4dee8a",
  "#9ef07a",
  "#ffe374",
  "#ff9f74"
] as const;

export const DEFAULT_COLLECTION_COLOR = "#8eb7ff";
export const DEFAULT_AREA_COLOR = "#b067e9";
export const DEFAULT_NOTE_COLOR = "#ffe374";

export function randomVisualizerColor(): string {
  const index = Math.floor(Math.random() * VISUALIZER_COLOR_OPTIONS.length);
  return VISUALIZER_COLOR_OPTIONS[index] ?? DEFAULT_COLLECTION_COLOR;
}

export type ColorPickerProps = {
  color: string;
  onChange: (color: string) => void;
  disabled?: boolean;
  /**
   * Custom trigger element. base-ui's `PopoverTrigger` clones the
   * provided element via its `render` prop, so the element must accept
   * arbitrary DOM props (it's typically a `<button>` or a `<div>`).
   */
  trigger?: ReactElement;
  ariaLabel?: string;
};

/**
 * 12-swatch color picker. Renders a small color chip as the default
 * trigger; consumers can override via `trigger` to attach the picker to
 * a different control (e.g. a context-menu item).
 */
export const ColorPicker = forwardRef<HTMLButtonElement, ColorPickerProps>(function ColorPicker(
  { color, onChange, disabled, trigger, ariaLabel = "Pick collection color" },
  ref
) {
  const handleSwatchClick = (next: string) => (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onChange(next);
  };
  return (
    <Popover>
      <PopoverTrigger
        ref={ref}
        disabled={disabled}
        aria-label={ariaLabel}
        render={
          trigger ?? (
            <button
              type="button"
              className={cn(
                "hcms-color-chip",
                disabled && "hcms-color-chip--disabled"
              )}
              style={{ background: color }}
              aria-label={ariaLabel}
            />
          )
        }
      />
      <PopoverContent className="hcms-color-popover w-fit p-2" sideOffset={6}>
        <div className="grid grid-cols-4 gap-2">
          {VISUALIZER_COLOR_OPTIONS.map((option) => (
            <button
              type="button"
              key={option}
              className={cn(
                "hcms-color-swatch",
                option === color && "hcms-color-swatch--active"
              )}
              style={{ background: option }}
              onClick={handleSwatchClick(option)}
              aria-label={`Use color ${option}`}
              aria-pressed={option === color}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
});
