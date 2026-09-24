/**
 * `nylorun serve` was removed (D§12 / F2-5). Use `nylorun dev` in development
 * and `node dist/src/main.js` (with the three environment variables) in production.
 */
export async function serve(): Promise<never> {
  throw new Error(
    "nylorun serve was removed. Use nylorun dev [entry] in development, or node dist/src/main.js with NYLORUN_RUNTIME_URL, NYLORUN_TENANT and NYLORUN_SERVER_KEY.",
  );
}
