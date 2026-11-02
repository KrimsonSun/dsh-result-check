# dsh-result-check

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：在一个回合结束前，把智能体的最终回答和工具实际返回的结果对一遍。
两者对不上时，让模型再走一步，并附一段简短说明，告诉它要改什么。

一共两项检查，都是普通代码，不额外调用模型：

| 检查 | 什么时候触发 | 例子 |
|---|---|---|
| **工具失败没报告** | 某次工具调用失败了，本回合之后没有任何调用成功，回答里也没提到任何失败 | `web_fetch` 返回 HTTP 503，回答照样总结了网页内容 |
| **数字找不到出处** | 回答里写的数字，按它写出的精度，在本次会话的工具输出、工具参数和用户消息里都找不到，用附近的数字做一步运算也得不到 | 工具报告 `AC: DDX41 392 / WT 258`，回答的表格却写 `469 / 181` |

检查触发时，模型会再走一步，收到类似这样的说明：

```text
[result-check] Before you finish, check your answer against this session's tool output. ...

These numbers in your answer appear in no tool output, tool argument or user message of this
session: 469, 181.
For each one, say which output it comes from or how you derived it, or correct it. Do not change
a number that is right.

Then give your final answer again.
```

对话里会显示一行提示，例如 `Result check: 2 unsourced numbers`。

## 为什么做这个

这个插件来自 [AiScientist](https://github.com/RCHENLAB/AiScientist)，一个分析生物医学数据的研究智能体。
在那里，靠提示词叫模型别报错结果并不可靠，用代码检查回答才管用：

- 某一步的回答把两组的细胞数写反了，还编出一组没有任何工具算过的分组数字。负责评审的模型照样以 0.95 的置信度通过了。
  现在由代码拦下数字和自己工具结果相矛盾的回答。
- 工具失败了就必须如实报告失败，不能写成成功。

这个插件把这两条规则做成通用形式，任何 dsh 智能体都能用。

## 适合用在哪

最适合工具产出数据、回答汇报数据的智能体：数据分析、跑分测试、运行监控、基于工具输出的调研。
这类场景里，写错或编造的数字才是关键错误，而且回答里的数字大多直接来自工具。

用在通用编程助手上，它大多数时候不出声（约 50 个回合打回 1 次，见下文），但能抓到的也更少：
那类回答里有大量估算、常识和多步推算，检查只能放行，或者标成"找不到出处"。

## 怎么测的

除了单元测试和智能体循环测试，还在真实对话上离线回放了两项检查：
一台开发机上 Claude Code 的对话记录里，用过工具的回合共 2,564 个，以软件开发和运维为主，也有调研、写作和理财。
脚本在 `eval/` 目录。两个框架行为不同的地方，回放按 dsh 处理（见脚本开头的说明）。

| | 0.1.0 | 0.2.0 |
|---|---|---|
| 被打回的回合 | 169（6.6%） | 53（2.1%） |
| …因为工具失败 | 36 | 1 |
| …因为数字 | 137 个回合，282 个数字 | 53 个回合，81 个数字 |
| 改错的数字被抓到（末位加一） | 50% | 48% |
| 改错的数字被抓到（放大 1.2 倍） | 56% | 52% |

- **误报。** 0.1.0 的 36 次失败告警，没有一次是回答真的把失败写成了成功：要么是调用还没执行就被拒（参数不对、工具不存在、被取消），
  要么是试探性调用（读一个不存在的文件、页面还没加载就去找元素），之后智能体换了别的工具继续做。
  随机抽查 24 个被标出的数字，也没有一个是真错误：16 个是正确的算术结果，4 个是单位换算，1 个是常识，3 个根本不是数量（行号、状态码）。
  0.2.0 能放行其中大部分：被拒的调用、单位换算、一步算术和行号引用。
- **漏报。** 为了量漏报，把每个回答里一个有出处的数字改错，再跑一次检查。
  4 位及以上有效数字改错能抓到约 85%，3 位约 40%，1–2 位只有约 10%：`3.6` 这样的短数字，在会话的几千个数字里多半能碰巧找到。
  会话越长，抓到的越少，原因相同。
- **没覆盖到的。** 这些对话来自 Claude 模型而不是 DeepSeek，来自 Claude Code 而不是 dsh。
  里面真正写错的数字很少，所以这次测的是误报和规则的覆盖面，不是某个模型犯这类错误的频率。

## 安装

从发布的压缩包或本地仓库安装（先构建：`npm install && npm run build`）：

```sh
dsh plugin --profile <name> add ./dsh-result-check
dsh --profile <name>
```

从 GitHub 安装。安装时 `prepare` 脚本会构建插件，所以 pnpm 会要求你授权一次（见 dsh 文档"从 GitHub 安装"一节）：

```sh
dsh plugin --profile <name> add github:KrimsonSun/dsh-result-check#<commit>
```

在 dsh 源码仓库里快速试用时，写一个指向构建产物的 `--patch` 文件：

```yaml
# result-check.yml
- insert:
    - id: result-check
      name: /absolute/path/to/dsh-result-check/lib/index.js
```

```sh
pnpm dsh web --patch result-check.yml
```

## 配置

所有配置项都可省略。要修改时，在 profile 自己的 `cordis.patch.yml` 里按 id 覆盖这一行。
后面的层会整体替换 `config`，所以要把你设置的每一项都写全。

```yaml
- id: result-check
  config:
    failureResolvedBy: same-tool
    ignoreTools: ['read', 'glob']
```

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `checkFailures` | `true` | 是否检查没报告的工具失败 |
| `checkNumbers` | `true` | 是否检查没有出处的数字 |
| `numbersNeedToolCall` | `true` | 只在调用过工具的回合检查数字（不管纯聊天的回答） |
| `minIntegerDigits` | `3` | 位数少于这个值的整数不检查 |
| `failureStatuses` | `error`、`failed`、`timeout`、`unavailable`、`dependency_missing`、`cancelled`、`blocked` 等 | 表示工具失败的 JSON `status` 值；以 `error`、`fail`、`blocked` 开头的也算 |
| `ignoreTools` | `[]` | 不检查失败的工具名（可用 `*` 通配） |
| `ignoreErrorCodes` | `*ABORTED*`、`*CANCELLED`、`*CANCELED`、`UNKNOWN_TOOL`、`INVALID_ARGS`、`TOOL_ACTIVATION_FAILED`、`AUTO_REVIEW_DENIED`、`DECLINED` | 表示调用根本没执行的 dsh 错误码（可用 `*` 通配）：被取消、工具不存在、参数不合法、被拒 |
| `failureResolvedBy` | `any-tool` | 失败之后，只要有调用成功就算处理过了；设成 `same-tool` 则必须是同一个工具成功。每个工具的结果都要汇报的流水线适合用 `same-tool` |
| `allowDerived` | `true` | 回答里其他数字做一步运算能得到的数字，算有出处 |
| `derivedScope` | `paragraph` | 参与运算的数字从哪来：同一段（默认），或整个回答 `answer`（更安静，但抓到的更少） |
| `skipSubagents` | `false` | 不检查子智能体 |
| `maxNudgesPerTurn` | `1` | 一个回合最多打回几次 |
| `maxListedNumbers` | `8` | 一条说明里最多列出几个数字 |

## 判断规则

误报会让用户多等一步，久了大家就不看这条提示了；漏报的代价则和没装插件时一样。所以拿不准的时候，插件不出声。

**工具调用算失败**：dsh 把结果标记为错误，或者结果是一个 JSON 对象且 `status` 是失败值。MCP 工具和大多数脚本工具都属于这种情况。
shell 命令以非零状态退出**不算**失败，因为 shell 工具把它当作正常结果返回。
还没执行就被 dsh 拒掉的调用（见 `ignoreErrorCodes`）既不算失败，也不算成功。

失败之后本回合只要有调用成功，就算处理过了：智能体看到了失败，换了做法。
回答里只要说了有东西失败（中英文都认，比如 "failed"、"could not"、"timed out"、"失败"、"无法"、"超时"），就算已经报告过。

**只检查回答当作数值写出的数字**：

- 检查：小数（`0.873`）、三位及以上的整数（`1,708`）、百分比（`12.5%`），带不带短单位都行（`1530ms`、`3.2GB`、`1.6x`），中英文都认（`共1708个细胞`）。
- 跳过：代码块和行内代码、网址、文件路径和行号引用（`app.py:120-140`、`` `f` (2867) ``、`(891-894)`）、版本号、日期、时间、`#123` 这样的编号、
  电话号码等用连字符连起来的数字串、标识符（`H100`、`x86_64`、`ISO-8601`、`HTTP 404`）、章节号和步骤号、列表序号、年份、整数值（`5000`、`50%`），
  以及带"约"或"上下限"的数字（`about 1700`、`p < 0.05`、`约1500`、`300左右`）。

**数字算有出处**：会话里某个工具输出、工具调用参数或用户消息中的数字，按回答写出的精度四舍五入后等于它。
`0.87312` 可以支撑 `0.873`，`1707.6` 可以支撑 `1708`，`0.125` 可以支撑 `12.5%`，`3.12e-4` 可以支撑 `0.000312`。
读出处时尽量宽松：标识符、JSON、表格里的数字，以及逗号的两种读法都算。多读出一个出处只会少报，不会多报。插件自己发的说明永远不算出处。

带单位的数字，换算成别的单位后找到也算：字节数（十进制或二进制）可以支撑 `15.6 GB`，`124763103` 可以支撑 `125 MB`，
`9731` 秒可以支撑 `2.7 hours`，`1630412` 可以支撑 `1.63M`，`427113` 可以支撑 `42.7万`。

**数字算推算出来的**：同一段里另外两个数字做一步运算（`+ − × ÷`）能得到它，比如 `4 × 96 = 384 GB`，或者写在 `594.28 of 600 TiB` 旁边的 `5.72 TiB left`。
参与运算的只能是本身有出处的数字，或者本来就不检查的小整数、整数值，所以编出来的数字不能互相作证（`469`、`181` 和它们的和 `650` 都会被标出）。
推算出来的数字可以继续参与下一步。

## 局限

- 超过一步的推算，或者用了回答里没写出来的工具数字的推算，会被标出来。说明里只要求模型交代怎么算的，所以正确的回答只会多一句解释，不会被改写。
- 短数字很少能抓到（见"怎么测的"）；两个都有出处的数字被互换，完全抓不到。
- 数字检查只对插件从第 1 回合就看着的会话生效。恢复或分叉出来的会话看不到之前的工具输出，插件宁可跳过也不瞎猜。失败检查不受影响。
- 检查只看 dsh 记录的内容：工具结果的文本和最终回答的文本。不读图片和文件。
- dsh 还是开发者预览版，插件接口可能会变。这个版本声明 `engines.dsh: >=0.2.0 <0.3.0`。

## 开发

```sh
npm install
npm test                      # 纯逻辑测试，不需要 dsh
npm run build                 # 生成 lib/index.js
npm run test:dsh -- /path/to/deepseek-harness
node eval/replay-claude-code.ts [~/.claude/projects]
```

`test:dsh` 会把插件复制进一个 dsh 源码仓库（需要先在那里 `pnpm install`）。它用 dsh 的模拟模型跑智能体循环测试，并按 dsh 的设置做类型检查。

`eval/replay-claude-code.ts` 在本机的 Claude Code 对话记录上回放两项检查，输出回合被打回的比例和改错的数字被抓到的比例（需要 Node 23.6 以上）。
它只读对话记录，不写任何文件。

## 来源

规则和背后的理由来自 AiScientist（Copyright (c) 2026 Chen Lab, University of California, Irvine；MIT 协议），
对应那里的 `agents/step_numbers.py` 和步骤验收规则。本插件是为 dsh 单独写的 TypeScript 实现。

## 许可

MIT
