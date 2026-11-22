# 转描传播实验（Rotoscoping Propagation Experiment）

本文记录两种传播模型在**同一组关键帧曲线**上的对照实验、逐段选择的边界条件、
重开镜头后的改绘负担，以及弱边缘/弱纹理与局部遮挡条件下“跟随精度 vs 编辑负担”
的权衡。所有轮廓距离与改点数量都由代码从实际传播结果与合成真值重新计算，数据
快照见 [`evidence/propagation-experiment.json`](./evidence/propagation-experiment.json)
与 [`evidence/bench-report.json`](./evidence/bench-report.json)，可通过
`npm run experiment` 与 `npm run bench` 重新生成。

## 1. 诚实性声明

- 界面与实验中显示的可见轮廓，全部是跟踪引擎（`src/core/engine.ts` 经
  `hybridStep` 调用 `trackStep` / `trackStepIndependent`）对真实合成画面逐帧
  计算得到的输出。
- 人工绘制或拖动过的曲线存放在关键帧 / 手动修正图层，**不会**被标记成自动
  算法结果，也不会冒充边缘精确的轮廓。
- 证据不足而由形状先验顶住的点一律带 `regularized: true, visible: false`，
  在画布上画成灰色虚线、在证据表里标为 inferred，绝不描述为“吸附到边缘”。
- 实验脚本 `verifyDocument` 会对每个数值做有限性与比例校验（非有限数、改点数
  超过总点数、重绘比例超出 [0,1]、存储比例与重算不一致都会以退出码 2 失败），
  因此**不存在用默认 0 值遮盖错误**的路径。

## 2. 两种传播模型

两种模型吃的是完全相同的关键帧曲线、相同的控制点 `id` 与相同的跟踪参数
（见证据 JSON 的 `params`），区别只在帧间如何传播。

| 模型 | 实现 | 运动自由度 | 形状耦合 | 证据失败时 |
|------|------|-----------|----------|-----------|
| 联合 + 形状正则（joint） | `src/core/tracker.ts` `trackStep` | 全局相似变换（平移/旋转/缩放）+ 沿法线精修 | 有，Gauss–Newton 联合拟合 + 正则 | 靠相似预测 coast，标 `regularized/visible:false` |
| 逐点独立（independent） | `src/core/independentTracker.ts` `trackStepIndependent` | 每点完整二维圆盘 patch 搜索，保留切向运动 | 无点间耦合 | 原地保持上一帧位置并标记，不借全局预测漂移 |

两者都使用同一套**内采样锚点模板 NCC 闸门**（`matchTemplateAt`，带
`templateRecover` 迟滞）：只有当前帧匹配到关键帧处的物体内部纹理才算可见，
移动的遮挡物即使帧间自相关很高也无法通过。`src/core/hybridTracker.ts` 的
`hybridStep` 同时跑两条管线，再按约束逐点选取，并把实际生效的模型写进每个
`PointEvidence.propagationMode`；没有约束时联合分支与原始 `trackStep` 输出
逐位一致，老场景行为不变。

## 3. 边界条件：区间统一选择 vs 逐段局部选择

模型选择通过 `PropagationConstraint`（`src/core/types.ts`）持久化，分两种作用域：

- **区间统一（`scope: 'interval'`）**：两个关键帧之间整段只使用一个模型
  （`mode` 为 joint 或 independent）。`modeForPoint` 对该区间所有点返回同一
  模型，`locallySelected=false`。
- **逐段局部（`scope: 'segment'`）**：保留一个区间基准模型，另用
  `segmentModes` 以“段起点控制点 id”为键覆盖个别轮廓段。被覆盖的点
  `locallySelected=true`，画布上用青色虚线（`#38bdf8`）区分。

编辑器可在“镜头跟踪窗口”的 **Propagation model** 卡片对遮挡区域逐段切换
joint/independent；该决策写回 track 的 `constraints`，任何模型编辑都会令该
区间自动帧失效并 bump revision，重算后才生效。选择结果随工程保存
（`src/core/persistence.ts`），重开镜头后仍然存在。

## 4. 实验设置

- 场景（`src/bench/synth.ts`）：
  - `weak-edge`：70 帧、26 个控制点，`edgeSoftness 5.5 / textureGain 0.08 /
    contrast 0.18` 的非刚性形变弱边缘弱纹理 blob；
  - `local-occlusion`：70 帧、26 个控制点，30×36 的紧凑遮挡条只扫过少数几段。
- 关键帧：0、20、40、60、69（两种模型完全相同的真值曲线）。
- 三种配置：`joint-interval`、`independent-interval`、`segment-local`。
- 逐段配置的判据来自**真实采样证据**而非结果调参：段起点在两个锚点都未被遮挡、
  区间内遮挡率 ≤ 0.34，且两锚点的原始锚点模板 NCC 都 ≥ `LOCAL_NCC_GATE=0.72`
  （该阈值取自实测 NCC 分布：弱边缘 p25≈0.65、中位≈0.80；局部遮挡可见点 >0.9，
  并与引擎自身模板阈值一致），才切到 independent，否则留在 joint 形状先验上。
- 指标（`src/bench/metrics.ts`、`src/core/redraw.ts`，源像素）：
  - 轮廓距离：boundary mean / p95 / Hausdorff，控制点误差 mean/max；
  - 改点数：控制点到真值折线距离 > `pointTolerance=2px` 的点数；
  - 改绘长度：把样条按每段 12 个采样点密集化，中点偏离真值 >
    `sampleTolerance=1.5px` 的样条弧长累计，以及占整条轮廓长度的比例。

## 5. 实测结果（代码复算，非默认值）

### 弱边缘 / 弱纹理（70 帧，自动帧共 1690 个控制点样本）

| 配置 | bnd-mean | bnd-p95 | hausdorff | cp-mean | 改点数 | 改绘长度(px) | 改绘比例 | 局部选中点 |
|------|---------:|--------:|----------:|--------:|-------:|-------------:|---------:|-----------:|
| joint-interval | 2.753 | 8.606 | 12.183 | 2.789 | 801 | 16409.7 | 59.2% | 0 |
| independent-interval | 3.151 | 10.236 | 14.165 | 2.854 | 822 | 19924.1 | 68.1% | 0 |
| segment-local | 2.779 | 8.298 | 12.475 | **2.536** | **759** | 17863.5 | 64.2% | 888 |

### 局部遮挡（70 帧，自动帧共 1690 个控制点样本）

| 配置 | bnd-mean | bnd-p95 | hausdorff | cp-mean | 改点数 | 改绘长度(px) | 改绘比例 | 局部选中点 |
|------|---------:|--------:|----------:|--------:|-------:|-------------:|---------:|-----------:|
| joint-interval | **0.458** | **1.207** | **2.049** | **0.432** | **21** | **548.0** | **2.2%** | 0 |
| independent-interval | 0.589 | 1.875 | 3.044 | 0.526 | 39 | 1276.7 | 5.2% | 0 |
| segment-local | 0.558 | 1.474 | 3.043 | 0.517 | 28 | 1076.3 | 4.4% | 1530 |

## 6. 精度与编辑负担的讨论

- **弱边缘 / 弱纹理**：没有可靠局部纹理时，逐点独立搜索会被噪声带偏，
  independent 的轮廓距离（3.151 vs 2.753）、改点数（822 vs 801）和改绘比例
  （68.1% vs 59.2%）全面差于联合模型——形状正则在证据稀薄处起到了约束作用。
  segment-local 把 888 个仍有真实纹理、可局部追踪的点切到 independent，
  得到最低的控制点平均误差（2.536）和最少改点数（759），但其改绘比例
  （64.2%）介于两者之间，因为独立点保留的切向运动让部分样条跨度变长。
- **局部遮挡**：遮挡只覆盖少数段，联合相似变换由其余可见点稳定投票，整体
  精度最高、编辑负担最小（改点 21、改绘 2.2%）。全区间 independent 失去全局
  约束，未遮挡区域也产生不必要的切向漂移，负担最高（改点 39、改绘 5.2%）。
  segment-local 对 1530 个可见段做局部选择，精度与负担（改点 28、改绘 4.4%）
  介于两者之间，并未优于纯联合——说明在“遮挡稀疏、其余区域纹理正常”时，
  联合模型本身已经足够，局部切换的收益取决于遮挡范围。
- **重开镜头的改绘量怎么读**：改点数回答“要重拖多少个控制点”，改绘长度/比例
  回答“真值意义上有多长的曲线需要重画”。界面 **Reopen lens** 卡片对当前自动帧
  用同一 `redrawBurden` 实时复算这两个量，并在 **Frame state / frame-to-frame**
  中给出相邻帧点位移与样条长度变化，便于在跟踪后逐帧核对而不是只看本文字。

## 7. 待验证的假设（hypotheses pending verification）

以下结论目前只有上述两个合成场景支撑，**列为待验证假设**，不能当作普遍规律：

1. 真实镜头（非合成 luma、含运动模糊与色彩纹理）下，0.72 的局部 NCC 闸门是否
   仍能正确区分可局部追踪段与弱纹理段，需要真实数据复测。
2. segment-local 在弱边缘场景降低改点数的收益，是否随关键帧间距增大而保持，
   尚未在更长区间（>20 帧）上验证。
3. 局部遮挡中联合模型占优是否在“大面积/多遮挡物”时反转——当前遮挡条只覆盖
   少数段，遮挡占比升高后逐点独立可能更稳，尚需专门场景。
4. independent 保留切向自由度在非刚性形变上的优势，是否能在更剧烈形变下转化
   为更低 boundary 误差，而不只是更低的控制点平均误差。
5. 改绘长度阈值（1.5px）与改点阈值（2px）取自当前 320×240 合成分辨率，换分辨率
   或真实素材后阈值与负担数值的对应关系需要重新标定。

## 8. 如何复现

```bash
npm install
npm run check        # 类型检查
npm test             # 38 个单元测试（含独立跟踪、混合选择、约束、持久化、改绘）
npm run bench        # 四个老场景基准，写 bench-out/report.json
npm run experiment   # 本文两个场景 × 三种配置，校验后写 bench-out/propagation-experiment.json
npm run build && npm run e2e   # 7 个 Playwright 界面测试
```

界面启动方式见 README“界面启动”一节：`npm run dev` 后打开 Vite 输出的本地地址
（默认 http://localhost:5173 ），在 **Propagation model** 卡片选择区间/逐段模型，
Recompute 后通过证据表的 model 列、画布配色与 Reopen lens 数据核对真实算法输出。
