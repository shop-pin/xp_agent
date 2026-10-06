// services/ui-service.ts——E1：UI 消费者化。
// 参照物：dsh 的"UI 是 session 事件的渲染器"（进程内版）。
//
// 迁移前 ui.ts 是被引擎到处 import 的打印库（48 个直印点）——引擎认识 UI。
// 迁移后分两层：
//   消息面（会话事实）——本服务订阅 session-log.onAppend，tool/call 事件驱动
//     渲染。引擎不再直印工具调用：**日志里有的事实，UI 自己看得见**。
//   叙事面（状态旁白）——info/error/cost/spinner/确认/子代理横幅走 ctx.ui.*，
//     引擎只说"发生了什么"，渲染器（可替换/可静默）决定长什么样。输出与旧
//     print* 逐字节一致——本章只搬家，不改样子。
//
// 差距记档：dsh 连叙事也是日志事件（surfaceOp 投影）；mini 的旁白仍是直接
// 调用——assistant 流式文本同理（增量走 onText，不_render自日志，否则与
// 流式双打）。全面事件化留待真 dsh 对照。

import chalk from "chalk";
import { Service } from "../cordis/service.js";
import type { SessionLog } from "./session-log.js";
import * as view from "../ui.js";

export interface UiRenderer {
    info(msg: string): void;
    error(msg: string): void;
    toolCall(name: string, input: Record<string, any>): void;
    /** assistant 文本（主循环是流式增量，子代理是非流式全文）。 */
    text(text: string): void;
    cost(inputTokens: number, outputTokens: number, cacheRead: number, cacheCreation: number): void;
    spinnerStart(label?: string): void;
    spinnerStop(): void;
    confirmation(message: string): void;
    subAgentStart(type: string, description: string): void;
    subAgentEnd(type: string, description: string): void;
}

/** 默认渲染器 = 旧 ui.ts 的控制台实现（逐字节同款输出）。 */
export const consoleRenderer: UiRenderer = {
    info: (msg) => view.printInfo(msg),
    error: (msg) => view.printError(msg),
    toolCall: (name, input) => view.printToolCall(name, input),
    text: (text) => view.printAssistantText(text),
    cost: (input, output, cacheRead, cacheCreation) => view.printCost(input, output, cacheRead, cacheCreation),
    spinnerStart: (label) => view.startSpinner(label),
    spinnerStop: () => view.stopSpinner(),
    confirmation: (message) => view.printConfirmation(message),
    subAgentStart: (type, description) => view.printSubAgentStart(type, description),
    subAgentEnd: (type, description) => view.printSubAgentEnd(type, description),
};

export class UiService extends Service {
    private renderer: UiRenderer = consoleRenderer;

    /** 渲染器替换（null = 静默——测试/未来 headless 模式用）。 */
    setRenderer(renderer: UiRenderer | null): void {
        this.renderer = renderer ?? {
            info: () => {}, error: () => {}, toolCall: () => {}, text: () => {},
            cost: () => {}, spinnerStart: () => {}, spinnerStop: () => {},
            confirmation: () => {}, subAgentStart: () => {}, subAgentEnd: () => {},
        };
    }

    info(msg: string): void { this.renderer.info(msg); }
    error(msg: string): void { this.renderer.error(msg); }
    text(text: string): void { this.renderer.text(text); }
    cost(inputTokens: number, outputTokens: number, cacheRead = 0, cacheCreation = 0): void {
        this.renderer.cost(inputTokens, outputTokens, cacheRead, cacheCreation);
    }
    spinnerStart(label?: string): void { this.renderer.spinnerStart(label); }
    spinnerStop(): void { this.renderer.spinnerStop(); }
    confirmation(message: string): void { this.renderer.confirmation(message); }
    subAgentStart(type: string, description: string): void { this.renderer.subAgentStart(type, description); }
    subAgentEnd(type: string, description: string): void { this.renderer.subAgentEnd(type, description); }

    /** 消息面挂载：session-log 的 tool/call 驱动工具调用渲染。日志里已有的
     *  事实不再由引擎直印——渲染顺序 = 日志顺序（onAppend 同步回调）。 */
    attachSessionLog(): void {
        this.ctx.get<SessionLog>("session-log")?.onAppend((evt) => {
            if (evt.type === "tool/call") this.renderer.toolCall(evt.name, evt.input);
        });
    }
}

declare module "../cordis/context.js" {
    interface Context {
        ui?: UiService;
    }
}
