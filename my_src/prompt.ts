import { existsSync, readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import * as os from "os";

const REGEXP = /^@(\S+)[ \t]*$/gm;
const MAX_DEPTH = 5;

// @<path> 指令：把引用文件的内容原地展开（CLAUDE.md 的 @import 语法，支持 ~/、
// 绝对路径、相对当前文件）。visited 防环；找不到/成环都以 HTML 注释占位，不炸加载
function resolveIncludes(content: string, basePath: string, visited: Set<string> = new Set(), depth: number = 0): string {
    if (depth > MAX_DEPTH) {
        return content;
    }
    return content.replace(REGEXP, (whole, rawPath) => {
        let path: string;
        if (rawPath.startsWith("~/")) {
            path = join(os.homedir(), rawPath.slice(2));
        } else if (rawPath.startsWith("/")) {
            path = rawPath;
        } else {
            path = join(dirname(basePath), rawPath);
        }

        if (visited.has(path)) {
            return `<!-- circular: ${path} -->`;
        }
        if (!existsSync(path)) {
            return `<!-- not found: ${whole} -->`;
        }
        visited.add(path);
        const inner = readFileSync(path, "utf-8");
        const expanded = resolveIncludes(inner, path, visited, depth + 1);
        return expanded;
    })
}

// 导出给 Auto Mode 分类器：CLAUDE.md 以 user 消息注入分类器（untrusted 内容
// 不进 system），与 buildUserContextReminder 读的是同一份
export function loadClaudeMd(): string {
    const parts = [];
    let dir = process.cwd();
    while (true) {
        const candidate = join(dir, "CLAUDE.md");
        if (existsSync(candidate)) {
            const raw = readFileSync(candidate, "utf-8");
            const expanded = resolveIncludes(raw, candidate, new Set([candidate]), 0);
            parts.unshift(expanded);
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    const rulesDir = join(process.cwd(), ".claude", "rules");
    if (existsSync(rulesDir)) {
        const rules = readdirSync(rulesDir)
            .filter((f) => f.endsWith(".md"))
            .sort()
            .map((f) => `<!-- rule: ${f} -->\n` + readFileSync(join(rulesDir, f), "utf-8"));
        if (rules.length > 0) {
            parts.push("## Rules\n\n" + rules.join("\n\n"));
        }
    }
    return parts.join("\n\n");
}

export function buildUserContextReminder(): string {
    const claudeMd = loadClaudeMd();
    const today = new Date().toISOString().split("T")[0];
    return `<system-reminder>\n${claudeMd}\n# currentDate\nToday's date is ${today}.\n</system-reminder>`;
}

const STATIC_CORE = `You are Mini Claude Code, a small coding assistant CLI.
You help with software engineering tasks using the tools available to you.

# Doing tasks
 - Do not propose changes to code you haven't read. Read files first.
 - Do not create files unless necessary. Prefer editing existing files.
 - Avoid over-engineering. Only make changes that were requested.

# Executing actions with care
 - Prefer reversible actions. For risky or destructive ones (rm -rf, git push,
   dropping tables), confirm with the user before proceeding.

# Using your tools
 - Use read_file / edit_file / list_files / grep_search instead of shell cat,
   sed, ls, grep. Reserve run_shell for actual shell operations.
 - If several tool calls are independent, make them in parallel.

# Tone and style
 - Keep responses short and concise. Lead with the answer.
 - Reference code as file_path:line_number.`;

// C7：动态上下文的拼装迁 services/system-prompt.ts + plugins/prompt-sections.ts
// （buildDynamicSystemContext/getGitContext 消亡）。本文件保留：CLAUDE.md 加载
// （@import 防环）、首条 user 消息的 reminder、静态主体文本。

// 缓存的静态主体：所有用户、所有会话都完全一致，才能吃到前缀缓存
export function buildStaticSystemPrompt(): string {
    return STATIC_CORE;
}
