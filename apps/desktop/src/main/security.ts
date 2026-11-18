import { app, session, type WebContents } from "electron";
import { CSP_DEV, CSP_PROD } from "./csp";

/**
 * Security posture (architecture §6.5). Call once, before app "ready".
 * - every renderer is sandboxed (app.enableSandbox)
 * - navigation, new windows and <webview> are denied for every WebContents
 * - all permission requests and checks are denied
 * - the CSP is sent as a response header too (the meta tag in index.html covers file://)
 *
 * TODO(WP5): shell:openExternal / talespire:openUrl allowlists live with their IPC handlers.
 */
export function installSecurityPolicy(isDev: boolean): void {
  app.enableSandbox();

  app.on("web-contents-created", (_event, contents) => {
    lockDownWebContents(contents);
  });

  void app.whenReady().then(() => {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false);
    });
    ses.setPermissionCheckHandler(() => false);
    const csp = isDev ? CSP_DEV : CSP_PROD;
    ses.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [csp],
        },
      });
    });
  });
}

function lockDownWebContents(contents: WebContents): void {
  contents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  contents.on("will-redirect", (event) => {
    event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}
