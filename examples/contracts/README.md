# 契约样例

这些文件用于审阅和验证补充设计，不是已经发布的游戏存档。

- [历史与撤销样例](history-and-undo.json)：7 个独立节点、6 份完整状态。S2 与 S2-copy 共享状态数据但不合并节点；S3 随机流不同；U1/U2 恢复世界进度但继续扣除当前撤销余量。
- [随机算法参考向量](pcg32-vector.json)：PCG32 初始化参数与六个预期输出，参考 [PCG 官方说明](https://www.pcg-random.org/using-pcg-c-basic.html)。
- [经典预设](../presets/classic.json)与[沙盒起步预设](../presets/sandbox.json)：与参数字典对应的基础规则草案。
- [JSON Schema](../../schemas/contracts-v1.schema.json)：严格校验 M1–M3 核心字段；高级事件、障碍和表达式另行版本化，不能视为已经支持。

样例关闭回合生成，方便直接核对 `[2,2,4,空] → [4,4,空,空] → [8,空,空,空]` 与分数 `0 → 4 → 12`。重抽分支可保持相同棋盘，但随机流与完整状态摘要不同。

验证入口为 [validate-design.mjs](../../scripts/validate-design.mjs)，依赖 Ajv2020。工程选型后可使用项目里的 ajv；当前可通过 `--ajv-path` 指定校验工具的绝对模块路径。

```text
node scripts/validate-design.mjs --ajv-path <Ajv2020模块的绝对路径>
```

检查范围包括结构、精确数值、摘要、引用、父子关系、撤销成本、随机规格向量和本地文档链接。真实引擎、事务、文件、离线和技能由独立应用测试验证，见 [M1 验收记录](../../docs/planning/M1_验收记录.md)、[M2 验收记录](../../docs/planning/M2_验收记录.md)和[M3 验收记录](../../docs/planning/M3_验收记录.md)。这些设计样例继续用于契约审阅；当前可导入的游戏文件见 [示例存档](../projects/README.md)。
