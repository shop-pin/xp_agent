// webui/projection.ts——F6：会话投影（React-free 纯 fold）。
// 参照物：dsh session-projection fold + session.projections 的 mini 裁决——
// **不加 RPC、不加帧**：客户端已从流里拿到全量日志（baseline = 带最后 seq 的
// 快照，live/补洞 = 增量），投影只是同一事件流上的第二个 fold（conversation
// 装配器是第一个）。dsh 需要 server-side fold + RPC 是因为 control stream 与
// journal 分离、feature 包不直接消费 journal；mini 没有这层隔离，重复建设
// 记档不抄。
//
// 数据源纪律：只认日志事件。goal set/clear（GoalService）、goal-progress
// （评估监听器）、loop start/finish（LoopService）都是 meta/note 落日志的
// 会话事实——侧栏因此天然 live（帧到场即重折）且 resume 后自动重现
// （JSONL 重放同一条流，fold 同一个结果）。cost 口径 = ui.printCost 公式
// （第三份拷贝：终端打印、host narrative 帧、客户端显示各一份，注释互认）。

/** 结构副本（WireEvent 同款客户端自有类型）：投影只消费这几个字段。 */
interface UsageLike {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
}

export interface ProjectionGoal {
    condition: string;
    iterations: number;
    lastReason?: string;
}

export interface ProjectionLoop {
    mode: string;
    intervalSeconds?: number;
    prompt?: string;
}

/** S7：成交流水（broker 插件的 meta/note key="trade" fold）。 */
export interface ProjectionTrades {
    fills: number;
    fees: number;
    realizedPnl: number;
    /** 成交后的现金余额（末笔为准；null = 无成交）。 */
    cash: number | null;
    last: string | null;
}

export interface SessionProjection {
    /** 折叠反映到的最后 seq（快照身份——与流 lastSeq 对账用）。 */
    lastSeq: number;
    mode: string | null;
    turns: number;
    compactions: number;
    tokens: UsageLike;
    costUsd: number;
    goal: ProjectionGoal | null;
    loop: ProjectionLoop | null;
    trades: ProjectionTrades;
}

const EMPTY_USAGE: UsageLike = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

export function projectSession(entries: Array<{ seq: number; event: any }>): SessionProjection {
    const p: SessionProjection = {
        lastSeq: -1,
        mode: null,
        turns: 0,
        compactions: 0,
        tokens: { ...EMPTY_USAGE },
        costUsd: 0,
        goal: null,
        loop: null,
        trades: { fills: 0, fees: 0, realizedPnl: 0, cash: null, last: null },
    };
    for (const { seq, event } of entries) {
        p.lastSeq = seq;
        switch (event.type) {
            case "turn/start":
                p.turns += 1;
                break;
            case "history/truncate":
                p.compactions += 1;
                break;
            case "assistant/message": {
                const usage = event.usage as UsageLike | undefined;
                if (usage) {
                    p.tokens.input += usage.input;
                    p.tokens.output += usage.output;
                    p.tokens.cacheRead += usage.cacheRead;
                    p.tokens.cacheCreation += usage.cacheCreation;
                }
                break;
            }
            case "meta/note": {
                if (event.key === "mode") {
                    p.mode = String(event.value);
                } else if (event.key === "goal") {
                    // set（{condition}）/clear（null）——set 重置进度，progress 只对活跃 goal 生效
                    p.goal = event.value
                        ? { condition: String((event.value as { condition?: string }).condition ?? ""), iterations: 0 }
                        : null;
                } else if (event.key === "goal-progress") {
                    if (p.goal) {
                        const v = event.value as { iterations?: number; lastReason?: string };
                        p.goal.iterations = Number(v.iterations ?? p.goal.iterations);
                        p.goal.lastReason = v.lastReason ? String(v.lastReason) : undefined;
                    }
                } else if (event.key === "loop") {
                    p.loop = (event.value as ProjectionLoop | null) ?? null;
                } else if (event.key === "trade") {
                    const v = event.value as {
                        side?: string; code?: string; qty?: number; price?: number;
                        fee?: number; realizedPnl?: number | null; cash?: number;
                    };
                    p.trades.fills += 1;
                    p.trades.fees += Number(v.fee ?? 0);
                    p.trades.realizedPnl += Number(v.realizedPnl ?? 0);
                    if (typeof v.cash === "number") p.trades.cash = v.cash;
                    p.trades.last = `${v.side === "sell" ? "卖出" : "买入"} ${v.code ?? ""} ${v.qty ?? 0}@${v.price ?? 0}`;
                }
                break;
            }
            default:
                break;
        }
    }
    p.costUsd = costUsd(p.tokens);
    return p;
}

/** ui.printCost / host costLine 的同式第三份（口径耦合，改一处改三处）。 */
export function costUsd(t: UsageLike): number {
    return (
        (t.input / 1_000_000) * 3 +
        (t.cacheRead / 1_000_000) * 0.3 +
        (t.cacheCreation / 1_000_000) * 3.75 +
        (t.output / 1_000_000) * 15
    );
}
