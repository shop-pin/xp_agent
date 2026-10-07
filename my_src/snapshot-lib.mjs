// snapshot-lib.mjs——E3：录制/回放的规范化与 diff。
// 对齐 dsh `test:snapshot` 思想（record 调真后端 → replay 无 key 重放断言）；
// mini 版的差异记档：dsh 在 llm 适配器层回放录制响应，mini 的 mock-anthropic
// 本身就是"录制响应供应者"（脚本响应 ≙ 录下的响应），快照锚的是
// **完整请求体 + 会话事件流**的逐字节 diff——现有 22+ 场景的手写 verify 是
// 点状锚，快照是全量锚：任何一行代码动了请求组装或事件序，回放立刻红。
//
// 规范化（章节危险点：录制内容含时间戳/随机 id）：
//   已知易变的具体值全局替换（record 时拿到真实 workdir/HOME/sessionId，
//   替换成 {{cwd}}/{{home}}/{{session:n}} 占位）——比猜模式可靠；
//   只能猜模式的（git log 段、日期、命令路径）用正则折叠。
// diff 规则：先比条数再逐行比，首个差异打印上下文（截断），失败即红。

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";

/** 请求体捕获文件的行形状：{ body }（mock-anthropic 的 capturePath 通道）。 */

/**
 * 规范化一段文本。vars 是本场景录制的易变值登记表：
 *   { cwd, home, date } 具体值 → 占位符；git 段/引号内命令路径走正则。
 * 顺序敏感：先长路径后短替换，避免 home 是 cwd 前缀时误替换。
 */
export function normalizeText(text, vars) {
    let out = text;
    // 路径替换要覆盖三种形态：原始（请求体 JSON.parse 后）、JSON 转义
    //（事件 content 是二次字符串化，分隔符成 \\）、正斜杠（跨平台混合）。
    // 长针优先，避免 home 是 cwd 前缀时被短替换截断。
    const pairs = [];
    for (const [key, ph] of [["home", "{{home}}"], ["cwd", "{{cwd}}"]]) {
        const v = vars[key];
        if (!v) continue;
        pairs.push([v, ph]);
        pairs.push([v.split("\\").join("\\\\"), ph]);
        pairs.push([v.split("\\").join("/"), ph]);
    }
    pairs.sort((a, b) => b[0].length - a[0].length);
    for (const [needle, ph] of pairs) out = out.split(needle).join(ph);
    // git 上下文整段折叠：branch/log/status 每次提交都变，锚不住也不该锚
    out = out.replace(/# Git context\nbranch: [^\n]*\n\nlog:\n(?:[^\n]*\n)*?\n?status:/g, "# Git context\n{{git}}\nstatus:");
    out = out.replace(/Today's date is \d{4}-\d{2}-\d{2}\./g, "Today's date is {{date}}.");
    // env 节的 Shell 行带机器相关绝对路径；Memory 目录行带 {{home}} 前缀之外的尾部哈希
    out = out.replace(/^Shell: .*$/gm, "Shell: {{shell}}");
    // Platform 行带平台架构（换机器回放必红），一并折叠
    out = out.replace(/^Platform: .*$/gm, "Platform: {{platform}}");
    out = out.replace(/projects\\*[a-f0-9]{16}/g, "projects{{projhash}}");
    // ISO 时间戳（memory 索引里的文件 mtime 等场景数据携带）
    out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "{{iso}}");
    // truncate 落盘文件名（毫秒时间戳-随机哈希）；捕获组保留分隔符形态
    //（请求体里是 JSON 转义的 \\，事件流里单/双形态都有）
    out = out.replace(/(tool-results[\/\\]+)\d{13}-[0-9a-f]{8}-/g, "$1{{resultfile}}-");
    // plan 文件名里的随机 sessionId（plan-<sid>.md）
    for (const sid of vars.sessionIds ?? []) {
        out = out.split(`plan-${sid}`).join("plan-{{session}}");
    }
    return out;
}

/** 深度规范化 JSON 结构里的所有字符串值（请求体/事件都是纯 JSON 树）。 */
export function normalizeJsonDeep(value, vars) {
    if (typeof value === "string") return normalizeText(value, vars);
    if (Array.isArray(value)) return value.map((v) => normalizeJsonDeep(v, vars));
    if (value && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = normalizeJsonDeep(v, vars);
        return out;
    }
    return value;
}

/** 录制：读捕获文件 + 会话目录，产出规范化后的快照载荷。 */
export function buildSnapshotPayload({ capturePath, workdir, home }) {
    // 会话文件按 mtime 排序后重命名成稳定名（文件名含随机 sessionId）
    const sessDir = join(home, ".mini-claude", "sessions");
    const files = existsSync(sessDir)
        ? readdirSync(sessDir).filter((f) => f.endsWith(".jsonl"))
            .map((f) => ({ f, m: statSync(join(sessDir, f)).mtimeMs }))
            .sort((a, b) => a.m - b.m)
        : [];
    // 文件名里的随机 sessionId 进登记表——plan 文件路径等处也要替换
    const vars = {
        cwd: workdir,
        home,
        date: "{{date}}",
        sessionIds: files.map(({ f }) => f.replace(/\.jsonl$/, "")).filter((s) => /^[0-9a-f]{8}$/.test(s)),
    };
    const requests = existsSync(capturePath)
        ? readFileSync(capturePath, "utf-8").split("\n").filter(Boolean).map((line) => {
            const { body } = JSON.parse(line);
            return normalizeJsonDeep(body, vars);
        })
        : [];
    const events = [];
    files.forEach(({ f }, i) => {
        // 事件行先 parse 再深度规范化：整行字符串替换吃不到 JSON 转义形式
        // 的路径（`C:\\tmp\\x` 里的双反斜杠），parse 后的原始字符串才能命中。
        // 解析不了的半行跳过（ch32 的崩溃尾巴是场景数据，修复行为由该章
        // 手写 verify 断言——快照锚不了字节层面非法的行）
        const lines = readFileSync(join(sessDir, f), "utf-8").split("\n").filter(Boolean)
            .map((line) => { try { return JSON.parse(line); } catch { return null; } })
            .filter((e) => e !== null)
            .map((e) => JSON.stringify(normalizeJsonDeep(e, vars)));
        events.push({ name: `session-${i + 1}.jsonl`, lines });
    });
    return { requests, events };
}

export function writeSnapshot(dir, payload, meta) {
    mkdirSync(dir, { recursive: true });
    const record = (name, lines) => writeFileSync(join(dir, name), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    record("requests.jsonl", payload.requests);
    // 事件流带文件名分组：每组首行是 {name}，其余是规范化事件（对象原样存）
    const eventLines = payload.events.flatMap((g) => [{ name: g.name }, ...g.lines.map((l) => JSON.parse(l))]);
    record("events.jsonl", eventLines);
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ ...meta, requests: payload.requests.length, eventGroups: payload.events.length }, null, 2) + "\n");
}

export function readSnapshot(dir) {
    const requests = readFileSync(join(dir, "requests.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const rawEvents = readFileSync(join(dir, "events.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const events = [];
    let current = null;
    for (const line of rawEvents) {
        if (typeof line.name === "string" && Object.keys(line).length === 1) {
            current = { name: line.name, lines: [] };
            events.push(current);
        } else {
            current.lines.push(JSON.stringify(line));
        }
    }
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
    return { requests, events, meta };
}

const clip = (s, n = 300) => (s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s);

/**
 * 逐字节 diff（规范化后）。返回 { ok, report }；report 收敛到首个差异，
 * 并给出差异计数——修快照时先看类型（新行为 or 规范化漏网）再决定。
 */
export function diffSnapshot(expected, actual) {
    const report = [];
    const cmp = (label, expLines, actLines) => {
        if (expLines.length !== actLines.length) {
            report.push(`${label}: line count ${expLines.length} (expected) != ${actLines.length} (actual)`);
        }
        const n = Math.min(expLines.length, actLines.length);
        for (let i = 0; i < n; i++) {
            if (expLines[i] !== actLines[i]) {
                report.push(`${label}: first diff at line ${i + 1}`);
                report.push(`  expected: ${clip(JSON.stringify(expLines[i]))}`);
                report.push(`  actual:   ${clip(JSON.stringify(actLines[i]))}`);
                break;
            }
        }
    };
    cmp("requests", expected.requests.map((r) => JSON.stringify(r)), actual.requests.map((r) => JSON.stringify(r)));
    if (report.length === 0) {
        const expEvents = expected.events.flatMap((g) => [g.name, ...g.lines]);
        const actEvents = actual.events.flatMap((g) => [g.name, ...g.lines]);
        cmp("events", expEvents, actEvents);
    }
    return { ok: report.length === 0, report };
}
