// plugins/core-exec-tools.ts——C1：执行类两件套（run_shell / web_fetch）。
// execute 函数体自 tools.ts 原样剪切，逻辑零改动。

import { execSync } from "child_process";
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

function runShell(input: { command: string }): string {
    try {
        const out = execSync(input.command, {
            encoding: "utf-8",
            maxBuffer: 5 * 1024 * 1024,
            timeout: 30000,
        });
        return out || "(no output)";
    } catch (e: any) {
        return `Command failed (exit ${e.status})${e.stdout ? `\nStdout: ${e.stdout}` : ""}${e.stderr ? `\nStderr: ${e.stderr}` : ""}`;
    }
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
