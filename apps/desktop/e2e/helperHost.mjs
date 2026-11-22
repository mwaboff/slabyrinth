/**
 * A bare Electron host for helperPage.spec.ts: one hidden, empty window that the spec points at the TaleSpire
 * add-on's real page (Electron's Chromium stands in for TaleSpire's embedded Chromium). Launched only by Playwright
 * under `npm run test:e2e`; its user data goes to the throwaway folder the spec names, never the real one.
 */
import { app, BrowserWindow } from "electron";

const userData = process.env["HELPER_HOST_USER_DATA"];
if (!userData) {
  console.error("HELPER_HOST_USER_DATA is required");
  process.exit(2);
}
app.setPath("userData", userData);
app.on("window-all-closed", () => {
  app.quit();
});
void app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, width: 420, height: 900 });
  void win.loadURL("about:blank");
});
