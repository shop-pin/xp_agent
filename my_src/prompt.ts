import { existsSync, readFileSync, readdirSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import * as os from "os";
import { buildMemoryPromptSection } from "./memory.js";
import { buildSkillDescriptions } from "./skills.js";
import { buildAgentDescriptions } from "./subagent.js";

const REGEXP = /^@(\S+)[ \t]*$/gm;
const MAX_DEPTH = 5;

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

function loadClaudeMd(): string {
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

function getGitContext(): string {
    const opts = {
        encoding: "utf-8" as const,
        timeout: 3000,
    }
    try {
        const branch = execSync("git rev-parse --abbrev-ref HEAD", opts);
        const log = execSync("git log --oneline -5", opts);
        const status = execSync("git status --short", opts);
        return `# Git context\nbranch: ${branch}\nlog: ${log}\nstatus: ${status}`;
    } catch {
        return "";
    }
}

// 动态上下文（含 memory 索引）：随项目/机器而变，且模型写记忆的瞬间索引会变——
// 所以绝不进 cache_control 静态块，单独作为第二个 system 块
export function buildDynamicSystemContext(): string {
    const memorySection = buildMemoryPromptSection();
    const skillsSection = buildSkillDescriptions();
    const agentSection = buildAgentDescriptions();
    return `# Environment\nWorking directory: ${process.cwd()}\nPlatform: ${os.platform()} ${os.arch()}\nShell: ${process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : (process.env.SHELL || "/bin/sh")}\n${getGitContext()}${memorySection}${skillsSection}${agentSection}`;
}

// 缓存的静态主体：所有用户、所有会话都完全一致，才能吃到前缀缓存
export function buildStaticSystemPrompt(): string {
    return STATIC_CORE;
}
