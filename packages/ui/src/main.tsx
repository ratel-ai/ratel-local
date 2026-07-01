import { ThemeProvider } from "next-themes";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { AppRouter } from "./router";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing root element");
}

createRoot(root).render(
  <StrictMode>
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
    >
      <AppRouter />
    </ThemeProvider>
  </StrictMode>,
);
