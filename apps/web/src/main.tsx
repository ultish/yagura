import "@fontsource/shippori-mincho/600.css";
import "@fontsource/shippori-mincho/700.css";
import "@fontsource/zen-kaku-gothic-new/latin-400.css";
import "@fontsource/zen-kaku-gothic-new/latin-500.css";
import "@fontsource/zen-kaku-gothic-new/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "./theme.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);
