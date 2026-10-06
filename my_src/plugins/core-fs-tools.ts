// plugins/core-fs-tools.ts——C1：文件系统五件套（read/write/edit/list/grep）。
// execute 函数体自 tools.ts 原样剪切，逻辑零改动；schema 从 tools.ts 的
// toolDefinitions 按名取用（schema 数据的单一来源仍在 tools.ts，迁移面最小）。

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { execFileSync } from "child_process";
import { glob } from "glob";
import type { Context } from "../cordis/context.js";
import { getMemoryDir, updateMemoryIndex } from "../memory.js";
import type { ToolsService, ToolDefinition, ToolExec, JSONSchema } from "../services/tools.js";
import { toolDefinitions } from "../tools.js";

/** 按名取旧 schema 三件套（description/parameters/deferred），工具定义就地组装。 */
function schemaOf(name: string): Pick<ToolDefinition, "description" | "parameters" | "deferred"> {
    const def = toolDefinitions.find((t) => t.name === name)!;
    return {
        description: def.description ?? "",
        parameters: def.input_schema as unknown as JSONSchema,
        deferred: def.deferred,
    };
}

function readFile(input: { file_path: string }, readFileState?: Map<string, number>): string {
    try {
        const lines = readFileSync(input.file_path, "utf-8").split("\n");
        const out = lines.map((l, i) => `${String(i + 1).padStart(4)} | ${l}`).join("\n");
        // 记：簿记失败不能毁掉一次成功的读，stat 单独包 try/catch
        if (readFileState) {
            try { readFileState.set(resolve(input.file_path), statSync(input.file_path).mtimeMs); } catch { }
        }
        return out;
    } catch (e: any) {
        return `Error reading file: ${e.message}`;
    }
}

function writeFile(input: { file_path: string; content: string }, readFileState?: Map<string, number>): string {
    const absPath = resolve(input.file_path);
    try {
        // 比：已存在的文件必须先读过、读后没被外部改过；新文件跳过（没东西可读）。
        // 比 处 statSync 抛（TOCTOU 删文件）由外层 catch 收成一次普通失败，不炸 Agent 循环
        if (readFileState && existsSync(absPath)) {
            if (!readFileState.has(absPath)) {
                return "Error: You must read this file before writing. Use read_file first to see its current contents.";
            }
            if (statSync(absPath).mtimeMs !== readFileState.get(absPath)) {
                return `Warning: ${input.file_path} was modified externally since your last read. Please read_file again before writing.`;
            }
        }
        const dir = dirname(input.file_path);
        if (dir && !existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        writeFileSync(input.file_path, input.content);
        autoUpdateMemoryIndex(absPath);
        // 更新（防自伤）：不回写的话下次写/编辑会把自己上次写入误判成"外部修改"
        if (readFileState) {
            try { readFileState.set(absPath, statSync(absPath).mtimeMs); } catch { }
        }
        const n = input.content.split("\n").length;
        return `Successfully wrote to ${input.file_path} (${n} lines)`;
    } catch (e: any) {
        return `Error writing file: ${e.message}`;
    }
}

// write_file 落进记忆目录时自动重建 MEMORY.md 索引——模型只管写记忆文件，
// 索引永远机器维护。解析失败/非记忆写入全部静默跳过（非关键路径）
function autoUpdateMemoryIndex(filePath: string): void {
    try {
        const memDir = getMemoryDir();
        if (filePath.startsWith(memDir) && filePath.endsWith(".md") && !filePath.endsWith("MEMORY.md")) {
            updateMemoryIndex();
        }
    } catch { /* non-critical */ }
}

function editFile(
    input: { file_path: string; old_string: string; new_string: string },
    readFileState?: Map<string, number>
): string {
    const absPath = resolve(input.file_path);
    try {
        if (readFileState && existsSync(absPath)) {
            if (!readFileState.has(absPath)) {
                return "Error: You must read this file before editing. Use read_file first to see its current contents.";
            }
            if (statSync(absPath).mtimeMs !== readFileState.get(absPath)) {
                return `Warning: ${input.file_path} was modified externally since your last read. Please read_file again before editing.`;
            }
        }
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
        // 更新（防自伤）：编辑失败（found N times 等）不会走到这里，map 里还是有效旧值
        if (readFileState) {
            try { readFileState.set(absPath, statSync(absPath).mtimeMs); } catch { }
        }
        const viaNormalization = actual !== input.old_string;
        const diff = generateDiff(content, actual, input.new_string);
        return `Successfully edited ${input.file_path}${viaNormalization ? " (matched via quote normalization)" : ""}\n\n${diff}`;
    } catch (e: any) {
        return `Error editing file: ${e.message}`;
    }
}

// 语义 diff：只描述这次替换（hunk 头 + 增删行），不是逐字符 diff——核对改动够用且省 token。
// 行号 = 匹配点之前文本里的换行数 + 1；oldString 传 actual（文件里的原始子串），
// 否则弯引号容错命中的场景里 diff 会和实际改动对不上。
function generateDiff(oldContent: string, oldString: string, newString: string): string {
    const beforeChange = oldContent.split(oldString)[0];
    const lineNum = (beforeChange.match(/\n/g) || []).length + 1;
    const oldLines = oldString.split("\n");
    const newLines = newString.split("\n");
    const parts: string[] = [`@@ -${lineNum},${oldLines.length} +${lineNum},${newLines.length} @@`];
    for (const l of oldLines) parts.push(`- ${l}`);
    for (const l of newLines) parts.push(`+ ${l}`);
    return parts.join("\n");
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
            } catch { }
        }
    };
    walk(dir);
    return matches.length ? matches.join("\n") : "No matches found.";
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

export const coreFsTools = {
    name: "core-fs-tools",
    apply(ctx: Context) {
        const tools = ctx.require<ToolsService>("tools");
        tools.register({
            name: "read_file",
            ...schemaOf("read_file"),
            permissionHint: "read",
            snippable: true, // D5：T2 可剪（旧 SNIPPABLE_TOOLS 集合变元数据）
            execute: (input, exec: ToolExec) => readFile(input as { file_path: string }, exec.readFileState),
        });
        tools.register({
            name: "write_file",
            ...schemaOf("write_file"),
            permissionHint: "edit",
            execute: (input, exec: ToolExec) => writeFile(input as { file_path: string; content: string }, exec.readFileState),
        });
        tools.register({
            name: "edit_file",
            ...schemaOf("edit_file"),
            permissionHint: "edit",
            execute: (input, exec: ToolExec) => editFile(input as { file_path: string; old_string: string; new_string: string }, exec.readFileState),
        });
        tools.register({
            name: "list_files",
            ...schemaOf("list_files"),
            permissionHint: "read",
            snippable: true,
            execute: (input) => listFiles(input as { pattern: string; path?: string }),
        });
        tools.register({
            name: "grep_search",
            ...schemaOf("grep_search"),
            permissionHint: "read",
            snippable: true,
            execute: (input) => grepSearch(input as { pattern: string; path?: string }),
        });
    },
};
