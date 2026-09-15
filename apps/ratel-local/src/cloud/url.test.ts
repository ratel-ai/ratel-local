import { describe, expect, it } from "vitest";
import { secretFreeHttpsUrl } from "./url.js";

const LABEL = "Ratel Cloud catalog endpoint";

describe("secretFreeHttpsUrl", () => {
  it("accepts a bare HTTPS URL and normalises it", () => {
    expect(secretFreeHttpsUrl("https://cloud.ratel.sh/v1/catalog", LABEL).toString()).toBe(
      "https://cloud.ratel.sh/v1/catalog",
    );
  });

  it("rejects anything that could leak a secret or drop TLS", () => {
    // A Bearer key rides on this URL, and userinfo, query and fragment all end
    // up in logs and error messages.
    for (const value of [
      "http://localhost:3000/v1/catalog",
      "https://user:pw@cloud.ratel.sh/v1/catalog",
      "https://cloud.ratel.sh/v1/catalog?api_key=secret",
      "https://cloud.ratel.sh/v1/catalog#token",
    ]) {
      expect(() => secretFreeHttpsUrl(value, LABEL)).toThrow(/must be a secret-free HTTPS URL/);
    }
  });

  it("names the setting when the value is not a URL at all", () => {
    expect(() => secretFreeHttpsUrl("not a url", LABEL)).toThrow(`${LABEL} is invalid`);
  });
});
