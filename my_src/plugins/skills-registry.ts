// plugins/skills-registry.ts——D1：skills 三层化。
// 参照物：deepseek-harness-master/packages/skill/ 的分层（registry / 发现 / 注入）。
//
// 三层：
//   ① provider registry（SkillRegistry 服务）：同名按 rank 竞争——project 覆盖
//      user 的现状 = rank 实现（user=10，project=20，高 rank 后写胜）
//   ② 目录发现：文件扫描从 skills.ts 迁入（每次现扫——旧的模块级缓存消亡，
//      换取 registry 视图永远新鲜）
//   ③ 目录注入：pre-step 监听器在会话首批输入（historyEmpty）追加 catalog
//      ——对齐 dsh"描述进目录（user message）、正文按需加载（skill 工具）"。
//      子 agent 不注入（config.catalogInjection=false：它的 system/白名单已定界）

import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { Service } from "../cordis/service.js";
import type { Context } from "../cordis/context.js";
import { parseSkillFile, buildSkillDescriptions, type SkillDefinition } from "../skills.js";

export interface SkillProvider {
    source: string;
    /** 同名竞争：高 rank 胜（同 rank 后注册胜）。 */
    rank: number;
    list(): SkillDefinition[];
}

export class SkillRegistry extends Service {
    private providers: SkillProvider[] = [];

    registerProvider(p: SkillProvider): () => void {
        if (this.providers.some((x) => x.source === p.source)) {
            throw new Error(`[mini-cordis] skill provider "${p.source}" already registered`);
        }
        this.providers.push(p);
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            this.providers = this.providers.filter((x) => x !== p);
        };
    }

    /** 解析视图：rank 升序逐层写入，高 rank 后写胜（project 盖 user）。 */
    list(): SkillDefinition[] {
        const byName = new Map<string, SkillDefinition>();
        for (const p of [...this.providers].sort((a, b) => a.rank - b.rank)) {
            for (const s of p.list()) byName.set(s.name, s);
        }
        return [...byName.values()];
    }

    getByName(name: string): SkillDefinition | null {
        return this.list().find((s) => s.name === name) || null;
    }
}

/** 目录扫描（自 skills.ts 的 loadSkillsFromDir 原样迁入）。 */
function scanSkillDir(baseDir: string, source: "user" | "project"): SkillDefinition[] {
    if (!existsSync(baseDir)) return [];
    let entries: string[];
    try {
        entries = readdirSync(baseDir);
    } catch { return []; }

    const found: SkillDefinition[] = [];
    for (const entry of entries) {
        const skillDir = join(baseDir, entry);
        // 两级结构：只处理目录（混进来的散文件跳过）；statSync 对坏符号链接会抛
        try {
            if (!statSync(skillDir).isDirectory()) continue;
        } catch { continue; }
        const skillFile = join(skillDir, "SKILL.md");
        if (!existsSync(skillFile)) continue;
        const skill = parseSkillFile(skillFile, source, skillDir);
        if (skill) found.push(skill);
    }
    return found;
}

export const skillsPlugin = {
    name: "skills-registry",
    apply(ctx: Context, config: { catalogInjection?: boolean } = {}) {
        const reg = new SkillRegistry(ctx, "skills");
        reg.registerProvider({
            source: "user",
            rank: 10,
            list: () => scanSkillDir(join(homedir(), ".claude", "skills"), "user"),
        });
        reg.registerProvider({
            source: "project",
            rank: 20,
            list: () => scanSkillDir(join(process.cwd(), ".claude", "skills"), "project"),
        });
        if (config.catalogInjection === false) return;

        // 目录注入：会话首批输入追加 catalog（<system-reminder> 包裹——skill 描述
        // 与 CLAUDE.md 同属不可信仓库内容，同款待遇）。around 礼仪：先取 inner 裁决，
        // 上游拒绝/改空则原样尊重，只在"继续进入"时追加（否决链不能被注入翻案）
        ctx.on("agent/pre-step", (payload, next) => {
            const inner = next() as { reject?: string; input?: string[] };
            if (!payload.historyEmpty || inner.reject !== undefined) return inner;
            const catalog = buildSkillDescriptions(reg.list());
            if (!catalog) return inner;
            const input = [...(inner.input ?? payload.input)];
            if (input.length === 0) return inner;
            input[input.length - 1] = `${input[input.length - 1]}\n\n<system-reminder>\n${catalog}\n</system-reminder>`;
            return { input };
        });
    },
};

declare module "../cordis/context.js" {
    interface Context {
        skills?: SkillRegistry;
    }
}
