import { printRetry } from "./ui.js";

export function isRetryable(error: any): boolean {
    const status = error?.status || error?.statusCode;
    if (status === 429 || status === 503 || status === 529) {
        return true;
    }
    if (error?.code === "ECONNRESET" || error?.code === "ETIMEDOUT")  {
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
                const delay = Math.min(1000 * Math.pow(2, attempt), 30000) + Math.random() * 1000;
                printRetry(attempt + 1, maxRetries, e?.status ? `HTTP ${e?.status}` : e?.code || "network error");
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }
}
