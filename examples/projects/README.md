# 可导入的演示存档

这些文件来自 M2–M4 的隔离浏览器测试，只包含演示对局。与 ../contracts/ 的设计样例不同，它们可直接在实际游戏的“文件与恢复”中导入。

| 文件 | 内容 |
|---|---|
| [m2-library-demo.2048backup](m2-library-demo.2048backup) | 两局、7 个节点、7 份状态、1 个检查点，包含增量快照 |
| [m2-path-demo.2048lab](m2-path-demo.2048lab) | 一条根到第 6 步的路径，共 7 个节点，来自有分支的源对局 |
| [m1-legacy-demo.json](m1-legacy-demo.json) | 旧 M1 JSON 结构，演示兼容迁移与独立副本导入 |
| [m3-mixed-demo.2048backup](m3-mixed-demo.2048backup) | 经典与 3×5 自定义两局，共 5 节点/5 状态，含洗牌、撤销和 2 份增量 |
| [m3-rules.json](m3-rules.json) | 2×4 自定义规则，固定初始布局、零回合生成与撤销 3 次，导入后新开一局 |
| [m4-advanced-demo.2048backup](m4-advanced-demo.2048backup) | 1×5 映射合并、加权位置、条件阶段、事件加成绩和变量计数；2 节点/2 状态 |
| [m4-mixed-versions-demo.2048backup](m4-mixed-versions-demo.2048backup) | 经典起点→派生自定义棋盘编辑→扩展为 4×5→移动；4 节点/4 状态、3 个规则版本 |
| [m4-advanced-rules.json](m4-advanced-rules.json) | 可新开的高级规则：2+4→16，首回合在格 4 生成 7，回合事件加 10 分并累计 moves |

存档每次导入均创建副本；可以重复导入检查项目隔离、节点 ID 和状态摘要保持不变。规则 JSON 用于创建新的根节点。导入后可继续游玩，再导出整库备份。

M2 两份 ZIP 文件已使用 Python 标准库独立解压，CRC、清单条目数、解压字节数和 SHA-256 全部通过。正式说明见 [存档格式 v1](../../docs/design/存档格式_v1.md)和[M2 验收记录](../../docs/planning/M2_验收记录.md)。

M3 混合备份同样通过独立 ZIP 校验；其增量经 Python 重建后，全部完整状态摘要一致，规则 JSON 的定义摘要也一致。操作与证据见 [基础沙盒 M3](../../docs/design/基础沙盒_M3.md)和[M3 验收记录](../../docs/planning/M3_验收记录.md)。

M4 两份 ZIP 已独立验证 CRC、条目 SHA-256、增量还原和所有规则定义摘要；实际应用也验证逐节点回放和导入继续。多版本示例保留每个节点的原 ruleRef，旧经典起点仍可查看和继续。语义与证据见 [高级沙盒 M4](../../docs/design/高级沙盒_M4.md)和[M4 验收记录](../../docs/planning/M4_验收记录.md)。
