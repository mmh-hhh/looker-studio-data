---
name: looker-studio-data
description: Looker Studio 数据下载 skill。用户只需提供一个 Looker Studio/Data Studio 网页链接，agent 就会复用用户本人 Google 登录态，列出可选报表与筛选项，并按用户确认的条件导出一次性或重复使用的 CSV。适用于日报下载、批量取数和远程服务器定时抓取；不用于绕过访问权限、验证码、二次验证或报表所有者关闭的下载权限。
license: Internal
metadata:
  scope: portable
  version: 0.5.0
  author: Codex
  compatibility: [codex, claude-code, hermes, cursor, opencode]
  tags: [looker-studio, data-studio, google-login, csv, report-export]
  canonical_name: looker-studio-data
  runtime_entry: looker-studio-data
  aliases: [looker-studio, data-studio-data]
  source_of_truth: repository-root
  references:
    - references/remote-runtime.md
    - references/protocol.md
---

# Looker Studio 数据下载

## 用户只需要做什么

发送一个自己有权访问的 Looker Studio 网页链接。需要重新登录时，在 agent 打开的安全浏览器窗口中由本人完成登录。

`https://datastudio.google.com/reporting/.../page/...`

`https://lookerstudio.google.com/reporting/.../page/...`

用户不需要准备命令、Cookie、登录态文件或组件 ID，也不需要使用指定浏览器或操作系统。

## Agent 必须交付的结果

1. 自动复用或建立用户本人的 Google 登录状态；
2. 深度理解页面中每张报表及筛选项的业务含义；
3. 用浅显中文列出可下载内容，让用户只选择看得懂的选项；
4. 按确认的报表、日期和筛选条件下载 CSV；
5. 检查权限、筛选、行数和文件完整性；
6. 重复需求验证两次后，才交付可定时运行的方案。

## 结果导向原则

- 自动适配 macOS、Windows 和 Linux。已有 Chrome 时优先使用这条已验证路径；没有 Chrome 再自动选择 Edge 或 Chromium。用户平时使用 Safari、Firefox 或其他浏览器也不影响。
- 只保留一个外部运行依赖 Playwright；已有 AI 运行环境能够提供时直接复用。缺少运行条件时由 agent 处理，不把安装步骤推给业务用户。
- 不写死登录、取数或保存路径。agent 根据本机、远程服务器、一次性或重复任务选择最短可验证方案。
- skill 真源只保存代码和说明，禁止保存任何用户的登录状态、Cookie、浏览器 profile、账号信息、抓取目录、配方或 CSV。所有运行数据必须放在 skill 目录之外的用户私有目录；`security-audit` 和 `self-test` 发现混入时必须失败。
- 默认只使用用户已经能打开的 Looker Studio 页面及其允许的下载能力，不假设用户拥有 BigQuery、Google Cloud 或原始数据源权限。
- 不获取他人凭证，不绕过权限、验证码或二次验证，不下载被所有者禁止的数据。

## 先理解，再让用户选择

结合页面标题、图表标题、字段、筛选名称、默认值和少量数据样例，判断每张报表在回答什么业务问题。每项选择至少包含：

- 自然的中文名称；
- 一句话说明“这张表能看什么”；
- 主要指标的中文含义；
- 可用筛选及选择后的影响。

优先沿用页面已有中文。英文、代码或缩写只有找到可靠对应关系后才能翻译，不能猜。不要把接口名、数据源 ID、组件 ID、字段代码、英文状态或意义不明的值交给用户选择。

推荐展示：`1. 每日订单表现——查看每天的订单量和成交金额，可按日期、国家和商户筛选。`

仍无法解释的内容要直说“原报表只显示内部代码，暂时无法安全解释”，继续寻找上下文，不能让用户盲选。

## 已知坑必须主动规避

| 已遇到的问题 | 必须采用的防护 |
|---|---|
| 从旧 Overview 页登录被 Google 拒绝 | 登录只从 `https://datastudio.google.com/` 开始 |
| 用户没有 Chrome 或使用 Windows | 有 Chrome 优先 Chrome；否则自动选择 Edge 或 Chromium，不要求改变日常浏览器 |
| 登录态复制到另一台机器后失效 | 目标机器重新验证；长期任务优先复用同机专用状态 |
| 登录过期或出现安全挑战 | 立即停止并用白话通知本人重新登录，不自动处理密码、MFA 或验证码 |
| 页面请求成功，普通接口回放却返回 400 | 一次性任务先使用页面原生成功响应；若全量分页仍被拒绝，使用图表“导出数据 → CSV”并核对行数。未验证前不宣称可以定时 |
| 透视表同时返回空壳、明细和汇总 | 只选有实际明细的主数据，不能把最后一个响应当结果 |
| 筛选列表采用虚拟滚动或只返回部分值 | 未证明完整时明确标记为预览，不伪装成全部选项 |
| 日期或筛选表达式无法识别 | 通过页面语义控件重新捕获，不猜内部表达式 |
| 所有者关闭下载 | 停止下载，用白话说明原因 |
| 行数少于接口总数或只有页面可见行 | 不交付部分文件，不用截图或页面文字冒充完整数据 |
| 每次重复取数都刷新页面目录 | 仅新链接、结构变化、换报表/筛选或完整性失败时刷新 |
| 同一登录状态被并发使用 | 串行运行，避免状态锁定或损坏 |
| 默认建议 BigQuery | 只有用户明确拥有原始数据源权限时才讨论替代接口 |

技术命令不面向业务用户。agent 按需使用运行脚本；跨平台运行见 [远程运行说明](references/remote-runtime.md)，接口与完整性细节见 [取数协议](references/protocol.md)。

## 真源

此仓库根目录是唯一可编辑真源。分发到 Codex、Claude Code 或其他 agent 的副本应通过安装或软链接复用该目录，不维护第二份实现代码。
