/**
 * Bearer credentials (and similar) must be non-empty and free of CR/LF so they
 * fit in a single HTTP header value without injection.
 */
export function headerSafeSecret(value: string, label: string): string {
  if (!value.trim() || /[\r\n]/.test(value)) {
    throw new Error(`${label} is required and must fit in an HTTP header`);
  }
  return value;
}
