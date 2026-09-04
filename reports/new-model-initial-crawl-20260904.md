# 新增型号首次抓取报告

本次按“品类与更新状态”实际数据与价格/历史差集重新识别范围，没有沿用上一轮全量刷新范围。

## 差集统计

- 品类状态去重型号：84
- 趋势图已有型号（`workbookHistory`）：34
- E 键弹窗现有可编辑型号：0（当前 E 弹窗仅保留标题，抓取状态已隐藏）
- 已完成初始化型号：78
- 最终目标 `C - A - B - alreadyInitialized`：6

目标型号均为品类状态中 `待更新` 且价格为空、未进入历史数据的记录：

| 品类 | 新增型号 | 原始来源 | 纳入原因 |
|---|---|---|---|
| SOC芯片 | NXP i.MX515 / `MCIMX515DVK8B` | DigiKey | 无价格、无有效更新时间、未进入趋势历史 |
| 塑料件 | Diagnostic tool carrying case / `Pelican 1200-000-110` | Google 供应商检索 | 无价格、无有效更新时间、未进入趋势历史 |
| 塑料件 | Front bezel / `Custom RFQ - LCD front bezel` | UL Prospector | 无价格、无有效更新时间、未进入趋势历史 |
| 塑料件 | Button/keypad assembly / `Custom RFQ - silicone keypad assembly` | UL Prospector | 无价格、无有效更新时间、未进入趋势历史 |
| 塑料件 | Connector dust cap / `Custom RFQ - connector dust cap` | UL Prospector | 无价格、无有效更新时间、未进入趋势历史 |
| 塑料件 | DIN-rail / mounting bracket / `UM108-DINRAIL` | DigiKey | 无价格、无有效更新时间、未进入趋势历史 |

## 实际执行结果

批次：`new-model-initial-20260904`

- 实际请求：6/6；遗漏：0；补跑：0
- success：1（NXP i.MX515，DigiKey API 403 后使用已配置 LCSC fallback，准确匹配并返回真实价格）
- unchanged：0
- not_found：1（Diagnostic tool carrying case，SunSirs 页面无对应价格记录）
- blocked：4（UL Prospector 3 个型号 HTTP 403 Blocked；DigiKey UM108 返回 Cloudflare “Just a moment” HTTP 403）
- parse_failed / validation_failed / timeout / source_unavailable / failed：0
- 成功写入价格：1；成功写入成功时间：1；进入趋势图数据源：1
- 旧趋势型号意外处理：0；E 弹窗旧型号意外处理：0

NXP 成功响应为真实 LCSC fallback 价格，来源链接为 `https://www.lcsc.com/product-detail/C6666559.html`；Next 开发服务器因没有 Cloudflare KV 上下文，写缓存时曾返回 500，因此最终写入验证以 Cloudflare Worker 本地预览为准。Worker 预览中该请求返回 HTTP 200，并完成 KV 写入路径；其余失败记录均未写入价格或成功时间。

项目已有的 E 键抓取状态隐藏、失败保留旧成功时间、单来源独立容错改动保持不变。本次未 Commit、Push 或 Deploy。
