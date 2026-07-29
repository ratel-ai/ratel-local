import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./button";

describe("Button.LoadingIndicator", () => {
  it("renders an accessible loading status inside the button", () => {
    const html = renderToStaticMarkup(
      <Button disabled>
        <svg aria-hidden="true" />
        <Button.LoadingIndicator label="Saving" />
        Save
      </Button>,
    );

    expect(html).toContain('data-slot="button-loading-indicator"');
    expect(html).toContain('data-slot="button-loading-spinner"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Saving"');
  });
});
