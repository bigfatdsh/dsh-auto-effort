# dsh-auto-effort — 推理等级 auto

**每一轮请求在发出去之前判一次"这次要花多少推理"，落成该模型真正支持的 effort id，
写进这次调用。** 简单问候不再按默认档烧思考 token；难任务自动升到高档；工具结果回灌的
续跑请求一个字都不动。判定是纯规则：**0 额外 token、0 额外往返**。

**自动是模型选择器里的一个档位**：点开模型 → 推理等级，列表里除了 `Off / Low / High / Max`
还多一条 **Auto**。选它，这一轮的推理强度就由本插件按任务轻重决定；选手选具体档位则照旧。

> 早期版本曾在输入栏放一枚「自动」胶囊，现已移除：同一个开关有两个入口只会互相打架
> （菜单里选了 Auto、胶囊显示"关闭"时，谁说了算需要用户去猜）。现在只有一个入口——菜单。
> 插件本身仍可被完全关掉：把 bundle 补丁里的 `enabled` 改成 `false`，或把 `mode` 改成 `off`。

本机 profile 把全局默认钉在 `reasoningEffort: max` 上，所以"自动"的实际效果是：
轻任务从 `max` 降到 `off`/`low`，重任务照旧 `high`/`max`。

---

## 1. 它为什么必须在"请求发出之前"做

推理强度是**请求头**的一部分：它决定服务端开不开思考、思考多深。一旦请求发出去，
这一轮的强度就定了——所以"让模型自己在需要时多想"只能由请求这一侧决定。判定读的
正是这次要发出去的消息数组，因此不需要再调一次模型来"猜难度"。

## 2. 判定规则（`lib/classify.js`）

输入是消息数组与工具表大小，输出一个档位：`off` / `low` / `high` / `max`。

- **信号加权**：动手做事（`帮我…`、`写一个…`、`把 X 转成 Y`）、报错/崩溃、
  代码与路径、URL、代码块、多步骤（第一步/其次/最后）、高要求（必须/全部/零错误）、
  审查类（架构/安全/性能/根因）、长度（词数分档）、尾部工具错误、工具表规模。
- **下界信号**（出现即"至少这么重"）：报错、交付物（Word/PPT/报告/表格）、多步骤、
  高要求、审查类、连续工具错误。
- **`off` 闸门**：任何"要求动手做事"的信号都会阻止降到 `off`；整条消息就是一句问候
  时才收敛到 `off`（"在吗？"带问号也不算提问）。
- **续跑不判定**：末尾是工具结果或助手发言时不给档位，原样放行，让一次任务里的推理
  强度保持一致（也避免 provider 侧前缀失效）。
- **尾部工具错误跨回执生效**：用户说"还是不行"时，证据在**上一句**附近——往前看 10 条，
  1 条错误 +1 分，≥2 条错误直接抬到 `high`。

判定只扫消息的开头 8k / 结尾 600 字符：信号都出现在这两处，成本恒定。

## 3. 档位 → effort（`clampEffort`）

1. **模型声明了什么就用什么**：不认识的 id 一律不猜。
2. **目标档位不存在时取档位距离最近的**（例如只有 `off/low` 的模型需要 `high` → `low`），
   平手取更强的那个。
3. **用户显式选过的强度默认不被降**：请求上带 `reasoningEffort` 只可能来自用户在模型
   选择器里的选择——模型自己的默认档由 provider 在解析请求时补齐，不出现在请求对象上。
   要让自动判定完全接管（连手选的强度也照降），把 `effortFloor` 配成 `off`。
4. `effortCeiling` 默认**不存在**：判定需要 `max` 就是 `max`。

## 4. Auto 档位是怎么接进选择器的

选择器的推理等级列表就是宿主 `llm.resolveModelInfo()` 的返回，所以插件在服务层包了两个
方法（只在模型**本来就有**推理能力时生效）：

1. **`resolveModelInfo`**：往 `reasoning.efforts` 末尾追加 `{ id: 'auto', name: 'Auto' }`。
   只影响展示与选择，不改任何模型能力。
2. **`prepareCall`**：宿主装配请求时会拿这份配置去适配器校验，而适配器不认识 `auto`，
   所以先摘掉它再往下传；真正的强度由 `llm/stream` 上的判定算出来写回去
   （那一刻已经在适配器校验之后）。

面板外的三个运行档仍然可用，只是入口变成配置：`mode: auto | pin | off`。

诊断：`GET /dsh-auto-effort?catalog=provider/model` 回报**经过本插件之后**那条路由的推理
等级列表——"Auto 没出现在菜单里"时用它确认，不用猜。

## 5. 行为边界（改了什么、没改什么）

只做一件事：给这次调用写 `reasoningEffort`。**不改**消息、系统提示、工具表、采样参数；
不注册工具；不加模型调用；不写会话历史（`adapterDefaults.reasoningEffort` 为真时该值
不进 canonical header，所以也不会记为 request header 变更）。

失败一律原样放行并记日志：模型元数据取不到、effort 一个都不认识、消息读不动——
最坏情况退化成"不装这个插件"，不会让请求失败或让模型收到非法值。

## 6. 配置（`cordis.patch.yml` 或 profile 补丁）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `auto` | `auto`（判定接管，含手选值）/ `pin`（只在没手选时判定）/ `off`（完全不碰）。 |
| `enabled` | `true` | 是否启用。`false` 等价于 `mode: off`。 |
| `effortId` / `effortName` | `auto` / `Auto` | 出现在选择器里的档位 id 与显示名。 |
| `autoDefault` | `false` | 置 `true` 时把 Auto 设成模型默认档（新会话默认就是自动）。 |
| `persist` | `true` | 档位写到 `<DSH_HOME>/auto-effort.json`，重启后保持。 |
| `minTier` / `maxTier` | `off` / `max` | 判定的人为上下限。 |
| `effortFloor` | `off` | `off`（不设下界）/ `observed`（保护手选值）/ `adapter-default`（不低于模型默认档）/ 具体档位。 |
| `effortCeiling` | `max` | `max`（不设上限）/ `adapter-default` / 具体档位。 |
| `log` | `true` | 每次判定打一行 info：`applied/unchanged/continuation/auxiliary … tier=… effort=… score=… why=…`。 |

## 7. 自检

```bash
node --test test/classify.test.js test/request.test.js test/plugin.test.js test/client.test.js
node tools/verify-host-wiring.mjs     # 真实 llm/stream 瀑布形状下：改了什么、谁收到
node tools/verify-client-bundle.mjs   # 浏览器半边能不能被宿主组合器收下
```

`tools/verify-host-wiring.mjs` 值得单独说一句：它按 Cordis 的瀑布语义（冻结的
`options`、`next()` 收尾、异步迭代器）真的派发一次请求，断言"重任务 → 适配器收到
`high/max`、问候 → `off`、续跑 → 原值不动、查询失败 → 原样放行、关闭档 → 完全不碰"。
客户端的装配失败不会让宿主启动失败，只在浏览器里炸，所以
`tools/verify-client-bundle.mjs` 把 `dsh.client` 声明、`exports["./client"]`、
bundle 里注册的模块 id、`apply` 注册的插槽逐条对一遍。

## 8. 已知取舍

- **换档会让 provider 侧前缀部分失效一次**：推理强度是请求头的一部分，改动它的那一次
  请求无法复用旧前缀。所以判定只在**用户消息**上做，续跑不重复改；一轮一次。
- **判定是规则，不是模型**：它看不懂暗示。因此每个档位都留了退路——看不懂就停在中间
  档（`low`/`high`），不倒向两极；要动手的活永不判 `off`。
- **同一轮里工具调用很多**：强度由这一轮的第一条用户消息决定，中途不变。这是刻意的：
  任务中途改口径可能让已经开始的推理白费。
