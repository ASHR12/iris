import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph from "force-graph";
import { forceCollide } from "d3-force";
import { BrainCircuit, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type { HandState } from "../hooks/useHandControl";
import { normalizeMarkdown } from "../lib/tasks";

type GraphNode = BrainNode & { x?: number; y?: number };
type ForceGraphType = InstanceType<typeof ForceGraph>;

// Deep-space constellation palette — folders become colored clusters.
const FOLDER_PALETTE = [
  "#22d3ee", "#a78bfa", "#2dd2af", "#f5b04a", "#f87171",
  "#5b8fe8", "#f472b6", "#34d399", "#eab308", "#94a3b8",
];

const DWELL_MS = 320;

export type BrainVoiceCommand = {
  seq: number;
  kind: "focus" | "open" | "close";
  query?: string;
};

export type BrainGraphState = {
  nodeTitles: string[];
  focusedTitle: string | null;
  openNoteTitle: string | null;
};

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Filler words carry no signal about WHICH note is meant — without stripping
// them, "the github for AI agents post" would match any title containing
// "the" + "post". Content words must do the matching.
const QUERY_STOPWORDS = new Set([
  "the", "a", "an", "for", "to", "of", "in", "on", "at", "about", "with",
  "my", "your", "our", "his", "her", "their", "its", "that", "this", "one",
  "note", "notes", "and", "or", "me", "show", "open", "find", "focus",
]);

/**
 * Resolve a spoken query ("the evomap draft", "june content") to the best
 * node BY TITLE. Scoring is dominated by how much of the query's content
 * words the title covers; misses return null so the caller can fall back to
 * the hybrid content search.
 */
function resolveNodeByQuery(nodes: GraphNode[], query: string): GraphNode | null {
  const q = normalizeForMatch(query);
  if (!q) return null;
  const allTokens = q.split(" ").filter(Boolean);
  const qTokens = allTokens.filter((token) => !QUERY_STOPWORDS.has(token));
  if (qTokens.length === 0) return null;
  let best: GraphNode | null = null;
  let bestScore = 0;
  for (const node of nodes) {
    const title = normalizeForMatch(node.title);
    const haystack = `${normalizeForMatch(node.folder)} ${title}`;
    const hits = qTokens.filter((token) => haystack.includes(token)).length;
    let score = (hits / qTokens.length) * 70;
    if (title === q) score += 30;
    else if (title.includes(q)) score += 15;
    // Tiny nudge toward well-connected notes for genuine ties.
    score += Math.min(4, Math.sqrt(node.degree || 0) * 0.5);
    if (score > bestScore) {
      bestScore = score;
      best = node;
    }
  }
  // >50% content-word coverage required — weak overlap defers to semantics.
  return bestScore > 40 ? best : null;
}

// Labels render at a constant 11px on screen; wrap anything wider than this
// into up to three centered lines so long titles never run into neighbors.
const LABEL_FONT = "11px Inter, sans-serif";
const LABEL_MAX_PX = 104;
const LABEL_MAX_LINES = 3;

/**
 * Vault notes synced from Notion carry scaffolding that CommonMark renders as
 * literal text (HTML comments, <empty-block/>, <columns>, <video>, wikilinks).
 * Translate all of it into honest markdown before handing it to the renderer.
 */
function prepareBrainMarkdown(raw: string): string {
  let text = normalizeMarkdown(raw);
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  // Column wrappers: keep the content, drop the tags and their indentation
  // (tab-indented lines would otherwise become accidental code blocks).
  text = text.replace(/<columns>([\s\S]*?)<\/columns>/gi, (_match, inner: string) =>
    inner.replace(/<\/?column>/gi, "").replace(/^[\t ]+/gm, ""),
  );
  text = text.replace(/<empty-block\s*\/?>/gi, "");
  text = text.replace(/<video[^>]*src="([^"]+)"[^>]*>\s*<\/video>/gi, "\n[▶ Watch video]($1)\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  // Obsidian embeds and wikilinks. Embeds become inline code; wikilinks become
  // internal #wiki= links that the renderer resolves to graph nodes.
  text = text.replace(/!\[\[([^\]]+)\]\]/g, "`$1`");
  text = text.replace(
    /\[\[([^\]|]+)\|([^\]]+)\]\]/g,
    (_match, target: string, alias: string) => `[${alias}](#wiki=${encodeURIComponent(target.trim())})`,
  );
  text = text.replace(
    /\[\[([^\]]+)\]\]/g,
    (_match, target: string) => `[${target.trim()}](#wiki=${encodeURIComponent(target.trim())})`,
  );
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function wrapLabel(ctx: CanvasRenderingContext2D, title: string): string[] {
  ctx.font = LABEL_FONT;
  const words = title.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (let i = 0; i < words.length; i += 1) {
    const candidate = line ? `${line} ${words[i]}` : words[i];
    if (!line || ctx.measureText(candidate).width <= LABEL_MAX_PX) {
      line = candidate;
      continue;
    }
    lines.push(line);
    if (lines.length === LABEL_MAX_LINES - 1) {
      // Final allowed line: take the rest and ellipsize to fit.
      let tail = words.slice(i).join(" ");
      const whole = tail;
      while (tail.length > 1 && ctx.measureText(`${tail}…`).width > LABEL_MAX_PX) {
        tail = tail.slice(0, -1).trimEnd();
      }
      lines.push(tail === whole ? whole : `${tail}…`);
      return lines;
    }
    line = words[i];
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The Neural Map: the Hermes brain (an Obsidian vault) rendered as a live
 * force-directed graph floating over the desktop (HUD mode only).
 *
 * Gestures: point + hold selects a node · one open palm pans · two open palms
 * zoom · fist closes. Mouse works natively (drag pan, wheel zoom, click).
 * Strictly read-only.
 */
export default function BrainGraph({
  hand,
  active,
  onClose,
  voiceCommand,
  onGraphState,
}: {
  hand: HandState | null;
  active: boolean;
  onClose: () => void;
  voiceCommand?: BrainVoiceCommand | null;
  onGraphState?: (state: BrainGraphState) => void;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<ForceGraphType | null>(null);

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [data, setData] = useState<{ nodes: BrainNode[]; links: BrainLink[] } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState<BrainNoteResult | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const hoverIdRef = useRef<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const focusIdRef = useRef<string | null>(null);
  focusIdRef.current = focusId;
  const focusAtRef = useRef(0);
  // Once a deliberate camera move happens (voice focus / node select), the
  // auto zoom-to-fit passes must not fight it.
  const suppressAutoFitRef = useRef(false);
  const handRef = useRef<HandState | null>(hand);
  handRef.current = hand;
  const activeRef = useRef(active);
  activeRef.current = active;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const folderColors = useMemo(() => {
    const folders = [...new Set((data?.nodes ?? []).map((node) => node.folder))].sort();
    const map = new Map<string, string>();
    folders.forEach((folder, index) => map.set(folder, FOLDER_PALETTE[index % FOLDER_PALETTE.length]));
    return map;
  }, [data]);

  // Load the vault graph.
  useEffect(() => {
    let cancelled = false;
    window.iris
      .loadBrain()
      .then((result) => {
        if (cancelled) return;
        if (result.ok && result.nodes && result.links) {
          setData({ nodes: result.nodes, links: result.links });
          setStatus("ready");
        } else {
          setError(result.error ?? "Could not load the brain vault.");
          setStatus("error");
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function select(node: GraphNode | null) {
    setSelectedId(node?.id ?? null);
    setNote(null);
    if (node?.id) {
      setFocusId(node.id); // "open it" after closing re-targets this note
      suppressAutoFitRef.current = true;
      window.iris.readBrainNote(node.id).then(setNote).catch(() => undefined);
      const graph = graphRef.current;
      if (graph && node.x !== undefined && node.y !== undefined) {
        graph.centerAt(node.x, node.y, 600);
      }
    }
  }

  function selectById(id: string) {
    const node = (data?.nodes as GraphNode[] | undefined)?.find((item) => item.id === id);
    if (node) select(node);
  }

  // Resolve a wikilink target ("EvoMap", "2026-06") to a node by title.
  function selectByTitle(title: string) {
    const wanted = title.toLowerCase();
    const node = (data?.nodes as GraphNode[] | undefined)?.find(
      (item) => item.title.toLowerCase() === wanted,
    );
    if (node) select(node);
  }

  // Voice traversal: fly the camera to a node and pulse-highlight it. The live
  // positions belong to the graph's own copy of the nodes, so look there.
  function liveNode(id: string): GraphNode | null {
    const graph = graphRef.current;
    if (!graph) return null;
    return ((graph.graphData().nodes as GraphNode[]) ?? []).find((item) => item.id === id) ?? null;
  }

  function focusNode(node: GraphNode) {
    const graph = graphRef.current;
    const live = liveNode(node.id);
    if (!graph || !live || live.x === undefined || live.y === undefined) return;
    if (selectedIdRef.current) select(null); // reading -> back to the map first
    setFocusId(node.id);
    focusAtRef.current = performance.now();
    suppressAutoFitRef.current = true;
    graph.centerAt(live.x, live.y, 900);
    graph.zoom(Math.min(5, Math.max(graph.zoom(), 3.2)), 900);
  }

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(null), 2600);
  }

  // Hot reload: the main process watches the vault + its semantic index and
  // pings when anything changes (Hermes brain sync, Obsidian edit, manual
  // re-index). Re-fetch in place — the constellation re-blooms with the new
  // data, an open note refreshes its content, and a deleted note closes.
  useEffect(() => {
    return window.iris.onBrainChanged(() => {
      window.iris
        .loadBrain()
        .then((result) => {
          if (!result.ok || !result.nodes || !result.links) return;
          setData({ nodes: result.nodes, links: result.links });
          const openId = selectedIdRef.current;
          if (openId) {
            if (result.nodes.some((node) => node.id === openId)) {
              window.iris.readBrainNote(openId).then(setNote).catch(() => undefined);
            } else {
              select(null); // the open note no longer exists
            }
          }
          const w = window as unknown as Record<string, unknown>;
          w.__brainReloads = ((w.__brainReloads as number) ?? 0) + 1;
        })
        .catch(() => undefined);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Test/automation hook.
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__brainSelectByTitle = (title: string) => {
      const node = (data?.nodes as GraphNode[] | undefined)?.find(
        (item) => item.title.toLowerCase() === title.toLowerCase(),
      );
      if (node) select(node);
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__brainSelectByTitle;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Build the force-graph instance.
  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host || !data) return;

    const labelCache = new Map<string, string[]>();

    const graph = new ForceGraph(host)
      .graphData({ nodes: data.nodes.map((node) => ({ ...node })), links: data.links.map((l) => ({ ...l })) })
      .nodeId("id")
      .backgroundColor("rgba(0,0,0,0)")
      .autoPauseRedraw(false)
      // Pre-run the physics before the first paint so the constellation
      // appears already unfolded (the live cooldown just settles the tail).
      .warmupTicks(180)
      .cooldownTime(3000)
      .d3VelocityDecay(0.32)
      .linkColor(() => "rgba(148, 196, 255, 0.12)")
      .linkWidth(0.4)
      .nodeCanvasObject((rawNode, ctx, scale) => {
        const node = rawNode as GraphNode;
        if (node.x === undefined || node.y === undefined) return;
        const color = folderColors.get(node.folder) ?? "#8aa0b8";
        const isSelected = node.id === selectedIdRef.current;
        const isHovered = node.id === hoverIdRef.current;
        const isFocused = node.id === focusIdRef.current;
        const r = Math.max(2.2, Math.min(9, 2 + Math.sqrt(node.degree || 0) * 1.1));

        ctx.shadowColor = color;
        ctx.shadowBlur = isSelected || isHovered || isFocused ? 18 : 8;
        ctx.fillStyle = isSelected ? "#ffffff" : color;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        if (isSelected || isHovered || isFocused) {
          ctx.strokeStyle = "rgba(255,255,255,0.85)";
          ctx.lineWidth = 1.6 / scale;
          ctx.beginPath();
          ctx.arc(node.x, node.y, r + 3 / scale, 0, Math.PI * 2);
          ctx.stroke();
        }

        // Voice-focus beacon: two expanding rings for a couple of seconds so
        // the eye lands on the node the camera just flew to.
        if (isFocused) {
          const elapsed = performance.now() - focusAtRef.current;
          if (elapsed < 2600) {
            for (const offset of [0, 650]) {
              const t = ((elapsed + offset) % 1300) / 1300;
              ctx.strokeStyle = `rgba(255, 255, 255, ${(1 - t) * 0.55})`;
              ctx.lineWidth = 1.4 / scale;
              ctx.beginPath();
              ctx.arc(node.x, node.y, r + 2 + t * 30 / scale, 0, Math.PI * 2);
              ctx.stroke();
            }
          }
        }

        const labelAlpha =
          isSelected || isHovered || isFocused ? 1 : Math.min(1, Math.max(0, (scale - 2.2) / 1.4));
        if (labelAlpha > 0.02) {
          let lines = labelCache.get(node.id);
          if (!lines) {
            lines = wrapLabel(ctx, node.title);
            labelCache.set(node.id, lines);
          }
          const fontPx = Math.max(3, 11 / scale);
          const lineStep = fontPx * 1.18;
          ctx.font = `${fontPx}px Inter, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillStyle = `rgba(232, 240, 250, ${labelAlpha})`;
          for (let i = 0; i < lines.length; i += 1) {
            ctx.fillText(lines[i], node.x, node.y + r + 3 / scale + i * lineStep);
          }
        }
      })
      .nodePointerAreaPaint((rawNode, color, ctx) => {
        const node = rawNode as GraphNode;
        if (node.x === undefined || node.y === undefined) return;
        const r = Math.max(2.2, Math.min(9, 2 + Math.sqrt(node.degree || 0) * 1.1));
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 4, 0, Math.PI * 2);
        ctx.fill();
      })
      .onNodeHover((node) => {
        hoverIdRef.current = (node as GraphNode | null)?.id ?? null;
      })
      .onNodeClick((node) => select(node as GraphNode))
      .onBackgroundClick(() => select(null))
      .width(window.innerWidth)
      .height(window.innerHeight);

    // Spread the constellations Obsidian-style: strong long-range repulsion,
    // link distances that grow with hub size (so a hub's hundred leaves get a
    // wide orbit instead of a tight ring), and a generous collide radius that
    // reserves room for labels. Slower alpha decay gives the layout time to
    // truly unfold.
    graph.d3Force("charge")?.strength(-110).distanceMax(760);
    graph.d3Force("link")?.distance((link: { source: unknown; target: unknown }) => {
      const s = ((link.source as GraphNode).degree ?? 0) || 0;
      const t = ((link.target as GraphNode).degree ?? 0) || 0;
      return 56 + Math.min(120, (Math.sqrt(s) + Math.sqrt(t)) * 8);
    });
    graph.d3Force(
      "collide",
      forceCollide((node) => 16 + Math.sqrt(((node as GraphNode).degree || 0)) * 2.8),
    );

    // Frame the constellation twice: right after the warmed-up reveal and
    // again when the physics fully settles, so it always ends centered —
    // unless a voice focus / selection has already taken the camera.
    suppressAutoFitRef.current = false;
    const fitTimer = window.setTimeout(() => {
      if (!suppressAutoFitRef.current) graph.zoomToFit(600, 70);
    }, 400);
    let settledFit = false;
    graph.onEngineStop(() => {
      if (settledFit || suppressAutoFitRef.current) return;
      settledFit = true;
      graph.zoomToFit(600, 70);
    });

    const onResize = () => graph.width(window.innerWidth).height(window.innerHeight);
    window.addEventListener("resize", onResize);

    graphRef.current = graph;
    return () => {
      window.clearTimeout(fitTimer);
      window.removeEventListener("resize", onResize);
      graphRef.current = null;
      graph._destructor();
    };
  }, [data, folderColors]);

  // Voice commands from Gemini (focus_brain_node / open_brain_note /
  // close_brain_note). Each command carries a seq so it runs exactly once, and
  // it waits here until the graph is built and its data ready — declared after
  // the graph-build effect so a command arriving with the auto-open finds a
  // live graph on the very first ready render.
  const doneSeqRef = useRef(0);
  useEffect(() => {
    if (!voiceCommand || voiceCommand.seq === doneSeqRef.current) return;
    if (status !== "ready" || !data) return;
    doneSeqRef.current = voiceCommand.seq;
    const command = voiceCommand;
    let cancelled = false;

    // Title matching first (instant); if it whiffs, fall back to the hybrid
    // BM25 + embedding search in the main process, which understands content
    // ("the note about the veed watermark") — then map the hit back to a node.
    const resolve = async (query: string, nodes: GraphNode[]): Promise<GraphNode | null> => {
      const byTitle = resolveNodeByQuery(nodes, query);
      if (byTitle) return byTitle;
      try {
        const found = await window.iris.searchBrain(query, 1);
        const top = found.ok ? found.results?.[0] : null;
        // Only follow CONFIDENT content hits — embeddings rank nonsense
        // against something no matter what; a weak match must stay a miss.
        if (top?.confident) return nodes.find((node) => node.id === top.path) ?? null;
      } catch {
        /* semantic side unavailable — title miss stands */
      }
      return null;
    };

    // Execute against the graph's live nodes (they carry x/y). Right after an
    // auto-open the physics warmup may not have positioned them yet, so poll
    // briefly until coordinates exist. `executing` makes the command one-shot
    // even while an async resolve is in flight.
    let executing = false;
    const run = async () => {
      if (executing) return true;
      const graph = graphRef.current;
      const nodes = (graph?.graphData().nodes as GraphNode[] | undefined) ?? [];
      if (!graph || nodes.length === 0 || nodes[0].x === undefined) return false;
      executing = true;

      if (command.kind === "close") {
        select(null);
        return true;
      }
      if (command.kind === "focus") {
        const hit = command.query ? await resolve(command.query, nodes) : null;
        if (cancelled) return true;
        if (hit) focusNode(hit);
        else showToast(`No note matched "${command.query ?? ""}"`);
        return true;
      }
      // open: named note, else the focused one, else the hovered one.
      const named = command.query ? await resolve(command.query, nodes) : null;
      if (cancelled) return true;
      const fallbackId = focusIdRef.current ?? hoverIdRef.current;
      const target = named ?? (fallbackId ? nodes.find((item) => item.id === fallbackId) ?? null : null);
      if (target) select(target);
      else showToast(command.query ? `No note matched "${command.query}"` : "Focus a note first");
      return true;
    };

    let timer = 0;
    run().then((done) => {
      if (done || cancelled) return;
      timer = window.setInterval(() => {
        run().then((ok) => {
          if (ok) window.clearInterval(timer);
        });
      }, 80);
    });
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceCommand, status, data]);

  // Report graph state upward (Gemini reads it through get_iris_ui_context).
  useEffect(() => {
    const focusedTitle = (data?.nodes ?? []).find((node) => node.id === focusId)?.title ?? null;
    const openNoteTitle = (data?.nodes ?? []).find((node) => node.id === selectedId)?.title ?? null;
    onGraphState?.({ nodeTitles: (data?.nodes ?? []).map((node) => node.title), focusedTitle, openNoteTitle });
    (window as unknown as Record<string, unknown>).__brainState = { focusedTitle, openNoteTitle };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, focusId, selectedId]);

  // Gesture bridge: point+dwell select · palm pan · two-palm zoom · fist close.
  useEffect(() => {
    let raf = 0;
    let lastPalm: { x: number; y: number } | null = null;
    let zoomBase: { dist: number; k: number } | null = null;
    let dwell: { id: string; startedAt: number; fired: boolean } | null = null;
    let fistLatch = false;

    const insidePanel = (x: number, y: number) => {
      const rect = panelRef.current?.getBoundingClientRect();
      return Boolean(rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
    };

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const graph = graphRef.current;
      const h = handRef.current;
      if (!graph || !h || !activeRef.current) {
        lastPalm = null;
        zoomBase = null;
        dwell = null;
        fistLatch = false;
        return;
      }

      // While a note is open the constellation is hidden — pause the canvas
      // gestures (the note card itself is plain DOM: universal point-and-hold
      // and palm-scroll already handle it). One exception: a fist closes the
      // note and brings the map back. The map itself never closes by fist.
      if (selectedIdRef.current) {
        const anyFist = h.fist || h.hands.some((item) => item.fist);
        if (anyFist) {
          if (!fistLatch) {
            fistLatch = true;
            select(null);
          }
        } else {
          fistLatch = false;
        }
        lastPalm = null;
        zoomBase = null;
        dwell = null;
        return;
      }
      fistLatch = false;

      const openPalms = h.hands.filter((item) => item.openPalm && item.point);

      // Two open palms -> zoom by inter-palm distance.
      if (openPalms.length >= 2) {
        const dist = Math.hypot(
          openPalms[0].point.x - openPalms[1].point.x,
          openPalms[0].point.y - openPalms[1].point.y,
        );
        if (!zoomBase) zoomBase = { dist, k: graph.zoom() };
        const next = Math.max(0.15, Math.min(8, zoomBase.k * (dist / Math.max(60, zoomBase.dist))));
        graph.zoom(next, 0);
        lastPalm = null;
        return;
      }
      zoomBase = null;

      // One open palm -> pan the camera (unless over the note panel, which
      // the app-level palm-scroll owns).
      if (h.openPalm && h.point && !insidePanel(h.point.x, h.point.y)) {
        if (lastPalm) {
          const k = graph.zoom();
          const center = graph.centerAt();
          graph.centerAt(center.x - (h.point.x - lastPalm.x) / k, center.y - (h.point.y - lastPalm.y) / k, 0);
        }
        lastPalm = { ...h.point };
        return;
      }
      lastPalm = null;

      // Pointing -> hover nearest node; hold to select.
      if (h.pointing && h.point && !insidePanel(h.point.x, h.point.y)) {
        const graphPoint = graph.screen2GraphCoords(h.point.x, h.point.y);
        const k = graph.zoom();
        const snap = 14 / k;
        let best: GraphNode | null = null;
        let bestDist = Infinity;
        for (const rawNode of graph.graphData().nodes as GraphNode[]) {
          if (rawNode.x === undefined || rawNode.y === undefined) continue;
          const d = Math.hypot(rawNode.x - graphPoint.x, rawNode.y - graphPoint.y);
          if (d < bestDist) {
            bestDist = d;
            best = rawNode;
          }
        }
        const hit = best && bestDist <= snap + Math.sqrt(best.degree || 0) ? best : null;
        hoverIdRef.current = hit?.id ?? null;

        if (hit) {
          const now = performance.now();
          if (dwell?.id !== hit.id) {
            dwell = { id: hit.id, startedAt: now, fired: false };
          } else if (!dwell.fired && now - dwell.startedAt > DWELL_MS) {
            dwell.fired = true;
            select(hit);
          }
        } else {
          dwell = null;
        }
        return;
      }
      dwell = null;
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Escape: close the open note first, then the map.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || !activeRef.current) return;
      if (selectedIdRef.current) select(null);
      else onCloseRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedNode = useMemo(
    () => (data?.nodes as GraphNode[] | undefined)?.find((node) => node.id === selectedId) ?? null,
    [data, selectedId],
  );

  // Connections derived from the graph itself (outlinks + backlinks).
  const connections = useMemo(() => {
    if (!data || !selectedId) return [];
    const related = new Map<string, "out" | "in">();
    for (const link of data.links) {
      const source = typeof link.source === "object" ? (link.source as GraphNode).id : link.source;
      const target = typeof link.target === "object" ? (link.target as GraphNode).id : link.target;
      if (source === selectedId) related.set(target, "out");
      else if (target === selectedId) related.set(source, "in");
    }
    return [...related.entries()]
      .map(([id, dir]) => ({ id, dir, node: data.nodes.find((node) => node.id === id) }))
      .filter((item) => item.node);
  }, [data, selectedId]);

  const folders = useMemo(() => [...folderColors.entries()], [folderColors]);

  return (
    <div className="brain-overlay">
      <div className={`brain-stage hud-hit ${selectedId ? "reading" : ""}`} ref={stageRef}>
        <div className="brain-canvas" ref={canvasHostRef} />

        <div className="brain-title">
          <BrainCircuit size={13} />
          Neural Map
          {status === "ready" && data ? (
            <span className="brain-count">
              {data.nodes.length} nodes · {data.links.length} links
            </span>
          ) : null}
        </div>

        <button type="button" className="hud-btn brain-close" onClick={onClose} title="Close (fist / Esc)">
          <X size={14} />
        </button>

        {status === "ready" ? (
          <div className="brain-legend">
            {folders.map(([folder, color]) => (
              <span key={folder} className="brain-legend-item">
                <i style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
                {folder}
              </span>
            ))}
          </div>
        ) : null}

        {status === "loading" ? <div className="brain-pill">Mapping the brain…</div> : null}
        {status === "error" ? <div className="brain-pill error">{error}</div> : null}
        {toast ? <div className="brain-pill toast">{toast}</div> : null}

        {selectedNode ? (
          <div className="brain-note" ref={panelRef}>
            <header className="brain-note-head">
              <span
                className="brain-note-folder"
                style={{ color: folderColors.get(selectedNode.folder) ?? "#8aa0b8" }}
              >
                {selectedNode.folder}
              </span>
              <button type="button" className="hud-btn" onClick={() => select(null)} title="Close note (fist / Esc)">
                <X size={13} />
              </button>
            </header>
            <h3 className="brain-note-title">{selectedNode.title}</h3>

            {note?.ok && note.meta && Object.keys(note.meta).length > 0 ? (
              <div className="brain-note-meta">
                {Object.entries(note.meta)
                  .filter(([key]) => !["notion_id", "synced", "source"].includes(key))
                  .slice(0, 8)
                  .map(([key, value]) => (
                    <span key={key} className="brain-meta-chip">
                      <em>{key}</em>
                      {value}
                    </span>
                  ))}
              </div>
            ) : null}

            <div className="brain-note-body">
              {note?.ok ? (
                <div className="markdown-body">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkBreaks]}
                    components={{
                      a: ({ href, children }) => {
                        if (href?.startsWith("#wiki=")) {
                          const target = decodeURIComponent(href.slice(6));
                          return (
                            <button
                              type="button"
                              className="brain-wikilink"
                              onClick={() => selectByTitle(target)}
                            >
                              {children}
                            </button>
                          );
                        }
                        return (
                          <a
                            href={href}
                            onClick={(event) => {
                              event.preventDefault();
                              if (href) window.iris.openExternal(href);
                            }}
                          >
                            {children}
                          </a>
                        );
                      },
                      img: ({ src, alt }) => (
                        <img
                          src={typeof src === "string" ? src : undefined}
                          alt={alt ?? ""}
                          loading="lazy"
                          onError={(event) => {
                            (event.currentTarget as HTMLImageElement).style.display = "none";
                          }}
                        />
                      ),
                    }}
                  >
                    {prepareBrainMarkdown(note.body || "*This note is empty.*")}
                  </ReactMarkdown>
                </div>
              ) : note ? (
                <p className="brain-note-error">{note.error}</p>
              ) : (
                <p className="brain-note-loading">Reading…</p>
              )}
            </div>

            {connections.length > 0 ? (
              <div className="brain-note-links">
                <span className="brain-links-label">Connections · {connections.length}</span>
                <div className="brain-links-list">
                  {connections.slice(0, 14).map(({ id, dir, node }) => (
                    <button key={id} type="button" className="brain-link-chip" onClick={() => selectById(id)}>
                      {dir === "in" ? "←" : "→"} {node!.title}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
