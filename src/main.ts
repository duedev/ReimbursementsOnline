import "./ui/styles.css";
import { registerSW } from "virtual:pwa-register";
import { App } from "./ui/app.ts";

// Bootstrap. The whole app is static files; this is the only entry point.

// Keep the offline cache fresh in the background; no prompts, strong defaults.
registerSW({ immediate: true });

const root = document.getElementById("app");
if (root) {
  const app = new App(root);
  void app.init();
}
