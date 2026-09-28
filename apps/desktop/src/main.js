// JARVIS desktop shell - Phase 1 (Foundation).
//
// This is intentionally a thin, minimal Electron shell: a single window that
// loads the web dashboard (apps/web) in dev, so JARVIS is reachable as a
// native app. It carries no logic of its own.
//
// PHASE 4 - NOT IMPLEMENTED: computer control, voice, desktop-native features
// (screen reading, OS-level automation, native notifications, system tray
// integration, offline-first sync, etc). None of that is wired up here yet -
// see tools/computer.ts and tools/voice.ts for the corresponding stubs on
// the backend side.

const { app, BrowserWindow } = require("electron");

const DEV_URL = process.env.JARVIS_WEB_URL || "http://localhost:5173";

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#0b0d10",
    title: "JARVIS — Prime Pak Packages",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadURL(DEV_URL);
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// PHASE 4 - NOT IMPLEMENTED: computer control, voice, desktop-native features
