// services/commands.ts——E1：REPL slash 命令注册表。
// 参照物：dsh 的 ctx.commands（命令是插件注册的能力，CLI 只是消费者）。
//
// cli.ts 的 slash if 链（9 个命令 + 各自的解析/打印/await）在此收口为数据：
// 命令 = { name, description, run }，斜杠解析与回退（静态表 → 技能）都是
// 本域的逻辑。REPL 只剩 dispatch 一个入口；表里没有 → false → 普通输入透传。

import { Service } from "../cordis/service.js";

export interface CommandDef {
    /** 不含斜杠的名字（"goal"，不收 "/goal"）。 */
    name: string;
    description: string;
    /** args = 名字后的原始文本。抛错由调用方统一 printError。 */
    run(args: string): void | Promise<void>;
}

export class CommandService extends Service {
    private commands = new Map<string, CommandDef>();
    /** 技能回退（动态注册表的投影）：名字 → 命令。commands 插件注入。 */
    private skillResolver: ((name: string) => CommandDef | null) | null = null;

    register(def: CommandDef): void {
        this.commands.set(def.name, def);
    }

    setSkillResolver(resolver: (name: string) => CommandDef | null): void {
        this.skillResolver = resolver;
    }

    get(name: string): CommandDef | undefined {
        return this.commands.get(name);
    }

    /** 注册序返回——帮助文本的展示顺序即注册顺序。 */
    list(): CommandDef[] {
        return [...this.commands.values()];
    }

    /** 斜杠输入分发：/name args → 静态表命中 → run；未命中 → 技能回退；
     *  都不认 → false（REPL 透传给 agent）。非斜杠输入直接 false。 */
    async dispatch(input: string): Promise<boolean> {
        if (!input.startsWith("/")) return false;
        const spaceIdx = input.indexOf(" ");
        const name = spaceIdx > 0 ? input.slice(1, spaceIdx) : input.slice(1);
        const args = spaceIdx > 0 ? input.slice(spaceIdx + 1) : "";
        const cmd = this.commands.get(name) ?? this.skillResolver?.(name) ?? null;
        if (!cmd) return false;
        await cmd.run(args);
        return true;
    }
}

declare module "../cordis/context.js" {
    interface Context {
        commands?: CommandService;
    }
}
