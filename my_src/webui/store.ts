// webui/store.ts——F3：React-free observable snapshot 引擎。
// 参照物：dsh packages/client/store/src/contract.ts（ObservableSnapshot +
// ActionsDecl 审计面 + baked actions）。教学裁剪：不做 persist / scopeKey /
// 插件注册，保留三根柱子——
//   1. 快照稳定：state 只在 immer produce 产出新引用时更替（uSES 的
//      getSnapshot 契约：同状态同引用，React 才不会空转）
//   2. 审计面：components 只能通过声明的 actions 写状态（draft 参数被烘掉），
//      write set = 声明表，没有暗门
//   3. 框架中立：本文件不 import react——唯一的 React 绑定在 renderer.tsx
//      （useSyncExternalStore + selector 缓存，对照 dsh "ui-renderer 是唯一
//      通过 useSyncExternalStore 绑定裸 observable 的包"红线）

import { produce, type Draft } from "immer";

/** 最小可观察快照源（dsh contract.ts 同名契约）。 */
export interface ObservableSnapshot<T> {
    getSnapshot(): T;
    subscribe(fn: () => void): () => void;
}

/** 声明式写集：每个 action 是纯 immer draft 变换——store 的全部写入口。 */
export type ActionsDecl<T> = Record<string, (draft: Draft<T>, ...params: any[]) => void>;

/** draft 参数被烘掉的回调形态——组件与装配层拿到的东西。 */
export type BakedActions<T, A extends ActionsDecl<T>> = {
    [K in keyof A]: A[K] extends (draft: Draft<T>, ...params: infer P) => void ? (...params: P) => void : never;
};

export interface StoreSpec<T, A extends ActionsDecl<T>> {
    /** 工厂而非值——每个实例一份新状态。 */
    init: () => T;
    actions: A;
}

export interface StoreInstance<T, A extends ActionsDecl<T>> extends ObservableSnapshot<T> {
    readonly actions: BakedActions<T, A>;
    /** 切片订阅：eq 缺省 Object.is，选中值不变则不通知（渲染按需）。 */
    select<S>(sel: (state: T) => S, eq: ((a: S, b: S) => boolean) | undefined, fn: () => void): () => void;
}

export interface StoreHandle<T, A extends ActionsDecl<T>> {
    readonly spec: StoreSpec<T, A>;
    create(): StoreInstance<T, A>;
}

export function defineStore<T, A extends ActionsDecl<T>>(spec: StoreSpec<T, A>): StoreHandle<T, A> {
    return { spec, create: () => new SnapshotStore<T, A>(spec) };
}

class SnapshotStore<T, A extends ActionsDecl<T>> implements StoreInstance<T, A> {
    private state: T;
    private listeners = new Set<() => void>();
    readonly actions: BakedActions<T, A>;

    constructor(spec: StoreSpec<T, A>) {
        this.state = spec.init();
        const baked = {} as BakedActions<T, A>;
        for (const [name, action] of Object.entries(spec.actions)) {
            baked[name as keyof A] = ((...params: any[]) => {
                this.update((draft) => (action as any)(draft, ...params));
            }) as any;
        }
        this.actions = baked;
    }

    getSnapshot(): T {
        return this.state;
    }

    subscribe(fn: () => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    select<S>(sel: (state: T) => S, eq: ((a: S, b: S) => boolean) | undefined, fn: () => void): () => void {
        const equals = eq ?? Object.is;
        let last = sel(this.state);
        return this.subscribe(() => {
            const next = sel(this.getSnapshot());
            if (!equals(last, next)) {
                last = next;
                fn();
            }
        });
    }

    /** 唯一写路径：produce 没改动（同引用）就不通知——空转防线。 */
    private update(recipe: (draft: Draft<T>) => void): void {
        const next = produce(this.state, recipe);
        if (next === this.state) return;
        this.state = next;
        for (const fn of [...this.listeners]) fn();
    }
}
