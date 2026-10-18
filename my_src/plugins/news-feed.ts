// plugins/news-feed.ts——S3：市场消息面（stock profile 专用，base 默认 disabled）。
//
// 与 market-data 同款分层：NewsSource 接缝（默认=新浪财经 7x24 直播流）+
// NewsFeedService（轮询 + id 去重 + JSONL 落盘）+ latest_news 只读工具。
// 消息面是 S6 裁决技能的另一半输入（信号×新闻），也是 /news-brief（S4）的底料。
//
// 接口口径（记档）：
//   - NewsItem.id 用源原生 id（字符串化）——去重键，跨重启由 JSONL 重建
//   - codes 只收 A 股关联（ext.stocks market==='cn' 的 symbol）；tags 收全部
//     关联显示名（"石油"/"微软"……中英文话题都进，query 匹配面更宽）
//   - 新闻 7x24 流动（美股/期货夜间也在跑）——不做交易时段 gating，
//     间隔可配（默认 60s）；夜间降频留给配置，不做代码分支
//   - JSONL 追加 + 超限折叠（默认 2MB 保半重写，S4 收口）；启动读尾部
//     ~2000 行重建去重集与内存环

import type { Context } from "../cordis/context.js";
import type { Plugin } from "../cordis/fiber.js";
import { Service } from "../cordis/service.js";
import type { ToolsService } from "../services/tools.js";
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ---------- 数据词汇表 ----------

export interface NewsItem {
    /** 源原生 id（字符串化）——去重键。 */
    id: string;
    /** 发布时间（epoch ms）。 */
    time: number;
    /** 正文（【标题】+ 内容；已剥 HTML 标签）。 */
    text: string;
    /** 关联话题名（ext.stocks 的 key，中英文都有："石油"/"微软"…）。 */
    tags: string[];
    /** A 股关联代码（market==='cn' 的 symbol，如 sh600000）。 */
    codes: string[];
}

/** 消息源接缝：一次拉最新一页（新→旧）。换源 = 换实现。 */
export interface NewsSource {
    fetchLatest(): Promise<NewsItem[]>;
}

// ---------- 新浪 7x24 实现 ----------

const ZB_URL = "https://zhibo.sina.com.cn/api/zhibo/feed"
    + "?page=1&page_size=20&zhibo_id=152&tag_id=0&dire=f&dpc=1";

/** "2026-10-18 14:40:10"（北京时间）→ epoch ms。 */
function cnTimeToEpoch(s: string): number {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
    if (!m) return 0;
    // 北京时间 = UTC+8 无夏令时——用 UTC 构造再减 8h，避开本机时差
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 8 * 3600_000;
}

/** 剥 HTML 标签 + 压空白（rich_text 大多数是纯文本，防御性处理）。 */
function stripTags(s: string): string {
    return s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

/** 新浪 7x24 响应 → NewsItem[]（纯函数，fixture 钉格式）。 */
export function parseSinaZhibo(json: unknown): NewsItem[] {
    const list = (json as {
        result?: { data?: { feed?: { list?: Record<string, unknown>[] } } };
    })?.result?.data?.feed?.list;
    if (!Array.isArray(list)) return [];
    const out: NewsItem[] = [];
    for (const item of list) {
        const id = String(item.id ?? "");
        const text = stripTags(String(item.rich_text ?? ""));
        if (!id || !text) continue;
        const tags: string[] = [];
        const codes: string[] = [];
        try {
            const ext = JSON.parse(String(item.ext || "{}")) as {
                stocks?: { market?: string; symbol?: string; key?: string }[];
            };
            for (const s of ext.stocks ?? []) {
                if (s.key && !tags.includes(s.key)) tags.push(s.key);
                if (s.market === "cn" && s.symbol) codes.push(s.symbol);
            }
        } catch { /* ext 缺失/坏 JSON 不炸整条 */ }
        out.push({
            id, time: cnTimeToEpoch(String(item.create_time ?? "")),
            text, tags, codes,
        });
    }
    return out;
}

export const sinaZhiboSource: NewsSource = {
    async fetchLatest(): Promise<NewsItem[]> {
        const res = await fetch(ZB_URL, {
            headers: { "User-Agent": "Mozilla/5.0", Referer: "https://finance.sina.com.cn/" },
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`sina zhibo: HTTP ${res.status}`);
        return parseSinaZhibo(await res.json());
    },
};

// ---------- 过滤（纯函数，测试可见） ----------

export interface NewsFilter {
    /** 关键词（不区分大小写，匹配正文与 tags）。 */
    query?: string;
    /** A 股代码（sh/sz 前缀）——命中 item.codes。 */
    codes?: string[];
    /** 默认 20，上限 50。 */
    limit?: number;
}

export function filterNews(items: NewsItem[], f: NewsFilter): NewsItem[] {
    const limit = Math.min(Math.max(f.limit ?? 20, 1), 50);
    const q = f.query?.toLowerCase();
    // 不做代码预校验：无前缀的 '600000' 天然匹配不到带前缀的 item.codes，
    // 结果为空——比"非法输入退化成无过滤"（返回全流）更安全
    const codes = f.codes ?? [];
    return items
        .filter((it) => {
            if (q && !(it.text.toLowerCase().includes(q) || it.tags.some((t) => t.toLowerCase().includes(q)))) return false;
            if (codes.length > 0 && !it.codes.some((c) => codes.includes(c))) return false;
            return true;
        })
        .slice(0, limit);
}

// ---------- 服务 ----------

/** 消息存储路径：HOME 沙箱下与 watchlist 同区。 */
export function newsStoragePath(): string {
    return join(homedir(), ".mini-claude", "stocks", "news.jsonl");
}

export interface NewsConfig {
    /** 轮询间隔 ms（默认 60,000——新闻 7x24 流动，不做时段 gating）。 */
    pollIntervalMs?: number;
    /** 内存环容量（默认 500 条；超出丢最旧）。 */
    keepInMemory?: number;
    /** 落盘折叠阈值字节（默认 2MB；超出保半重写——均摊 O(1)，S4 收口 S3 的 deferred）。 */
    maxStorageBytes?: number;
    /** 消息源注入（测试用 MockNewsSource）。 */
    source?: NewsSource;
    /** 存储路径注入（测试用临时文件）。 */
    storagePath?: string;
}

export class NewsFeedService extends Service {
    private source: NewsSource;
    private pollIntervalMs: number;
    private keepInMemory: number;
    private maxStorageBytes: number;
    private storagePath: string;
    private timer: NodeJS.Timeout | null = null;
    private inFlight: Promise<void> | null = null;

    /** 新→旧。 */
    items: NewsItem[] = [];
    private seen = new Set<string>();
    /** 测试可见：新增条数累计。 */
    addedCount = 0;

    constructor(ctx: Context, name: string, config: NewsConfig = {}) {
        super(ctx, name);
        this.source = config.source ?? sinaZhiboSource;
        this.pollIntervalMs = config.pollIntervalMs ?? 60_000;
        this.keepInMemory = config.keepInMemory ?? 500;
        this.maxStorageBytes = config.maxStorageBytes ?? 2 * 1024 * 1024;
        this.storagePath = config.storagePath ?? newsStoragePath();
        this.loadFromDisk();
    }

    /** 启动：立即拉一轮 + 定时轮询（消息 7x24，不做时段 gating）。 */
    start(): void {
        if (this.timer) return;
        void this.refresh().catch(() => { /* 网络失败不炸进程——下个 tick 再试 */ });
        this.timer = setInterval(() => {
            void this.refresh().catch(() => { });
        }, this.pollIntervalMs);
        this.timer.unref?.();
    }

    dispose(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /** 拉一轮：新 id 进内存环 + 追加 JSONL（老→新顺序落盘）。 */
    async refresh(): Promise<void> {
        if (this.inFlight) return this.inFlight;
        this.inFlight = (async () => {
            const fresh = await this.source.fetchLatest(); // 新→旧
            const added = fresh.filter((it) => !this.seen.has(it.id)); // 仍是新→旧
            if (added.length > 0) {
                this.items = [...added, ...this.items].slice(0, this.keepInMemory);
                for (const it of added) this.seen.add(it.id);
                this.addedCount += added.length;
                this.appendToFile([...added].reverse()); // 老→新
            }
            this.lastRefreshAt = Date.now();
        })();
        try {
            await this.inFlight;
        } finally {
            this.inFlight = null;
        }
    }

    /** 工具入口：以"最后一次成功刷新"计龄（消息流可能整轮无新增，不能用
     *  最新条目时间近似）；从未刷过或过期则拉一轮。 */
    async ensureFresh(maxAgeMs: number): Promise<void> {
        if (this.lastRefreshAt > 0 && Date.now() - this.lastRefreshAt <= maxAgeMs) return;
        await this.refresh();
    }

    private lastRefreshAt = 0;

    private appendToFile(items: NewsItem[]): void {
        try {
            mkdirSync(dirname(this.storagePath), { recursive: true });
            appendFileSync(this.storagePath, items.map((it) => JSON.stringify(it)).join("\n") + "\n");
            this.maybeCompact();
        } catch { /* 落盘失败不炸轮询——内存环仍在 */ }
    }

    /** 折叠：超过 maxStorageBytes 就保半重写（丢最旧一半）。均摊成本 O(1)——
     *  折半而不是截到固定条数，避免"每次追加都触发重写"的抖动带。 */
    private maybeCompact(): void {
        try {
            if (statSync(this.storagePath).size < this.maxStorageBytes) return;
            const lines = readFileSync(this.storagePath, "utf-8").split("\n").filter(Boolean);
            const keep = lines.slice(Math.floor(lines.length / 2));
            writeFileSync(this.storagePath, keep.join("\n") + (keep.length > 0 ? "\n" : ""));
        } catch { /* 折叠失败不影响主流程——下轮追加再试 */ }
    }

    /** 启动回读：尾部 ~2000 行重建去重集与内存环（老→新读入后翻新→旧）。 */
    private loadFromDisk(): void {
        try {
            if (!existsSync(this.storagePath)) return;
            const lines = readFileSync(this.storagePath, "utf-8").trim().split("\n").slice(-2000);
            for (const line of lines) {
                try {
                    const it = JSON.parse(line) as NewsItem;
                    if (it?.id && !this.seen.has(it.id)) {
                        this.seen.add(it.id);
                        this.items.push(it);
                    }
                } catch { /* 半行/坏行丢弃——appendFileSync 非原子，容忍 */ }
            }
            this.items.sort((a, b) => b.time - a.time);
            this.items = this.items.slice(0, this.keepInMemory);
        } catch { /* 读失败 = 空存储起步 */ }
    }

    /** 注册模型面的只读工具。 */
    attachTools(): void {
        const tools = this.ctx.require<ToolsService>("tools");
        tools.register({
            name: "latest_news",
            description: "最新市场快讯（新浪财经 7x24 直播流，轮询缓存）。"
                + "query 按关键词过滤（匹配正文与话题，如'锂'/'降息'）；codes 按 A 股个股关联过滤（如 sh600000）；"
                + "返回新→旧时间线。消息面查证、个股动态、宏观事件都用它。",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "关键词（不区分大小写，匹配正文与话题名）" },
                    codes: {
                        type: "array", items: { type: "string" }, maxItems: 20,
                        description: 'A 股代码过滤（带前缀，如 ["sh600000"]）——命中编辑标注的个股关联',
                    },
                    limit: { type: "number", description: "返回条数（默认 20，上限 50）" },
                },
            },
            permissionHint: "read",
            execute: async (input) => {
                await this.ensureFresh(30_000);
                const rows = filterNews(this.items, {
                    query: input.query as string | undefined,
                    codes: input.codes as string[] | undefined,
                    limit: input.limit as number | undefined,
                });
                const newest = rows[0]?.time ?? this.items[0]?.time ?? 0;
                const header = `快讯 ${rows.length} 条（内存 ${this.items.length} 条，最新 ${new Date(newest).toLocaleString("zh-CN")}）`;
                if (rows.length === 0) return header + "\n（无命中——换个关键词，或不带条件看全流）";
                return [header, ...rows.map((it) => {
                    const hhmm = new Date(it.time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
                    const tags = it.tags.length > 0 ? `［${it.tags.slice(0, 4).join("、")}］` : "";
                    const text = it.text.length > 200 ? it.text.slice(0, 200) + "…" : it.text;
                    return `[${hhmm}] ${tags}${text}`;
                })].join("\n");
            },
        });
    }
}

function dirname(p: string): string {
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return i <= 0 ? "." : p.slice(0, i);
}

declare module "../cordis/context.js" {
    interface Context {
        news?: NewsFeedService;
    }
}

export const newsFeedPlugin: Plugin = {
    name: "news-feed",
    inject: ["tools"],
    apply(ctx: Context, config: NewsConfig = {}) {
        const news = new NewsFeedService(ctx, "news", config);
        news.attachTools();
        news.start();
        ctx.effect(() => () => news.dispose());
    },
};
