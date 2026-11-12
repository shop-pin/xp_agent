// webui/renderer.tsx——F3：渲染面（全仓唯一 React 绑定点）。
// 参照物：dsh ui-renderer——"唯一通过 useSyncExternalStore 绑定裸 observable、
// 拥有 React context 并渲染 root tree 的包"（web-client.md 红线）。
//
// useStoreSelector 是 per-selector 缓存的教科书实现：useSyncExternalStore 用
// Object.is 比较 getSnapshot 结果，selector 每次返回新对象会让 React 空转——
// 所以按"状态引用 + 等值"两级缓存，等值时交还旧引用。

import { useCallback, useRef, useSyncExternalStore } from "react";
import type { StoreInstance } from "./store.js";

const defaultEq = Object.is;

export function useStoreSelector<T, S>(
    store: StoreInstance<T, any>,
    sel: (s: T) => S,
    eq: (a: S, b: S) => boolean = defaultEq,
): S {
    const cache = useRef<{ source: T; value: S } | null>(null);
    const getSnapshot = useCallback(() => {
        const source = store.getSnapshot();
        const last = cache.current;
        if (last && last.source === source) return last.value;
        const value = sel(source);
        if (last && eq(last.value, value)) {
            // 选中值等值：沿用旧引用，订阅方按 Object.is 判定为"没变"
            cache.current = { source, value: last.value };
            return last.value;
        }
        cache.current = { source, value };
        return value;
    }, [store, sel, eq]);
    // subscribe 必须绑接收者——useSyncExternalStore 裸调 subscribe(fn) 不带
    // this，脱绑方法（store.subscribe）首帧就抛 TypeError 整树卸载
    const subscribe = useCallback((fn: () => void) => store.subscribe(fn), [store]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
