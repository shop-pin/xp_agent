// S6 单测：裁决技能的发货守门——verdict 契约条款钉在模板上
// （action 四值枚举、confidence 保守上限、真假摔条款、token 纪律）。
// 改模板的人放松了契约，先红这里。裁决质量本身是手测面（真 LLM）。
// 运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../cordis/context.js'
import { skillsPlugin } from '../plugins/skills-registry.js'

test('product 技能层随产品发货 adjudicate，verdict 契约条款完整', () => {
    const ctx = new Context()
    ctx.plugin(skillsPlugin, { productSkills: true })
    const skill = ctx.skills!.getByName('adjudicate')
    assert.ok(skill, 'adjudicate 应随 my_src/skills/ 发货')
    assert.equal(skill!.source, 'product')
    assert.equal(skill!.context, 'inline', '裁决走 inline（fork+插件工具白名单是已知缺口，章内记档）')
    const t = skill!.promptTemplate
    for (const clause of [
        '只允许四值',                     // 枚举克制：无 buy/sell 指令
        'watch', 'buy-candidate', 'avoid', 'no-opinion',
        '无消息佐证 ≤0.4',               // confidence 保守阶梯
        '消息矛盾 ≤0.3',
        '不超过 0.8',
        '真假摔',                        // 矛盾判别条款
        '两次 news 调用',                // token 纪律
        '非投资建议',
    ]) {
        assert.ok(t.includes(clause), `契约条款「${clause}」应在模板中`)
    }
    assert.deepEqual(skill!.allowedTools, ['get_signals', 'latest_news'])
})
