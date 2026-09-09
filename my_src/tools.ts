import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { execFileSync, execSync } from "child_process";
import { glob } from "glob";
import type Anthropic from "@anthropic-ai/sdk";

export const toolDefinitions: Anthropic.Tool[] = [
    {
        name: "read_file",
        description: "Read the contents of a file. Returns the file content with line numbers.",
        input_schema: {
            type: "object",
            properties: {
                file_path: {
                    type: "string",
                    description: "The path to the file to read",
                },
            },
            required: ["file_path"],
        },
    },
    {
        name: "write_file",
        description: "Write content to a file. Creates it if missing, overwrites if it exists.",
        input_schema: {
            type: "object",
            properties: {
                file_path: {
                    type: "string",
                    description: "The path to the file to write",
                },
                content: {
                    type: "string",
                    description: "The content to write",
                },
            },
            required: ["file_path", "content"],
        },
    },
    {
        name: "edit_file",
        description: "Replace an exact string in a file with new content. old_string must match exactly and be unique.",
        input_schema: {
            type: "object",
            properties: {
                file_path: {
                    type: "string",
                    description: "The path to the file to edit",
                },
                old_string: {
                    type: "string",
                    description: "The exact string to find",
                },
                new_string: {
                    type: "string",
                    description: "The string to replace it with",
                }
            },
            required: ["file_path", "old_string", "new_string"],
        },
    },
    {
        name: "list_files",
        description: 'List files matching a glob pattern (e.g. "**/*.ts").',
        input_schema: {
            type: "object",
            properties: {
                pattern: {
                    type: "string",
                    description: "Glob pattern to match files",
                },
                path: {
                    type: "string",
                    description: "Base directory. Defaults to cwd.",
                },
            },
            required: ["pattern"],
        },
    },
    {
        name: "grep_search",
        description: "Search for a regex pattern in files. Returns matching lines with paths and line numbers.",
        input_schema: {
            type: "object",
            properties: {
                pattern: {
                    type: "string",
                    description: "The regex pattern to search for",
                },
                path: {
                    type: "string",
                    description: "Directory or file to search. Defaults to cwd.",
                },
            },
            required: ["pattern"],
        },
    },
    {
        name: "run_shell",
        description: "Execute a shell command and return its output. For tests, git, package installs, etc.",
        input_schema: {
            type: "object",
            properties: {
                command: {
                    type: "string",
                    description: "The shell command to execute",
                },
            },
            required: ["command"],
        },
    },
    {
        name: "web_fetch",
        description: "Fetch a URL and return its content as text. For HTML pages, tags are stripped.",
        input_schema: {
            type: "object",
            properties: {
                url: {
                    type: "string",
                    description: "The URL to fetch",
                },
                max_length: {
                    type: "number",
                    description: "Maximum content length (default 50000)",
                },
            },
            required: ["url"],
        },
    },
];

export async function executeTool(name: string, input: Record<string, any>): Promise<string> {
    let result: string;
    switch (name) {
        case "read_file":
            result = readFile(input as { file_path: string });
            break;
        case "write_file":
            result = writeFile(input as { file_path: string; content: string });
            break;
        case "edit_file":
            result = editFile(input as { file_path: string; old_string: string; new_string: string });
            break;
        case "list_files":
            result = await listFiles(input as { pattern: string; path?: string });
            break;
        case "grep_search":
            result = grepSearch(input as { pattern: string; path?: string });
            break;
        case "run_shell":
            result = runShell(input as { command: string });
            break;
        case "web_fetch":
            result = await webFetch(input as { url: string; max_length?: number });
            break;
        default:
            return `Unknown tool: ${name}`;
    }
    return truncateResult(result);
}

function readFile(input: { file_path: string }): string {
    try {
        const lines = readFileSync(input.file_path, "utf-8").split("\n");
        return lines.map((l, i) => `${String(i + 1).padStart(4)} | ${l}`).join("\n");
    } catch (e: any) {
        return `Error reading file: ${e.message}`;
    }
}

function writeFile(input: { file_path: string; content: string }): string {
    try {
        const dir = dirname(input.file_path);
        if (dir && !existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        writeFileSync(input.file_path, input.content);
        const n = input.content.split("\n").length;
        return `Successfully wrote to ${input.file_path} (${n} lines)`;
    } catch (e: any) {
        return `Error writing file: ${e.message}`;
    }
}

function editFile(input: { file_path: string; old_string: string; new_string: string }): string {
    try {
        const content = readFileSync(input.file_path, "utf-8");
        const actual = findActualString(content, input.old_string);
        if (!actual) {
            return `Error: old_string not found in ${input.file_path}`;
        }
        const times = content.split(actual).length - 1;
        if (times > 1) {
            return `Error: old_string found ${times} times in ${input.file_path}. Must be unique.`;
        }
        // split/join 是字面量替换；String.replace 会把 new_string 里的 $&、$1 当替换模式展开
        const updated = content.split(actual).join(input.new_string);
        writeFileSync(input.file_path, updated);
        const viaNormalization = actual !== input.old_string;
        return `Successfully edited ${input.file_path}${viaNormalization ? " (matched via quote normalization)" : ""}`;
    } catch (e: any) {
        return `Error editing file: ${e.message}`;
    }
}

async function listFiles(input: { pattern: string; path?: string }): Promise<string> {
    try {
        const files = await glob(input.pattern, {
            cwd: input.path || process.cwd(),
            nodir: true,
            ignore: ["node_modules/**", ".git/**"],
        });
        if (files.length === 0) return "No files found matching the pattern.";
        return files.slice(0, 200).join("\n");
    } catch (e: any) {
        return `Error listing files: ${e.message}`;
    }
}

function grepSearch(input: { pattern: string; path?: string }): string {
    try {
        const out = execFileSync("grep", ["--line-number", "--color=never", "-r", "--", input.pattern, input.path || "."], {
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
            timeout: 10000,
        });
        return out.split("\n").filter(Boolean).slice(0, 100).join("\n") || "No matches found.";
    } catch (e: any) {
        // grep 退出码 1 = 无匹配，不是错误；其他失败退回 JS 遍历（Windows 上系统 grep 可能不存在）
        if (e.status === 1) return "No matches found.";
        return grepJS(input.pattern, input.path || ".");
    }
}

function grepJS(pattern: string, dir: string): string {
    let re: RegExp;
    try { re = new RegExp(pattern); } catch (e: any) { return `Error: invalid regex: ${e.message}`; }
    const matches: string[] = [];
    const walk = (d: string) => {
        let entries: string[];
        try { entries = readdirSync(d); } catch { return; }
        for (const name of entries) {
            if (name.startsWith(".") || name === "node_modules") continue;
            const full = join(d, name);
            let st; try { st = statSync(full); } catch { continue; }
            if (st.isDirectory()) { walk(full); continue; }
            try {
                readFileSync(full, "utf-8").split("\n").forEach((line, i) => {
                    if (re.test(line) && matches.length < 100) matches.push(`${full}:${i + 1}:${line}`);
                });
            } catch {}
        }
    };
    walk(dir);
    return matches.length ? matches.join("\n") : "No matches found.";
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

const MAX_RESULT_CHARS = 50000;

// 保留头尾、砍中间：编译错误摘要、测试结果统计这类关键信息往往在输出末尾
function truncateResult(result: string): string {
    if (result.length <= MAX_RESULT_CHARS) return result;
    const keepEach = Math.floor((MAX_RESULT_CHARS - 60) / 2);
    return (
        result.slice(0, keepEach) +
        `\n\n[... truncated ${result.length - keepEach * 2} chars ...]\n\n` +
        result.slice(-keepEach)
    );
}

// LLM tokenization 偶尔把直引号写成弯引号（" → "），不做容错这类编辑会 100% 失败
function normalizeQuotes(s: string): string {
    return s
        .replace(/[‘’′]/g, "'")
        .replace(/[“”″]/g, '"');
}

// 匹配成功返回文件中的原始子串（不是标准化版本），替换时保持文件原有字符风格
function findActualString(fileContent: string, searchString: string): string | null {
    if (fileContent.includes(searchString)) return searchString;
    const normSearch = normalizeQuotes(searchString);
    const normFile = normalizeQuotes(fileContent);
    const idx = normFile.indexOf(normSearch);
    if (idx !== -1) return fileContent.substring(idx, idx + searchString.length);
    return null;
}