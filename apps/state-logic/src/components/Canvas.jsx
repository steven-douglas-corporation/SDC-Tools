/**
 * Canvas - React Flow diagram editor for state logic diagrams.
 * Features:
 *   - onConnectEnd: drag handle to empty canvas → create node + auto-connect
 *   - addNodeWithAutoConnect: shared helper for + button and sidebar drop
 *   - Ctrl+D (or Cmd+D): duplicate the currently selected node
 *   - Auto-generated verify conditions on edges via buildVerifyLabel
 */

import { useCallback, useRef, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Controls,
  MiniMap,
  useReactFlow,
  SelectionMode,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { StateNode } from './nodes/StateNode.jsx';
import { DecisionNode } from './nodes/DecisionNode.jsx';
import { RoutableEdge } from './edges/RoutableEdge.jsx';
import { useDiagramStore } from '../store/useDiagramStore.js';
import { buildVerifyLabel } from '../lib/conditionBuilder.js';
import { saveStandard, updateStandard } from '../lib/standardsLibrary.js';
import { computeStateNumbers } from '../lib/computeStateNumbers.js';
import { computeExitLabels, computeAutoRoute } from '../lib/edgeRouting.js';
import { OUTCOME_COLORS } from '../lib/outcomeColors.js';
import { computePresetWaypoints } from './ConnectMenu.jsx';

const nodeTypes = { stateNode: StateNode, decisionNode: DecisionNode };
const edgeTypes = { routableEdge: RoutableEdge };

/** Build edge condition data from the source node's actions */
function getVerifyEdgeData(sm, sourceNodeId) {
  if (!sm) return { conditionType: 'ready', label: 'Ready' };
  const sourceNode = (sm.nodes ?? []).find(n => n.id === sourceNodeId);

  // Initial/Home node → Ready condition
  if (sourceNode?.data?.isInitial) {
    return { conditionType: 'ready', label: 'Ready' };
  }

  const devices = sm.devices ?? [];
  if (!sourceNode || (sourceNode.data?.actions ?? []).length === 0) {
    return { conditionType: 'ready', label: 'Ready' };
  }

  // CheckResults branching: auto-assign outcome to this edge
  const actions = sourceNode.data?.actions ?? [];
  const checkAction = actions.find(a => {
    const dev = devices.find(d => d.id === a.deviceId);
    return dev?.type === 'CheckResults';
  });
  if (checkAction) {
    const checkDevice = devices.find(d => d.id === checkAction.deviceId);
    const outcomes = checkDevice?.outcomes ?? [];

    // SINGLE CONDITION: linear verify (no branching)
    if (outcomes.length === 1) {
      const outcome = outcomes[0];
      const label = outcome.label || 'Verify';
      return {
        conditionType: 'verify',
        label,
        conditions: [{
          tag: outcome.label,
          state: outcome.condition === 'off' || outcome.condition === 'outOfRange' ? 'Off' : 'On',
          role: 'verify-input',
          deviceId: checkDevice.id,
          outcomeId: outcome.id,
          inputRef: outcome.inputRef,
          condition: outcome.condition,
        }],
      };
    }

    // 2+ OUTCOMES: branching — auto-assign next unused outcome
    const existingEdges = (sm.edges ?? []).filter(e => e.source === sourceNodeId);
    const usedOutcomeIds = new Set(
      existingEdges
        .filter(e => e.data?.conditionType === 'checkResult')
        .map(e => e.data?.outcomeId)
    );
    const nextOutcome = outcomes.find(o => !usedOutcomeIds.has(o.id));
    if (nextOutcome) {
      const outcomeIdx = outcomes.indexOf(nextOutcome);
      const edgeLabel = nextOutcome.label || `Branch ${outcomeIdx + 1}`;
      return {
        conditionType: 'checkResult',
        deviceId:      checkDevice.id,
        outcomeId:     nextOutcome.id,
        outcomeLabel:  edgeLabel,
        outcomeIndex:  outcomeIdx,
        label:         edgeLabel,
        inputRef:      nextOutcome.inputRef,
        condition:     nextOutcome.condition,
        paramDeviceId: nextOutcome.paramDeviceId,
        paramScope:    nextOutcome.paramScope,
        crossSmId:     nextOutcome.crossSmId,
      };
    }
    return { conditionType: 'ready', label: 'Ready' };
  }

  // VisionInspect branching: auto-assign outcome to this edge
  const visionAction = actions.find(a => {
    const dev = devices.find(d => d.id === a.deviceId);
    return dev?.type === 'VisionSystem' && (a.operation === 'VisionInspect' || a.operation === 'Inspect') && a.outcomes?.length >= 2;
  });
  if (visionAction) {
    const outcomes = visionAction.outcomes;
    const existingEdges = (sm.edges ?? []).filter(e => e.source === sourceNodeId);
    const usedOutcomeIds = new Set(
      existingEdges
        .filter(e => e.data?.conditionType === 'visionResult')
        .map(e => e.data?.outcomeId)
    );
    const nextOutcome = outcomes.find(o => !usedOutcomeIds.has(o.id));
    if (nextOutcome) {
      const outcomeIdx = outcomes.indexOf(nextOutcome);
      const edgeLabel = nextOutcome.label || `Branch ${outcomeIdx + 1}`;
      return {
        conditionType: 'visionResult',
        outcomeId: nextOutcome.id,
        outcomeLabel: edgeLabel,
        outcomeIndex: outcomeIdx,
        label: edgeLabel,
      };
    }
    return { conditionType: 'ready', label: 'Ready' };
  }

  const { label, conditions } = buildVerifyLabel(sourceNode, devices);
  if (!label) return { conditionType: 'ready', label: 'Ready' };
  return { conditionType: 'verify', label, conditions };
}

// Viewport storage per SM (persists across tab lifetime, not in localStorage)
const smViewports = {};

/**
 * Compute the position of a source handle for axis-preservation math.
 * Mirrors the layout of StateNode's / DecisionNode's handles.
 */
function getSourceHandlePos(fromNode, handleId) {
  const nodeW = fromNode.measured?.width  ?? fromNode.width  ?? 240;
  const nodeH = fromNode.measured?.height ?? fromNode.height ?? 80;
  let x = fromNode.position.x + nodeW / 2;
  let y = fromNode.position.y + nodeH;
  if (handleId === 'exit-pass') {
    x = fromNode.position.x;
    y = fromNode.position.y + nodeH / 2;
  } else if (handleId === 'exit-fail') {
    x = fromNode.position.x + nodeW;
    y = fromNode.position.y + nodeH / 2;
  } else if (handleId === 'exit-retry') {
    x = fromNode.position.x + nodeW / 2;
    y = fromNode.position.y + nodeH;
  }
  return { x, y };
}

// (manual-draw helpers removed — every edge auto-routes)
// Local call sites resolve handle positions via getSourceHandlePos() first.

export function Canvas() {
  const store = useDiagramStore();
  const sm = store.getActiveSm();
  const project = store.project;
  // Auto-save state for standards-linked tabs (shown in SM header)
  const [standardSaveAt, setStandardSaveAt] = useState(null);
  const pendingStandardSaveRef = useRef(null);
  const reactFlowWrapper = useRef(null);
  const { screenToFlowPosition, setCenter, getViewport, setViewport, fitView, getNodes } = useReactFlow();
  const [selectMode, setSelectMode] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [activeRecoverySeqId, setActiveRecoverySeqId] = useState(null);
  const [starFormOpen, setStarFormOpen] = useState(false);
  const [starName, setStarName] = useState('');
  const [starDesc, setStarDesc] = useState('');
  const [starCategory, setStarCategory] = useState('');
  // Computed early so callbacks below can reference without TDZ
  const activeRecoverySeq = recoveryMode
    ? (sm?.recoverySeqs ?? []).find(r => r.id === activeRecoverySeqId) ?? (sm?.recoverySeqs ?? [])[0] ?? null
    : null;
  const activeSeqId = activeRecoverySeq?.id ?? null;
  const prevSmIdRef = useRef(null);

  // Reactive read of the connect-preset state. When the user clicks "Connect"
  // in the ConnectMenu, `_connectPreset` is set with the source node + handle.
  // The next node click finalizes the edge. While preset is active, we want
  // visual feedback on the canvas wrapper so users can see "I'm picking a
  // target now" — without it, target nodes look identical to non-target nodes
  // and feel hard to click. The wrapper gets `canvas-wrapper--picking-target`,
  // and a `data-source-id` attribute so CSS can dim the source node.
  const connectPreset = useDiagramStore(s => s._connectPreset);

  // Mark the source node's DOM element with `connect-source-node` so the CSS
  // can dim it (clearly "not a target"). React Flow renders nodes with
  // `data-id="<nodeId>"`, so we querySelector the matching element and toggle
  // the class. We do this imperatively because static CSS can't compare a
  // dynamic attribute (`data-connect-source-id` on the wrapper) with each
  // node's `data-id`. Cleanup removes the class when preset clears or the
  // source node changes.
  useEffect(() => {
    if (!connectPreset?.sourceNodeId) return;
    const wrapper = reactFlowWrapper.current;
    if (!wrapper) return;
    const sourceNode = wrapper.querySelector(
      `.react-flow__node[data-id="${connectPreset.sourceNodeId}"]`
    );
    if (!sourceNode) return;
    sourceNode.classList.add('connect-source-node');
    return () => sourceNode.classList.remove('connect-source-node');
  }, [connectPreset?.sourceNodeId]);

  // ── Auto-save standards-linked tabs back to the library ───────────────────
  // When this project is a standard (isStandard) AND it carries a standardId,
  // any change to the SM's nodes/edges/devices/name/description/category is
  // debounced-persisted to the localStorage Standards Library. On tab switch
  // or unmount, the pending save is flushed so no edits are lost.
  const standardId = project?.standardId;
  const isStandard = project?.isStandard === true;
  const stdNodes = sm?.nodes;
  const stdEdges = sm?.edges;
  const stdDevices = sm?.devices;
  const stdName = sm?.displayName ?? sm?.name ?? project?.name;
  const stdDesc = sm?.description;
  const stdCategory = sm?.category;
  useEffect(() => {
    if (!isStandard || !standardId || !sm) return;
    const doSave = () => {
      updateStandard(standardId, {
        name: stdName,
        description: stdDesc,
        category: stdCategory,
        nodes: stdNodes ?? [],
        edges: stdEdges ?? [],
        devices: stdDevices ?? [],
      });
      setStandardSaveAt(Date.now());
      pendingStandardSaveRef.current = null;
    };
    pendingStandardSaveRef.current = doSave;
    const timer = setTimeout(doSave, 400);
    return () => {
      clearTimeout(timer);
      // Flush any pending save before switching tabs / unmounting
      if (pendingStandardSaveRef.current) {
        pendingStandardSaveRef.current();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStandard, standardId, stdNodes, stdEdges, stdDevices, stdName, stdDesc, stdCategory]);

  // ── Re-space nodes vertically using designTheme.verticalNodeSpacing (as GAP) ─
  // Spacing = the visual gap between the bottom of one row and the top of
  // the next. Tall nodes get more vertical space; short nodes get less.
  // Preserves branches (nodes at ~same current Y stay on the same row).
  // If ≥2 nodes are selected, only re-spaces the selection; otherwise re-spaces all.
  const respaceVertically = useCallback(() => {
    if (!sm) return;
    const activeSeqId = useDiagramStore.getState()._activeRecoverySeqId;
    const rfNodes = getNodes(); // has measured heights + selection state
    const storeNodes = activeSeqId
      ? (sm.recoverySeqs ?? []).find(r => r.id === activeSeqId)?.nodes ?? []
      : sm.nodes ?? [];
    if (storeNodes.length < 2) return;

    const gap = Number(useDiagramStore.getState().project?.designTheme?.verticalNodeSpacing) || 80;

    // Attach measured height + selection flag.
    const rfById = new Map(rfNodes.map(n => [n.id, n]));
    const withMeta = storeNodes.map(n => {
      const rfn = rfById.get(n.id);
      return {
        ...n,
        _height: rfn?.measured?.height ?? rfn?.height ?? 120,
        _selected: rfn?.selected === true,
      };
    });

    // If 2+ nodes are selected, operate on just those; otherwise operate on all.
    const selectedCount = withMeta.filter(n => n._selected).length;
    const target = selectedCount >= 2 ? withMeta.filter(n => n._selected) : withMeta;
    if (target.length < 2) return;

    // Group target nodes into rows by current Y (ROW_TOLERANCE handles branch siblings).
    const ROW_TOLERANCE = 30;
    const sortedByY = [...target].sort((a, b) => a.position.y - b.position.y);
    const rows = []; // [{ anchorY, nodes, maxHeight }]
    for (const n of sortedByY) {
      const last = rows[rows.length - 1];
      if (last && Math.abs(n.position.y - last.anchorY) <= ROW_TOLERANCE) {
        last.nodes.push(n);
        last.maxHeight = Math.max(last.maxHeight, n._height);
      } else {
        rows.push({ anchorY: n.position.y, nodes: [n], maxHeight: n._height });
      }
    }

    // Walk rows top-to-bottom: nextRowTop = prevRowTop + prevRowMaxHeight + gap.
    const newTopById = new Map();
    let currentTop = rows[0].anchorY;
    for (let i = 0; i < rows.length; i++) {
      for (const n of rows[i].nodes) newTopById.set(n.id, currentTop);
      if (i < rows.length - 1) currentTop += rows[i].maxHeight + gap;
    }

    const changes = [];
    for (const n of target) {
      const newY = newTopById.get(n.id);
      if (newY !== undefined && Math.abs(newY - n.position.y) >= 0.5) {
        changes.push({ id: n.id, type: 'position', position: { x: n.position.x, y: newY } });
      }
    }

    if (changes.length === 0) return;
    store._pushHistory();
    if (activeSeqId) {
      store.onRecoveryNodesChange(sm.id, activeSeqId, changes);
    } else {
      store.onNodesChange(sm.id, changes);
    }
  }, [sm, store, getNodes]);

  // ── Straighten selected nodes (align centers to median center X) ─────────────
  const straightenSelected = useCallback(() => {
    if (!sm) return;
    const selected = getNodes().filter(n => n.selected);
    if (selected.length < 2) return;
    // Compute center X for each node, find the median
    const centers = selected.map(n => {
      const w = n.measured?.width ?? n.width ?? 240;
      return { id: n.id, centerX: n.position.x + w / 2, width: w, y: n.position.y };
    });
    const sorted = [...centers].sort((a, b) => a.centerX - b.centerX);
    const medianCenterX = sorted[Math.floor(sorted.length / 2)].centerX;
    store._pushHistory();
    const changes = centers
      .filter(c => Math.abs(c.centerX - medianCenterX) > 0.5)
      .map(c => ({
        id: c.id,
        type: 'position',
        position: { x: medianCenterX - c.width / 2, y: c.y },
      }));
    if (changes.length > 0) store.onNodesChange(sm.id, changes);
  }, [sm, store, getNodes]);

  // ── Viewport persistence per SM ──────────────────────────────────────────
  // Save viewport when switching away from an SM, restore when switching to one
  useEffect(() => {
    const currentSmId = sm?.id;
    const prevSmId = prevSmIdRef.current;

    // Save previous SM's viewport before switching
    if (prevSmId && prevSmId !== currentSmId) {
      try { smViewports[prevSmId] = getViewport(); } catch (_) { /* not mounted yet */ }
    }

    // Always fitView when switching to a new SM — show the whole sequence
    if (currentSmId && currentSmId !== prevSmId) {
      setTimeout(() => fitView({ padding: 0.2, duration: 250, maxZoom: 1 }), 50);
    }

    // Reset recovery mode when switching SMs
    if (currentSmId && currentSmId !== prevSmId) {
      setRecoveryMode(false);
      setActiveRecoverySeqId(null);
      useDiagramStore.setState({ _activeRecoverySeqId: null });
    }

    prevSmIdRef.current = currentSmId;
  }, [sm?.id]);

  // Sync recovery seq ID into store so per-seq actions route correctly
  useEffect(() => {
    useDiagramStore.setState({ _activeRecoverySeqId: recoveryMode ? activeRecoverySeqId : null });
  }, [recoveryMode, activeRecoverySeqId]);

  // Auto-select first recovery seq when entering recovery mode
  useEffect(() => {
    if (recoveryMode && sm && !activeRecoverySeqId) {
      const firstSeq = (sm.recoverySeqs ?? [])[0];
      if (firstSeq) setActiveRecoverySeqId(firstSeq.id);
    }
  }, [recoveryMode, sm, activeRecoverySeqId]);

  // Save viewport on every pan/zoom change
  const onMoveEnd = useCallback((_event, viewport) => {
    if (sm?.id) {
      smViewports[sm.id] = viewport;
    }
  }, [sm?.id]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    function handleKeyDown(e) {
      // Escape: cancel connect menu or connect preset
      if (e.key === 'Escape') {
        const { _connectPreset, _connectMenuNodeId } = useDiagramStore.getState();
        if (_connectMenuNodeId) {
          e.preventDefault();
          useDiagramStore.setState({ _connectMenuNodeId: null, _connectMenuHandleId: null, _connectPreset: null });
          return;
        }
        if (_connectPreset) {
          e.preventDefault();
          useDiagramStore.setState({ _connectPreset: null });
          return;
        }
      }

      const mod = e.ctrlKey || e.metaKey;
      // Ctrl+D: duplicate selected node
      if (mod && e.key === 'd') {
        e.preventDefault();
        const { activeSmId, selectedNodeId } = useDiagramStore.getState();
        if (activeSmId && selectedNodeId) {
          useDiagramStore.getState().duplicateNode(activeSmId, selectedNodeId);
        }
      }
      // Ctrl+Z: undo
      if (mod && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        useDiagramStore.getState().undo();
      }
      // Ctrl+Y or Ctrl+Shift+Z: redo
      if (mod && (e.key === 'y' || (e.key === 'Z' && e.shiftKey) || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        useDiagramStore.getState().redo();
      }
      // Delete / Backspace: delete selected node or edge
      // Skip if focus is inside an input/textarea/contenteditable (user is typing)
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const tag = document.activeElement?.tagName;
        const isEditing = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
        if (!isEditing) {
          const { activeSmId, selectedNodeId, selectedEdgeId, _activeRecoverySeqId } = useDiagramStore.getState();
          if (activeSmId && selectedNodeId) {
            if (_activeRecoverySeqId) {
              useDiagramStore.getState().deleteRecoveryNode(activeSmId, _activeRecoverySeqId, selectedNodeId);
            } else {
              useDiagramStore.getState().deleteNode(activeSmId, selectedNodeId);
            }
          } else if (activeSmId && selectedEdgeId) {
            if (_activeRecoverySeqId) {
              useDiagramStore.getState().deleteRecoveryEdge(activeSmId, _activeRecoverySeqId, selectedEdgeId);
            } else {
              useDiagramStore.getState().deleteEdge(activeSmId, selectedEdgeId);
            }
          }
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // ── Capture pre-drag snapshot for undo ────────────────────────────────────
  // Also set a global `_draggingNodeId` flag so RoutableEdge can bypass its
  // frozen manualRoute waypoints during the drag (see RoutableEdge.jsx for
  // the why). Cleared in onNodeDragStop below. Without this, the per-node
  // `dragging` flag from React Flow is async and the first drag deltas
  // render before it flips → edge appears to stick before catching up.
  const onNodeDragStart = useCallback((event, node) => {
    useDiagramStore.getState()._pushHistory();
    useDiagramStore.setState({ _draggingNodeId: node?.id ?? '__any__' });
  }, []);

  // ── Snap-to-vertical on drag stop ──────────────────────────────────────────
  // When a node is dropped within 25px of a connected node's X, snap it to align
  const onNodeDragStop = useCallback((event, node) => {
    const state = useDiagramStore.getState();
    const currentSm = state.getActiveSm();
    // Snap-to-straight threshold — configurable in Setup → Design System →
    // Canvas Spacing. Default 20px. When the dropped node's center X is
    // within this distance of any connected node's center X, snap to align
    // so the edge between them is a clean straight line (no Z-bend).
    // Set 0 to disable the snap entirely.
    const themeSnap = state.project?.designTheme?.snapStraightThreshold;
    const SNAP_THRESHOLD = themeSnap != null ? Number(themeSnap) : 20;
    if (!currentSm || SNAP_THRESHOLD <= 0) {
      useDiagramStore.setState({ _draggingNodeId: null });
      return;
    }

    // Recovery-aware: nodes/edges live on activeSeq when we're inside a
    // recovery sequence (Canvas shows "Recovery" mode). Reading sm.nodes/edges
    // here would silently miss everything — the snap loop would find no
    // connected nodes and never snap.
    const recoverySeqId = state._activeRecoverySeqId ?? null;
    const activeSeq = recoverySeqId
      ? (currentSm.recoverySeqs ?? []).find(r => r.id === recoverySeqId)
      : null;
    const isRecovery = !!activeSeq;
    const sourceNodes = isRecovery ? (activeSeq.nodes ?? []) : (currentSm.nodes ?? []);
    const sourceEdges = isRecovery ? (activeSeq.edges ?? []) : (currentSm.edges ?? []);

    // Find connected nodes (parent + child via edges)
    const connectedNodeIds = new Set();
    for (const e of sourceEdges) {
      if (e.source === node.id) connectedNodeIds.add(e.target);
      if (e.target === node.id) connectedNodeIds.add(e.source);
    }

    // Snap to closest connected node's center X if within threshold
    const nodeW = node.measured?.width ?? node.width ?? 240;
    const nodeCenterX = node.position.x + nodeW / 2;

    let snapCenterX = null;
    let minDist = SNAP_THRESHOLD;
    for (const nId of connectedNodeIds) {
      const connected = sourceNodes.find(n => n.id === nId);
      if (!connected) continue;
      const connW = connected.measured?.width ?? connected.width ?? 240;
      const connCenterX = connected.position.x + connW / 2;
      const dist = Math.abs(nodeCenterX - connCenterX);
      if (dist < minDist) {
        minDist = dist;
        snapCenterX = connCenterX;
      }
    }

    if (snapCenterX !== null) {
      const newX = snapCenterX - nodeW / 2;
      if (Math.abs(newX - node.position.x) > 0.5) {
        // onNodesChange is recovery-aware in the store — writes route to
        // the active recovery seq automatically when one is set.
        state.onNodesChange(currentSm.id, [{
          type: 'position',
          id: node.id,
          position: { x: newX, y: node.position.y },
        }]);
      }
    }
    // Clear the global drag flag — edges go back to using stored manualRoute.
    useDiagramStore.setState({ _draggingNodeId: null });
  }, []);

  // ── Scroll-wheel zoom: direct viewport control (scroll up = zoom in) ──────
  // We disable React Flow's built-in zoomOnScroll and drive the viewport
  // ourselves. Keeps zoom step small, direction predictable, anchors at the
  // mouse pointer. Ignore .nowheel subtrees (picker menus, node popups).
  useEffect(() => {
    const el = reactFlowWrapper.current;
    if (!el) return;
    function handleWheel(e) {
      // Let elements opt out (popups/menus/scroll areas)
      if (e.target.closest && e.target.closest('.nowheel')) return;
      e.preventDefault();

      const vp = getViewport();
      // Scroll up (deltaY < 0) → zoom in; scroll down → zoom out
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const nextZoom = Math.max(0.05, Math.min(2, vp.zoom * factor));

      // Keep the point under the mouse fixed during zoom
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      // Flow coord under mouse: (mx - vp.x) / vp.zoom
      // Solve for new vp.x/y so that same flow coord stays under (mx, my):
      const flowX = (mx - vp.x) / vp.zoom;
      const flowY = (my - vp.y) / vp.zoom;
      const nextX = mx - flowX * nextZoom;
      const nextY = my - flowY * nextZoom;
      setViewport({ x: nextX, y: nextY, zoom: nextZoom });
    }
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [getViewport, setViewport]);

  // ── Shared helper: add a node and auto-connect from previously selected ───
  const addNodeWithAutoConnect = useCallback((opts = {}) => {
    if (!sm) return null;

    const prevSelectedId = useDiagramStore.getState().selectedNodeId;
    const curSeqId = useDiagramStore.getState()._activeRecoverySeqId;
    const isRecovery = recoveryMode && !!curSeqId;
    const activeSeq = isRecovery
      ? (sm.recoverySeqs ?? []).find(r => r.id === curSeqId) ?? null
      : null;
    const currentNodes = isRecovery ? (activeSeq?.nodes ?? []) : (sm.nodes ?? []);
    const currentEdges = isRecovery ? (activeSeq?.edges ?? []) : (sm.edges ?? []);

    // Determine which node we'll connect from
    const connectFromId =
      prevSelectedId ??
      (currentNodes.length > 0 ? currentNodes[currentNodes.length - 1].id : null);

    // Default position: straight below source node (center-aligned); branch → offset right
    // New Y = source bottom + gap, so tall nodes get more vertical room and
    // the visual gap between nodes stays constant regardless of source height.
    if (!opts.position && connectFromId) {
      const sourceNode = currentNodes.find(n => n.id === connectFromId);
      if (sourceNode) {
        const existingOutEdges = currentEdges.filter(e => e.source === connectFromId);
        // Prefer React-Flow measured dimensions (live layout); fall back to stored values.
        const rfSource = getNodes().find(n => n.id === connectFromId);
        const srcW = rfSource?.measured?.width ?? sourceNode.measured?.width ?? sourceNode.width ?? 240;
        const srcH = rfSource?.measured?.height ?? sourceNode.measured?.height ?? sourceNode.height ?? 120;
        const gap = Number(useDiagramStore.getState().project?.designTheme?.verticalNodeSpacing) || 80;
        const newW = 240;
        const newY = sourceNode.position.y + srcH + gap;
        // Top-left aligned with parent (NOT measured-center aligned).
        // Centers based on momentary measured widths drift visually when
        // the child's content grows after spawn (e.g. picking a long
        // action label). Top-left alignment is stable: as either node
        // grows in width, both extend rightward and stay correlated.
        opts = { ...opts, position: { x: sourceNode.position.x, y: newY } };
      }
    }

    const newNodeId = isRecovery
      ? store.addRecoveryNode(sm.id, curSeqId, opts)
      : store.addNode(sm.id, opts);
    if (!newNodeId) return null;

    // Auto-connect from source node
    if (connectFromId && connectFromId !== newNodeId) {
      const edgeCond = getVerifyEdgeData(isRecovery ? { ...sm, nodes: currentNodes, edges: currentEdges } : sm, connectFromId);
      if (isRecovery) {
        store.addRecoveryEdge(sm.id, curSeqId,
          { source: connectFromId, sourceHandle: null, target: newNodeId, targetHandle: null },
          edgeCond
        );
      } else {
        store.addEdge(sm.id,
          { source: connectFromId, sourceHandle: null, target: newNodeId, targetHandle: null },
          edgeCond
        );
      }
    }

    store.setOpenPickerOnNode(newNodeId);

    const finalOpts = opts;
    if (finalOpts.position) {
      setTimeout(() => {
        setCenter(finalOpts.position.x + 120, finalOpts.position.y + 40, { zoom: getViewport().zoom, duration: 300 });
      }, 50);
    }

    return newNodeId;
  }, [sm, store, setCenter, getViewport, recoveryMode]);

  // ── Node / Edge change handlers ────────────────────────────────────────────
  const onNodesChange = useCallback((changes) => {
    if (!sm) return;
    if (recoveryMode && activeSeqId) {
      store.onRecoveryNodesChange(sm.id, activeSeqId, changes);
    } else {
      store.onNodesChange(sm.id, changes);
    }
  }, [sm, store, recoveryMode, activeSeqId]);

  const onEdgesChange = useCallback((changes) => {
    if (!sm) return;
    if (recoveryMode && activeSeqId) {
      store.onRecoveryEdgesChange(sm.id, activeSeqId, changes);
    } else {
      store.onEdgesChange(sm.id, changes);
    }
  }, [sm, store, recoveryMode, activeSeqId]);

  // ── Connection handlers ────────────────────────────────────────────────────

  /** Connection drag begins — no-op now that manual-draw is gone. */
  const onConnectStart = useCallback(() => {}, []);

  // Build decision/vision-exit edge data when dragging from a decision/vision node's pass/fail/single handle
  const getDecisionExitData = useCallback((sourceNodeId, sourceHandle) => {
    if (!sm || !sourceHandle) return null;
    const sourceNode = sm.nodes.find(n => n.id === sourceNodeId);
    if (!sourceNode) return null;

    // Recognize the source's "decision flavor":
    //  - DecisionNode (standalone)
    //  - StateNode with vision branching (`data.visionExitMode`)
    //  - StateNode with a v2 picker Branch action (newest path)
    const isDecision = sourceNode.type === 'decisionNode';
    const isVisionExit = sourceNode.type === 'stateNode' && sourceNode.data?.visionExitMode;
    // Find the latest v2 Branch action on this state — its edgeLabels drive the
    // pass/fail label when the user manually re-draws a deleted side branch.
    const v2BranchAction = sourceNode.type === 'stateNode'
      ? (sourceNode.data?.actions ?? [])
          .slice().reverse()
          .find(a => a?.pickerV2
            && a?.pickerConfig?.mode === 'decision'
            && a?.pickerConfig?.subAction === 'branch')
      : null;
    const isV2Branch = !!v2BranchAction;
    if (!isDecision && !isVisionExit && !isV2Branch) return null;

    const handle = sourceHandle;

    // Single-exit wait: SEQUENTIAL edge, not a pass-branch. Don't flag it as
    // a decision exit — that caused downstream coloring to paint it green.
    // It's just the wait's only path forward; it renders gray like any other
    // state-to-state edge.
    if (handle === 'exit-single') {
      return { conditionType: isVisionExit ? 'visionResult' : 'ready' };
    }

    // Retry exit: amber colored with "Retry_Fail" label
    if (handle === 'exit-retry') {
      const sigName = sourceNode.data?.signalName ?? '';
      const label = `Retry_Fail_${sigName}`;
      return {
        conditionType: 'ready',
        label,
        outcomeLabel: label,
        isDecisionExit: true,
        exitColor: 'retry',
      };
    }

    // Multi-outcome exits (exit-0, exit-1, exit-2, ...)
    const multiMatch = handle.match(/^exit-(\d+)$/);
    if (multiMatch) {
      const idx = parseInt(multiMatch[1], 10);
      const labels = sourceNode.data?.outcomeLabels ?? [];
      const label = labels[idx] ?? `Option ${idx + 1}`;
      const color = OUTCOME_COLORS[idx % OUTCOME_COLORS.length];
      return {
        conditionType: 'ready',
        label,
        outcomeLabel: label,
        isDecisionExit: true,
        exitColor: 'multi',
        outcomeIndex: idx,
      };
    }

    // Pass / Fail exits: colored with label
    if (handle !== 'exit-pass' && handle !== 'exit-fail') return null;
    const isPass = handle === 'exit-pass';

    // v2 Branch action on a state node — pull the label from the action's
    // edgeLabels (primary at index 0, fail at 1). Mirrors the auto-spawn
    // labels so a manually-redrawn branch matches the original visually.
    if (isV2Branch) {
      const labels = v2BranchAction.pickerConfig?.edgeLabels ?? [];
      const label = isPass ? (labels[0] ?? '') : (labels[1] ?? '');
      return {
        conditionType: 'custom',
        label,
        outcomeLabel: label,
        isDecisionExit: true,
        exitColor: isPass ? 'pass' : 'fail',
      };
    }

    if (isVisionExit) {
      // Vision node: use job name from VisionInspect action
      const visionAction = (sourceNode.data?.actions ?? []).find(a => a.operation === 'VisionInspect' || a.operation === 'Inspect');
      const jobName = visionAction?.jobName ?? '';
      const label = isPass ? `Pass_${jobName}` : `Fail_${jobName}`;
      return {
        conditionType: 'visionResult',
        label,
        outcomeLabel: label,
        isDecisionExit: true,
        exitColor: isPass ? 'pass' : 'fail',
      };
    }

    // Decision node — derive label from current node config (mode, conditionType, etc.)
    const computedLabels = computeExitLabels(sourceNode.data ?? {});
    let label;
    if (computedLabels) {
      label = isPass ? computedLabels.exit1 : computedLabels.exit2;
    } else {
      const sigName = sourceNode.data?.signalName ?? '';
      label = isPass ? `Pass_${sigName}` : `Fail_${sigName}`;
    }
    return {
      conditionType: 'ready',
      label,
      outcomeLabel: label,
      isDecisionExit: true,
      exitColor: isPass ? 'pass' : 'fail',
    };
  }, [sm]);

  /** React Flow drag-to-connect: drag from one handle to another. */
  const onConnect = useCallback((connection) => {
    if (!sm) return;
    const curSeqId = useDiagramStore.getState()._activeRecoverySeqId;
    const isRecovery = recoveryMode && !!curSeqId;
    const activeSeq = isRecovery ? (sm.recoverySeqs ?? []).find(r => r.id === curSeqId) : null;
    const currentNodes = isRecovery ? (activeSeq?.nodes ?? []) : (sm.nodes ?? []);
    const decExitData = getDecisionExitData(connection.source, connection.sourceHandle);
    const smForVerify = isRecovery ? { ...sm, nodes: currentNodes, edges: activeSeq?.edges ?? [] } : sm;
    const edgeCond = decExitData ?? getVerifyEdgeData(smForVerify, connection.source);
    const edgeId = isRecovery
      ? store.addRecoveryEdge(sm.id, curSeqId, connection, edgeCond)
      : store.addEdge(sm.id, connection, edgeCond);
    if (!decExitData) {
      store.setSelectedEdge(edgeId);
      store.openTransitionModal(edgeId);
    }
  }, [sm, store, getDecisionExitData, recoveryMode]);

  /** Drag-to-empty-canvas: create a new node at the cursor and connect to it. */
  const onConnectEnd = useCallback((event, connectionState) => {
    if (connectionState.toNode || !sm) return;
    const fromNode = connectionState.fromNode;
    if (!fromNode) return;

    const fromHandle = connectionState.fromHandle?.id ?? null;
    const cursorFlow = screenToFlowPosition({
      x: event.clientX ?? event.touches?.[0]?.clientX ?? 0,
      y: event.clientY ?? event.touches?.[0]?.clientY ?? 0,
    });

    const curSeqId2 = useDiagramStore.getState()._activeRecoverySeqId;
    const isRecovery2 = !!curSeqId2;
    const activeSeq2 = isRecovery2 ? (sm.recoverySeqs ?? []).find(r => r.id === curSeqId2) : null;
    const currentEdges2 = isRecovery2 ? (activeSeq2?.edges ?? []) : (sm.edges ?? []);

    const existingOutEdges = currentEdges2.filter(e => e.source === fromNode.id);
    const srcW = fromNode.measured?.width ?? fromNode.width ?? 240;
    const newW = 240;
    const centerAlignedX = fromNode.position.x + (srcW - newW) / 2;
    const position = {
      x: existingOutEdges.length > 0 ? cursorFlow.x : centerAlignedX,
      y: cursorFlow.y,
    };

    const newNodeId = isRecovery2
      ? store.addRecoveryNode(sm.id, curSeqId2, { position })
      : store.addNode(sm.id, { position });
    if (!newNodeId) return;

    const decExitData = getDecisionExitData(fromNode.id, fromHandle);
    const currentNodes2 = isRecovery2 ? (activeSeq2?.nodes ?? []) : (sm.nodes ?? []);
    const smForVerify2 = isRecovery2 ? { ...sm, nodes: currentNodes2, edges: currentEdges2 } : sm;
    const edgeCond = decExitData ?? getVerifyEdgeData(smForVerify2, fromNode.id);
    if (isRecovery2) {
      store.addRecoveryEdge(sm.id, curSeqId2,
        { source: fromNode.id, sourceHandle: fromHandle, target: newNodeId, targetHandle: null },
        edgeCond
      );
    } else {
      store.addEdge(sm.id,
        { source: fromNode.id, sourceHandle: fromHandle, target: newNodeId, targetHandle: null },
        edgeCond
      );
    }

    store.setOpenPickerOnNode(newNodeId);
  }, [sm, store, screenToFlowPosition, getDecisionExitData]);

  // ── Click handlers ────────────────────────────────────────────────────────

  /**
   * Complete a Connect Menu preset connection.
   * Called when _connectPreset is active and user clicks a target node.
   */
  const finalizePresetConnect = useCallback((targetNodeId) => {
    const preset = useDiagramStore.getState()._connectPreset;
    if (!preset || !sm) return;

    const { sourceNodeId, sourceHandle, routeType } = preset;
    if (targetNodeId === sourceNodeId) return; // can't connect to self

    const curSeqId4 = useDiagramStore.getState()._activeRecoverySeqId;
    const isRecovery4 = !!curSeqId4;
    const activeSeq4 = isRecovery4 ? (sm.recoverySeqs ?? []).find(r => r.id === curSeqId4) : null;
    const currentNodes4 = isRecovery4 ? (activeSeq4?.nodes ?? []) : (sm.nodes ?? []);

    const fromNode = currentNodes4.find(n => n.id === sourceNodeId);
    const toNode = currentNodes4.find(n => n.id === targetNodeId);
    if (!fromNode || !toNode) return;

    const srcPos = getSourceHandlePos(fromNode, sourceHandle);
    const tgtNodeW = toNode.measured?.width ?? toNode.width ?? 240;
    const tgtPos = { x: toNode.position.x + tgtNodeW / 2, y: toNode.position.y };

    const { loopSide } = computePresetWaypoints(
      routeType, srcPos, tgtPos, sourceHandle, currentNodes4
    );

    const decExitData = getDecisionExitData(sourceNodeId, sourceHandle);
    const smForVerify4 = isRecovery4 ? { ...sm, nodes: currentNodes4, edges: activeSeq4?.edges ?? [] } : sm;
    const edgeCond = decExitData ?? getVerifyEdgeData(smForVerify4, sourceNodeId);

    // Loop presets only set `loopSide` — auto-route reads it on every
    // render and U's around the chosen side. No frozen waypoints.
    if (loopSide) {
      edgeCond.loopSide = loopSide;
    }

    const tgtHandle = toNode.type === 'decisionNode' ? 'input' : null;

    const edgeId = isRecovery4
      ? store.addRecoveryEdge(sm.id, curSeqId4,
          { source: sourceNodeId, sourceHandle, target: targetNodeId, targetHandle: tgtHandle },
          edgeCond
        )
      : store.addEdge(sm.id,
          { source: sourceNodeId, sourceHandle, target: targetNodeId, targetHandle: tgtHandle },
          edgeCond
        );

    useDiagramStore.setState({ _connectPreset: null, _connectMenuNodeId: null, _connectMenuHandleId: null });
    store.clearSelection();

    if (!decExitData && edgeId) {
      store.setSelectedEdge(edgeId);
      store.openTransitionModal(edgeId);
    }
  }, [sm, store, getDecisionExitData]);

  const onNodeClick = useCallback((event, node) => {
    // If Connect Menu preset is active, complete the connection
    const preset = useDiagramStore.getState()._connectPreset;
    if (preset) {
      if (node.id !== preset.sourceNodeId) {
        finalizePresetConnect(node.id);
        return;
      }
    }
    store.setSelectedNode(node.id);
  }, [store, finalizePresetConnect]);

  const onEdgeClick = useCallback((event, edge) => {
    // If Connect Menu preset is active, connect to the edge's target node
    const preset = useDiagramStore.getState()._connectPreset;
    if (preset && edge.target && edge.target !== preset.sourceNodeId) {
      finalizePresetConnect(edge.target);
      return;
    }
    store.setSelectedEdge(edge.id);
  }, [store, finalizePresetConnect]);

  const onEdgeDoubleClick = useCallback((event, edge) => {
    store.setSelectedEdge(edge.id);
    store.openTransitionModal(edge.id);
  }, [store]);

  const onPaneClick = useCallback(() => {
    // Close connect menu / preset on pane click
    const { _connectPreset, _connectMenuNodeId } = useDiagramStore.getState();
    if (_connectMenuNodeId || _connectPreset) {
      useDiagramStore.setState({ _connectMenuNodeId: null, _connectMenuHandleId: null, _connectPreset: null });
      return;
    }
    store.clearSelection();
    useDiagramStore.setState(s => ({ _closePickerSignal: s._closePickerSignal + 1 }));
  }, [store]);

  // ── Drag-from-sidebar drop ────────────────────────────────────────────────
  const onDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback((event) => {
    event.preventDefault();
    if (!sm) return;

    const label = event.dataTransfer.getData('application/state-node-label');
    if (!label && event.dataTransfer.getData('application/state-node') !== 'true') return;

    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    addNodeWithAutoConnect({ position, ...(label ? { label } : {}) });
  }, [sm, addNodeWithAutoConnect, screenToFlowPosition]);

  // Compute state numbers and inject into node data
  // (hooks must always run — React forbids hooks after an early return)
  const devices = sm?.devices ?? [];
  const smEdges = recoveryMode ? (activeRecoverySeq?.edges ?? []) : (sm?.edges ?? []);
  const smNodes = recoveryMode ? (activeRecoverySeq?.nodes ?? []) : (sm?.nodes ?? []);
  const { stateMap: stateNumberMap, visionSubStepsMap } = useMemo(
    () => sm ? computeStateNumbers(smNodes, smEdges, devices, recoveryMode ? { startAt: 100, completeStep: 124 } : {}) : { stateMap: new Map(), visionSubStepsMap: new Map() },
    [sm, smNodes, smEdges, devices, recoveryMode]
  );

  const nodes = useMemo(() => {
    if (!sm) return [];
    return smNodes.map(n => {
      // dragHandle: only the `.node-drag-handle` element (rendered inside
      // each StateNode/DecisionNode) initiates a node drag. Clicks on any
      // other part of the node body go to their normal handlers — no more
      // accidentally moving a node while clicking an action chip.
      const dragHandle = '.node-drag-handle';

      // DecisionNode: inject stateNumber (same sequence as state nodes)
      if (n.type === 'decisionNode') {
        return {
          ...n,
          dragHandle,
          data: {
            ...n.data,
            stateNumber: stateNumberMap.get(n.id) ?? 0,
          },
        };
      }

      const visionSubSteps = visionSubStepsMap.get(n.id);
      // Inject visionSubSteps into each Inspect action for rendering
      let actions = n.data?.actions;
      if (visionSubSteps && actions) {
        actions = actions.map(a => {
          const dev = devices.find(d => d.id === a.deviceId);
          if (dev?.type === 'VisionSystem' && (a.operation === 'Inspect' || a.operation === 'VisionInspect')) {
            return { ...a, visionSubSteps };
          }
          return a;
        });
      }
      return {
        ...n,
        dragHandle,
        data: {
          ...n.data,
          stateNumber: stateNumberMap.get(n.id) ?? 0,
          ...(actions !== n.data?.actions ? { actions } : {}),
        },
      };
    });
  }, [sm, smNodes, stateNumberMap, visionSubStepsMap, devices]);

  // Always use RoutableEdge; show labels only on branch edges (vision/check results).
  // Edges sourced from OR targeting a decisionNode use 'straight' type for natural routing.
  const edges = useMemo(() => {
    if (!sm) return [];
    // Build a fast lookup map for nodes by id
    const nodesById = {};
    for (const n of smNodes) nodesById[n.id] = n;

    // ── Merge detection ──────────────────────────────────────────────────────
    // For each edge ending at a target T, check if there's another edge to T
    // whose source node is in the SAME X column as T. That sibling is the
    // "primary" straight-down path; THIS edge's last vertical drop (the
    // bottom of a Z-bend) duplicates the bottom of the sibling's vertical
    // line into T. We tag THIS edge with `_trimLastSegment=true` so
    // RoutableEdge drops its last segment and ends at the merge point.
    // The arrow then sits on the horizontal segment pointing into the merge
    // column — communicating "this path joins the column here".
    //
    // Detection heuristic: two edges share target T. The "primary" edge has
    // a source whose center X is within a tolerance of T's center X (i.e.
    // straight up the same column). The OTHER edge gets the trim flag.
    // Both edges drawing the same vertical drop into T is the visual noise
    // we want to eliminate.
    const COLUMN_TOL = 8;
    const trimSet = new Set();
    const edgesByTarget = new Map();
    for (const e of smEdges) {
      if (!e.target) continue;
      const list = edgesByTarget.get(e.target) ?? [];
      list.push(e);
      edgesByTarget.set(e.target, list);
    }
    edgesByTarget.forEach((list, targetId) => {
      if (list.length < 2) return;
      const tgtNode = nodesById[targetId];
      if (!tgtNode) return;
      const tgtCenterX = tgtNode.position.x + (tgtNode.measured?.width ?? 240) / 2;
      // Find the "primary" edge — source X aligned with target column.
      const primary = list.find(e => {
        const src = nodesById[e.source];
        if (!src) return false;
        const srcCenterX = src.position.x + (src.measured?.width ?? 240) / 2;
        return Math.abs(srcCenterX - tgtCenterX) < COLUMN_TOL;
      });
      if (!primary) return;
      // All OTHER edges to this target get trimmed.
      for (const e of list) {
        if (e.id !== primary.id) trimSet.add(e.id);
      }
    });

    return smEdges.map(e => {
      const isBranch = e.data?.conditionType === 'visionResult' || e.data?.conditionType === 'checkResult';
      const sourceNode = nodesById[e.source];
      const targetNode = nodesById[e.target];
      // Ensure edges going TO a decision node always target the 'input' handle
      let targetHandle = e.targetHandle;
      if (targetNode?.type === 'decisionNode' && !targetHandle) {
        targetHandle = 'input';
      }

      // Decision exit edges (pass/fail/multi): colored label — exit-single is plain gray
      const isDecisionExit = e.data?.isDecisionExit === true && e.sourceHandle !== 'exit-single';
      if (isDecisionExit) {
        const isPass = e.data?.exitColor === 'pass';
        const isMulti = e.data?.exitColor === 'multi';
        // Only force targetHandle='input' if targeting a decisionNode; stateNodes use default (null)
        const decTargetHandle = targetNode?.type === 'decisionNode' ? 'input' : (e.targetHandle ?? null);

        // Color: multi-outcome uses OUTCOME_COLORS palette, otherwise pass=green fail=red
        let color;
        if (isMulti) {
          const idx = e.data?.outcomeIndex ?? 0;
          color = OUTCOME_COLORS[idx % OUTCOME_COLORS.length];
        } else {
          color = isPass ? '#16a34a' : '#dc2626';
        }

        // ── Live label: always derive from the source decision node's current
        //    config so labels stay in sync even if edge data is stale.
        let liveLabel = e.data?.outcomeLabel ?? '';
        if (sourceNode?.type === 'decisionNode' && e.sourceHandle !== 'exit-single') {
          const sn = sourceNode.data ?? {};
          // Multi-outcome: live label from stored outcomeLabels array
          if (isMulti && sn.outcomeLabels) {
            const idx = e.data?.outcomeIndex ?? 0;
            if (idx < sn.outcomeLabels.length) liveLabel = sn.outcomeLabels[idx];
          } else {
            // Prefer stored labels on the node (respects user customization).
            // Fall back to computed defaults only if unset.
            const computedLabels = computeExitLabels(sn);
            if (e.sourceHandle === 'exit-pass')  liveLabel = sn.exit1Label ?? computedLabels?.exit1 ?? liveLabel;
            if (e.sourceHandle === 'exit-fail')  liveLabel = sn.exit2Label ?? computedLabels?.exit2 ?? liveLabel;
            // Retry branch label stays as stored
          }
        }

        return {
          ...e,
          targetHandle: decTargetHandle,
          type: 'routableEdge',
          // Pass live label through BOTH label prop and data.outcomeLabel so
          // RoutableEdge's pill renderer always shows the correct text.
          data: { ...(e.data ?? {}), outcomeLabel: liveLabel, _trimLastSegment: trimSet.has(e.id) },
          label: e.sourceHandle === 'exit-single' ? '' : liveLabel,
          labelStyle: { fill: '#fff', fontWeight: 600, fontSize: 11 },
          labelBgStyle: { fill: color, rx: 4, ry: 4 },
          labelBgPadding: [4, 8],
          style: { stroke: color, strokeWidth: 2 },
          markerEnd: { type: 'ArrowClosed', color },
        };
      }

      // All other edges (including loop-backs TO decision nodes) use routableEdge.
      //
      // Single-exit wait edges (sourceHandle='exit-single') are SEQUENTIAL — they
      // connect a wait's only outgoing path to the next state. Older data (and the
      // store's create path at the time) baked green pass-branch styling onto
      // them, which is wrong: a wait with one exit isn't a decision. Strip that
      // styling here so they render like any state-to-state edge (RF default gray).
      // This covers existing project files without needing a data migration.
      const isExitSingle = e.sourceHandle === 'exit-single';
      const base = {
        ...e,
        targetHandle,
        type: 'routableEdge',
        label: isBranch ? (e.data?.outcomeLabel ?? e.data?.label ?? '') : '',
        // Inject trim flag from the merge-detection pass above. RoutableEdge
        // checks `data._trimLastSegment` and drops its last segment.
        data: { ...(e.data ?? {}), _trimLastSegment: trimSet.has(e.id) },
      };
      if (isExitSingle) {
        // Force gray sequential look, discard any stale colored-branch styling.
        base.style = undefined;
        base.markerEnd = undefined;
        base.labelStyle = undefined;
        base.labelBgStyle = undefined;
        base.labelBgPadding = undefined;
        base.label = '';
      }
      return base;
    });
  }, [sm, smEdges, smNodes]);

  // ── Empty state ────────────────────────────────────────────────────────────
  if (!sm) {
    return (
      <div className="canvas-empty">
        <div className="canvas-empty__content">
          <div className="canvas-empty__icon">&#x26A1;</div>
          <h2>No State Machine Selected</h2>
          <p>Create a new state machine to begin building your sequence logic.</p>
          <button className="btn btn--primary btn--lg" onClick={store.openNewSmModal}>
            + New State Machine
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`canvas-wrapper${connectPreset ? ' canvas-wrapper--picking-target' : ''}`}
      ref={reactFlowWrapper}
      data-connect-source-id={connectPreset?.sourceNodeId ?? ''}
    >
      {/* SM title header on canvas */}
      {sm && (
        <div className={`canvas-sm-title${recoveryMode ? ' canvas-sm-title--recovery' : ''}`}>
          <span className="canvas-sm-title__number">S{String(sm.stationNumber ?? 0).padStart(2, '0')}</span>
          <span className="canvas-sm-title__name">{sm.name || 'Untitled'}</span>
          {/* Normal / Recovery toggle. I/O Map lives in the toolbar I/O
              button now (popup) — no need to take canvas tab space too. */}
          <div className="canvas-mode-toggle">
            <button
              className={`canvas-mode-btn${!recoveryMode ? ' canvas-mode-btn--active' : ''}`}
              onClick={() => setRecoveryMode(false)}
            >Normal</button>
            <button
              className={`canvas-mode-btn${recoveryMode ? ' canvas-mode-btn--active canvas-mode-btn--recovery' : ''}`}
              onClick={() => setRecoveryMode(true)}
            >Recovery</button>
          </div>
          {/* Recovery variant selector */}
          {recoveryMode && (sm.recoverySeqs ?? []).length > 1 && (
            <select
              className="canvas-recovery-seq-select"
              value={activeRecoverySeqId ?? ''}
              onChange={e => setActiveRecoverySeqId(e.target.value)}
            >
              {(sm.recoverySeqs ?? []).map(r => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          )}
          {/* Standards auto-save indicator — shown only when this tab is
              linked to a library entry (isStandard + standardId). Replaces
              the ★ button because there's nothing to manually save. */}
          {isStandard && standardId ? (
            <span
              className="canvas-standard-saved"
              title="This tab is linked to the Standards Library. All edits are saved automatically."
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                marginLeft: 8, fontSize: 11, fontWeight: 600,
                color: recoveryMode ? '#fff' : '#16a34a',
                background: recoveryMode ? 'rgba(255,255,255,0.15)' : 'rgba(22,163,74,0.12)',
                padding: '3px 8px', borderRadius: 10,
              }}
            >
              <span style={{ fontSize: 10 }}>★</span>
              {standardSaveAt ? 'Saved' : 'Linked'}
            </span>
          ) : (
            <button
              className="canvas-star-btn"
              title="Save to Standards Library"
              onClick={() => {
                setStarName(sm.name || '');
                setStarDesc('');
                setStarCategory('');
                setStarFormOpen(v => !v);
              }}
            >★</button>
          )}
        </div>
      )}
      {/* Star save form — floats below the header */}
      {starFormOpen && sm && (
        <div className="canvas-star-form">
          <div className="canvas-star-form__title">Save to Standards Library</div>
          <input
            className="canvas-star-form__input"
            placeholder="Name"
            value={starName}
            onChange={e => setStarName(e.target.value)}
          />
          <input
            className="canvas-star-form__input"
            placeholder="Category (optional)"
            value={starCategory}
            onChange={e => setStarCategory(e.target.value)}
          />
          <textarea
            className="canvas-star-form__input canvas-star-form__textarea"
            placeholder="Description (optional)"
            value={starDesc}
            onChange={e => setStarDesc(e.target.value)}
            rows={2}
          />
          <div className="canvas-star-form__btns">
            <button
              className="canvas-star-form__save"
              disabled={!starName.trim()}
              onClick={() => {
                saveStandard({
                  name: starName.trim(),
                  description: starDesc.trim(),
                  category: starCategory.trim(),
                  nodes: sm.nodes ?? [],
                  edges: sm.edges ?? [],
                  devices: sm.devices ?? [],
                });
                setStarFormOpen(false);
              }}
            >Save</button>
            <button className="canvas-star-form__cancel" onClick={() => setStarFormOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        connectOnClick={false}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onEdgeDoubleClick={onEdgeDoubleClick}
        onPaneClick={onPaneClick}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        // 0 = the node moves on the FIRST pixel of mouse movement.
        // React Flow's default (1) means small mouse jitter is ignored —
        // but for our case it makes the edge appear to "stick" at the
        // start of a drag because the node hasn't moved yet but the
        // user expected it to.
        nodeDragThreshold={0}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onMoveEnd={onMoveEnd}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        minZoom={0.05}
        zoomOnScroll={false}
        zoomOnPinch={true}
        panOnScroll={false}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        defaultEdgeOptions={{
          type: 'routableEdge',
          style: { stroke: '#6b7280', strokeWidth: 2 },
          markerEnd: { type: 'ArrowClosed', color: '#6b7280' },
        }}
        deleteKeyCode={null}
        selectionOnDrag={selectMode}
        selectionMode={SelectionMode.Partial}
        panOnDrag={selectMode ? [1, 2] : true}
        proOptions={{ hideAttribution: true }}
      >
        {/* No grid — machine image background on wrapper is the only bg */}
        <Controls position="top-right" style={{ top: 50, right: 10 }} showInteractive={false} />
        <MiniMap
          style={{ bottom: 16, right: 16 }}
          nodeColor={(n) => {
            if (n.type === 'decisionNode') return n.data?.decisionType === 'vision' ? '#f59e0b' : '#0072B5';
            return n.data?.isInitial ? '#5a9a48' : '#4a89b8';
          }}
          maskColor="rgba(255,255,255,0.7)"
        />

        {/* Missing Home Node banner */}
        {sm && (sm.nodes ?? []).length > 0 && !(sm.nodes ?? []).some(n => n.data?.isInitial) && (
          <div className="canvas-missing-home">
            <span>⚠ No Home node</span>
            <button className="btn btn--sm btn--primary" onClick={() => store.addHomeNode(sm.id)}>
              + Add Home Node
            </button>
          </div>
        )}

      </ReactFlow>
      {/* Machine watermark — sits on top of React Flow pane, pointer-events: none so you can still click through */}
      <div style={{
        position: 'absolute',
        inset: 0,
        backgroundImage: 'url(/bg-machine.jpg)',
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'center center',
        backgroundSize: 'cover',
        opacity: 0.25,
        pointerEvents: 'none',
        zIndex: 1,
      }} />

      {/* Canvas bottom toolbar — outside ReactFlow so it never overlaps diagram nodes */}
      <div className="canvas-bottom-bar">
        <div className="canvas-bottom-bar__tools">
          <div className="canvas-tool">
            <button
              className="btn btn--circle btn--primary"
              onClick={() => addNodeWithAutoConnect()}
              title="Add new state step (Ctrl+D duplicates selected)"
            >
              +
            </button>
            <span className="canvas-tool__label">Add State</span>
          </div>
          <div className="canvas-tool">
            <button
              className="btn btn--circle btn--ghost canvas-renumber-btn"
              onClick={() => {
                if (sm) {
                  const curSeqId = useDiagramStore.getState()._activeRecoverySeqId;
                  if (curSeqId) store.onRecoveryNodesChange(sm.id, curSeqId, []);
                  else store.onNodesChange(sm.id, []);
                }
              }}
              title="Renumber states (follows edge connections)"
            >
              #
            </button>
            <span className="canvas-tool__label">Renumber</span>
          </div>
        </div>
        <div className="canvas-bottom-bar__actions">
          <button
            className={`btn btn--sm canvas-select-btn${selectMode ? ' canvas-select-btn--active' : ''}`}
            onClick={() => setSelectMode(m => !m)}
            title={selectMode ? 'Selection mode ON — drag to select nodes. Click to exit.' : 'Click to enter selection mode'}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="1" y="1" width="14" height="14" strokeDasharray="3 2" rx="1" />
              <path d="M11 7L13 14L10.5 11.5L8 14L6 7" fill="currentColor" stroke="currentColor" strokeWidth="1" />
            </svg>
            <span>{selectMode ? 'Select ON' : 'Select'}</span>
          </button>
          <button
            className="btn btn--sm canvas-select-btn"
            onClick={straightenSelected}
            title="Align selected nodes vertically (same X position)"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="1" x2="8" y2="15" />
              <polyline points="4,5 8,1 12,5" />
              <polyline points="4,11 8,15 12,11" />
              <circle cx="4" cy="8" r="1.5" fill="currentColor" />
              <circle cx="12" cy="8" r="1.5" fill="currentColor" />
            </svg>
            <span>Straighten</span>
          </button>
          <button
            className="btn btn--sm canvas-select-btn"
            onClick={respaceVertically}
            title="Re-space nodes vertically to the Design System gap value. With a selection: only the selected nodes. Nothing selected: all nodes."
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="1.5" width="10" height="3" rx="0.5" />
              <rect x="3" y="11.5" width="10" height="3" rx="0.5" />
              <line x1="8" y1="6" x2="8" y2="10" />
              <polyline points="6,7 8,5 10,7" />
              <polyline points="6,9 8,11 10,9" />
            </svg>
            <span>Re-space</span>
          </button>
        </div>
      </div>
    </div>
  );
}

