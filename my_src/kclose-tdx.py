# 盘后日K收口（2026-11-04 用户拍板：收盘后等满 15:01 再用 TDX 盘后数据选股；
# TDX 纯化路线图②）。职责：把当日 daily-k 的 sh/sz 行覆写为 eltdx 已收日K
# （官方收盘口径，qfq 与通达信同族），换手率用股本表自算——选股/digest 从此
# 吃真盘后数据，不再吃 15:00 快照。
# 降级面：eltdx 无目标日 bar（数据未就绪/停牌）的票保留快照行不动；脚本失败
# 不阻断收口链（选股退回快照口径，stderr 喊出声）。
# 用法：E:/xp_agent/mcp-tdx/.venv/Scripts/python.exe kclose-tdx.py --day 2026-11-04 [--workers 4]
# 注：--day 当日 15:01 前调用会等到 15:01（收盘链自动触发即此语义；手工盘后
# 调用不等）。
import json, os, sys, threading, time
from datetime import datetime, timedelta
from pathlib import Path

day_arg = None
workers = 4
if "--day" in sys.argv:
    day_arg = sys.argv[sys.argv.index("--day") + 1]
if "--workers" in sys.argv:
    workers = int(sys.argv[sys.argv.index("--workers") + 1])
if not day_arg:
    print("缺 --day YYYY-MM-DD")
    sys.exit(1)

# 15:01 闸（本机时区=中国时区；zoneinfo 在 Windows venv 缺 tzdata，用 naive 本地钟）
target = datetime.strptime(day_arg + " 15:01", "%Y-%m-%d %H:%M")
wait = (target - datetime.now()).total_seconds()
if 0 < wait <= 900:  # 收盘链刚翻 closed 就被调进来的场景：等满 15:01（上限 15 分钟）
    print(f"等待盘后数据就绪：{wait:.0f}s（15:01 闸）")
    time.sleep(wait)

data_root = Path.home() / ".mini-claude" / "stocks" / "data"
kfile = data_root / "daily-k" / f"{day_arg}.jsonl"
if not kfile.exists():
    print(f"无当日收口文件 {kfile}")
    sys.exit(1)
lines = kfile.read_text(encoding="utf-8").splitlines()
head = json.loads(lines[0])
rows = [json.loads(l) for l in lines[1:] if l.strip()]

# 股本表（换手率自算：to% = vol手×10000/流通股股）
shares = {}
shares_file = data_root / "shares.jsonl"
if shares_file.exists():
    for l in shares_file.read_text(encoding="utf-8").splitlines()[1:]:
        if l.strip():
            try:
                r = json.loads(l)
                shares[r["code"]] = r.get("floatShares")
            except Exception:
                pass

codes = [r["code"] for r in rows if r["code"].startswith(("sh", "sz"))]
print(f"盘后日K收口 {day_arg}：{len(codes)} 只 sh/sz 覆写（{workers} 路）…")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "mcp-tdx" / ".venv" / "Lib" / "site-packages"))
from eltdx import TdxClient  # noqa: E402
from eltdx.serialization import to_jsonable  # noqa: E402

updates = {}  # code -> eltdx 日K（已收目标日）
kept = []
lock = threading.Lock()
t0 = time.time()


def worker(client):
    while True:
        with lock:
            if not codes:
                return
            code = codes.pop(0)
        try:
            p = to_jsonable(client.bars.get(code, period="day", count=2, adjust="qfq"))
            bars = p.get("bars") or []
            if not bars:
                raise RuntimeError("空序列")
            last = bars[-1]
            if last["time"][:10] != day_arg:
                raise RuntimeError(f"末根 {last['time'][:10]} 未到目标日（未就绪/停牌）")
            prev_c = bars[-2]["close"] if len(bars) >= 2 else None
            updates[code] = {
                "o": round(last["open"], 4), "h": round(last["high"], 4),
                "l": round(last["low"], 4), "c": round(last["close"], 4),
                "vol": round(last["volume_lots"]), "amt": round(last["amount"]),
                "chg": round((last["close"] / prev_c - 1) * 100, 3) if prev_c else None,
            }
        except Exception as e:  # noqa: BLE001
            with lock:
                kept.append(f"{code}:{e}")


clients = []
for _ in range(workers):
    c = TdxClient(timeout=10.0, heartbeat_interval=None)
    c.connect()
    clients.append(c)
threads = [threading.Thread(target=worker, args=(c,)) for c in clients]
for t in threads:
    t.start()
for t in threads:
    t.join()
for c in clients:
    c.close()

# 覆写：sh/sz 用 eltdx 已收 bar（换手率有股本表则自算，否则保留原值）；bj/未就绪票原行不动
out = [lines[0]]
replaced = 0
for r in rows:
    u = updates.get(r["code"])
    if u:
        nr = dict(r)
        nr.update({k: v for k, v in u.items() if v is not None})
        fs = shares.get(r["code"])
        if fs and nr.get("vol"):
            nr["to"] = round(nr["vol"] * 10000 / fs, 5)
        out.append(json.dumps(nr, ensure_ascii=False))
        replaced += 1
    else:
        out.append(json.dumps(r, ensure_ascii=False))
kfile.write_text("\n".join(out) + "\n", encoding="utf-8")
print(f"完成：覆写 {replaced}/{len(rows)}，保留快照 {len(rows) - replaced}"
      f"（未就绪样例 {'; '.join(kept[:5]) if kept else '无'}），耗时 {time.time() - t0:.0f}s → {kfile}")
