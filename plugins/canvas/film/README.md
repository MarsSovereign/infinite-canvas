# 短片分镜插件（film）

把一部 AI 短片的分镜铺在画布上，配合 MiniMax-H3 Studio 的「全能参考」逐镜头生成。

| 节点 | 类型 | 作用 |
| --- | --- | --- |
| 镜头 | `film:shot` | 一个 5–15 秒的连续镜头：编号、时长、台词、动作、衔接、六段式 H3 提示词与状态（待生成 / 生成中 / 待审 / 已通过 / 需重拍） |
| 角色/场景卡 | `film:card` | 设定集里的一个角色或场景：名称、说话人、外观描述、固定音色；上游连一张定稿参考图 |
| 时间线 | `film:timeline` | 按顺序汇总所有镜头的时长和状态，可连播已通过的镜头 |

## 用法

- 把角色卡、场景卡或图片连到镜头上作为参考，**连线顺序就是提示词里的 `<Picture N>` 顺序**；镜头连卡片时自动取卡片上游的定稿图。
- 镜头工具栏「生成」用当前视频模型按全能参考生成一条，结果作为下游视频节点保留并接到镜头后面；「通过」「重拍」标记状态，时间线随之更新。
- 视频模型推荐用调用脚本模板「MiniMax-H3 Studio（本地 GPU）」，见 [接入 MiniMax-H3 Studio](../../../docs/content/docs/overview/minimax-h3-studio.zh-CN.mdx)。
- 双击镜头或卡片打开编辑面板。

OpenMontage 的 `ai-short-film` 流程可用 `canvas_storyboard` 工具把整个项目导出成可导入的画布 zip，或通过 Canvas Agent 直接写入当前画布；字段与本插件一致。

## 构建

```bash
npm install && npm run build   # 产出 dist/film.js 并同步到 web/public/plugins/
```
