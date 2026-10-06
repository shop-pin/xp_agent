// plugins/commands.ts——E1：REPL slash 命令 = 插件注册。
// cli.ts 的 slash if 链整体迁此：命令的解析/打印/await 全在 handler 里，
// CLI 只剩 dispatch。goal/loop 这类 agent 驱动的命令在 handler 里 await
// 收敛——CLI 不需要知道谁阻塞。
//
// 技能调用（/<skill-name>）不进静态命令表：它是动态注册表（skills）的投影，
// 经 setSkillResolver 注入——fork/inline 分流与 skill 工具同源（同一 registry
// 同一 resolveSkillPrompt）。

import type { Context } from "../cordis/context.js";
import { CommandService, type CommandDef } from "../services/commands.js";
import { UiService } from "../services/ui-service.js";
import { SkillRegistry } from "./skills-registry.js";
import { resolveSkillPrompt } from "../skills.js";
import { listMemories } from "../memory.js";

/** Agent 借给命令插件的桥：REPL 动词到 agent 能力的映射。 */
export interface CommandsBridge {
    clearHistory(): void;
    togglePlanMode(): void;
    showCost(): void;
    compact(): Promise<boolean>;
    showGoal(): void;
    /** setGoal + pursueGoal（首 turn 即开）。 */
    startGoal(condition: string): Promise<void>;
    runLoop(rest: string): Promise<void>;
    /** 斜杠输入透传（技能回退走它——fork 借模型之手，inline 直注入）。 */
    send(text: string): Promise<void>;
}

function isAbortLike(e: unknown): boolean {
    return e instanceof Error && (e.name === "AbortError" || String(e.message).includes("aborted"));
}

async function runGuarded(ui: UiService, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
    } catch (e: any) {
        // 中断由 SIGINT 处理器报告过了，这里只报真错误
        if (!isAbortLike(e)) ui.error(String(e.message ?? e));
    }
}

export const commandsPlugin = {
    name: "commands",
    apply(ctx: Context, bridge: CommandsBridge) {
        const commands = ctx.require<CommandService>("commands");
        const ui = ctx.require<UiService>("ui");

        const def = (name: string, description: string, run: CommandDef["run"]) =>
            commands.register({ name, description, run });

        def("clear", "Clear conversation history", () => {
            bridge.clearHistory();
            ui.info("(history cleared)");
        });
        def("plan", "Toggle plan mode (read-only <-> normal)", () => bridge.togglePlanMode());
        def("cost", "Show token usage and estimated cost", () => bridge.showCost());
        def("compact", "Manually compact the conversation", () => runGuarded(ui, async () => { await bridge.compact(); }));
        def("memory", "List saved memories", () => {
            const memories = listMemories();
            if (memories.length === 0) {
                ui.info("No memories saved yet.");
                return;
            }
            ui.info(`${memories.length} memories:`);
            for (const m of memories) {
                console.log(`    [${m.type}] ${m.name} — ${m.description}`);
            }
        });
        def("goal", "Pursue a goal until met (/goal <condition>) or show status (/goal)", (args) => {
            const condition = args.trim();
            if (!condition) {
                bridge.showGoal();
                return;
            }
            return runGuarded(ui, () => bridge.startGoal(condition));
        });
        def("loop", "Re-run a prompt on an interval (5m/2h) or self-paced", (args) => {
            return runGuarded(ui, () => bridge.runLoop(args.trim()));
        });
        def("skills", "List available skills", () => {
            const skills = ctx.require<SkillRegistry>("skills").list();
            if (skills.length === 0) {
                ui.info("No skills found. Add skills to .claude/skills/<name>/SKILL.md");
                return;
            }
            ui.info(`${skills.length} skills:`);
            for (const s of skills) {
                const tag = s.userInvocable ? `/${s.name}` : s.name;
                console.log(`    ${tag} (${s.source}) — ${s.description}`);
            }
        });

        // 技能回退：动态注册表的可调用技能 → 命令形状
        commands.setSkillResolver((name) => {
            const skill = ctx.require<SkillRegistry>("skills").getByName(name);
            if (!skill || !skill.userInvocable) return null;
            return {
                name: skill.name,
                description: skill.description,
                run: async (args) => {
                    ui.info(`Invoking skill: ${skill.name}`);
                    await bridge.send(
                        skill.context === "fork"
                            ? `Use the skill tool to invoke "${skill.name}" with args: ${args || "(none)"}`
                            : resolveSkillPrompt(skill, args),
                    );
                },
            };
        });
    },
};
