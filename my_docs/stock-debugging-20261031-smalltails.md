# 小尾巴清理轮：挂账 #4/#5/#6/#11（2026-10-31 傍晚档）

四件修补一次清完，外加一个意外收获。单件都很小，但 #11 的加固过程抓获了一个被静默吞掉多日的真 bug——本轮最有价值的部分。

## 各件修法

**#5 record 尾行判定**：runner 的 ok 判定原来不认 ⚑（录制成功旗标），`--record` 恒红、进不了 `&&` 链。修为 record 模式认 ⚑（录制完成即目标达成，verify 红基线的非零退出不追究）、replay 模式判定不变。"重录后必须 replay 验证"的纪律保留（好习惯），"不能进 && 链"的坑消除。

**#6 host HEAD**：`serveStatic` 加 `headOnly` 参数——HEAD 头照发（content-type 等）body 不写；404/403 分支同样静默 body。此前 HEAD 落 API 404，监控探针/健康检查类客户端会误判服务不可用。

**#4 ch34 真网络**：挂账原文的场景号有笔误（29 → 现为 ch34）。stockProbe 用 `profile: "stock"` 整树装配，news-feed 行无 config = 真新浪源起轮询。修：extraRows 加 news mock 行覆盖（同 id 后写胜，与 market 行同款手法）——探针网络零依赖纪律补齐最后一角。

**#11 探针加固（三处治本）**：
1. `probeFetchGate(source)`：包裹 mock source 的调用计数，轮询等首轮 refresh 落定（2s 超时显式抛错）——替换全部 8 处裸 `setTimeout(50)` 竞速窗（含 watchProbe 里变量名 res 漏网的第 8 处）。偶发"0 requests"红的根子拔了。
2. crash 退出码收紧：`crashed → exit 1`，不再被"verify 绿"吃掉；runner 的 spawnSync stderr 从 inherit 改 pipe，失败时把 stderr 尾巴带进输出行（"0 requests"类失败终于可断因）。
3. **意外收获**：收紧后 ch41 立刻暴露 `run crashed: watch is not defined`——watchProbe 的 `const watch` 声明在 try 块内，finally 的 `watch.stop()` 每次成功路径都 ReferenceError，被"crash 但 exit 0"静默吞了数日（verify 全绿 + 快照字节一致，谁也看不出少跑了一次 stop）。声明提 try 外 + `watch?.stop()` 根治；ch41 因 close 流程完整化多一行 session 事件，重录。

## 教训记档

**"crash 但退出 0"是最危险的静默吞模式**——错误被 catch 记了日志（run crashed 行有打印），但退出码说谎，一切自动化判定（runner/CI/人眼扫日志）都放行。本例里 crash 点在 finally（清理路径），恰是"最不该崩的地方崩了"的典型。抓这类 bug 的手段不是加日志，是**收紧退出码语义**——让错误无处遁形。

## 回归基线

mock 28 章全绿（ch20 crash 场景不受收紧影响——它断言的就是"不 crash"）、cordis 307/307、snapshot 40/40（ch41 重录）。

## 建议 commit

```
harden snapshot probes with deterministic waits and honest exit codes
```
