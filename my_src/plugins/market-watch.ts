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

import { spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import type { Context } from "../cordis/context.js";
import type { Plugin } from "../cordis/fiber.js";
import { Service } from "../cordis/service.js";
import type { CommandService } from "../services/commands.js";
import type { UiService } from "../services/ui-service.js";
import type { SessionLog } from "../services/session-log.js";
import type { ScheduleService } from "../services/schedule.js";
import { SCHEMA } from "../backtest/schema.js";
import { BUILTIN_SCREENERS } from "../backtest/formulas/builtin.js";
import type { ScreenerHit } from "../backtest/screener-run.js";
import { dataRootPath, readSchemaJsonl } from "./data-store.js";
import { marketPhase, type MarketDataService } from "./market-data.js";
import { cnDay, cnHm, type PaperBroker } from "./paper-broker.js";
import type { Signal } from "./signal-engine.js";
import type { TradeGuardService } from "./trade-guard.js";
import { loadStrategy, type StrategyConfig } from "./strategy.js";

/** 破离场线的持仓快照（drawdown 与 /portfolio 浮盈同口径：对含费总成本）。 */
export interface RiskHit {
    code: string;
    qty: number;
    availQty: number;
    /** 含费总成本（元）。 */
    cost: number;
    /** 现价（元）。 */
    price: number;
    /** 相对含费总成本的浮动盈亏比例（负数，如 -0.0602）。 */
    drawdown: number;
    /** 触发类型：stop-loss = 破成本止损线；trailing = 峰值回撤锁利。 */
    reason: "stop-loss" | "trailing";
    /** 持有期最高快照价（trailing 触发时随附；止损触发 = 现价）。 */
    peak: number;
}

export interface WatchPrompts {
    open(date: string): string;
    /** sigs 新→旧；冷却窗内多笔合并成一个 digest turn（Day 1 P1 攒批）。 */
    signal(sigs: Signal[], time: string): string;
    /** 破止损线的持仓（S14 离场节：watch 唤醒裁决，不自动卖）。 */
    risk(hits: RiskHit[], time: string): string;
    close(date: string): string;
    /** 盘后精选（2026-11-03）：pool = 自定义公式命中池文本（空串=当日无选股产物）。 */
    refine(pool: string, day: string): string;
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
    refine: (pool, day) =>
        `[盯盘 ${day} 盘后精选] 今日选股已完成，请基于命中池做盘后精选并给出明日交易计划。`
        + `命中池（自定义公式，全量，"跟 X"=该票今日所属最强板块及板块涨幅）：\n`
        + `${pool || "（今日无选股产物——直接按盘面给计划）"}\n`
        + `精选与计划要求：`
        + `①精选 2–5 只明日候选：结合当日盘面强度、命中池自带的板块归属（板块联动）、`
        + `当日消息（latest_news）、风格状态与裁决对账（read_file 读当日 digest 的 §三/§六/§七）、`
        + `历史教训（get_learnings），每只给出：入选理由 / 风险点 / 明日关注位（介入价区与放弃条件）。`
        + `②明日交易计划：现有持仓处理（含止损/止盈触发位）、开仓方向与仓位上限、`
        + `风控纪律（单日亏损红线、不追高条件）。`
        + `③纪律：命中池已带板块归属——不要运行 shell/写脚本去解析报告或翻历史文件找板块数据；`
        + `直接给精选清单与明日计划（这是收盘前的最后输出，会话随后自退）。`,
    risk: (hits, time) => {
        const lines = hits.map((h) =>
            h.reason === "trailing"
                ? `${h.code}：峰值回撤锁利——持有期峰值 ${h.peak}，现价 ${h.price}（回撤 ${(h.peak > 0 ? (h.price / h.peak - 1) * 100 : 0).toFixed(1)}%），`
                + `含费成本 ${h.cost} 元（${h.qty} 股，可卖 ${h.availQty}），当前浮盈 ${h.drawdown >= 0 ? "+" : ""}${(h.drawdown * 100).toFixed(1)}%`
                : `${h.code}：含费成本 ${h.cost} 元（${h.qty} 股，可卖 ${h.availQty}），`
                + `现价 ${h.price}，浮亏 ${(h.drawdown * 100).toFixed(1)}%`);
        return `[盯盘 持仓风控 ${time}] ${hits.length} 笔持仓触离场线：${lines.join("；")}。`
            + `不自动卖：请逐笔 /adjudicate 裁决，确认离场的直接 place_order 卖出可卖部分`
            + `（guard 会拦超限单）；若判为瞬时插针/正常回踩可暂持，但须给出理由与认错位。`;
    },
};

/** 收盘收口缺省实现：spawn 同仓的 digest-run CLI（零 LLM 编译当日 digest）。
 *  cwd 纪律：runbook 固定从 my_src 起 `node dist/cli.js`。显式 --day（2026-10-30
 *  缺陷③：缺省取最新收口日，当日断供时静默重算昨日 digest 无告警）；stderr
 *  捕获、非零退出显式 reject——digest 挂掉要能在收口链的 catch 里喊出声。
 *  收口链本身仍不阻断自退（digest 可事后手动补跑）。 */
function spawnDigestRun(day: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath,
            [join("dist", "backtest", "digest-run.js"), "--day", day],
            { stdio: ["ignore", "ignore", "pipe"] });
        let err = "";
        child.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
        child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`digest-run exit ${code}${err.trim() ? `：${err.trim()}` : ""}`));
        });
        child.on("error", reject);
    });
}

/** 选股步骤（SC5）：同形态 spawn screener-run（research 面，结果只进
 *  screener/<day>.{jsonl,md}）。开关 = strategy.screener.autoRun（默认 false）。 */
function spawnScreenerRun(day: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath,
            [join("dist", "backtest", "screener-run.js"), "--day", day],
            { stdio: ["ignore", "ignore", "pipe"] });
        let err = "";
        child.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
        child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`screener-run exit ${code}${err.trim() ? `：${err.trim()}` : ""}`));
        });
        child.on("error", reject);
    });
}

/** 盘后日K收口（2026-11-04 用户拍板：等满 15:01 用 TDX 已收日K覆写当日
 *  daily-k 再选股——盘后官方口径替代 15:00 快照；换手率由股本表自算）。
 *  脚本 = kclose-tdx.py（eltdx TdxClient 直连，不依赖网关）。python 解释器
 *  路径 env MINI_TDX_PYTHON 可覆盖（缺省 mcp-tdx venv，相对 my_src cwd）。 */
function spawnKcloseRun(day: string): Promise<void> {
    const py = process.env.MINI_TDX_PYTHON
        ?? join("..", "mcp-tdx", ".venv", "Scripts", "python.exe");
    return new Promise((resolve, reject) => {
        const child = spawn(py,
            [join("kclose-tdx.py"), "--day", day],
            { stdio: ["ignore", "ignore", "pipe"] });
        let err = "";
        child.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
        child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`kclose-tdx exit ${code}${err.trim() ? `：${err.trim()}` : ""}`));
        });
        child.on("error", reject);
    });
}

/** 缺省收口链：盘后日K收口（kclose，等满 15:01 用 TDX 已收K覆写当日 daily-k）
 *  → 选股（strategy.screener.autoRun 开时）→ digest（必跑）。
 *  选股先于 digest 的理由：digest 第八节读当日 screener/<day>.jsonl——旧序在
 *  autoRun 当天 §八永远缺当日行（2026-11-03 修正）。kclose/选股失败都不阻断
 *  digest（复盘基础产物保住），错误最后随收口链 catch 喊出声、不阻断自退。
 *  spawn 函数可注入——链路组合的测试面。 */
export function defaultCloseOut(
    strategy: StrategyConfig,
    spawnDigest: (day: string) => Promise<void> = spawnDigestRun,
    spawnScreener: (day: string) => Promise<void> = spawnScreenerRun,
    spawnKclose: (day: string) => Promise<void> = spawnKcloseRun,
): (day: string) => Promise<void> {
    return async (day) => {
        const errs: unknown[] = [];
        try {
            await spawnKclose(day);
        } catch (e) {
            errs.push(e); // 盘后日K收口失败 = 选股退回快照口径，不静默
        }
        let screenerErr: unknown = null;
        if (strategy.screener?.autoRun) {
            try {
                await spawnScreener(day);
            } catch (e) {
                screenerErr = e;
                errs.push(e);
            }
        }
        await spawnDigest(day);
        if (errs.length > 0) throw errs[0];
    };
}

/** 选股完成一行提示进 terminal（2026-11-04 用户需求变更：结果不再打印，
 *  只落 screener/<day>.md 报告文件——这里只报"做完了+文件在哪+各公式计数"）。
 *  文件缺席（选股未跑/失败）返回空串——失败路径已有 catch 喊，这里不重复。 */
export function screenerSummary(day: string): string {
    const path = join(dataRootPath(), "screener", `${day}.jsonl`);
    if (!existsSync(path)) return "";
    let rows: ScreenerHit[];
    try {
        rows = readSchemaJsonl<ScreenerHit>(path, SCHEMA.SCREENER).rows;
    } catch {
        return ""; // 坏文件不挡收口链
    }
    const counts = new Map<string, number>();
    for (const h of rows) for (const f of h.formulas) counts.set(f, (counts.get(f) ?? 0) + 1);
    if (counts.size === 0) return "";
    const head = [...counts.entries()].map(([id, n]) => `${id} ${n}`).join(" / ");
    return `🎯 选股完成 ${day}：${head} → 报告（按板块分组）screener/${day}.md`;
}

export interface WatchConfig {
    /** 策略配置（缺省 loadStrategy()——watch 节参数源）。 */
    strategy?: StrategyConfig;
    /** 唤醒桥（AppHost.wake——profile 工厂注入）。 */
    wake?: (text: string) => Promise<void>;
    /** 信号唤醒最小间隔 ms（缺省走策略 watch.signalCooldownMs）。 */
    signalCooldownMs?: number;
    /** 单信号最大待醒年龄 ms（缺省走策略 watch.maxSignalAgeMs）。 */
    maxSignalAgeMs?: number;
    /** 同 code 每日最大唤醒次数（缺省走策略 watch.perCodeWakeCap）。 */
    perCodeWakeCap?: number;
    /** 止损线（缺省走策略 exit.stopLossPct；0 = 关）。 */
    stopLossPct?: number;
    /** 移动止盈线（缺省走策略 exit.trailingStopPct；0 = 关）。 */
    trailingStopPct?: number;
    /** 收盘收口钩（复盘 turn 结束后跑；参数 = 收口日。缺省 spawn dist/backtest/digest-run.js）。 */
    closeOut?: (day: string) => Promise<void> | void;
    /** 宿主自退桥（AppHost.requestExit——close 后退出进程；缺 Host = 只收口不退）。 */
    exit?: () => void;
    /** 收盘收口链开关（缺省走策略 watch.closeOutAfterReview）。 */
    closeOutAfterReview?: boolean;
    /** 盘后精选 turn 开关（缺省走策略 watch.postCloseRefine）。 */
    postCloseRefine?: boolean;
    /** 盘后精选墙钟预算 ms（缺省走策略 watch.refineTimeoutMs；0 = 关）。
     *  2026-11-04 实录：精选 turn 陷入文件考古被硬杀，自退链没走到——
     *  收口产物（复盘/digest/选股）落盘后精选是纯输出面，超时即自退。 */
    refineTimeoutMs?: number;
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
    /** 收盘收口链 armed：close wake 已发、等复盘 turn 的 agent/turn-end。 */
    private awaitingReview = false;
    /** 盘后精选 armed：refine wake 已发、等精选 turn 的 agent/turn-end 再自退。 */
    private awaitingExit = false;
    private lastSignalWake = 0;
    /** 信箱：同 code 留最新（冷却内的信号不再裸丢——Day 1 中恒集团被槽位饿死）。 */
    private pending = new Map<string, { sig: Signal; at: number }>();
    private wakeCounts = new Map<string, { day: string; count: number }>();
    /** 风控已唤醒日：code → day（破线是持续状态，同 code 每日至多一次）。 */
    private riskWoke = new Map<string, string>();
    private wake: ((text: string) => Promise<void>) | undefined;
    private cooldown: number;
    private maxSignalAgeMs: number;
    private perCodeWakeCap: number;
    private stopLossPct: number;
    private trailingStopPct: number;
    private closeOut: ((day: string) => Promise<void> | void) | undefined;
    private exit: (() => void) | undefined;
    private closeOutAfterReview: boolean;
    private postCloseRefine: boolean;
    private refineTimeoutMs: number;
    /** 精选墙钟预算定时器（armed 于 refine wake 发出后；unref 不阻进程退出）。 */
    private refineTimer: ReturnType<typeof setTimeout> | undefined;
    private prompts: WatchPrompts;
    private tickMs: number;
    private strategy: StrategyConfig;

    constructor(ctx: Context, name: string, config: WatchConfig = {}) {
        super(ctx, name);
        this.strategy = config.strategy ?? loadStrategy();
        this.wake = config.wake;
        this.cooldown = config.signalCooldownMs ?? 180_000;
        this.maxSignalAgeMs = config.maxSignalAgeMs ?? this.cooldown * 2;
        this.perCodeWakeCap = config.perCodeWakeCap ?? 2;
        this.stopLossPct = config.stopLossPct ?? 0.05;
        this.trailingStopPct = config.trailingStopPct ?? 0.05;
        this.closeOut = config.closeOut ?? spawnDigestRun;
        this.exit = config.exit;
        this.closeOutAfterReview = config.closeOutAfterReview ?? false;
        this.postCloseRefine = config.postCloseRefine ?? this.strategy.watch.postCloseRefine;
        this.refineTimeoutMs = config.refineTimeoutMs ?? this.strategy.watch.refineTimeoutMs;
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
        this.clearRefineTimer();
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
            this.awaitingReview = this.closeOutAfterReview;
            void this.fire(this.prompts.close(today), "close", today);
        }
        if (phase === "open") {
            this.flush(); // 冷却到期由 tick 兜底出账，不靠下一发信号
            this.checkStops();
        }
    }

    /** 持仓风控（S14 离场节 + 2026-10-31 移动止盈）：现价市值破含费成本止损线，
     *  或从持有期峰值回撤穿越锁利线（且回撤线高于止损线=锁利位有效）→ 唤醒裁决
     *  （不自动卖）。破线是持续状态、没有新鲜度——同 code 每日至多唤醒一次
     *  （Day 1 教训：重复唤醒没有新信息；止损/止盈共用一把去重阀）；T+1 当日
     *  买入不可卖——无可卖部分不叫（叫了也执行不了）。 */
    private checkStops(): void {
        if (this.stopLossPct <= 0 && this.trailingStopPct <= 0) return;
        const market = this.ctx.get<MarketDataService>("market");
        const broker = this.ctx.get<PaperBroker>("broker");
        if (!market || !broker || !market.latest) return;
        if (this.ctx.get<TradeGuardService>("guard")?.isHalted()) return;
        const now = market.clock();
        const day = cnDay(now.getTime());
        const hits: RiskHit[] = [];
        for (const p of broker.getPositions()) {
            if (p.availQty <= 0 || p.qty <= 0 || p.cost <= 0) continue;
            if (this.riskWoke.get(p.code) === day) continue;
            const q = market.latest.byCode.get(p.code);
            if (!q) continue;
            broker.notePrice(p.code, q.price); // 峰值喂价先行：只上抬不下压
            const drawdown = (q.price * p.qty - p.cost) / p.cost;
            const stopLineValue = p.cost * (1 - this.stopLossPct);
            const trailingLineValue = p.peak * (1 - this.trailingStopPct) * p.qty;
            // trailing 只在锁利位高于止损位时接管（浮盈不足时止损线兜底，不双叫）
            const trailingArmed = this.trailingStopPct > 0 && trailingLineValue > stopLineValue;
            if (this.stopLossPct > 0 && drawdown <= -this.stopLossPct) {
                this.riskWoke.set(p.code, day);
                hits.push({ code: p.code, qty: p.qty, availQty: p.availQty, cost: p.cost, price: q.price, drawdown, reason: "stop-loss", peak: p.peak });
            } else if (trailingArmed && q.price * p.qty <= trailingLineValue) {
                this.riskWoke.set(p.code, day);
                hits.push({ code: p.code, qty: p.qty, availQty: p.availQty, cost: p.cost, price: q.price, drawdown, reason: "trailing", peak: p.peak });
            }
        }
        if (hits.length > 0) {
            void this.fire(this.prompts.risk(hits, cnHm(now.getTime())), "risk", day);
        }
    }

    /** 数据面降级记账（2026-10-30 缺陷①）：不唤醒 turn——断供无裁决可做，
     *  省 token 纪律；注记进 SessionLog，盘后复盘/追责有据可查。 */
    onDegraded(d: { at: number; source: string; fallback?: string; error: string; failCount: number; switched: boolean }): void {
        this.note({ kind: "data-degraded", ...d });
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
        // 开盘巡检先行（2026-11-03）：巡检 wake 是 tick 驱动、信号 wake 是快照
        // 事件驱动——盘中启动时信号会抢在巡检前面（实录：open 词迟到 4 个 turn）。
        // 巡检未做，信号只攒信箱不叫醒；evaluate 的巡检轮同 tick 兜底出账。
        if (!this.patrolled) return;
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

    /** 收盘收口链（2026-10-29 方案 C）：close wake 的复盘 turn 结束（agent/turn-end
     *  且仍处 closed）→ 跑收口钩（digest-run 编译）→ 宿主自退。挂机工作流的无人值守
     *  半边：早开会话挂机，收盘自动 复盘→digest→退出——两天实录里复盘 turn 都死在
     *  "note 入队后进程被关"，本链把收尾搬进进程自己的生命周期。
     *  误触发面：收盘后用户手聊的第一个 turn 结束也会命中——挂机场景无此输入，
     *  交互模式默认关（strategy.watch.closeOutAfterReview）。 */
    async onTurnEnd(): Promise<void> {
        if (!this.armed) return;
        const market = this.ctx.get<MarketDataService>("market");
        if (!market || marketPhase(market.clock()) !== "closed") return;
        // 盘后精选 turn 结束 → 现在才自退（2026-11-03：精选/明日计划是收盘前最后输出）
        if (this.awaitingExit) {
            this.awaitingExit = false;
            this.clearRefineTimer();
            this.requestExit("复盘与盘后计划完成，盯盘会话自退");
            return;
        }
        if (!this.awaitingReview) return;
        this.awaitingReview = false;
        this.note({ kind: "close-out", day: this.day });
        if (this.closeOut) {
            this.ctx.get<UiService>("ui")?.info("🌙 收盘收口：编译今日 digest…");
            try {
                await this.closeOut(this.day);
            } catch (e) {
                this.ctx.get<UiService>("ui")?.error(`收盘 digest 失败：${e instanceof Error ? e.message : String(e)}`);
            }
        }
        // 选股完成一行提示（2026-11-04 用户需求：结果不再打 terminal，只落报告文件）
        if (this.strategy.screener?.autoRun) {
            const summary = screenerSummary(this.day);
            if (summary) this.ctx.get<UiService>("ui")?.info(summary);
        }
        // 盘后精选 + 明日计划（2026-11-03）：命中池喂给 LLM turn 精选；
        // 自退推迟到该 turn 结束（awaitingExit）。精选规则日后由用户教程文档接管。
        // 墙钟预算（2026-11-04）：精选 turn 若超时未结束，视为烂尾——收口产物
        // 已全部落盘，照样自退，别让人回来收尸。
        if (this.postCloseRefine) {
            const pool = this.refinePool(this.day);
            this.awaitingExit = true;
            this.armRefineTimer();
            void this.fire(this.prompts.refine(pool, this.day), "refine", this.day);
            return;
        }
        this.requestExit("复盘完成，盯盘会话自退");
    }

    private armRefineTimer(): void {
        if (!this.refineTimeoutMs || this.refineTimeoutMs <= 0) return;
        this.refineTimer = setTimeout(() => {
            this.refineTimer = undefined;
            if (!this.awaitingExit) return; // 正常路径已自退
            this.awaitingExit = false;
            this.requestExit("盘后精选超时——收口产物已全部落盘，盯盘会话自退");
        }, this.refineTimeoutMs);
        this.refineTimer.unref?.();
    }

    private clearRefineTimer(): void {
        if (this.refineTimer !== undefined) {
            clearTimeout(this.refineTimer);
            this.refineTimer = undefined;
        }
    }

    /** 精选命中池：自定义公式（非内置库）打全量，内置只给计数行；cap 50 行防
     *  wake 文本膨胀（更多命中留给 read_file 报告文件）。行带板块归属标签——
     *  2026-11-04 实录：refine turn 为找"板块联动"数据翻文件写脚本，最后被
     *  硬杀——数据就地给足，prompt 同时禁考古。 */
    private refinePool(day: string): string {
        const path = join(dataRootPath(), "screener", `${day}.jsonl`);
        if (!existsSync(path)) return "";
        let rows: ScreenerHit[];
        try {
            rows = readSchemaJsonl<ScreenerHit>(path, SCHEMA.SCREENER).rows;
        } catch {
            return "";
        }
        const builtinIds = new Set(BUILTIN_SCREENERS.map((s) => s.id));
        const custom = rows.filter((h) => h.formulas.some((f) => !builtinIds.has(f)));
        const fmtChg = (chg: number): string => `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%`;
        const lines = custom.slice(0, 50).map((h) => {
            const formulas = h.formulas.filter((f) => !builtinIds.has(f)).join("/");
            const sec = h.sector ? `｜跟 ${h.sector} ${fmtChg(h.sectorChg ?? 0)}` : "";
            return `  ${h.code} ${h.name} 收 ${h.close.toFixed(2)}（${formulas}${sec}）`;
        });
        if (custom.length > 50) lines.push(`  …（其余 ${custom.length - 50} 只见 screener/${day}.md）`);
        return lines.join("\n");
    }

    private requestExit(message: string): void {
        this.clearRefineTimer();
        if (!this.exit) return;
        this.ctx.get<UiService>("ui")?.info(`👋 ${message}`);
        this.exit();
    }
}

export const marketWatchPlugin: Plugin = {
    name: "market-watch",
    // 只 inject commands（行位早）——/watch 即时注册；market/guard/schedule 惰性取
    inject: ["commands"],
    apply(ctx: Context, config: WatchConfig = {}) {
        const strategy = config.strategy ?? loadStrategy();
        const watch = new WatchService(ctx, "watch", {
            ...config,
            strategy,
            signalCooldownMs: config.signalCooldownMs ?? strategy.watch.signalCooldownMs,
            maxSignalAgeMs: config.maxSignalAgeMs ?? strategy.watch.maxSignalAgeMs,
            perCodeWakeCap: config.perCodeWakeCap ?? strategy.watch.perCodeWakeCap,
            stopLossPct: config.stopLossPct ?? strategy.exit.stopLossPct,
            trailingStopPct: config.trailingStopPct ?? strategy.exit.trailingStopPct,
            // 缺省收口链 = digest + 选股（autoRun 开时）——显式 closeOut 覆盖不受影响
            closeOut: config.closeOut ?? defaultCloseOut(strategy),
            closeOutAfterReview: config.closeOutAfterReview ?? strategy.watch.closeOutAfterReview,
            postCloseRefine: config.postCloseRefine ?? strategy.watch.postCloseRefine,
        });
        ctx.on("market/signal", (sig) => watch.onSignal(sig));
        ctx.on("market/degraded", (d) => watch.onDegraded(d));
        ctx.on("agent/turn-end", () => void watch.onTurnEnd());
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
