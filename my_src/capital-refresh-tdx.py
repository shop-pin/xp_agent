# 流通股本表 TDX 源全量刷新（2026-11-04 数据源审计后 TDX 纯化第一步）。
# 源：eltdx corporate.finance_batch（流通股本/总股本，单位=股，float32 尾差可忽略）。
# 消费：backtest/screener-run.ts 读 <dataRoot>/shares.jsonl → baseFromBars 注入
# CAPITAL（手=股/100）——TDX 收盘日 daily-k 无换手率（to=0）时 HSL/FINANCE 闸
# 不再依赖反推（11-03 事故根治，挂机兜底退役的前置件）。
# 用法：E:/xp_agent/mcp-tdx/.venv/Scripts/python.exe capital-refresh-tdx.py [--workers 4]
import json, os, sys, threading, time
from pathlib import Path

workers = 4
if "--workers" in sys.argv:
    workers = int(sys.argv[sys.argv.index("--workers") + 1])

data_root = Path.home() / ".mini-claude" / "stocks" / "data"
kdir = data_root / "daily-k"

# 代码清单 = daily-k 最新收口的 sh/sz（"YYYY-MM-DD.jsonl"=16 字符）
codes = set()
kdays = sorted(f for f in os.listdir(kdir) if f[:2] in ("19", "20") and len(f) == 16)
if not kdays:
    print("无 daily-k 收口——先跑盯盘会话收口")
    sys.exit(1)
for line in (kdir / kdays[-1]).read_text(encoding="utf-8").splitlines():
    if not line.strip():
        continue
    try:
        c = json.loads(line).get("code", "")
        if c.startswith(("sh", "sz")):
            codes.add(c)
    except Exception:
        pass
codes = sorted(codes)
print(f"刷新股本表 {len(codes)} 只（TDX finance_batch，{workers} 路）…")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "mcp-tdx" / ".venv" / "Lib" / "site-packages"))
from eltdx import TdxClient  # noqa: E402
from eltdx.serialization import to_jsonable  # noqa: E402

CHUNK = 100  # finance_batch 服务端单次实测截到 ~100 只——超了静默丢，必须小批
results = {}
fails = []
lock = threading.Lock()
t0 = time.time()


def worker(client):
    while True:
        with lock:
            if not codes:
                return
            chunk = codes[:CHUNK]
            del codes[:CHUNK]
        try:
            batch = to_jsonable(client.corporate.finance_batch(
                chunk, fields=["circulating_shares", "total_shares"]))
            rows = {}
            for rec in batch:
                fs = rec.get("circulating_shares")
                ts = rec.get("total_shares")
                if not fs or fs <= 0:
                    raise RuntimeError(f"流通股本缺失：{rec.get('full_code')}")
                rows[rec["full_code"]] = {
                    "floatShares": round(fs),
                    "totalShares": round(ts) if ts else None,
                }
            short = [c for c in chunk if c not in rows]
            with lock:
                results.update(rows)
                if short:
                    fails.extend(short)
                    print(f"  短回 {len(short)} 只（请求 {len(chunk)} 回 {len(rows)}）")
        except Exception as e:  # noqa: BLE001
            with lock:
                fails.extend(chunk)
                print(f"  失败 {len(chunk)} 只：{e}")


threads = [threading.Thread(target=worker, args=(TdxClient(),)) for _ in range(workers)]
for t in threads:
    t.start()
for t in threads:
    t.join()

day = kdays[-1][:10]  # 最新收口日——股本表对应的宇宙就是它
rows = [{"code": k, **v} for k, v in sorted(results.items())]
header = {"v": 1, "schema": "stocks.shares", "day": day,
          "writtenAt": int(time.time() * 1000), "count": len(rows)}
out = data_root / "shares.jsonl"
out.write_text(
    "\n".join([json.dumps(header, ensure_ascii=False)] + [json.dumps(r, ensure_ascii=False) for r in rows]) + "\n",
    encoding="utf-8")
print(f"完成：{len(rows)} 只 / 失败 {len(fails)} → {out}（{time.time() - t0:.0f}s）")
if fails:
    print(f"失败清单前 10：{fails[:10]}")
