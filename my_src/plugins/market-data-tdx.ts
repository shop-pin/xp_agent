// plugins/market-data-tdx.ts——M7：TdxQuoteSource（eltdx HTTP 网关桥）。
//
// 数据源接缝第三次兑现（S1 设计"能力划分而非供应商划分"）：与 sinaSource
// 同接口，watch/signal 管线无感切换。网关 = eltdx 的 http_server（POST /rpc
// 通用方法桥），独立启动（mcp-tdx venv）：
//   python -m eltdx.http_server --port 7727
// env MINI_TDX_GATEWAY（缺省 http://127.0.0.1:7727）。
//
// 能力对照（诚实记档——TDX 分类行情没有新浪列表白送的估值字段）：
//   有：price / change / changePercent(派生) / open / high / low / preClose /
//       volume(手=total_hand) / amount(元) / name（代码表 latest_stock_list）
//   无（填 0=未知，与新浪明细同约定）：turnoverRate / volumeRatio / marketCap /
//       floatCap / pb / pe——screen_market 与池工具的这些过滤在 tdx 源下退化，
//       池/回测研究面继续吃新浪（sinaSource 不拆，双源对拍后才切）
//   fetchIpoDays 不提供（调用方退化 N/C 前缀）。
// 全市场：list_by_category 每页 ≤80、sh/sz/bj 三市场约 74 页；A股过滤在投影层
// （分类行情含 B 股/基金/债券，按代码段 sh^6 / sz^[03] / bj^[48] 收窄）。
// 名称表一次 5,580 行，缓存 TTL 12h（名称低频变化）。

import type { Quote, QuoteSource } from "./market-data.js";

const round4 = (x: number): number => Math.round(x * 10000) / 10000;

export interface TdxSourceConfig {
    /** 网关地址（缺省 env MINI_TDX_GATEWAY 或 http://127.0.0.1:7727）。 */
    gatewayUrl?: string;
    /** 全市场分页并发（缺省 4——本地网关转发，TDX 服务器侧仍是一路连接）。 */
    pageConcurrency?: number;
    /** 每页行数（TDX 上限 80）。 */
    pageSize?: number;
    /** 名称表缓存 TTL ms（缺省 12h）。 */
    nameTtlMs?: number;
    /** 测试注入。 */
    fetchImpl?: typeof fetch;
    now?: () => number;
}

interface TdxRecord {
    exchange: string;
    code: string;
    last_price: number;
    pre_close_price: number;
    open_price: number;
    high_price: number;
    low_price: number;
    total_hand: number;
    amount: number;
}

interface NameRow { exchange: string; code: string; name: string; category?: string }

/** A 股代码段过滤（分类行情混着 B 股/基金/债券——sh^6 / sz^[03] / bj^[48]）。 */
export function isAShare(exchange: string, code: string): boolean {
    if (exchange === "sh") return /^6/.test(code);
    if (exchange === "sz") return /^[03]/.test(code);
    if (exchange === "bj") return /^[48]/.test(code);
    return false;
}

/** TDX 行 → Quote 投影（changePercent 派生；估值字段 0=未知）。停牌行（价≤0）返回 null。 */
export function projectTdxRecord(rec: TdxRecord, name: string): Quote | null {
    const { exchange, code } = rec;
    if (!isAShare(exchange, code)) return null;
    const price = Number(rec.last_price);
    const pre = Number(rec.pre_close_price);
    if (!Number.isFinite(price) || price <= 0) return null;
    return {
        code: `${exchange}${code}`,
        name,
        price,
        change: pre > 0 ? round4(price - pre) : 0,
        changePercent: pre > 0 ? round4((price / pre - 1) * 100) : 0,
        open: Number(rec.open_price) || 0,
        high: Number(rec.high_price) || 0,
        low: Number(rec.low_price) || 0,
        preClose: pre,
        volume: Number(rec.total_hand) || 0,
        amount: Number(rec.amount) || 0,
        turnoverRate: 0,
        volumeRatio: 0,
        marketCap: 0,
        floatCap: 0,
        pb: 0,
        pe: 0,
    };
}

const CN_HSA = "沪深A股"; // normalize_category 唯一别名 → 分类 6；北交所无别名

export class TdxQuoteSource implements QuoteSource {
    private gateway: string;
    private concurrency: number;
    private pageSize: number;
    private nameTtlMs: number;
    private fetchImpl: typeof fetch;
    private now: () => number;
    private nextId = 1;
    private names = new Map<string, string>();
    private namesAt = 0;
    private namesPromise: Promise<void> | null = null;

    constructor(config: TdxSourceConfig = {}) {
        this.gateway = config.gatewayUrl
            ?? process.env.MINI_TDX_GATEWAY
            ?? "http://127.0.0.1:7727";
        this.gateway = this.gateway.replace(/\/$/, "");
        this.concurrency = config.pageConcurrency ?? 4;
        this.pageSize = Math.min(config.pageSize ?? 80, 80);
        this.nameTtlMs = config.nameTtlMs ?? 12 * 3600_000;
        this.fetchImpl = config.fetchImpl ?? fetch;
        this.now = config.now ?? Date.now;
    }

    /** POST /rpc——网关不可达时报人话（先启动网关），不裸抛 TypeError。 */
    private async rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
        let res: Response;
        try {
            res = await this.fetchImpl(`${this.gateway}/rpc`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: this.nextId++, method, params }),
                signal: AbortSignal.timeout(30_000),
            });
        } catch (e) {
            throw new Error(
                `TDX 网关不可达（${this.gateway}）——先启动：`
                + `python -m eltdx.http_server --port 7727；原因：${e instanceof Error ? e.message : String(e)}`);
        }
        const body = await res.json() as
            { ok?: boolean; result?: T; error?: { message?: string } | string };
        if (!res.ok || body.ok !== true) {
            const msg = typeof body.error === "string" ? body.error
                : body.error?.message ?? `HTTP ${res.status}`;
            throw new Error(`TDX rpc ${method} 失败：${msg}`);
        }
        return body.result as T;
    }

    /** 名称表：TTL 内复用；并发调用共享同一次拉取。失败不炸——名称缺省用码。 */
    private ensureNames(): Promise<void> {
        if (this.names.size > 0 && this.now() - this.namesAt < this.nameTtlMs) {
            return Promise.resolve();
        }
        if (!this.namesPromise) {
            this.namesPromise = this.rpc<NameRow[]>("codes.latest_stock_list", {})
                .then((rows) => {
                    for (const r of rows) {
                        if ((r.category ?? "a_share") !== "a_share") continue;
                        this.names.set(`${r.exchange}${r.code}`, r.name);
                    }
                    this.namesAt = this.now();
                })
                .catch(() => { /* 名称缺失不炸行情——名字退化为代码 */ })
                .finally(() => { this.namesPromise = null; });
        }
        return this.namesPromise;
    }

    private toQuote(rec: TdxRecord): Quote | null {
        return projectTdxRecord(rec, this.names.get(`${rec.exchange}${rec.code}`) ?? `${rec.exchange}${rec.code}`);
    }

    /** 沪深 A 股顺序分页：短页即止。北交所无 category 别名（上游 normalize_category
     *  只认 沪深A股/a股）——TDX 快照缺北交 390 只，与策略宇宙闸 excludeBJ=true
     *  （2026-10-21 用户定）恰好对齐；放开北交时先探数字分类再补。 */
    async fetchMarketSnapshot(): Promise<Quote[]> {
        await this.ensureNames();
        const quotes: Quote[] = [];
        for (let start = 0; ; start += this.pageSize) {
            const page = await this.rpc<{ records: TdxRecord[] }>(
                "quotes.list_by_category",
                { category: CN_HSA, start, count: this.pageSize });
            for (const rec of page.records ?? []) {
                const q = this.toQuote(rec);
                if (q) quotes.push(q);
            }
            if ((page.records?.length ?? 0) < this.pageSize) break;
        }
        if (quotes.length === 0) {
            throw new Error("TDX 全市场快照为空（网关/网络/源不可用——fail-closed）");
        }
        return quotes;
    }

    async fetchQuotes(codes: string[]): Promise<Quote[]> {
        if (codes.length === 0) return [];
        await this.ensureNames();
        // get_snapshots 的 result 是裸数组（list_by_category 才是 {records} 包一层）
        const records = await this.rpc<TdxRecord[]>("quotes.get_snapshots", { codes });
        const out: Quote[] = [];
        for (const rec of records ?? []) {
            const q = this.toQuote(rec);
            if (q) out.push(q);
        }
        return out;
    }
}

/** 生产实例（env 装配；测试自建带 fetchImpl 的实例）。 */
export function makeTdxSource(config: TdxSourceConfig = {}): TdxQuoteSource {
    return new TdxQuoteSource(config);
}
