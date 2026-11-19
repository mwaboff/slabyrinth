/**
 * electron-builder's `appId` (electron-builder.yml). The NSIS installer stamps it on the Start menu
 * and desktop shortcuts as their AppUserModelID; the running app must use the same ID so Windows
 * groups its window under those shortcuts (taskbar pin, jump list, notifications). Checked against
 * the builder config by appIdentity.test.ts.
 */
export const APP_ID = "app.slabyrinth.desktop";
