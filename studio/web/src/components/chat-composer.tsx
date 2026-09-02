import { type FormEvent, type KeyboardEvent } from "react";
import { LoaderCircle, SendHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  disabled = false,
  sending = false,
  placeholder,
  submitLabel = "Send message",
  autoFocus = false,
}: Readonly<{
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  sending?: boolean;
  placeholder: string;
  submitLabel?: string;
  autoFocus?: boolean;
}>) {
  const blocked = disabled || sending;
  const canSubmit = !blocked && value.trim() !== "";
  const submit = (event?: FormEvent): void => {
    event?.preventDefault();
    if (!canSubmit) return;
    onSubmit();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submit();
  };
  return (
    <form onSubmit={submit}>
      <div className="flex items-end gap-2 rounded-xl border bg-muted/40 p-2 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
        <Textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={blocked}
          placeholder={placeholder}
          autoFocus={autoFocus}
          rows={1}
          className="min-h-12 max-h-40 flex-1 resize-none overflow-y-auto border-0 bg-transparent py-1.5 shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
        />
        <Button type="submit" size="icon" disabled={!canSubmit} className="mb-0.5 shrink-0" aria-busy={sending}>
          {sending ? <LoaderCircle className="size-4 animate-spin" /> : <SendHorizontal className="size-4" />}
          <span className="sr-only">{submitLabel}</span>
        </Button>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">Enter to send · Shift+Enter for a new line</p>
    </form>
  );
}
