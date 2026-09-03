import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useRef,
  useState,
} from "react";
import { ImagePlus, LoaderCircle, SendHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export type ImageAttachment = Readonly<{
  mediaType: string;
  base64: string;
  previewUrl: string;
}>;

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  attachment,
  onAttachmentChange,
  acceptedTypes = [],
  maxBytes,
  disabled = false,
  sending = false,
  placeholder,
  submitLabel = "Send message",
  autoFocus = false,
}: Readonly<{
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  attachment?: ImageAttachment;
  onAttachmentChange?: (value: ImageAttachment | undefined) => void;
  acceptedTypes?: readonly string[];
  maxBytes?: number;
  disabled?: boolean;
  sending?: boolean;
  placeholder: string;
  submitLabel?: string;
  autoFocus?: boolean;
}>) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | undefined>();
  const blocked = disabled || sending;
  const canAttach =
    onAttachmentChange !== undefined && acceptedTypes.length > 0;
  const canSubmit =
    !blocked && (value.trim() !== "" || attachment !== undefined);
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
  const chooseFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!acceptedTypes.includes(file.type)) {
      setError("Choose a JPEG, PNG, or WebP image.");
      return;
    }
    if (maxBytes !== undefined && file.size > maxBytes) {
      setError(
        `Images must be no larger than ${Math.floor(maxBytes / (1024 * 1024))} MiB.`,
      );
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setError("Studio could not read that image.");
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      const prefix = `data:${file.type};base64,`;
      if (!dataUrl.startsWith(prefix)) {
        setError("Studio could not encode that image.");
        return;
      }
      setError(undefined);
      onAttachmentChange?.({
        mediaType: file.type,
        base64: dataUrl.slice(prefix.length),
        previewUrl: dataUrl,
      });
    };
    reader.readAsDataURL(file);
  };
  return (
    <form onSubmit={submit}>
      {attachment === undefined ? null : (
        <div className="mb-2 flex w-fit items-start gap-2 rounded-lg border bg-muted/40 p-1.5">
          <img
            src={attachment.previewUrl}
            alt="Attached room"
            className="h-16 w-20 rounded object-cover"
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-6"
            disabled={blocked}
            onClick={() => onAttachmentChange?.(undefined)}
          >
            <X className="size-3.5" />
            <span className="sr-only">Remove image</span>
          </Button>
        </div>
      )}
      <div className="flex items-end gap-2 rounded-xl border bg-muted/40 p-2 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
        {canAttach ? (
          <>
            <input
              ref={fileInput}
              type="file"
              accept={acceptedTypes.join(",")}
              className="sr-only"
              onChange={chooseFile}
              disabled={blocked}
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="mb-0.5 shrink-0"
              disabled={blocked}
              onClick={() => fileInput.current?.click()}
            >
              <ImagePlus className="size-4" />
              <span className="sr-only">Attach image</span>
            </Button>
          </>
        ) : null}
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
        <Button
          type="submit"
          size="icon"
          disabled={!canSubmit}
          className="mb-0.5 shrink-0"
          aria-busy={sending}
        >
          {sending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <SendHorizontal className="size-4" />
          )}
          <span className="sr-only">{submitLabel}</span>
        </Button>
      </div>
      {error === undefined ? null : (
        <p role="alert" className="mt-1.5 text-[11px] text-destructive">
          {error}
        </p>
      )}
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Enter to send · Shift+Enter for a new line
      </p>
    </form>
  );
}
