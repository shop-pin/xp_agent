// plugins/market-data.ts——S1：行情快照插件（stock profile 专用，base 默认 disabled）。
//
// 分层（stock-00-plan §一）：全市场监控是**数据面的活**——服务轮询快照、代码
// 做筛选，模型只看短名单。本插件是数据面的全部：
//   QuoteSource     数据源接缝（能力划分而非供应商划分：全市场快照走东财
//                   push2，单票明细走新浪 hq——想全走一家/换源，实现自己的
//                   QuoteSource 传进来即可）
//   MarketDataService  轮询 duty cycle（交易时段高频、休市停摆）+ 最新快照
//                   缓存 + 价格序列环形缓冲（S5 信号引擎的口粮）
//   get_quote / screen_market  模型面的两个只读工具
//
// 接口口径（记档）：
//   - code 带交易所前缀：sh600000 / sz000001 / bj920196（预留 hk/us）
//   - 停牌/缺失数值一律归 0（东财 "-"、新浪字段缺失），消费方判 0 跳过
//   - volume 单位=手（东财原生；新浪股→手换算）；amount/市值单位=元
//   - 非官方接口，随时可能改版——解析函数纯导出，fixture 回放测试钉住格式

import type { Context } from "../cordis/context.js";
import type { Plugin } from "../cordis/fiber.js";
import { Service } from "../cordis/service.js";
import type { ToolsService } from "../services/tools.js";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ---------- 数据词汇表 ----------

/** 统一行情快照（一轮全市场或单票明细的一行）。 */
export interface Quote {
    code: string;
    name: string;
    price: number;
    change: number;
    changePercent: number;
    open: number;
    high: number;
    low: number;
    preClose: number;
    /** 成交量（手）。 */
    volume: number;
    /** 成交额（元）。 */
    amount: number;
    /** 换手率 %（新浪明细无此字段，填 0）。 */
    turnoverRate: number;
    /** 量比（0 = 未知，如停牌 "-"）。 */
    volumeRatio: number;
    /** 总市值（元；新浪明细 0）。 */
    marketCap: number;
    /** 流通市值（元；新浪明细 0）。 */
    floatCap: number;
    /** 市净率（新浪明细 0）。 */
    pb: number;
    /** 快照时间（新浪明细才有：日期+时间）。 */
    quotedAt?: string;
    /** 五档盘口（仅单票明细 hq 接口带；量=股——买卖压力是比值，量纲自消）。 */
    book?: Book;
}

/** 盘口一档：价 p（元）+ 量 v（股）。 */
export interface Level { p: number; v: number }

/** 五档盘口（决策 #9：只进关注面，L2/逐笔不接）。 */
export interface Book { bids: Level[]; asks: Level[] }

/** 数据源接缝：换源 = 换实现，服务与工具零改。 */
export interface QuoteSource {
    /** 全市场快照（约 5,900 只，分页并发拉取）。 */
    fetchMarketSnapshot(): Promise<Quote[]>;
    /** 单票/少量明细（实时性优于快照轮询间隔）。 */
    fetchQuotes(codes: string[]): Promise<Quote[]>;
}

// ---------- 交易时段（纯函数，测试可见） ----------

export type MarketPhase = "closed" | "auction" | "open" | "lunch";

const CN_TZ = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", hourCycle: "h23",
    weekday: "short", hour: "2-digit", minute: "2-digit",
});

/** A 股时段判定（只看钟表，不认识节假日——节假日照跑轮询但价格不动，
 *  staleness 自然揭示；调休上班的周末判定 closed，与交易所一致）。 */
export function marketPhase(now: Date): MarketPhase {
    const parts: Record<string, string> = {};
    for (const p of CN_TZ.formatToParts(now)) parts[p.type] = p.value;
    if (parts.weekday === "Sat" || parts.weekday === "Sun") return "closed";
    const m = Number(parts.hour) * 60 + Number(parts.minute);
    if (m >= 555 && m < 570) return "auction"; // 9:15–9:30 集合竞价
    if (m >= 570 && m < 690) return "open";    // 9:30–11:30
    if (m >= 690 && m < 780) return "lunch";   // 11:30–13:00
    if (m >= 780 && m < 900) return "open";    // 13:00–15:00
    return "closed";
}

export function isPollingActive(phase: MarketPhase): boolean {
    return phase !== "closed";
}

// ---------- 数据源实现 ----------
// 主源=新浪（排行列表全市场 + hq 明细），备源=东财 push2（快照）。
// 为什么主源不是东财：2026-10-18 探测发现东财 CDN 对 Node 的 TCP/TLS 特征
// 直接 RST（curl 同 IP 同头通、新浪 Node 也通——WAF 指纹过滤），跨环境不可
// 依赖。东财实现保留为备源（换个网络环境可能就能用），parser 各自 fixture 钉住。

const EM_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const EM_FIELDS = "f2,f3,f4,f5,f6,f8,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23";
// 沪深主板+创业板+科创板+北交所的全 A 股市场过滤器
const EM_FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048";
const EM_PAGE = 100;      // 服务端单页硬上限（pz>100 也只回 100）
const EM_CONCURRENCY = 8; // 分页并发：60 页 ≈ 8 波 × ~200ms

const SL_PAGE = 100;       // 新浪列表同款单页硬上限（num>100 也只回 100）
const SL_CONCURRENCY = 8;

/** 数值容错：新浪列表的数值全是字符串（"trade":"22.560"），东财是原生数；
 *  "-"（停牌）/空串/undefined 一律归 0。 */
function num(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

/** 东货行代码 → 带前缀 code。f13：1=沪 0=深；北交所（4/8/92 开头）在 0 侧。 */
function emCode(raw: string, market: number): string {
    if (market === 1) return `sh${raw}`;
    return /^(4|8|92)/.test(raw) ? `bj${raw}` : `sz${raw}`;
}

/** 东财 diff 行 → Quote（纯函数，fixture 测试钉格式）。 */
export function parseEastmoneyDiff(diff: Record<string, unknown>[]): Quote[] {
    return diff.map((d) => ({
        code: emCode(String(d.f12 ?? ""), num(d.f13)),
        name: String(d.f14 ?? ""),
        price: num(d.f2), change: num(d.f4), changePercent: num(d.f3),
        open: num(d.f17), high: num(d.f15), low: num(d.f16), preClose: num(d.f18),
        volume: num(d.f5), amount: num(d.f6), turnoverRate: num(d.f8),
        volumeRatio: num(d.f10), marketCap: num(d.f20), floatCap: num(d.f21), pb: num(d.f23),
    }));
}

interface EmPage { total: number; diff: Record<string, unknown>[] }

async function emFetchPage(pageNo: number): Promise<EmPage> {
    const url = "https://push2.eastmoney.com/api/qt/clist/get"
        + `?pn=${pageNo}&pz=${EM_PAGE}&po=1&np=1&fltt=2&invt=2&fid=f12&fs=${EM_FS}&fields=${EM_FIELDS}`;
    const res = await fetch(url, {
        headers: { "User-Agent": EM_UA },
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`eastmoney page ${pageNo}: HTTP ${res.status}`);
    const json = (await res.json()) as { data?: { total?: number; diff?: Record<string, unknown>[] } };
    return { total: json.data?.total ?? 0, diff: json.data?.diff ?? [] };
}

/** 五档盘口解析（S11）：hq 行 f[10..29] = 买一量,买一价,…,买五量,买五价,
 *  卖一量,卖一价,…,卖五量,卖五价（量=股）。字段不足（指数等短行）→ undefined。 */
function parseBook(f: string[]): Book | undefined {
    if (f.length < 30) return undefined;
    const level = (v: string, p: string): Level => ({ v: Math.round(num(v)), p: num(p) });
    const bids: Level[] = [];
    const asks: Level[] = [];
    for (let i = 0; i < 5; i++) {
        bids.push(level(f[10 + i * 2]!, f[11 + i * 2]!));
        asks.push(level(f[20 + i * 2]!, f[21 + i * 2]!));
    }
    return { bids, asks };
}

/** 新浪响应 → Quote[]（纯函数；输入为 GBK 解码后的文本）。 */
export function parseSinaResponse(text: string): Quote[] {
    const out: Quote[] = [];
    for (const line of text.split("\n")) {
        const m = /var hq_str_(\w+)="(.*)";?\s*$/.exec(line);
        if (!m) continue;
        const [, code, body] = m;
        const f = body.split(",");
        // 新浪 sh/sz 头部字段：名称,今开,昨收,最新,最高,最低,...,成交量(股),成交额,...,日期,时间
        if (f.length < 32 || !f[0]) continue;
        const price = Number(f[3]);
        const preClose = Number(f[2]);
        out.push({
            code, name: f[0],
            price, open: Number(f[1]), high: Number(f[4]), low: Number(f[5]), preClose,
            change: preClose ? price - preClose : 0,
            changePercent: preClose ? ((price / preClose) - 1) * 100 : 0,
            volume: Math.round(Number(f[8]) / 100),
            amount: Number(f[9]),
            turnoverRate: 0, volumeRatio: 0, marketCap: 0, floatCap: 0, pb: 0,
            quotedAt: `${f[30]} ${f[31]}`,
            book: parseBook(f),
        });
    }
    return out;
}

const SINA_BATCH = 50;

async function sinaFetch(codes: string[]): Promise<Quote[]> {
    const chunks: string[][] = [];
    for (let i = 0; i < codes.length; i += SINA_BATCH) chunks.push(codes.slice(i, i + SINA_BATCH));
    const texts = await Promise.all(chunks.map(async (chunk) => {
        const res = await fetch("https://hq.sinajs.cn/list=" + chunk.join(","), {
            headers: { "User-Agent": EM_UA, Referer: "https://finance.sina.com.cn" },
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`sina hq: HTTP ${res.status}`);
        return new TextDecoder("gbk").decode(await res.arrayBuffer());
    }));
    return parseSinaResponse(texts.join("\n"));
}

// ---------- 主源：新浪排行列表（全市场快照） ----------

/** 新浪 Market_Center 列表行 → Quote（纯函数；字段量纲：volume=股、
 *  mktcap/nmc=万元、turnoverratio=换手率%）。量比此接口没有——填 0，
 *  S5 信号引擎用历史序列近似补上（记档）。 */
export function parseSinaList(rows: Record<string, unknown>[]): Quote[] {
    return rows.map((r) => ({
        code: String(r.symbol ?? ""),
        name: String(r.name ?? ""),
        price: num(r.trade), change: num(r.pricechange), changePercent: num(r.changepercent),
        open: num(r.open), high: num(r.high), low: num(r.low), preClose: num(r.settlement),
        volume: Math.round(num(r.volume) / 100),
        amount: num(r.amount),
        turnoverRate: num(r.turnoverratio),
        volumeRatio: 0,
        marketCap: num(r.mktcap) * 1e4,
        floatCap: num(r.nmc) * 1e4,
        pb: num(r.pb),
    }));
}

async function slFetchPage(pageNo: number): Promise<Quote[]> {
    const url = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData"
        + `?page=${pageNo}&num=${SL_PAGE}&sort=symbol&asc=1&node=hs_a`;
    const res = await fetch(url, {
        headers: { "User-Agent": EM_UA, Referer: "https://vip.stock.finance.sina.com.cn/" },
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`sina list page ${pageNo}: HTTP ${res.status}`);
    const rows = JSON.parse(await res.text()) as Record<string, unknown>[];
    return Array.isArray(rows) ? parseSinaList(rows) : [];
}

/** 主数据源：全市场快照=新浪排行列表，单票明细=新浪 hq。 */
export const sinaSource: QuoteSource = {
    async fetchMarketSnapshot(): Promise<Quote[]> {
        // sort=symbol 固定升序 = 分页稳定序（按涨跌幅排序会在翻页时洗牌）。
        // 波式并发：一波 8 页，见到短页/空页即到尾部。
        const pages: Quote[][] = [];
        for (let start = 1; start <= 200; start += SL_CONCURRENCY) {
            const group: number[] = [];
            for (let p = start; p < start + SL_CONCURRENCY; p++) group.push(p);
            const results = await Promise.all(group.map(slFetchPage));
            let done = false;
            for (const rows of results) {
                if (rows.length === 0) { done = true; break; }
                pages.push(rows);
                if (rows.length < SL_PAGE) { done = true; break; }
            }
            if (done) break;
        }
        return pages.flat();
    },
    fetchQuotes(codes: string[]): Promise<Quote[]> {
        return sinaFetch(codes);
    },
};

/** 备源：全市场快照=东财 push2（部分网络环境对 Node 掐连接，见文件头记档）。 */
export const eastmoneySource: QuoteSource = {
    async fetchMarketSnapshot(): Promise<Quote[]> {
        const first = await emFetchPage(1);
        const pages = Math.ceil(first.total / EM_PAGE);
        const rest: Record<string, unknown>[] = [];
        for (let start = 2; start <= pages; start += EM_CONCURRENCY) {
            const group: number[] = [];
            for (let pn = start; pn < Math.min(start + EM_CONCURRENCY, pages + 1); pn++) group.push(pn);
            const results = await Promise.all(group.map(emFetchPage));
            for (const r of results) rest.push(...r.diff);
        }
        return parseEastmoneyDiff([...first.diff, ...rest]);
    },
    fetchQuotes(codes: string[]): Promise<Quote[]> {
        return sinaFetch(codes);
    },
};

// ---------- 自选股清单（S2：/brief 技能的默认输入源） ----------

/** 清单路径：HOME 沙箱下全局一份（跨项目共享，与 sessions/memory 同区）。 */
export function watchlistPath(): string {
    return join(homedir(), ".mini-claude", "stocks", "watchlist.txt");
}

export interface WatchlistEntry {
    code: string;
    remark: string;
}

/** 清单解析（纯函数）：一行 = 代码 [# 备注]；# 后是备注、空行跳过、
 *  不合法行丢弃（不炸整份）；无 # 时代码后的余词也收作备注。 */
export function parseWatchlist(text: string): WatchlistEntry[] {
    const out: WatchlistEntry[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const hashIdx = raw.indexOf("#");
        const line = (hashIdx >= 0 ? raw.slice(0, hashIdx) : raw).trim();
        const hashRemark = hashIdx >= 0 ? raw.slice(hashIdx + 1).trim() : "";
        if (!line) continue;
        const [code, ...rest] = line.split(/\s+/);
        if (/^(sh|sz|bj)\d{6}$/.test(code)) out.push({ code, remark: hashRemark || rest.join(" ") });
    }
    return out;
}

// ---------- 筛选（纯函数，测试可见） ----------

/** 宇宙排除判定（纯函数）：北交所前缀 + ST/退市名称——screen_market 筛选与
 *  S5 信号引擎宇宙闸共用（trading-rules.md 规则 1-2/1-3 的代码面）。Day 1
 *  复盘教训：筛选只长在 screen_market 上、引擎裸跑全市场，三处筛点必须
 *  同一口径；ST 是名称状态（戴帽/摘帽），逐轮现场判，不存静态名单。 */
export function isExcludedStock(q: Pick<Quote, "code" | "name">, excludeST: boolean, excludeBJ: boolean): boolean {
    return (excludeBJ && q.code.startsWith("bj"))
        || (excludeST && (/ST/i.test(q.name) || q.name.includes("退")));
}

export interface ScreenFilter {
    changePercentMin?: number;
    changePercentMax?: number;
    /** 量比下限（>1 = 放量）。 */
    volumeRatioMin?: number;
    /** 换手率下限 %。 */
    turnoverRateMin?: number;
    priceMin?: number;
    priceMax?: number;
    /** 成交额下限（元）——流动性闸。 */
    amountMin?: number;
    /** 排除 ST/*ST/退市整理（默认 true）。 */
    excludeST?: boolean;
    /** 排除北交所（默认 true：30% 涨跌幅会污染沪深异动榜）。 */
    excludeBJ?: boolean;
    sortBy?: "changePercent" | "amount" | "volumeRatio" | "turnoverRate";
    order?: "desc" | "asc";
    /** 默认 20，上限 50。 */
    limit?: number;
}

/** 快照筛选：price>0 隐式过滤（停牌行不可交易、涨跌幅无意义）。 */
export function screenQuotes(quotes: Quote[], f: ScreenFilter): Quote[] {
    const excludeST = f.excludeST ?? true;
    const excludeBJ = f.excludeBJ ?? true;
    const sortBy = f.sortBy ?? "changePercent";
    const order = f.order ?? "desc";
    const limit = Math.min(Math.max(f.limit ?? 20, 1), 50);
    const kept = quotes.filter((q) => {
        if (q.price <= 0) return false;
        if (isExcludedStock(q, excludeST, excludeBJ)) return false;
        if (f.changePercentMin !== undefined && q.changePercent < f.changePercentMin) return false;
        if (f.changePercentMax !== undefined && q.changePercent > f.changePercentMax) return false;
        if (f.volumeRatioMin !== undefined && q.volumeRatio < f.volumeRatioMin) return false;
        if (f.turnoverRateMin !== undefined && q.turnoverRate < f.turnoverRateMin) return false;
        if (f.priceMin !== undefined && q.price < f.priceMin) return false;
        if (f.priceMax !== undefined && q.price > f.priceMax) return false;
        if (f.amountMin !== undefined && q.amount < f.amountMin) return false;
        return true;
    });
    kept.sort((a, b) => (order === "desc" ? b[sortBy] - a[sortBy] : a[sortBy] - b[sortBy]));
    return kept.slice(0, limit);
}

// ---------- 服务 ----------

export interface Snapshot {
    at: number;
    quotes: Quote[];
    byCode: Map<string, Quote>;
}

/** 环形缓冲的一轮：每码三值（S5 起——量类指标要口粮）。
 *  p=价格 v=当日累计成交量(手) a=当日累计成交额(元)——后两者是累计量，
 *  差分出区间量。 */
export interface HistoryRound {
    at: number;
    rows: Map<string, { p: number; v: number; a: number }>;
}

export interface MarketConfig {
    /** 交易时段轮询间隔 ms（默认 5,000）。 */
    pollIntervalMs?: number;
    /** 价格序列环形缓冲轮数（默认 60 ≈ 5 分钟口粮，S5 消费）。 */
    historyRounds?: number;
    /** 数据源注入（测试用 MockQuoteSource；生产缺省=新浪主源）。 */
    source?: QuoteSource;
    /** 时钟注入（测试时段判定）。 */
    now?: () => Date;
}

/** 快照/明细的文本面：模型看的是这张表，不是 5,900 行原始数据。 */
function formatQuoteRow(q: Quote): string {
    const ratio = q.volumeRatio > 0 ? q.volumeRatio.toFixed(2) : "-";
    return `${q.code}  ${q.name}\t${q.price.toFixed(2)}  ${q.changePercent >= 0 ? "+" : ""}${q.changePercent.toFixed(2)}%  `
        + `额${(q.amount / 1e8).toFixed(2)}亿  量比${ratio}  换手${q.turnoverRate.toFixed(2)}%`;
}

export class MarketDataService extends Service {
    private source: QuoteSource;
    private pollIntervalMs: number;
    private historyRounds: number;
    private now: () => Date;
    private timer: NodeJS.Timeout | null = null;
    private inFlight: Promise<Snapshot> | null = null;

    latest: Snapshot | null = null;
    /** 最近 N 轮序列（环形，S5 信号引擎的口粮：价格+量+额）。 */
    history: HistoryRound[] = [];
    /** 测试可见：全市场刷新计数。 */
    refreshCount = 0;

    constructor(ctx: Context, name: string, config: MarketConfig = {}) {
        super(ctx, name);
        this.source = config.source ?? sinaSource;
        this.pollIntervalMs = config.pollIntervalMs ?? 5_000;
        this.historyRounds = config.historyRounds ?? 60;
        this.now = config.now ?? (() => new Date());
    }

    /** 启动轮询：立即拉一轮（休市也拉——收盘快照可用），此后只在交易时段刷。
     *  后台刷新失败只吞不炸（离线/接口改版时进程不死，下个 tick 再试）——
     *  工具面的 ensureFresh 仍会抛，由调用侧给用户看到错误。 */
    start(): void {
        if (this.timer) return;
        void this.refresh().catch(() => { });
        this.timer = setInterval(() => {
            if (isPollingActive(marketPhase(this.now()))) void this.refresh().catch(() => { });
        }, this.pollIntervalMs);
        this.timer.unref?.();
    }

    dispose(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /** 注入时钟的公共读口（S9 watch 的单一时钟源——行情时间就是盯盘时间）。 */
    clock(): Date {
        return this.now();
    }

    /** 全市场刷新（并发去重：进行中就等同一趟）。完成时同步广播
     *  market/snapshot——S5 信号引擎等消费者在此挂评估。 */
    async refresh(): Promise<Snapshot> {
        if (this.inFlight) return this.inFlight;
        this.inFlight = (async () => {
            const quotes = await this.source.fetchMarketSnapshot();
            // at 走注入时钟（测试/场景确定性）；缺省=真钟表
            const snap: Snapshot = { at: this.now().getTime(), quotes, byCode: new Map(quotes.map((q) => [q.code, q])) };
            this.latest = snap;
            this.history.push({
                at: snap.at,
                rows: new Map(quotes.map((q) => [q.code, { p: q.price, v: q.volume, a: q.amount }])),
            });
            while (this.history.length > this.historyRounds) this.history.shift();
            this.refreshCount++;
            return snap;
        })();
        try {
            const snap = await this.inFlight;
            this.ctx.emit("market/snapshot", snap);
            return snap;
        } finally {
            this.inFlight = null;
        }
    }

    /** 缓存新鲜直接用，过期拉一轮——工具入口（休市也能按需取收盘快照）。 */
    async ensureFresh(maxAgeMs: number): Promise<Snapshot> {
        if (this.latest && Date.now() - this.latest.at <= maxAgeMs) return this.latest;
        return this.refresh();
    }

    /** 单票明细：直连数据源实时取（不占快照轮询节奏）。 */
    async detailQuotes(codes: string[]): Promise<Quote[]> {
        return this.source.fetchQuotes(codes);
    }

    /** 注册模型面的只读工具（S1 两件 + S2 自选股清单）。 */
    attachTools(): void {
        const tools = this.ctx.require<ToolsService>("tools");
        tools.register({
            name: "get_watchlist",
            description: "读取自选股清单（代码 + 备注）。文件：~/.mini-claude/stocks/watchlist.txt，"
                + "一行一只（sh600000  # 备注可选）。不存在时返回创建指引。/brief 技能的默认输入源。",
            parameters: { type: "object", properties: {} },
            permissionHint: "read",
            execute: () => {
                const path = watchlistPath();
                if (!existsSync(path)) {
                    return `No watchlist yet. Create it at:\n  ${path}\nFormat: one code per line, e.g.\n`
                        + `  sh600000  # 浦发银行\n  sz300750  # 宁德时代\n`
                        + `Or pass codes directly as /brief arguments: /brief sh600000,sz300750`;
                }
                const entries = parseWatchlist(readFileSync(path, "utf-8"));
                if (entries.length === 0) return `Watchlist is empty (${path}).`;
                return [`watchlist (${entries.length}) — ${path}`,
                    ...entries.map((e) => `${e.code}${e.remark ? `  # ${e.remark}` : ""}`)].join("\n");
            },
        });
        tools.register({
            name: "get_quote",
            description: "获取 A 股个股实时行情明细（价格/涨跌/成交量额/买卖五档盘口，来源：新浪）。"
                + "code 带交易所前缀：sh600000（沪）/ sz000001（深）/ bj920196（北交所）。一次最多 30 只。",
            parameters: {
                type: "object",
                properties: {
                    codes: {
                        type: "array", items: { type: "string" }, maxItems: 30,
                        description: '带前缀的股票代码，如 ["sh600000", "sz300750"]',
                    },
                },
                required: ["codes"],
            },
            permissionHint: "read",
            execute: async (input) => {
                const codes = (input.codes as string[]).filter((c) => /^((sh|sz|bj)\d{6})$/.test(c));
                if (codes.length === 0) return "Error: no valid codes (expect sh/sz/bj + 6 digits).";
                try {
                    const quotes = await this.detailQuotes(codes);
                    if (quotes.length === 0) return `No quotes found for: ${(input.codes as string[]).join(", ")}`;
                    const fmtLevels = (ls: Level[]) => ls.map((l) => `${l.p.toFixed(2)}×${l.v}`).join("/");
                    return quotes.map((q) => {
                        const head = formatQuoteRow(q);
                        const detail = q.quotedAt ? `  [${q.quotedAt}]` : "";
                        const book = q.book ? `\n  盘口 买[${fmtLevels(q.book.bids)}] 卖[${fmtLevels(q.book.asks)}]（量=股）` : "";
                        return head + detail + book;
                    }).join("\n");
                } catch (err) {
                    return `Error fetching quotes: ${(err as Error).message}`;
                }
            },
        });
        tools.register({
            name: "screen_market",
            description: "筛选全 A 股实时快照（约 5,900 只），返回命中条件的短名单。"
                + "适合找异动：涨幅榜/跌幅榜/放量/高换手/低价股等。数据源：新浪全市场快照（轮询缓存，秒级新鲜度）。",
            parameters: {
                type: "object",
                properties: {
                    changePercentMin: { type: "number", description: "涨跌幅下限 %（如 5 = 涨逾 5%）" },
                    changePercentMax: { type: "number", description: "涨跌幅上限 %" },
                    volumeRatioMin: { type: "number", description: "量比下限（>1 放量）。注意：主源（新浪列表）无量比字段，当前恒 0——此条件待 S5 用历史序列补上后才生效" },
                    turnoverRateMin: { type: "number", description: "换手率下限 %" },
                    priceMin: { type: "number", description: "价格下限（元）" },
                    priceMax: { type: "number", description: "价格上限（元）" },
                    amountMin: { type: "number", description: "成交额下限（元，如 3e8 = 3 亿）——流动性闸" },
                    excludeST: { type: "boolean", description: "排除 ST/退市整理，默认 true" },
                    excludeBJ: { type: "boolean", description: "排除北交所，默认 true" },
                    sortBy: { type: "string", enum: ["changePercent", "amount", "volumeRatio", "turnoverRate"], description: "排序字段，默认 changePercent" },
                    order: { type: "string", enum: ["desc", "asc"], description: "排序方向，默认 desc" },
                    limit: { type: "number", description: "返回条数（默认 20，上限 50）" },
                },
            },
            permissionHint: "read",
            execute: async (input) => {
                const snap = await this.ensureFresh(15_000);
                const filter: ScreenFilter = {
                    changePercentMin: input.changePercentMin as number | undefined,
                    changePercentMax: input.changePercentMax as number | undefined,
                    volumeRatioMin: input.volumeRatioMin as number | undefined,
                    turnoverRateMin: input.turnoverRateMin as number | undefined,
                    priceMin: input.priceMin as number | undefined,
                    priceMax: input.priceMax as number | undefined,
                    amountMin: input.amountMin as number | undefined,
                    excludeST: input.excludeST as boolean | undefined,
                    excludeBJ: input.excludeBJ as boolean | undefined,
                    sortBy: input.sortBy as ScreenFilter["sortBy"],
                    order: input.order as ScreenFilter["order"],
                    limit: input.limit as number | undefined,
                };
                const rows = screenQuotes(snap.quotes, filter);
                const phase = marketPhase(new Date());
                const header = `全市场 ${snap.quotes.length} 只，命中 ${rows.length} 条`
                    + `（快照 ${new Date(snap.at).toLocaleString("zh-CN")}，当前时段 ${phase}${phase === "closed" ? "=收盘快照" : ""}）`;
                if (rows.length === 0) return header + "\n（无命中——放宽条件试试）";
                return [header, ...rows.map(formatQuoteRow)].join("\n");
            },
        });
    }
}

declare module "../cordis/context.js" {
    interface Context {
        market?: MarketDataService;
    }
}

declare module "../cordis/events.js" {
    interface Events {
        /** 每轮全市场快照落定（refresh 尾同步广播）——消费方：S5 信号引擎。 */
        "market/snapshot"(snap: Snapshot): void;
    }
}

export const marketDataPlugin: Plugin = {
    name: "market-data",
    inject: ["tools"],
    apply(ctx: Context, config: MarketConfig = {}) {
        const market = new MarketDataService(ctx, "market", config);
        market.attachTools();
        market.start();
        ctx.effect(() => () => market.dispose());
    },
};
