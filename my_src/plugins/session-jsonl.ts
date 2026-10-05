// plugins/session-jsonl.ts——C8：会话持久化（JSONL 追加日志）。
// 参照物：packages/core/session/src/ 的持久化段（generation/独占写句柄/migration）。
//
// 世界观：落盘的不是"消息快照"，是**事件日志本身**——resume = 逐行重放进
// SessionLog，derive 恢复请求历史，meta/note 顺带恢复 mode/cost/激活工具/goal
// （超越旧版 JSON 快照 resume 的能力）。
//
// 已知裁剪（真 dsh 有、mini 不做，记 dsh-C8.md）：
//   - generation/独占写句柄/fsync 策略：appendFileSync 每事件一次（同步写，
//     进程崩则丢最后一批 OS 缓冲——半行丢弃兜底）
//   - migration（旧代日志升级）：重启即弃
//   - 压缩改写与日志的发散（C3 双记口径）：resume 恢复的是**压缩前**的原始
//     历史——比崩溃前的工作集大但语义正确，D5 投影 replace 后消失

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Context } from "../cordis/context.js";
import type { SessionEvent, SessionLog } from "../services/session-log.js";

/** 文件里的一行：会话事件，或 /clear 的截断标记。 */
export type PersistLine = SessionEvent | { type: "log/clear" };

export function sessionDir(): string {
    return join(homedir(), ".mini-claude", "sessions");
}

/** 读会话文件：逐行 parse，半行（崩溃尾巴）静默丢弃。文件不存在返回 null。 */
export function readSessionLines(sessionId: string, dir: string = sessionDir()): PersistLine[] | null {
    const file = join(dir, `${sessionId}.jsonl`);
    if (!existsSync(file)) return null;
    const lines: PersistLine[] = [];
    for (const raw of readFileSync(file, "utf-8").split("\n")) {
        if (!raw.trim()) continue;
        try {
            lines.push(JSON.parse(raw) as PersistLine);
        } catch { /* 崩溃尾巴：半行丢弃 */ }
    }
    return lines;
}

/** 最新会话 id：按文件 mtime（"每事件即落盘"让 mtime 天然新鲜）。 */
export function getLatestSessionId(dir: string = sessionDir()): string | null {
    try {
        const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
        if (files.length === 0) return null;
        let best: string | null = null;
        let bestMtime = -1;
        for (const f of files) {
            const m = statSync(join(dir, f)).mtimeMs;
            if (m > bestMtime) {
                bestMtime = m;
                best = f;
            }
        }
        return best ? best.replace(/\.jsonl$/, "") : null;
    } catch {
        return null;
    }
}

/** 崩溃修复：turn/start 无配对 turn/end → 补合成 end（注记层完整性）。 */
export function repairUnclosedTurn(log: SessionLog): void {
    let open = false;
    for (const evt of log.events) {
        if (evt.type === "turn/start") open = true;
        else if (evt.type === "turn/end") open = false;
    }
    if (open) log.append({ type: "turn/end", reason: "recovered" });
}

export const sessionJsonlPlugin = {
    name: "session-jsonl",
    inject: ["session-log"],
    apply(ctx: Context, config: { sessionId: string; dir?: string }) {
        const dir = config.dir ?? sessionDir();
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${config.sessionId}.jsonl`);
        const log = ctx.require<SessionLog>("session-log");
        const offAppend = log.onAppend((evt) => {
            try {
                appendFileSync(file, JSON.stringify(evt) + "\n");
            } catch { /* 落盘失败不毁会话——内存日志仍是真相 */ }
        });
        const offClear = log.onClear(() => {
            try {
                appendFileSync(file, JSON.stringify({ type: "log/clear" }) + "\n");
            } catch { }
        });
        ctx.effect(() => () => {
            offAppend();
            offClear();
        });
    },
};
