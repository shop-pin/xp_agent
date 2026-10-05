// services/system-prompt.ts——C7：system prompt 服务。
// 参照物：deepseek-harness-master/packages/core/system-prompt/src/index.ts。
//
// 世界观：system 不是一根手拼字符串，是**分节拼装**——每节自我描述（id、
// order、静态/动态、渲染函数），服务负责排序、拼接、插值、断点。加一节
// （新的上下文源）= 注册一个 section，不碰任何既有代码。
//
// 两块结构（字节等价的锚，C3 起被 mock 场景背书）：
//   static 组 → 一块，尾打 cache_control: ephemeral（会话内不变，吃前缀缓存）
//   dynamic 组 → 一块，无断点（每次请求现算），整体 trim 后为空则不出现
// （真 dsh 的 system 是"日志里的 surface 节点"多块结构——差距记 dsh-C7.md）

import type Anthropic from "@anthropic-ai/sdk";
import { Service } from "../cordis/service.js";

export type PromptVars = Record<string, string>;

export interface PromptSection {
    id: string;
    order: number;
    /** static = 缓存断点块（会话内不变）；dynamic = 断点后块（逐请求现算）。 */
    group: "static" | "dynamic";
    render(vars: PromptVars): string | null;
}

const VAR_RE = /\{\{(\w+)\}\}/g;

export class SystemPromptService extends Service {
    private sections: PromptSection[] = [];
    private variables = new Map<string, () => string>();

    registerSection(sec: PromptSection): () => void {
        if (this.sections.some((s) => s.id === sec.id)) {
            throw new Error(`[mini-cordis] prompt section "${sec.id}" already registered`);
        }
        this.sections.push(sec);
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            this.sections = this.sections.filter((s) => s !== sec);
        };
    }

    registerVariable(key: string, get: () => string): () => void {
        if (this.variables.has(key)) {
            throw new Error(`[mini-cordis] prompt variable "{{${key}}}" already registered`);
        }
        this.variables.set(key, get);
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            this.variables.delete(key);
        };
    }

    /** 严格插值：未知 {{var}} 直接抛错——拼错名字静默上线路，比炸掉贵。 */
    private interpolate(text: string): string {
        return text.replace(VAR_RE, (whole, key: string) => {
            const get = this.variables.get(key);
            if (!get) throw new Error(`[mini-cordis] unknown prompt variable ${whole}`);
            return get();
        });
    }

    /**
     * 拼装：order 升序（稳定排序，同序按注册序）→ 分组拼接（null 跳过，连接串
     * 为空——各节自带前导分隔符，与旧 buildDynamicSystemContext 的拼接字节一致）
     * → 严格插值 → static 块打 ephemeral 断点，dynamic 整体 trim 后非空才出块。
     */
    assemble(): { system: Anthropic.TextBlockParam[] } {
        const vars: PromptVars = {};
        for (const [key, get] of this.variables) vars[key] = get();
        const sorted = [...this.sections].sort((a, b) => a.order - b.order);
        const renderGroup = (group: "static" | "dynamic"): string =>
            sorted
                .filter((s) => s.group === group)
                .map((s) => s.render({ ...vars }))
                .filter((t): t is string => t !== null)
                .join("");
        const blocks: Anthropic.TextBlockParam[] = [
            { type: "text", text: this.interpolate(renderGroup("static")), cache_control: { type: "ephemeral" } },
        ];
        const dynamicText = this.interpolate(renderGroup("dynamic")).trim();
        if (dynamicText) blocks.push({ type: "text", text: dynamicText });
        return { system: blocks };
    }
}

declare module "../cordis/context.js" {
    interface Context {
        "system-prompt"?: SystemPromptService;
    }
}
