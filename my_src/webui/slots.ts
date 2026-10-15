// webui/slots.ts——F3：槽位简版（dsh ui-slots 的 single/list 两类裁剪）。
// 红线：跨包 UI 只靠 Slots 组合——功能贡献注册到具名槽位，装配层不 import
// 任何 feature 的值。mini F3 只有 root（single）+ sidebar/conversation/composer
// （list）五个具名槽；single = 同 id 后写替换，list = 追加有序。

import type { ComponentType } from "react";

export interface SlotEntry {
    id: string;
    component: ComponentType<any>;
}

const registry = new Map<string, SlotEntry[]>();

export function addSlot(slot: string, entry: SlotEntry, mode: "single" | "list" = "list"): () => void {
    const entries = registry.get(slot) ?? [];
    const next = mode === "single" ? [...entries.filter((e) => e.id !== entry.id), entry] : [...entries, entry];
    registry.set(slot, next);
    return () => registry.set(slot, entries);
}

export function slotEntries(slot: string): SlotEntry[] {
    return registry.get(slot) ?? [];
}
