// ch17 多会话持久化 —— 类型契约按规格，函数体对齐 src/session.ts。
// 收尾讲解（含你原稿的坑位分析）见 my_docs/17-multi-session.md 收尾记录

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface SessionMetadata {
    id: string;
    model: string;
    cwd: string;
    startTime: string;
    messageCount: number;
}

export interface SessionData {
    metadata: SessionMetadata;
    anthropicMessages?: any[];
}

function sessionDir(): string {
    return join(homedir(), ".mini-claude", "sessions");
}

export function saveSession(id: string, data: SessionData): void {
    mkdirSync(sessionDir(), { recursive: true });
    writeFileSync(join(sessionDir(), `${id}.json`), JSON.stringify(data, null, 2));
}

export function loadSession(id: string): SessionData | null {
    const sessionFile = join(sessionDir(), `${id}.json`);
    if (!existsSync(sessionFile)) return null;
    try {
        return JSON.parse(readFileSync(sessionFile, "utf-8"));
    } catch {
        return null;
    }
}

export function listSessions(): SessionMetadata[] {
    try {
        const files = readdirSync(sessionDir()).filter((f) => f.endsWith(".json"));
        return files
            .map((f) => {
                try {
                    const data = JSON.parse(readFileSync(join(sessionDir(), f), "utf-8"));
                    return data.metadata as SessionMetadata;
                } catch {
                    return null;
                }
            })
            .filter(Boolean) as SessionMetadata[];
    } catch {
        return [];
    }
}

export function getLatestSessionId(): string | null {
    const sessions = listSessions();
    if (sessions.length === 0) return null;
    sessions.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
    return sessions[0].id;
}
