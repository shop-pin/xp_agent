// plugins/core-exec-tools.ts——C1：执行类两件套（run_shell / web_fetch）。
// execute 函数体自 tools.ts 原样剪切，逻辑零改动。

import { spawn, type ChildProcess } from "child_process";
import type { Context } from "../cordis/context.js";
import type { ToolsService, ToolDefinition, JSONSchema } from "../services/tools.js";
import { toolDefinitions } from "../tools.js";

function schemaOf(name: string): Pick<ToolDefinition, "description" | "parameters" | "deferred"> {
    const def = toolDefinitions.find((t) => t.name === name)!;
    return {
        description: def.description ?? "",
        parameters: def.input_schema as unknown as JSONSchema,
        deferred: def.deferred,
    };
}

const SHELL_TIMEOUT_MS = 30000;
const KILL_GRACE_MS = 5000;
const MAX_CAPTURE = 5 * 1024 * 1024;

function killTree(child: ChildProcess): void {
    if (process.platform === "win32") {
        try {
            spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
                .on("error", () => child.kill("SIGKILL"));
            return;
        } catch {
            child.kill("SIGKILL");
            return;
        }
    }
    // POSIX：detached 起的进程组长，负 pid 杀整组
    try {
        process.kill(-child.pid!, "SIGKILL");
    } catch {
        child.kill("SIGKILL");
    }
}

/** 2026-11-05 挂机实录：execSync 的 timeout 只杀直接子进程（cmd.exe），孤儿
 *  powershell 仍握着 stdio 管道 → spawnSync 等管道 EOF 永不返回 → driver 全天
 *  卡死（0 裁决、收盘链全没跑）。改异步 exec + 超时树杀 + 宽限期硬解；契约
 *  不变——永远 resolve 字符串、不抛。exec 的完成回调在孤儿持管道时同样可能
 *  永不触发，输出从流里自己收。 */
async function runShell(input: { command: string }): Promise<string> {
    return new Promise<string>((resolve) => {
        let settled = false;
        let stdout = "";
        let stderr = "";
        let killTimer: ReturnType<typeof setTimeout>;
        let graceTimer: ReturnType<typeof setTimeout>;
        const finish = (text: string): void => {
            if (settled) return;
            settled = true;
            clearTimeout(killTimer);
            clearTimeout(graceTimer);
            resolve(text || "(no output)");
        };
        const format = (code: number | null, timedOut: boolean): string =>
            code === 0 && !timedOut
                ? stdout
                : `Command failed (exit ${code}${timedOut ? ", timed out; process tree killed" : ""})`
                    + (stdout ? `\nStdout: ${stdout}` : "")
                    + (stderr ? `\nStderr: ${stderr}` : "");
        let child: ChildProcess;
        try {
            child = spawn(input.command, {
                shell: true,
                detached: process.platform !== "win32",
                // stdin 关掉：读 stdin 的命令立刻 EOF，不开新的挂死面
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch (e: any) {
            resolve(`Command failed: ${e?.message ?? e}`);
            return;
        }
        child.stdout?.on("data", (d: Buffer) => { if (stdout.length < MAX_CAPTURE) stdout += d.toString(); });
        child.stderr?.on("data", (d: Buffer) => { if (stderr.length < MAX_CAPTURE) stderr += d.toString(); });
        child.on("close", (code) => finish(format(code, false)));
        child.on("error", (e) => finish(`Command failed: ${e?.message ?? e}${stderr ? `\nStderr: ${stderr}` : ""}`));
        killTimer = setTimeout(() => {
            killTree(child);
            graceTimer = setTimeout(() => finish(format(null, true)), KILL_GRACE_MS);
            graceTimer.unref?.();
        }, SHELL_TIMEOUT_MS);
    });
}

async function webFetch(input: { url: string; max_length?: number }): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
        const res = await fetch(input.url, {
            signal: controller.signal,
            headers: { "User-Agent": "mini-claude/1.0" },
        });
        if (!res.ok) return `HTTP error: ${res.status} ${res.statusText}`;
        let text = await res.text();
        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("html")) {
            // 去掉 script/style，标签转空格——模型看纯文本更省 token
            text = text
                .replace(/<script[\s\S]*?<\/script>/gi, "")
                .replace(/<style[\s\S]*?<\/style>/gi, "")
                .replace(/<[^>]*>/g, " ")
                .replace(/&nbsp;/g, " ")
                .replace(/&amp;/g, "&")
                .replace(/\s{2,}/g, " ")
                .replace(/\n{3,}/g, "\n\n")
                .trim();
        }
        const maxLength = input.max_length || 50000;
        if (text.length > maxLength) {
            text = text.slice(0, maxLength) + `\n\n[... truncated at ${maxLength} characters]`;
        }
        return text || "(empty response)";
    } catch (e: any) {
        return e.name === "AbortError"
            ? "Error: Request timed out (30s)"
            : `Error fetching ${input.url}: ${e.message}`;
    } finally {
        clearTimeout(timer);
    }
}

export const coreExecTools = {
    name: "core-exec-tools",
    apply(ctx: Context) {
        const tools = ctx.require<ToolsService>("tools");
        tools.register({
            name: "run_shell",
            ...schemaOf("run_shell"),
            permissionHint: "exec",
            snippable: true,
            execute: (input) => runShell(input as { command: string }),
        });
        tools.register({
            name: "web_fetch",
            ...schemaOf("web_fetch"),
            permissionHint: "read",
            execute: (input) => webFetch(input as { url: string; max_length?: number }),
        });
    },
};
