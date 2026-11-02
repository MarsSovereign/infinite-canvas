// 短片分镜插件:把一部 AI 短片的分镜铺在画布上。
// - 镜头节点(film:shot):一个 5-15 秒的连续镜头,上游连线即参考(按连线顺序对应 <Picture N>),
//   可直接用当前视频模型按「全能参考」生成,生成结果作为下游视频节点保留,标记通过的那一条进入时间线。
// - 角色/场景卡(film:card):设定集里的一个角色或场景,上游连一张定稿参考图;镜头连卡片时自动取卡片的图。
// - 时间线(film:timeline):按顺序汇总所有镜头的时长与状态,可连播已通过的镜头。
// 字段约定与 OpenMontage ai-short-film 流程导出的画布一致。
import { definePlugin, useEffect, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContentProps, CanvasNodeContext, CanvasNodeData } from "@infinite-canvas/plugin-sdk";

type ShotStatus = "planned" | "generating" | "review" | "accepted" | "rejected";

const STATUS_LABEL: Record<ShotStatus, string> = { planned: "待生成", generating: "生成中", review: "待审", accepted: "已通过", rejected: "需重拍" };
const STATUS_COLOR: Record<ShotStatus, string> = { planned: "#a8a29e", generating: "#3b82f6", review: "#f59e0b", accepted: "#22c55e", rejected: "#ef4444" };

const str = (value: unknown) => (typeof value === "string" ? value : "");
const num = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

function shotStatus(node: CanvasNodeData): ShotStatus {
    const value = node.metadata?.shotStatus;
    return typeof value === "string" && value in STATUS_LABEL ? (value as ShotStatus) : "planned";
}

// 图片节点或卡片节点 → 参考图地址;卡片取其上游第一张图
function imageOf(node: CanvasNodeData, getUpstream: (id: string) => CanvasNodeData[]): string {
    if (node.type === "image") return str(node.metadata?.content);
    if (node.type === "film:card") {
        const image = getUpstream(node.id).find((up) => up.type === "image" && str(up.metadata?.content));
        return image ? str(image.metadata?.content) : "";
    }
    return "";
}

function upstreamOf(ctx: CanvasNodeContext, id: string) {
    const nodes = ctx.getNodes();
    return ctx
        .getConnections()
        .filter((conn) => conn.toNodeId === id)
        .map((conn) => nodes.find((node) => node.id === conn.fromNodeId))
        .filter((node): node is CanvasNodeData => Boolean(node));
}

function shotReferences(ctx: CanvasNodeContext, shot: CanvasNodeData) {
    return upstreamOf(ctx, shot.id)
        .filter((node) => node.type === "image" || node.type === "film:card")
        .map((node) => ({ node, url: imageOf(node, (id) => upstreamOf(ctx, id)) }));
}

// 当前采用的镜头:标记通过的那条,否则取最新一条下游视频
function takeOf(ctx: CanvasNodeContext, shot: CanvasNodeData): CanvasNodeData | null {
    const takes = ctx
        .getConnections()
        .filter((conn) => conn.fromNodeId === shot.id)
        .map((conn) => ctx.getNode(conn.toNodeId))
        .filter((node): node is CanvasNodeData => Boolean(node && node.type === "video" && str(node.metadata?.content)));
    const accepted = str(shot.metadata?.acceptedVideoId);
    return takes.find((node) => node.id === accepted) || takes[takes.length - 1] || null;
}

// 时间线只在自身数据变化时才会被宿主重绘,镜头改动后广播一次让它刷新
const CHANGED = "film:changed";
function updateShot(ctx: CanvasNodeContext, patch: Record<string, unknown>) {
    ctx.updateMetadata(patch);
    ctx.emit(CHANGED);
}

function Chip({ status }: { status: ShotStatus }) {
    return <span style={{ fontSize: 11, padding: "1px 8px", borderRadius: 999, background: STATUS_COLOR[status], color: "#fff", whiteSpace: "nowrap" }}>{STATUS_LABEL[status]}</span>;
}

// ---------------------------------------------------------------- 镜头节点

async function generateShot(ctx: CanvasNodeContext) {
    const shot = ctx.node;
    const prompt = str(shot.metadata?.prompt).trim();
    if (!prompt) throw new Error("镜头还没有提示词");
    const refs = shotReferences(ctx, shot).map((ref) => ref.url).filter(Boolean);
    updateShot(ctx, { shotStatus: "generating", errorDetails: "" });
    try {
        const result = await ctx.ai.generateVideo(prompt, {
            references: refs,
            seconds: String(num(shot.metadata?.duration, 5)),
            mode: refs.length ? "reference" : "frames",
        });
        const takes = num(shot.metadata?.takeCount, 0) + 1;
        const id = `${shot.id}-take${takes}-${Date.now().toString(36)}`;
        const width = 320;
        const height = result.width && result.height ? Math.round((width * result.height) / result.width) : 180;
        ctx.applyOps([
            {
                type: "add_node",
                id,
                nodeType: "video",
                title: `${str(shot.metadata?.shotId) || shot.title} · 第 ${takes} 条`,
                x: shot.position.x + shot.width + 40,
                y: shot.position.y + (takes - 1) * (height + 24),
                width,
                height,
                metadata: { content: result.url, storageKey: result.storageKey, status: "success", mimeType: result.mimeType, naturalWidth: result.width, naturalHeight: result.height, durationMs: result.durationMs },
            },
            { type: "connect_nodes", fromNodeId: shot.id, toNodeId: id },
        ]);
        updateShot(ctx, { shotStatus: "review", takeCount: takes, acceptedVideoId: id });
    } catch (error) {
        updateShot(ctx, { shotStatus: "rejected", errorDetails: error instanceof Error ? error.message : String(error) });
    }
}

function ShotContent({ ctx }: CanvasNodeContentProps) {
    const meta = ctx.node.metadata || {};
    const status = shotStatus(ctx.node);
    const refs = shotReferences(ctx, ctx.node);
    const take = takeOf(ctx, ctx.node);
    const { text, muted, faint, stroke } = ctx.theme.node;
    return (
        <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 8, padding: 12, boxSizing: "border-box", color: text, fontSize: 13, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <strong style={{ fontSize: 15 }}>{str(meta.shotId) || ctx.node.title}</strong>
                <span style={{ color: muted }}>{num(meta.duration, 5)} 秒 · {refs.length ? `${refs.length} 个参考` : "无参考"}</span>
                <span style={{ flex: 1 }} />
                <Chip status={status} />
            </div>
            <div style={{ display: "flex", gap: 6, minHeight: 44 }}>
                {refs.length ? (
                    refs.map((ref, index) => (
                        <div key={ref.node.id} title={`<Picture ${index + 1}> ${ref.node.title}`} style={{ width: 44, height: 44, borderRadius: 8, overflow: "hidden", border: `1px solid ${stroke}`, position: "relative", flex: "none" }}>
                            {ref.url ? <img src={ref.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <div style={{ fontSize: 10, color: faint, padding: 4 }}>无图</div>}
                            <span style={{ position: "absolute", left: 2, bottom: 1, fontSize: 10, color: "#fff", textShadow: "0 0 3px #000" }}>{index + 1}</span>
                        </div>
                    ))
                ) : (
                    <div style={{ color: faint, fontSize: 12, alignSelf: "center" }}>把角色卡、场景卡或图片连到这里作为参考(按连线顺序)</div>
                )}
            </div>
            {str(meta.dialogue) ? <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.45 }}>{str(meta.dialogue)}</div> : <div style={{ color: faint }}>(无台词)</div>}
            {str(meta.action) ? <div style={{ color: muted, whiteSpace: "pre-wrap", lineHeight: 1.4, fontSize: 12 }}>{str(meta.action)}</div> : null}
            {str(meta.continuity) ? <div style={{ color: faint, fontSize: 12 }}>衔接:{str(meta.continuity)}</div> : null}
            {status === "rejected" && str(meta.errorDetails) ? <div style={{ color: "#ef4444", fontSize: 12 }}>{str(meta.errorDetails)}</div> : null}
            <span style={{ flex: 1 }} />
            <div style={{ color: faint, fontSize: 11 }}>{take ? `采用:${take.title}` : str(meta.prompt) ? "提示词已就绪" : "缺少提示词"}</div>
        </div>
    );
}

function ShotPanel({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const meta = ctx.node.metadata || {};
    const [draft, setDraft] = useState({
        shotId: str(meta.shotId),
        duration: String(num(meta.duration, 5)),
        dialogue: str(meta.dialogue),
        action: str(meta.action),
        continuity: str(meta.continuity),
        prompt: str(meta.prompt),
    });
    const { text, stroke, panel } = ctx.theme.node;
    const field = { width: "100%", boxSizing: "border-box" as const, border: `1px solid ${stroke}`, borderRadius: 8, padding: "6px 8px", background: "transparent", color: text, font: "inherit", fontSize: 13 };
    const save = () => {
        const duration = Math.min(15, Math.max(2, Number(draft.duration) || 5));
        updateShot(ctx, { ...draft, duration });
        onClose();
    };
    return (
        <div onMouseDown={stop} onPointerDown={stop} onWheel={stop} style={{ display: "grid", gap: 8, padding: 12, background: panel, color: text, fontSize: 13, borderRadius: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 8 }}>
                <label>镜头编号<input style={field} value={draft.shotId} onChange={(e) => setDraft({ ...draft, shotId: e.target.value })} /></label>
                <label>时长(秒,2-15)<input style={field} type="number" min={2} max={15} value={draft.duration} onChange={(e) => setDraft({ ...draft, duration: e.target.value })} /></label>
            </div>
            <label>台词<textarea style={{ ...field, minHeight: 48 }} value={draft.dialogue} onChange={(e) => setDraft({ ...draft, dialogue: e.target.value })} /></label>
            <label>动作要点<textarea style={{ ...field, minHeight: 48 }} value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })} /></label>
            <label>与下一镜的衔接<input style={field} value={draft.continuity} onChange={(e) => setDraft({ ...draft, continuity: e.target.value })} /></label>
            <label>{"H3 提示词(六段式,<Picture N> 按上游连线顺序)"}<textarea style={{ ...field, minHeight: 180, fontFamily: "ui-monospace, monospace", fontSize: 12 }} value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} /></label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" onClick={onClose} style={{ ...field, width: "auto", cursor: "pointer" }}>取消</button>
                <button type="button" onClick={save} style={{ ...field, width: "auto", cursor: "pointer", fontWeight: 600 }}>保存</button>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------- 角色 / 场景卡

function CardContent({ ctx }: CanvasNodeContentProps) {
    const meta = ctx.node.metadata || {};
    const location = meta.cardKind === "location";
    const image = upstreamOf(ctx, ctx.node.id).find((node) => node.type === "image" && str(node.metadata?.content));
    const { text, muted, faint, stroke } = ctx.theme.node;
    return (
        <div style={{ height: "100%", display: "flex", gap: 10, padding: 12, boxSizing: "border-box", color: text, fontSize: 13, overflow: "hidden" }}>
            <div style={{ width: 96, flex: "none", borderRadius: 10, overflow: "hidden", border: `1px solid ${stroke}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {image ? <img src={str(image.metadata?.content)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ color: faint, fontSize: 11, padding: 6, textAlign: "center" }}>连一张定稿参考图</span>}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                    <strong style={{ fontSize: 15 }}>{str(meta.cardName) || ctx.node.title}</strong>
                    <span style={{ color: muted, fontSize: 12 }}>{location ? "场景" : "角色"}{str(meta.speakerId) ? ` · ${str(meta.speakerId)}` : ""}</span>
                </div>
                <div style={{ color: muted, fontSize: 12, lineHeight: 1.4, overflow: "hidden" }}>{str(meta.cardDescription) || "(未填写外观描述)"}</div>
                {str(meta.voice) ? <div style={{ color: faint, fontSize: 12, lineHeight: 1.4 }}>音色:{str(meta.voice)}</div> : null}
            </div>
        </div>
    );
}

function CardPanel({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const meta = ctx.node.metadata || {};
    const [draft, setDraft] = useState({ cardName: str(meta.cardName), cardKind: str(meta.cardKind) || "character", speakerId: str(meta.speakerId), cardDescription: str(meta.cardDescription), voice: str(meta.voice) });
    const { text, stroke, panel } = ctx.theme.node;
    const field = { width: "100%", boxSizing: "border-box" as const, border: `1px solid ${stroke}`, borderRadius: 8, padding: "6px 8px", background: "transparent", color: text, font: "inherit", fontSize: 13 };
    return (
        <div onMouseDown={stop} onPointerDown={stop} onWheel={stop} style={{ display: "grid", gap: 8, padding: 12, background: panel, color: text, fontSize: 13, borderRadius: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 110px 90px", gap: 8 }}>
                <label>名称<input style={field} value={draft.cardName} onChange={(e) => setDraft({ ...draft, cardName: e.target.value })} /></label>
                <label>类型<select style={field} value={draft.cardKind} onChange={(e) => setDraft({ ...draft, cardKind: e.target.value })}><option value="character">角色</option><option value="location">场景</option></select></label>
                <label>说话人<input style={field} placeholder="S1" value={draft.speakerId} onChange={(e) => setDraft({ ...draft, speakerId: e.target.value })} /></label>
            </div>
            <label>外观 / 布局描述(镜头提示词原样引用)<textarea style={{ ...field, minHeight: 72 }} value={draft.cardDescription} onChange={(e) => setDraft({ ...draft, cardDescription: e.target.value })} /></label>
            <label>固定音色描述<textarea style={{ ...field, minHeight: 48 }} value={draft.voice} onChange={(e) => setDraft({ ...draft, voice: e.target.value })} /></label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" onClick={onClose} style={{ ...field, width: "auto", cursor: "pointer" }}>取消</button>
                <button type="button" onClick={() => { ctx.updateMetadata(draft); ctx.updateNode({ title: draft.cardName || ctx.node.title }); onClose(); }} style={{ ...field, width: "auto", cursor: "pointer", fontWeight: 600 }}>保存</button>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------- 时间线

function TimelineContent({ ctx }: CanvasNodeContentProps) {
    // 镜头改动时立即刷新;再每 2 秒兜底一次,覆盖增删镜头、连线等宿主侧变化
    const [, setTick] = useState(0);
    const nodeId = ctx.node.id;
    useEffect(() => {
        const off = ctx.on(CHANGED, () => setTick((tick) => tick + 1));
        const timer = window.setInterval(() => setTick((tick) => tick + 1), 2000);
        return () => {
            off();
            window.clearInterval(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nodeId]);
    const shots = ctx
        .getNodes()
        .filter((node) => node.type === "film:shot")
        .sort((a, b) => num(a.metadata?.order, 0) - num(b.metadata?.order, 0) || str(a.metadata?.shotId).localeCompare(str(b.metadata?.shotId)));
    const total = shots.reduce((sum, shot) => sum + num(shot.metadata?.duration, 5), 0);
    const accepted = shots.filter((shot) => shotStatus(shot) === "accepted").length;
    const playlist = shots.filter((shot) => shotStatus(shot) === "accepted").map((shot) => takeOf(ctx, shot)).filter((node): node is CanvasNodeData => Boolean(node));
    const [playing, setPlaying] = useState(-1);
    const videoRef = useRef<HTMLVideoElement>(null);
    useEffect(() => {
        if (playing >= 0 && videoRef.current) void videoRef.current.play().catch(() => setPlaying(-1));
    }, [playing]);
    const { text, muted, faint, stroke } = ctx.theme.node;
    const minutes = `${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, "0")}`;
    return (
        <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 8, padding: 12, boxSizing: "border-box", color: text, fontSize: 13 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <strong style={{ fontSize: 15 }}>时间线</strong>
                <span style={{ color: muted }}>{shots.length} 个镜头 · 计划 {minutes} · 已通过 {accepted}/{shots.length}</span>
                <span style={{ flex: 1 }} />
                <button
                    type="button"
                    disabled={!playlist.length}
                    onMouseDown={stop}
                    onClick={() => setPlaying(playing >= 0 ? -1 : 0)}
                    style={{ border: `1px solid ${stroke}`, borderRadius: 8, padding: "2px 10px", background: "transparent", color: text, cursor: playlist.length ? "pointer" : "not-allowed" }}
                >
                    {playing >= 0 ? "停止" : "连播已通过镜头"}
                </button>
            </div>
            {playing >= 0 && playlist[playing] ? (
                <video
                    ref={videoRef}
                    key={playlist[playing].id}
                    src={str(playlist[playing].metadata?.content)}
                    controls
                    onEnded={() => setPlaying(playing + 1 < playlist.length ? playing + 1 : -1)}
                    style={{ width: "100%", maxHeight: 220, borderRadius: 8, background: "#000" }}
                />
            ) : null}
            <div data-canvas-no-zoom onWheel={stop} style={{ display: "flex", gap: 4, overflowX: "auto", paddingBottom: 4 }}>
                {shots.map((shot) => {
                    const status = shotStatus(shot);
                    return (
                        <button
                            key={shot.id}
                            type="button"
                            title={str(shot.metadata?.dialogue) || shot.title}
                            onMouseDown={stop}
                            onClick={() => ctx.applyOps([{ type: "select_nodes", ids: [shot.id] }])}
                            style={{ flex: "none", width: Math.max(48, num(shot.metadata?.duration, 5) * 12), height: 48, borderRadius: 8, border: `1px solid ${stroke}`, borderBottom: `4px solid ${STATUS_COLOR[status]}`, background: "transparent", color: text, cursor: "pointer", fontSize: 11, textAlign: "left", padding: "4px 6px", overflow: "hidden" }}
                        >
                            <div style={{ fontWeight: 600 }}>{str(shot.metadata?.shotId) || shot.title}</div>
                            <div style={{ color: faint }}>{num(shot.metadata?.duration, 5)}s</div>
                        </button>
                    );
                })}
                {!shots.length ? <div style={{ color: faint }}>画布上还没有镜头节点</div> : null}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------- 注册

export default definePlugin({
    id: "film",
    name: "短片分镜",
    version: "1.0.0",
    description: "镜头、角色/场景卡与时间线;镜头按连线参考用当前视频模型生成,适配 MiniMax-H3 全能参考",
    nodes: [
        {
            type: "film:shot",
            title: "镜头",
            icon: "🎬",
            description: "一个 5-15 秒的连续镜头",
            defaultSize: { width: 360, height: 280 },
            defaultMetadata: { shotId: "", order: 0, duration: 5, dialogue: "", action: "", continuity: "", prompt: "", shotStatus: "planned", takeCount: 0 },
            minimapColor: "#6366f1",
            hasSourceHandle: true,
            Content: ShotContent,
            Panel: ShotPanel,
            toolbar: (ctx) => {
                const status = shotStatus(ctx.node);
                return [
                    { id: "edit", title: "编辑镜头", label: "编辑", icon: "✏️", onClick: () => ctx.openPanel() },
                    { id: "generate", title: "用当前视频模型生成一条", label: status === "generating" ? "生成中" : "生成", icon: "🎥", onClick: () => { if (status !== "generating") void generateShot(ctx); } },
                    { id: "accept", title: "采用最新一条", label: "通过", icon: "✅", active: status === "accepted", onClick: () => updateShot(ctx, { shotStatus: status === "accepted" ? "review" : "accepted" }) },
                    { id: "reject", title: "标记需要重拍", label: "重拍", icon: "↻", danger: true, onClick: () => updateShot(ctx, { shotStatus: "rejected" }) },
                ];
            },
            onDoubleClick: (ctx) => {
                ctx.openPanel();
                return true;
            },
        },
        {
            type: "film:card",
            title: "角色/场景卡",
            icon: "🎭",
            description: "设定集里的角色或场景,上游连定稿参考图",
            defaultSize: { width: 340, height: 150 },
            defaultMetadata: { cardKind: "character", cardName: "", speakerId: "", cardDescription: "", voice: "" },
            minimapColor: "#ec4899",
            Content: CardContent,
            Panel: CardPanel,
            toolbar: (ctx) => [{ id: "edit", title: "编辑卡片", label: "编辑", icon: "✏️", onClick: () => ctx.openPanel() }],
            onDoubleClick: (ctx) => {
                ctx.openPanel();
                return true;
            },
        },
        {
            type: "film:timeline",
            title: "时间线",
            icon: "🎞️",
            description: "汇总全部镜头的顺序、时长与状态",
            defaultSize: { width: 720, height: 150 },
            minimapColor: "#14b8a6",
            hasSourceHandle: false,
            hidePanel: true,
            Content: TimelineContent,
        },
    ],
});
