# 路径统计报告示例

这些文件来自 M5 隔离浏览器测试，格式为 2048-sandbox-path-statistics / formatVersion=1。它们供查看和外部分析；游戏恢复文件位于 [projects](../projects/README.md)。

| 文件 | 内容 |
|---|---|
| [m5-path-statistics.json](m5-path-statistics.json) | 根→移动→移动→撤销，共 4 节点，成绩 0→4→12→4，路径最高 12，最大数字 8 |
| [m5-large-statistics.json](m5-large-statistics.json) | 根与 300 次往返移动，共 301 节点；完整报告保留全部行，图表只抽样显示 |

精确成绩和数字均为十进制字符串。报告包含真实演示节点 ID、规则引用和状态摘要，不含用户个人对局。口径见 [M5 操作说明](../../docs/design/交互与统计_M5.md)，验证见 [M5 验收记录](../../docs/planning/M5_验收记录.md)。
