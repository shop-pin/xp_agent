// run-snapshot.mjs——E3：snapshot 总驱动。
// 默认 replay：对 snapshots/ 里已录的每章无 key 重放断言（对齐 dsh
// `test:snapshot` 的"replay 是无 key 默认"）；--record 重录（≙ refresh：
// 代码有意变更后重新 harvest 期望值）。每章一个子进程——HOME 沙箱、MCP
// 子进程、进程级状态互相隔离；退出码汇总是验收线。
//   node run-snapshot.mjs              → 全量回放
//   node run-snapshot.mjs 21 26        → 只回放指定章
//   node run-snapshot.mjs --record 21  → 重录指定章
import { spawnSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const record = args.includes("--record");
const chapters = args.filter((a) => !a.startsWith("--"));

const dirs = existsSync(join(HERE, "snapshots"))
    ? readdirSync(join(HERE, "snapshots")).filter((d) => /^ch\d+$/.test(d))
        .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)))
    : [];
if (dirs.length === 0) {
    console.error("no snapshots/ recorded yet — record with: node run-mock.mjs <ch> --snapshot-record");
    process.exit(1);
}

const targets = chapters.length > 0 ? chapters.map((c) => `ch${c}`) : dirs;
const flag = record ? "--snapshot-record" : "--snapshot-replay";
let red = 0;
for (const dir of targets) {
    if (!dirs.includes(dir)) {
        console.log(`${dir} ✗ (no snapshot recorded)`);
        red++;
        continue;
    }
    const ch = dir.slice(2);
    const r = spawnSync(process.execPath, [join(HERE, "run-mock.mjs"), ch, flag], {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
    });
    const tail = (r.stdout || "").trim().split("\n").filter(Boolean).pop() || "";
    // record 的成功旗标是 ⚑（录制完成即目标达成——场景 verify 在录制期可能
    // 因旧期望红基线而非零退出，不追究）；replay 才锚退出码 + ✓。挂账#5：
    // 原判定不认 ⚑，--record 恒红、进不了 && 链。
    const ok = record ? tail.includes("⚑ snapshot recorded") : r.status === 0 && tail.includes("✓ snapshot");
    // 失败时带出场景的 crash/stderr 尾巴（挂账#11：此前 stderr 直通终端不进
    // runner 输出，"0 requests"类失败只剩光秃秃的 line count 断言没法断因）
    const stderrTail = (r.stderr || "").trim().split("\n").filter(Boolean).slice(-2).join(" | ");
    const detail = ok ? tail.trim() : tail.slice(0, 120)
        + (stderrTail ? ` …stderr: ${stderrTail.slice(0, 140)}` : "");
    if (!ok) red++;
    console.log(`${dir} ${ok ? (record ? "⚑" : "✓") : "✗"}  ${detail}`);
}
console.log(`\nsnapshot ${record ? "record" : "replay"}: ${targets.length - red}/${targets.length} green`);
process.exit(red === 0 ? 0 : 1);
