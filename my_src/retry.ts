import { printRetry } from "./ui.js";

// 只重试瞬态错误：429 限流、503/529 过载（529 是 Anthropic 自定义的 overloaded）、
// 网络抖动。其余（4xx 参数错等）重试也不会好
export function isRetryable(error: any): boolean {
    const status = error?.status || error?.statusCode;
    if (status === 429 || status === 503 || status === 529) {
        return true;
    }
    if (error?.code === "ECONNRESET" || error?.code === "ETIMEDOUT") {
        return true;
    }
    if (error?.message?.includes("overloaded")) {
        return true;
    }
    return false;
}

export async function withRetry<T>(
    fn: () => Promise<T>,
    maxRetries = 3
): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        }
        catch (e: any) {
            if (attempt >= maxRetries || !isRetryable(e)) {
                throw e;
            } else {
                // 指数退避（1s 起步、封顶 30s）+ 随机抖动，防同刻重试雷群
                const delay = Math.min(1000 * Math.pow(2, attempt), 30000) + Math.random() * 1000;
                printRetry(attempt + 1, maxRetries, e?.status ? `HTTP ${e?.status}` : e?.code || "network error");
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }
}
