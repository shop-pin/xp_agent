// services/schedule.ts——D6：定时与唤醒的服务化。
// 参照物：dsh 的 schedule（定时归服务，监听器只做决策）。
//
// 收口两样东西：
//   ① loop 的裸 setTimeout（原 scheduleTick 长在 LoopState.timer 上）
//   ② schedule_wakeup 的字段回传协议（原 LoopService.pendingWakeup：工具写
//      字段 → turn-end 监听器取走清空——读写两端隔着一个 turn 边界，靠约定同步）
// 两者都是"未来才发生的事"，归同一个家：键控一次性定时器（同 key 顶替）+
// 唤醒意图槽（工具侧 requestWakeup，边界侧 takeWakeup）。loop 退役为纯状态。

import { Service } from "../cordis/service.js";

export interface WakeupRequest {
    delaySeconds: number;
    reason: string;
    prompt: string;
}

export class ScheduleService extends Service {
    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    private wakeup: WakeupRequest | null = null;

    /** 键控一次性定时器：同 key 再排 = 顶替（cancel + 重排），旧回调作废。 */
    after(key: string, ms: number, fn: () => void): void {
        this.cancel(key);
        this.timers.set(key, setTimeout(() => {
            this.timers.delete(key);
            fn();
        }, ms));
    }

    cancel(key: string): void {
        const t = this.timers.get(key);
        if (t !== undefined) {
            clearTimeout(t);
            this.timers.delete(key);
        }
    }

    has(key: string): boolean {
        return this.timers.has(key);
    }

    /** schedule_wakeup 工具的写入点；turn-end 监听器经 takeWakeup 消费（取走即清）。 */
    requestWakeup(w: WakeupRequest): void {
        this.wakeup = w;
    }

    takeWakeup(): WakeupRequest | null {
        const w = this.wakeup;
        this.wakeup = null;
        return w;
    }

    clearWakeup(): void {
        this.wakeup = null;
    }
}

declare module "../cordis/context.js" {
    interface Context {
        schedule?: ScheduleService;
    }
}
