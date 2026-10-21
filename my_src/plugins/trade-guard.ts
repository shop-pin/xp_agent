// plugins/trade-guard.ts——S8：交易风控五件套（stock profile 专用）。
//
// 位置语义（本章核心约束，记档）：风控是 tools/pre-execute 瀑布的**最外层**
// 监听器——违规订单 deny 短路，审批（C2/F5 卡）根本不发问。瀑布序=注册序=
// 激活完成序，而 **带 inject 等待的插件激活晚**（等依赖 provide）——所以
// guard 只 inject 行位最早的 commands（/halt 用），market/broker 一律
// ctx.get 惰性取：即时挂载换最外层位，惰性取依赖换挂载自由。到 place_order
// 真正执行时，全树早已挂载完毕，惰性取必然命中。
//
// 五件套（每条一个 deny 理由，全部代码硬限制——提示词拦不住的东西才算风控）：
//   ① /halt 熔断：人工一键，拦一切订单
//   ② 时段闸门：marketPhase 非 open 拒单（config.tradingHours:false 可关——
//      休市手测/回放用；S10 实盘前置校验这个开关必须为 true）
//   ③ 标的排除：北交所前缀/ST/退市名称拒单；委托价触及涨跌停板拒单（追板/杀跌单）
//   ④ 单日亏损上限：当日已实现盈亏 ≤ -maxDailyLoss 拦一切新单
//   ⑤ 单票仓位上限：买入后该票市值占比 ≤ maxPositionPct（LLM 说"全仓"
//      也拦得住的那条）
//   外加一条不变量：行情拿不到 = 拒单（fail-closed）——③⑤都依赖行情，
//   风控不能"查不到就放行"。
//
// 礼仪：非 place_order 调用原样 next()（guard 只管订单）；deny 不调 next
// （短路——B4 waterfall 语义）；通过后 default 模式发 ask（订单的审批卡
// 在 guard 而不在 C2 判定序——exec hint 在那里是兜底放行）；其余模式 next()。

import type { Context } from "../cordis/context.js";
import type { Plugin } from "../cordis/fiber.js";
import { Service } from "../cordis/service.js";
import type { CommandService } from "../services/commands.js";
import type { UiService } from "../services/ui-service.js";
import type { SessionLog } from "../services/session-log.js";
import type { PreExecDecision } from "../services/tools.js";
import { marketPhase, type MarketDataService } from "./market-data.js";
import { priceBand, type PaperBroker } from "./paper-broker.js";
import { loadStrategy } from "./strategy.js";

export interface GuardConfig {
    /** 交易时段闸门（默认 true；测试/回放可关）。 */
    tradingHours?: boolean;
    /** ST/退市标的排除（默认 true）。 */
    excludeST?: boolean;
    /** 北交所标的排除（默认 true——trading-rules.md 规则 1-2 的交易面兜底：
     *  引擎不产信号 ≠ 不交易，LLM 手动 place_order 也要拦）。 */
    excludeBJ?: boolean;
    /** 单票市值占净资产上限（默认 0.2 = 20%）。 */
    maxPositionPct?: number;
    /** 单日已实现亏损上限（元，默认 50,000）。 */
    maxDailyLoss?: number;
    /** 时钟注入（测试时段判定）。 */
    now?: () => Date;
}

interface HaltState {
    halted: boolean;
    reason: string;
}

export class TradeGuardService extends Service {
    private cfg: Required<Pick<GuardConfig, "tradingHours" | "excludeST" | "excludeBJ" | "maxPositionPct" | "maxDailyLoss">>;
    private now: () => Date;
    private state: HaltState = { halted: false, reason: "" };

    constructor(ctx: Context, name: string, config: GuardConfig = {}) {
        super(ctx, name);
        this.cfg = {
            tradingHours: config.tradingHours ?? true,
            excludeST: config.excludeST ?? true,
            excludeBJ: config.excludeBJ ?? true,
            maxPositionPct: config.maxPositionPct ?? 0.2,
            maxDailyLoss: config.maxDailyLoss ?? 50_000,
        };
        this.now = config.now ?? (() => new Date());
    }

    isHalted(): boolean {
        return this.state.halted;
    }

    /** /halt [reason] 熔断；/halt off 解除。 */
    toggleHalt(args: string): void {
        if (args.trim() === "off") {
            this.state = { halted: false, reason: "" };
        } else {
            this.state = { halted: true, reason: args.trim() };
        }
        const line = this.state.halted
            ? `⛔ 交易已熔断${this.state.reason ? `：${this.state.reason}` : ""}（/halt off 解除）`
            : "✅ 交易熔断已解除";
        this.ctx.get<UiService>("ui")?.info(line);
        this.ctx.get<SessionLog>("session-log")?.append({
            type: "meta/note", key: "trade-halt", value: { ...this.state },
        });
    }

    /** 订单检查：返回 deny 决策或 null（通过，交下一层）。 */
    checkOrder(input: Record<string, any>): PreExecDecision | null {
        if (this.state.halted) {
            return { type: "deny", reason: `交易已熔断${this.state.reason ? `：${this.state.reason}` : ""}（/halt off 解除）` };
        }
        if (this.cfg.tradingHours && marketPhase(this.now()) !== "open") {
            return { type: "deny", reason: `非交易时段（当前 ${marketPhase(this.now())}）——时段闸门拒单` };
        }
        const code = String(input.code ?? "");
        const price = Number(input.price ?? 0);
        const broker = this.ctx.get<PaperBroker>("broker");
        const market = this.ctx.get<MarketDataService>("market");
        // fail-closed：行情依赖的规则（ST/价带/仓位）拿不到行情就拒单——
        // 风控不能"查不到就放行"（broker 自己也无行情拒单，姿态一致）。
        const quote = market?.latest?.byCode.get(code);
        if (!market || !quote) {
            return { type: "deny", reason: `无 ${code} 实时行情，无法执行风控校验（fail-closed）` };
        }
        if (this.cfg.excludeBJ && quote.code.startsWith("bj")) {
            return { type: "deny", reason: `风控排除标的：北交所 ${quote.name}（${code}）不在交易范围` };
        }
        if (this.cfg.excludeST && (/ST/i.test(quote.name) || quote.name.includes("退"))) {
            return { type: "deny", reason: `风控排除标的：${quote.name}` };
        }
        if (quote.preClose > 0) {
            const [lo, hi] = priceBand(code, quote.name, quote.preClose);
            if (price >= hi || price <= lo) {
                return { type: "deny", reason: `委托价 ${price} 触及涨跌停板 [${lo}, ${hi}]——追板/杀跌单拒单` };
            }
        }
        if (broker && broker.todayPnl() <= -this.cfg.maxDailyLoss) {
            return { type: "deny", reason: `当日已实现亏损 ${broker.todayPnl()} 元触及上限 ${this.cfg.maxDailyLoss} 元——当日停止交易` };
        }
        if (broker && market && input.side === "buy") {
            const qty = Math.floor(Number(input.qty ?? 0) / 100) * 100;
            const positions = broker.getPositions();
            const assets = positions.reduce((s, p) => s + (market.latest?.byCode.get(p.code)?.price ?? 0) * p.qty, broker.cash);
            const existing = (market.latest?.byCode.get(code)?.price ?? 0)
                * (positions.find((p) => p.code === code)?.qty ?? 0);
            const projected = (existing + qty * price) / (assets || 1);
            if (projected > this.cfg.maxPositionPct + 1e-9) {
                return {
                    type: "deny",
                    reason: `单票仓位上限：买入后 ${(projected * 100).toFixed(1)}% > ${(this.cfg.maxPositionPct * 100).toFixed(0)}%`
                        + `（净资产 ${Math.round(assets)} 元）——"全仓"类指令在这里拦死`,
                };
            }
        }
        return null;
    }
}

export const tradeGuardPlugin: Plugin = {
    name: "trade-guard",
    // 只 inject commands（行位早）——即时挂载保瀑布最外层；market/broker 惰性取
    inject: ["commands"],
    apply(ctx: Context, config: GuardConfig = {}) {
        const strategy = loadStrategy();
        const guard = new TradeGuardService(ctx, "guard", {
            ...config,
            maxPositionPct: config.maxPositionPct ?? strategy.risk.maxPositionPct,
            maxDailyLoss: config.maxDailyLoss ?? strategy.risk.maxDailyLoss,
            excludeST: config.excludeST ?? strategy.universe.excludeST,
            excludeBJ: config.excludeBJ ?? strategy.universe.excludeBJ,
        });
        ctx.on("tools/pre-execute", (call, next) => {
            if (call.name !== "place_order") return next();
            const decision = guard.checkOrder(call.input);
            if (decision) return decision; // deny 短路：审批不发问
            // 五件套通过 → 审批卡（C2 ask → 终端 confirm / F5 远程卡）。
            // default 模式由 guard 发问——exec hint 在 C2 判定序里没有 ask
            // 分支（⑨ 兜底放行），订单的"必过审批"由这里补齐；auto 模式
            // 弃权给内层分类器（S9 无人值守编排的 economy）。
            if (call.mode === "default") {
                const i = call.input;
                return {
                    type: "ask",
                    message: `下单确认：${i.side === "buy" ? "买入" : "卖出"} ${i.code}`
                        + ` ${i.qty} 股 @ ${i.price}${i.reason ? `（依据：${i.reason}）` : ""}`,
                };
            }
            return next();
        });
        ctx.require<CommandService>("commands").register({
            name: "halt",
            description: "交易熔断开关：/halt [原因] 一键停止一切订单；/halt off 解除",
            run: (args) => { guard.toggleHalt(args); },
        });
    },
};

declare module "../cordis/context.js" {
    interface Context {
        guard?: TradeGuardService;
    }
}
