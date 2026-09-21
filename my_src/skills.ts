import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { parseFrontmatter } from "./frontmatter.js";

export interface SkillDefinition {
    name: string;
    description: string;
    whenToUse?: string;
    allowedTools?: string[];
    userInvocable: boolean;
    context: "inline" | "fork";
    promptTemplate: string;
    source: "project" | "user";
    skillDir: string;
}

function parseSkillFile(
    filePath: string,
    source: "project" | "user",
    skillDir: string
): SkillDefinition | null {
    try {
        const raw = readFileSync(filePath, "utf-8");
        const { meta, body } = parseFrontmatter(raw);

        const name = meta.name || basename(skillDir);
        const userInvocable = meta["user-invocable"] !== "false";
        const context = meta.context === "fork" ? "fork" as const : "inline" as const;

        let allowedTools: string[] | undefined;
        if (meta["allowed-tools"]) {
            const rawTools = meta["allowed-tools"];
            if (rawTools.startsWith("[")) {
                try {
                    allowedTools = JSON.parse(rawTools);
                } catch {
                    allowedTools = rawTools.replace(/[\[\]]/g, "").split(",").map((s) => s.trim());
                }
            } else {
                allowedTools = rawTools.split(",").map((s) => s.trim());
            }
        }

        return {
            name,
            description: meta.description || "",
            whenToUse: meta.when_to_use || meta["when-to-use"],
            allowedTools,
            userInvocable,
            context,
            promptTemplate: body,
            source,
            skillDir,
        };
    } catch {
        return null;
    }
}

export function resolveSkillPrompt(skill: SkillDefinition, args: string): string {
    let prompt = skill.promptTemplate;
    prompt = prompt.replace(/\$ARGUMENTS|\$\{ARGUMENTS\}/g, args);
    prompt = prompt.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skill.skillDir);
    return prompt;
}

// ─── Discovery ──────────────────────────────────────────────

let cachedSkills: SkillDefinition[] | null = null;

export function discoverSkills(): SkillDefinition[] {
    if (cachedSkills) return cachedSkills;

    const skills = new Map<string, SkillDefinition>();

    // user 层先加载（低优先级），project 层后加载覆盖同名
    loadSkillsFromDir(join(homedir(), ".claude", "skills"), "user", skills);
    loadSkillsFromDir(join(process.cwd(), ".claude", "skills"), "project", skills);

    cachedSkills = Array.from(skills.values());
    return cachedSkills;
}

function loadSkillsFromDir(
    baseDir: string,
    source: "project" | "user",
    skills: Map<string, SkillDefinition>
): void {
    if (!existsSync(baseDir)) return;
    let entries: string[];
    try {
        entries = readdirSync(baseDir);
    } catch { return; }

    for (const entry of entries) {
        const skillDir = join(baseDir, entry);
        // 两级结构：只处理目录（混进来的散文件跳过）；statSync 对坏符号链接会抛
        try {
            if (!statSync(skillDir).isDirectory()) continue;
        } catch { continue; }
        const skillFile = join(skillDir, "SKILL.md");
        if (!existsSync(skillFile)) continue;

        const skill = parseSkillFile(skillFile, source, skillDir);
        if (skill) skills.set(skill.name, skill);
    }
}

// ─── Resolution ─────────────────────────────────────────────

export function getSkillByName(name: string): SkillDefinition | null {
    return discoverSkills().find((s) => s.name === name) || null;
}

export function executeSkill(
    skillName: string,
    args: string
): { prompt: string; allowedTools?: string[]; context: "inline" | "fork" } | null {
    const skill = getSkillByName(skillName);
    if (!skill) return null;
    return {
        prompt: resolveSkillPrompt(skill, args),
        allowedTools: skill.allowedTools,
        context: skill.context,
    };
}

// ─── System prompt section ──────────────────────────────────

export function buildSkillDescriptions(): string {
    const skills = discoverSkills();
    if (skills.length === 0) return "";

    const lines = ["# Available Skills", ""];
    const invocable = skills.filter((s) => s.userInvocable);
    const autoOnly = skills.filter((s) => !s.userInvocable);

    if (invocable.length > 0) {
        lines.push("User-invocable skills (user types /<name> to invoke):");
        for (const s of invocable) {
            lines.push(`- **/${s.name}**: ${s.description}`);
            if (s.whenToUse) lines.push(`  When to use: ${s.whenToUse}`);
        }
        lines.push("");
    }

    if (autoOnly.length > 0) {
        lines.push("Auto-invocable skills (use the skill tool when appropriate):");
        for (const s of autoOnly) {
            lines.push(`- **${s.name}**: ${s.description}`);
            if (s.whenToUse) lines.push(`  When to use: ${s.whenToUse}`);
        }
        lines.push("");
    }

    lines.push(
        "To invoke a skill programmatically, use the `skill` tool with the skill name and optional arguments."
    );
    return lines.join("\n");
}

export function resetSkillCache(): void {
    cachedSkills = null;
}
