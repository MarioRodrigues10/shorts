import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import "./index.css";
import App from "./App.jsx";
import { applyTheme } from "./lib/theme.js";
import { TipProvider } from "./components/ui/index.jsx";

applyTheme();

createRoot(document.getElementById("root")).render(
  <TipProvider>
    <App />
    <Toaster position="bottom-center" offset={340} toastOptions={{
      className: "!bg-surface !border-line-strong !text-fg !text-[13px] !shadow-xl",
    }} />
  </TipProvider>,
);
