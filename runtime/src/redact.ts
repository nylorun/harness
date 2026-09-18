export function scrub(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string")
    return secrets.reduce(
      (text, secret) =>
        secret.length >= 8 ? text.split(secret).join("[redacted]") : text,
      value.replace(
        /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/giu,
        "[inline image data redacted]",
      ),
    );
  if (Array.isArray(value)) return value.map((item) => scrub(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        /^(authorization|api[_-]?key|(?:access|refresh|id|auth)[_-]?token|token|secret|password|cookie|credentials?)$/iu.test(
          key,
        )
          ? "[redacted]"
          : scrub(item, secrets),
      ]),
    );
  return value;
}
