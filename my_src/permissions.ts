import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// 5+1 权限模式：auto 走分类器（ch15），不进本流水线
export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "auto";

export const READ_TOOLS = new Set(["read_file", "list_files", "grep_search", "web_fetch"]);
export const EDIT_TOOLS = new Set(["write_file", "edit_file"]);

// src 清单全量移植（含 Windows）。语义变化：从旧版 deny 升级为 confirm——
// 由人决定而非机器拒绝；--dont-ask（CI）下 confirm 自动转 deny
const DANGEROUS_PATTERNS = [
    /\brm\s/,
    /\bgit\s+(push|reset|clean|checkout\s+\.)/,
    /\bsudo\b/,
    /\bmkfs\b/,
    /\bdd\s/,
    />\s*\/dev\//,
    /\bkill\b/,
    /\bpkill\b/,
    /\breboot\b/,
    /\bshutdown\b/,
    /\bdel\s/i,
    /\brmdir\s/i,
    /\bformat\s/i,
    /\btaskkill\s/i,
    /\bRemove-Item\s/i,
    /\bStop-Process\s/i,
];

export function isDangerous(command: string): boolean {
    return DANGEROUS_PATTERNS.some((p) => p.test(String(command || "")));
}

// ─── 规则文件（.claude/settings.json 的 permissions.allow/deny）───

export interface ParsedRule {
    tool: string;
    pattern: string | null; // null = 匹配该工具的一切调用
}

interface PermissionRules {
    allow: ParsedRule[];
    deny: ParsedRule[];
}

// 解析语法而非特判数据："run_shell(rm *)" → {tool, pattern}；裸 "read_file" → pattern null（匹配一切调用）。
// 锚定 ^$ + 贪子 .+ 取到**最后一个**右括号，pattern 里再含括号也能正确截住
export function parseRule(rule: string): ParsedRule {
    const match = rule.match(/^([a-z_]+)\((.+)\)$/);
    if (match) {
        return { tool: match[1], pattern: match[2] };
    }
    return { tool: rule, pattern: null };
}

function loadSettings(filePath: string): any {
    if (!existsSync(filePath)) return null;
    try {
        return JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
        return null;
    }
}

// 模块级缓存：settings 是只读配置，进程内不变，读一次即可。
// 对比 ch17 的教训——session 路径是运行时状态必须惰性求值，这里是纯配置，缓存安全
let cachedRules: PermissionRules | null = null;

export function loadPermissionRules(): PermissionRules {
    if (cachedRules) return cachedRules;
    const allow: ParsedRule[] = [];
    const deny: ParsedRule[] = [];
    // 用户级 + 项目级两层都收
    const userSettings = loadSettings(join(homedir(), ".claude", "settings.json"));
    const projectSettings = loadSettings(join(process.cwd(), ".claude", "settings.json"));
    for (const settings of [userSettings, projectSettings]) {
        if (!settings?.permissions) continue;
        if (Array.isArray(settings.permissions.allow)) {
            for (const r of settings.permissions.allow) allow.push(parseRule(r));
        }
        if (Array.isArray(settings.permissions.deny)) {
            for (const r of settings.permissions.deny) deny.push(parseRule(r));
        }
    }
    cachedRules = { allow, deny };
    return cachedRules;
}

// deny 先扫（优先级高），再 allow；都没命中 → null（落回默认逻辑）
export function checkPermissionRules(
    toolName: string,
    input: Record<string, any>
): "allow" | "deny" | null {
    const rules = loadPermissionRules();
    for (const rule of rules.deny) {
        if (matchesRule(rule, toolName, input)) return "deny";
    }
    for (const rule of rules.allow) {
        if (matchesRule(rule, toolName, input)) return "allow";
    }
    return null;
}

// 返回 true = 这条规则适用于本次调用。四步各是一个 return：
// 工具名不等最先排除（最便宜）；pattern null = 管一切；取值 run_shell→command、
// 其余→file_path，都没有视为"值无关"命中；* 结尾前缀匹配，否则全等
export function matchesRule(rule: ParsedRule, toolName: string, input: Record<string, any>): boolean {
    if (rule.tool !== toolName) return false;
    if (!rule.pattern) return true;
    let value = "";
    if (toolName === "run_shell") value = String(input.command || "");
    else if (input.file_path) value = String(input.file_path);
    else return true;
    if (rule.pattern.endsWith("*")) {
        return value.startsWith(rule.pattern.slice(0, -1));
    }
    return value === rule.pattern;
}

export type PermissionDecision = { action: "allow" | "deny" | "confirm"; message?: string };

// 八阶段流水线：顺序即安全语义（显式禁令 > 模式契约 > 便捷快捷方式 > 默认行为）。
// ① deny 规则（连 --yolo 也拦） ② plan 只读契约（唯一豁免 = plan 文件本身，
//   路径全等才放行） ③ bypass 全放行 ④ allow 规则（核心价值=免确认）
// ⑤ READ_TOOLS ⑥ plan 工具本身（进出是纯状态切换，agent 层处理） ⑦ acceptEdits+EDIT_TOOLS
// ⑧ confirm 候选（dontAsk 转 deny） ⑨ 兜底 allow
export function checkPermission(
    toolName: string,
    input: Record<string, any>,
    mode: PermissionMode = "default",
    planFilePath?: string
): PermissionDecision {
    // 只扫一次规则表，①④ 共用同一个结果——两次调用间规则不会变，且省一半扫描
    const ruleResult = checkPermissionRules(toolName, input);
    if (ruleResult === "deny") {
        return { action: "deny", message: `Denied by permission rule for ${toolName}` };
    }
    // plan 只读契约压在 allow 规则和 bypass 之上：除 plan 文件外一切写/编辑都拦，
    // shell 也拦——"只读"是代码强制，不是提示词恳求
    if (mode === "plan") {
        if (EDIT_TOOLS.has(toolName)) {
            const filePath = input.file_path || input.path;
            if (planFilePath && filePath === planFilePath) {
                return { action: "allow" };
            }
            return { action: "deny", message: `Blocked in plan mode: ${toolName}` };
        }
        if (toolName === "run_shell") {
            return { action: "deny", message: "Shell commands blocked in plan mode" };
        }
    }
    if (mode === "bypassPermissions") return { action: "allow" };
    if (ruleResult === "allow") return { action: "allow" };
    if (READ_TOOLS.has(toolName)) return { action: "allow" };
    if (toolName === "enter_plan_mode" || toolName === "exit_plan_mode") {
        return { action: "allow" };
    }
    if (mode === "acceptEdits" && EDIT_TOOLS.has(toolName)) return { action: "allow" };

    let confirmMessage = "";
    if (toolName === "run_shell" && isDangerous(String(input.command || ""))) {
        confirmMessage = String(input.command || "");
    } else if (toolName === "write_file" && !existsSync(input.file_path)) {
        confirmMessage = `write new file: ${input.file_path}`;
    } else if (toolName === "edit_file" && !existsSync(input.file_path)) {
        confirmMessage = `edit non-existent file: ${input.file_path}`;
    }
    if (confirmMessage) {
        if (mode === "dontAsk") {
            return { action: "deny", message: `Auto-denied (dontAsk mode): ${confirmMessage}` };
        }
        return { action: "confirm", message: confirmMessage };
    }
    return { action: "allow" };
}
