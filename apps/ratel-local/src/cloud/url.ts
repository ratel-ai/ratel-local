/**
 * Every Cloud endpoint the daemon holds must be a bare HTTPS URL: TLS because a
 * Bearer key rides on it, and no userinfo, query, or fragment because those
 * carry secrets into logs and error messages. `label` names the setting so the
 * failure points at what the operator has to fix.
 */
export function secretFreeHttpsUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${label} must be a secret-free HTTPS URL`);
  }
  return url;
}
