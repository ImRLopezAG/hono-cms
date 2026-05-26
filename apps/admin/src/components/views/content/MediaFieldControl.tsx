import { useSetAtom } from "jotai";
import { Image } from "lucide-react";
import { type ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { mediaPickerStateAtom } from "../../../state/admin-atoms";
import type { FieldRenderModel } from "../../../lib/field-rendering";

export function MediaFieldControl(props: { model: FieldRenderModel; value: string; onChange(value: string): void; onBlur(): void }): ReactElement {
  const setMediaPicker = useSetAtom(mediaPickerStateAtom);
  const openPicker = () => {
    setMediaPicker({
      open: true,
      fieldId: props.model.name,
      resolve: (assetId) => {
        if (assetId !== null) props.onChange(assetId);
        props.onBlur();
      }
    });
  };

  return (
    <div className="media-field-control">
      <div className="media-field-preview">
        <Image size={18} />
        <span>{props.value || "No asset selected"}</span>
      </div>
      <div className="media-field-actions">
        <Button type="button" variant="outline" onClick={openPicker}><Image size={15} /> {props.value ? "Change" : "Select"}</Button>
        {props.value && <Button type="button" variant="ghost" onClick={() => { props.onChange(""); props.onBlur(); }}>Clear</Button>}
      </div>
    </div>
  );
}
