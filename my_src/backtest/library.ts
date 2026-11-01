// backtest/library.ts——SC3：公式库装载器（编译 + 指标依赖解析 + 装卸）。
//
// 库形态：内置（product 层）+ 用户覆盖（SC4 接 screeners.json）。本模块只管
// "定义 → 可执行库"的编译与解析：
//   ① 指标公式逐条编译（坏定义 fail-fast 抛 FormulaError——内置库是产品
//      bug，不静默跳过；用户覆盖层的按条拒装在 SC4 配置面做）
//   ② 选股公式编译期拿到 "指标ID.输出名" 集合做静态检查
//   ③ 逐票求值：先跑指标收集产出（复合键），再跑选股公式（装卸开关在
//      enabled=false 的条目上跳过求值但仍保留注册信息）
//
// 输出名冲突天然隔离：指标产出以 "ID.OUT" 复合键注册（两个指标同名输出
// 不互相污染）；选股公式引用未注册的指标名 = 编译期 FormulaError。

import { loadFormula, runFormula, type CompiledFormula, type Val, FormulaError } from "./formula.js";
import type { Series, Cond } from "./indicators.js";
import type { ScreenerDef, IndicatorDef } from "./formulas/builtin.js";

export interface CompiledIndicator {
    def: IndicatorDef;
    compiled: CompiledFormula;
}

export interface CompiledScreener {
    def: ScreenerDef;
    compiled: CompiledFormula;
}

export class FormulaLibrary {
    private constructor(
        readonly indicators: CompiledIndicator[],
        readonly screeners: CompiledScreener[],
        private readonly indicatorNames: Set<string>,
    ) {}

    /** 从定义构建（内置或用户合并后）——任何坏定义 fail-fast。 */
    static build(indicatorDefs: readonly IndicatorDef[], screenerDefs: readonly ScreenerDef[]): FormulaLibrary {
        const indicators: CompiledIndicator[] = [];
        const indicatorNames = new Set<string>();
        for (const def of indicatorDefs) {
            const compiled = loadFormula(def.formula, { params: def.params });
            for (const out of compiled.outputs) indicatorNames.add(`${def.id.toUpperCase()}.${out.toUpperCase()}`);
            indicators.push({ def, compiled });
        }
        const placeholder = new Map<string, Val>([...indicatorNames].map((n) => [n, []]));
        const screeners: CompiledScreener[] = screenerDefs.map((def) => ({
            def,
            compiled: loadFormula(def.formula, { params: def.params, requireXg: true, indicators: placeholder }),
        }));
        return new FormulaLibrary(indicators, screeners, indicatorNames);
    }

    /** 指标是否在库内（选股公式静态引用检查用——SC4 配置面校验）。 */
    hasIndicator(name: string): boolean {
        return this.indicatorNames.has(name.toUpperCase());
    }

    /** 逐票求值指标层：产出复合键（"ID.输出名" → 序列/条件）。 */
    runIndicatorValues(base: Record<string, Series>): Map<string, Val> {
        const produced = new Map<string, Val>();
        for (const ind of this.indicators) {
            const out = runFormula(ind.compiled, base);
            for (const [name, val] of out.values) {
                if (ind.compiled.outputs.includes(name)) {
                    produced.set(`${ind.def.id.toUpperCase()}.${name}`, val);
                }
            }
        }
        return produced;
    }

    /** 逐票求值：指标先行（产出复合键注入），选股公式按装卸开关参跑。
     *  命中 = 目标日（最后一根 bar）XG 为真——调用侧负责把序列截到目标日
     *  （曾用 some(Boolean)：窗口内历史真值也会算命中，选股语义下是错的）。 */
    runStock(base: Record<string, Series>): Map<string, Cond> {
        const produced = this.runIndicatorValues(base);
        const result = new Map<string, Cond>();
        for (const sc of this.screeners) {
            if (!sc.def.enabled) continue; // 装卸：注册不参跑
            const out = runFormula(sc.compiled, base, produced);
            if (out.xg && out.xg[out.xg.length - 1] === true) result.set(sc.def.id, out.xg);
        }
        return result;
    }
}

export { FormulaError };
