// skills.ts——D1 后只剩纯函数层：SKILL.md 解析、$ARGUMENTS 展开、目录文本。
// 发现与竞争（user/project 两层、同名覆盖）迁 plugins/skills-registry.ts 的
// provider registry（rank 竞争）；catalog 注入改 user message（pre-step 改写）。

import { readFileSync } from "fs";
import { basename } from "path";
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

export function parseSkillFile(
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

        // allowed-tools 两种写法都收：JSON 数组字符串（"[a, b]"）或裸逗号分隔（a, b）
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

/** 目录文本：名字 + 描述（正文按需经 skill 工具加载）。D1 起进 user message。 */
export function buildSkillDescriptions(skills: SkillDefinition[]): string {
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
