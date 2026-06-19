export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = sortJsonValue(value[key]);
  return out;
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}
