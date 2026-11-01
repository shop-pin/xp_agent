# SC1 探针（TDX 侧，一次性真机跑，产物进 my_src/fixtures/sc1/）：
# 每只票拉 TDX 日线（前复权）+ 原生周线/月线（同口径）——日线喂给 TS 侧重
# 采样器后与原生周/月对拍，差异只归因于重采样本身（复权方法学被隔离）。
# 运行：E:/xp_agent/mcp-tdx/.venv/Scripts/python.exe my_src/sc1-tdx-probe.py
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "mcp-tdx"))
from server.source import EltdxSource  # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "fixtures", "sc1")
CODES = ["sh600000", "sz000001", "sz300750"]


def bars(payload: dict) -> list:
    """TdxSource.kline → 精简 bar（OHLC+day 对拍锚；量额字段语义特殊只记不断言）。"""
    rows = payload.get("bars") or []
    out = []
    for r in rows:
        out.append({
            "day": str(r["time"])[:10],
            "open": float(r["open"]), "close": float(r["close"]),
            "high": float(r["high"]), "low": float(r["low"]),
            "volume": float(r.get("volume_raw", 0)),
            "amount": float(r.get("amount", 0)),
        })
    return out


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    src = EltdxSource()
    for code in CODES:
        day_raw = src.kline(code, period="day", count=500, adjust="front")
        week_raw = src.kline(code, period="week", count=110, adjust="front")
        month_raw = src.kline(code, period="month", count=30, adjust="front")
        path = os.path.join(OUT, f"tdx-{code}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"code": code, "adjust_mode": day_raw.get("adjust_mode"),
                       "dayFront": bars(day_raw), "weekFront": bars(week_raw),
                       "monthFront": bars(month_raw)}, f, ensure_ascii=False)
        nb = lambda p: len(p.get("bars") or [])  # noqa: E731
        print(f"{code}: day {nb(day_raw)} / week {nb(week_raw)} / month {nb(month_raw)}"
              f" (adjust={day_raw.get('adjust_mode')}) -> {path}")


if __name__ == "__main__":
    main()
