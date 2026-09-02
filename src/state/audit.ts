import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEvent } from "../types.js";

export async function appendAuditEvent(path: string, event: Omit<AuditEvent, "timestamp">): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const fullEvent: AuditEvent = {
    timestamp: new Date().toISOString(),
    ...event,
  };
  await writeFile(path, `${JSON.stringify(fullEvent)}\n`, { flag: "a" });
}

export async function readAuditEvents(path: string): Promise<AuditEvent[]> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditEvent);
}
