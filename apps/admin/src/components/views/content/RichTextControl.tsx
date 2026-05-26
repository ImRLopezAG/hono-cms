import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Heading2, Italic, List, ListOrdered, Quote } from "lucide-react";
import { useEffect, type ReactElement } from "react";
import { Button } from "@/components/ui/button";

export function RichTextControl(props: { name: string; value: string; onChange(value: string): void; onBlur(): void }): ReactElement {
  const editor = useEditor({
    extensions: [StarterKit],
    content: props.value,
    immediatelyRender: false,
    onBlur: props.onBlur,
    onUpdate: ({ editor: updatedEditor }) => props.onChange(updatedEditor.getHTML())
  });

  useEffect(() => {
    if (!editor) return;
    if (editor.getHTML() !== props.value) {
      editor.commands.setContent(props.value, { emitUpdate: false });
    }
  }, [editor, props.value]);

  return (
    <div className="richtext-control" data-field-name={props.name}>
      <div className="richtext-toolbar" role="toolbar" aria-label={`${props.name} formatting`}>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Bold" aria-pressed={editor?.isActive("bold") ?? false} disabled={!editor} onClick={() => editor?.chain().focus().toggleBold().run()}><Bold size={14} /></Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Italic" aria-pressed={editor?.isActive("italic") ?? false} disabled={!editor} onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic size={14} /></Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Heading" aria-pressed={editor?.isActive("heading", { level: 2 }) ?? false} disabled={!editor} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 size={14} /></Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Bulleted list" aria-pressed={editor?.isActive("bulletList") ?? false} disabled={!editor} onClick={() => editor?.chain().focus().toggleBulletList().run()}><List size={14} /></Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Numbered list" aria-pressed={editor?.isActive("orderedList") ?? false} disabled={!editor} onClick={() => editor?.chain().focus().toggleOrderedList().run()}><ListOrdered size={14} /></Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Quote" aria-pressed={editor?.isActive("blockquote") ?? false} disabled={!editor} onClick={() => editor?.chain().focus().toggleBlockquote().run()}><Quote size={14} /></Button>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
