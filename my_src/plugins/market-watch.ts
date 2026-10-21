// plugins/market-watch.ts——S9：盯盘编排（P3 总验收的粘合层）。
//
// 编排思想（总纲 §一"数据面/模型面分离"的 turn 侧推论）：巡检是代码的
// 事（market-data 已在轮询），LLM turn 只在有内容时发生——三个 turn 来源：
//   ① 开盘巡检：进入 open 后的第一个 tick 唤醒一次（/brief + 信号 + 计划）
//   ② 盘中信号：market/signal 事件唤醒（信箱攒批——冷却窗内同 code 留最新
//      不裸丢，出账时超龄丢弃 + 同 code 日上限 + digest 合并一个 turn。
//      Day 1 复盘 P1：80 个 turn 全在裁噪音，真信号还被槽位饿死）
//   ③ 收盘复盘：当日巡检过且转入 closed 后唤醒一次（/review）
//
// 状态机（tick 驱动，不描墙钟目标）：schedule 键控 tick 每 tickMs 评估
// marketPhase(market.clock())——开盘/收盘是"观察到的迁移"不是"算出来的
// 时刻"，对时钟跳变/注入钟天然稳健。日键 = cnDay：跨日重置巡检/复盘标记，
// 一个长驻会话可以连盯多日。
//
// 时钟源纪律：watch 不注入自己的钟——market.clock() 单一来源（mock 场景
// 换 market 的钟，watch 自动跟随）。唤醒走 AppHost 桥（profile 工厂传
// host.wake——C5 loop 同款 inbox next-turn 机制）。
//
// /watch（off 停）：用户显式启动——不是挂载即盯盘（一次性问价的会话不该
// 被唤醒）。注记 meta/note(key:"watch") 进 SessionLog（日志即真相）。

import type { Context } from "../cordis/context.js";
import type { Plugin } from "../cordis/fiber.js";
import { Service } from "../cordis/service.js";
import type { CommandService } from "../services/commands.js";
import type { UiService } from "../services/ui-service.js";
import type { SessionLog } from "../services/session-log.js";
import type { ScheduleService } from "../services/schedule.js";
import { marketPhase, type MarketDataService } from "./market-data.js";
import { cnDay } from "./paper-broker.js";
import type { Signal } from "./signal-engine.js";
import type { TradeGuardService } from "./trade-guard.js";

/** 盘中信号的时:分（CN）——唤醒文本里给人看的时间戳。 */
function cnHm(ts: number): string {
    const parts: Record<string, string> = {};
    for (const p of new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(ts))) parts[p.type] = p.value;
    return `${parts.hour}:${parts.minute}`;
}

export interface WatchPrompts {
    open(date: string): string;
    /** sigs 新→旧；冷却窗内多笔合并成一个 digest turn（Day 1 P1 攒批）。 */
    signal(sigs: Signal[], time: string): string;
    close(date: string): string;
}

export const defaultPrompts: WatchPrompts = {
    open: (date) =>
        `[盯盘 ${date} 开盘巡检] 请依次：/brief（自选股要闻与行情概览）→ get_signals（早盘信号）→`
        + ` 若有信号跑 /adjudicate。最后给出今日盯盘计划（关注位与风控位）。`,
    signal: (sigs, time) => {
        const lines = sigs.map((s) =>
            `${s.code} ${s.name}：${s.note}（${s.rule}/${s.direction}，strength ${s.strength}）`);
        return `[盯盘 盘中信号 ${time}] ${sigs.length} 笔待裁：${lines.join("；")}。`
            + `请逐笔 /adjudicate；若某笔 verdict 为 buy-candidate 且信心充足，`
            + `可 place_order 小仓位模拟（自动过风控与审批）。`;
    },
    close: (date) =>
        `[盯盘 ${date} 收盘] 请运行 /review 做今日复盘（持仓与当日盈亏、当日成交、`
        + `信号与消息对照、memory 更新持仓与偏好、明日计划）。`,
};

export interface WatchConfig {
    /** 唤醒桥（AppHost.wake——profile 工厂注入）。 */
    wake?: (text: string) => Promise<void>;
    /** 信号唤醒最小间隔 ms（默认 3 分钟——turn 经济性）。 */
    signalCooldownMs?: number;
    /** 单信号最大待醒年龄 ms（flush 时超龄丢弃；默认 2×冷却窗——Day 1：
     *  5 小时前的信号照常醒来。攒批需要余量，取 1×冷却窗会让冷却早期进
     *  信箱的信号到出账时必然超龄）。 */
    maxSignalAgeMs?: number;
    /** 同 code 每日最大唤醒次数（默认 2——"已裁决码静音"的机械代理）。 */
    perCodeWakeCap?: number;
    /** 提示词覆盖（测试锚定）。 */
    prompts?: Partial<WatchPrompts>;
}

export class WatchService extends Service {
    armed = false;
    /** 测试/探针观察面：编排进度的只读快照。 */
    get snapshot(): { armed: boolean; day: string; patrolled: boolean; reviewed: boolean } {
        return { armed: this.armed, day: this.day, patrolled: this.patrolled, reviewed: this.reviewed };
    }
    private day = "";
    private patrolled = false;
    private reviewed = false;
    private lastSignalWake = 0;
    /** 信箱：同 code 留最新（冷却内的信号不再裸丢——Day 1 中恒集团被槽位饿死）。 */
    private pending = new Map<string, { sig: Signal; at: number }>();
    private wakeCounts = new Map<string, { day: string; count: number }>();
    private wake: ((text: string) => Promise<void>) | undefined;
    private cooldown: number;
    private maxSignalAgeMs: number;
    private perCodeWakeCap: number;
    private prompts: WatchPrompts;
    private tickMs: number;

    constructor(ctx: Context, name: string, config: WatchConfig = {}) {
        super(ctx, name);
        this.wake = config.wake;
        this.cooldown = config.signalCooldownMs ?? 180_000;
        this.maxSignalAgeMs = config.maxSignalAgeMs ?? this.cooldown * 2;
        this.perCodeWakeCap = config.perCodeWakeCap ?? 2;
        this.prompts = { ...defaultPrompts, ...config.prompts };
        // 测试/演示加速旋钮（对齐 MINI_WEB_PORT 的 env 传参先例）
        this.tickMs = Number(process.env.MINI_WATCH_TICK_MS) || 30_000;
    }

    private note(value: unknown): void {
        this.ctx.get<SessionLog>("session-log")?.append({ type: "meta/note", key: "watch", value });
    }

    /** /watch：武装并立即评估（盘中启动 → 巡检马上补上）+ 排 tick 链。 */
    start(): void {
        if (this.armed) return;
        this.armed = true;
        this.ctx.get<UiService>("ui")?.info("👀 盯盘已启动（开盘巡检 / 信号唤醒 / 收盘复盘；/watch off 停止）");
        this.note({ armed: true });
        this.evaluate();
        this.chain();
    }

    /** /watch off：解除 + 撤 tick（唤醒中的 turn 不追杀——in-box 的照常跑完）。 */
    stop(): void {
        if (!this.armed) return;
        this.armed = false;
        this.ctx.get<ScheduleService>("schedule")?.cancel("watch-tick");
        this.ctx.get<UiService>("ui")?.info("👀 盯盘已停止");
        this.note({ armed: false });
    }

    private chain(): void {
        if (!this.armed) return;
        const schedule = this.ctx.get<ScheduleService>("schedule");
        if (!schedule) return;
        schedule.after("watch-tick", this.tickMs, () => {
            this.evaluate();
            this.chain();
        });
    }

    /** tick 评估：观察 phase 迁移发唤醒。跨日重置——一个会话连盯多日。 */
    evaluate(): void {
        if (!this.armed) return;
        const market = this.ctx.get<MarketDataService>("market");
        if (!market) return;
        const now = market.clock();
        const today = cnDay(now.getTime());
        if (today !== this.day) {
            this.day = today;
            this.patrolled = false;
            this.reviewed = false;
        }
        const phase = marketPhase(now);
        if (phase === "open" && !this.patrolled) {
            this.patrolled = true;
            void this.fire(this.prompts.open(today), "open", today);
        } else if (phase === "closed" && this.patrolled && !this.reviewed) {
            this.reviewed = true;
            void this.fire(this.prompts.close(today), "close", today);
        }
        if (phase === "open") this.flush(); // 冷却到期由 tick 兜底出账，不靠下一发信号
    }

    /** market/signal 监听：armed + 开盘中 + 未熔断才进信箱——冷却窗内不裸丢。 */
    onSignal(sig: Signal): void {
        if (!this.armed) return;
        const market = this.ctx.get<MarketDataService>("market");
        if (!market) return;
        const now = market.clock();
        if (marketPhase(now) !== "open") return;
        if (this.ctx.get<TradeGuardService>("guard")?.isHalted()) return;
        this.pending.set(sig.code, { sig, at: now.getTime() });
        this.flush();
    }

    /** 信箱出账：冷却窗外取一批（新→旧），超龄丢弃、同 code 超日上限丢弃——
     *  落选者翻篇不欠 wake（引擎重发纪律会带新值再来）。 */
    private flush(): void {
        if (this.pending.size === 0) return;
        const market = this.ctx.get<MarketDataService>("market");
        if (!market) return;
        const now = market.clock();
        if (marketPhase(now) !== "open") return;
        const ts = now.getTime();
        if (ts - this.lastSignalWake < this.cooldown) return;
        const day = cnDay(ts);
        const eligible = [...this.pending.values()]
            .filter((p) => ts - p.at <= this.maxSignalAgeMs)
            .filter((p) => {
                const c = this.wakeCounts.get(p.sig.code);
                return !(c && c.day === day && c.count >= this.perCodeWakeCap);
            })
            .sort((a, b) => b.at - a.at);
        this.pending.clear();
        if (eligible.length === 0) return;
        for (const p of eligible) {
            const c = this.wakeCounts.get(p.sig.code);
            this.wakeCounts.set(p.sig.code, { day, count: c && c.day === day ? c.count + 1 : 1 });
        }
        this.lastSignalWake = ts;
        void this.fire(this.prompts.signal(eligible.map((p) => p.sig), cnHm(ts)), "signal", this.day || day);
    }

    private async fire(text: string, kind: string, day: string): Promise<void> {
        this.note({ kind, day, text: text.slice(0, 120) });
        // 唤醒文本本身不进终端——转录里要有"这个 turn 是谁叫醒的"的头行
        this.ctx.get<UiService>("ui")?.info(`🔔 ${text}`);
        if (!this.wake) return; // 无桥的树（dump-config 预览）只留注记
        try {
            await this.wake(text);
        } catch (e) {
            // 唤醒失败不炸 tick 链——下一个迁移还有机会
            this.ctx.get<UiService>("ui")?.error(`盯盘唤醒失败：${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

export const marketWatchPlugin: Plugin = {
    name: "market-watch",
    // 只 inject commands（行位早）——/watch 即时注册；market/guard/schedule 惰性取
    inject: ["commands"],
    apply(ctx: Context, config: WatchConfig = {}) {
        const watch = new WatchService(ctx, "watch", config);
        ctx.on("market/signal", (sig) => watch.onSignal(sig));
        ctx.effect(() => () => {
            if (watch.armed) watch.stop();
        });
        ctx.require<CommandService>("commands").register({
            name: "watch",
            description: "盯盘编排：/watch 启动（开盘巡检/信号唤醒/收盘复盘自动驱动）；/watch off 停止",
            run: (args) => { if (args.trim() === "off") watch.stop(); else watch.start(); },
        });
    },
};

declare module "../cordis/context.js" {
    interface Context {
        watch?: WatchService;
    }
}
