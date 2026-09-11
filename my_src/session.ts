import { existsSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";

const SESSION_FILE = join(process.cwd(), ".mini-session.json");

export function saveSession(messages: unknown[]): void {
    try {
        writeFileSync(SESSION_FILE, JSON.stringify(messages, null, 2));
    } catch {}
}

export function loadSession(): unknown[] | null {
    if (!existsSync(SESSION_FILE)) {
        return null;
    }
    try {
        return JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
    } catch {
        return null;
    }
}