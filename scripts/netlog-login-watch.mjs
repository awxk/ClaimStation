import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

const entryUrl = "https://store.playstation.com/en-us/pages/latest";
const outPath = resolve(".ps-free-redeem/chrome-login-netlog.json");
const userDataDir = resolve(".ps-free-redeem/netlog-login-profile");
const chromePath = findChromePath();

await mkdir(dirname(outPath), { recursive: true });
await mkdir(userDataDir, { recursive: true });

const chrome = spawn(
  chromePath,
  [
    `--user-data-dir=${userDataDir}`,
    `--log-net-log=${outPath}`,
    "--net-log-capture-mode=Default",
    "--no-first-run",
    "--no-default-browser-check",
    entryUrl,
  ],
  { stdio: ["ignore", "ignore", "ignore"], windowsHide: true },
);

let stopping = false;
let promptedClose = false;

console.log(`READY ${outPath}`);
console.log("Log in in the opened Chrome window. Close that Chrome window when finished so the profile and NetLog flush cleanly.");

chrome.once("exit", () => {
  stopping = true;
});

while (!stopping) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
}

console.log("Chrome closed.");

function findChromePath() {
  const candidates = [
    process.env.PS_REDEEM_CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Could not find Chrome. Set PS_REDEEM_CHROME_PATH.");
  return found;
}

process.on("SIGINT", () => {
  if (!promptedClose) {
    console.log("Close the opened Chrome window to finish cleanly.");
    promptedClose = true;
  }
});
process.on("SIGTERM", () => {
  if (!promptedClose) {
    console.log("Close the opened Chrome window to finish cleanly.");
    promptedClose = true;
  }
});
