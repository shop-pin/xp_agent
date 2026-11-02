# hist-k 缓存 TDX 源全量刷新（通达信同源对齐轮，2026-11-02）。
# 背景：腾讯源两个实锤问题——①科创板量=股（主板=手）单位混杂；②限频 501。
# eltdx bars.get：volume_lots=手（原生正确）、amount=真实成交额、adjust=qfq
# 与通达信同族。缓存格式与 my_src/backtest/kline.ts 的 writeKlineCache 一致。
# 用法：E:/xp_agent/mcp-tdx/.venv/Scripts/python.exe hist-refresh-tdx.py [--limit 800] [--workers 4]
import json, os, sys, threading, time
from pathlib import Path

limit = 800
workers = 4
if "--limit" in sys.argv: limit = int(sys.argv[sys.argv.index("--limit") + 1])
if "--workers" in sys.argv: workers = int(sys.argv[sys.argv.index("--workers") + 1])

data_root = Path.home() / ".mini-claude" / "stocks" / "data"
hdir = data_root / "hist-k"
kdir = data_root / "daily-k"

# 代码清单 = hist-k 已有 ∪ daily-k 最新收口的 sh/sz（覆盖新股）
codes = {f[:-6] for f in os.listdir(hdir) if f.startswith(("sh", "sz")) and f.endswith(".jsonl")}
kdays = sorted(f for f in os.listdir(kdir) if f[:2] in ("19", "20") and len(f) == 14)
if kdays:
    latest = kdir / kdays[-1]
    for line in latest.read_text(encoding="utf-8").splitlines():
        if not line.strip(): continue
        try:
            c = json.loads(line).get("code", "")
            if c.startswith(("sh", "sz")): codes.add(c)
        except Exception: pass
codes = sorted(codes)
print(f"刷新 {len(codes)} 只 × {limit} 根（TDX 同源，{workers} 路）…")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "mcp-tdx" / ".venv" / "Lib" / "site-packages"))
from eltdx import TdxClient  # noqa: E402
from eltdx.serialization import to_jsonable  # noqa: E402

ok = fail = 0
fails = []
lock = threading.Lock()
t0 = time.time()

def worker(client):
    global ok, fail
    while True:
        with lock:
            if not codes: return
            code = codes.pop(0)
        try:
            p = to_jsonable(client.bars.get(code, period="day", count=limit, adjust="qfq"))
            bars = p.get("bars") or []
            if not bars: raise RuntimeError("空序列")
            rows = []
            for b in bars:
                rows.append(json.dumps({
                    "day": b["time"][:10], "open": round(b["open"], 4), "close": round(b["close"], 4),
                    "high": round(b["high"], 4), "low": round(b["low"], 4),
                    "volume": round(b["volume_lots"]), "amount": round(b["amount"]),
                }))
            head = json.dumps({"v": 1, "schema": "backtest.hist-k", "code": code, "count": len(rows)})
            (hdir / f"{code}.jsonl").write_text("\n".join([head] + rows) + "\n", encoding="utf-8")
            with lock:
                ok += 1
                if (ok % 500) == 0: print(f"  … {ok} 只（{time.time()-t0:.0f}s）")
        except Exception as e:
            with lock:
                fail += 1
                fails.append(f"{code}:{e}")

clients = []
for i in range(workers):
    c = TdxClient(timeout=10.0, heartbeat_interval=None)
    c.connect()
    clients.append(c)
threads = [threading.Thread(target=worker, args=(c,)) for c in clients]
for t in threads: t.start()
for t in threads: t.join()
for c in clients: c.close()
print(f"完成：ok {ok} / fail {fail}，耗时 {time.time()-t0:.0f}s")
if fails[:20]: print("失败样例：", "; ".join(fails[:20]))
