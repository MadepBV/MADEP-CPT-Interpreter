// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

const EPS = 1e-12;
const DEFAULT_MECHANISM_SCORE_THRESHOLD = 0.65;
const DEFAULT_MECHANISM_CANDIDATE_THRESHOLD = 0.40;
const DEFAULT_MECHANISM_PLASTIC_THRESHOLD = 1e-8;

function clamp01(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(Math.max(numeric, 0), 1);
}

function finitePositive(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function elementCornerNodeIds(element) {
  return (element || []).slice(0, 3)
    .map((nodeId) => Math.trunc(Number(nodeId)))
    .filter((nodeId) => Number.isInteger(nodeId) && nodeId >= 0);
}

function edgeKey(n1, n2) {
  return n1 < n2 ? `${n1}:${n2}` : `${n2}:${n1}`;
}

export function buildSafetyMechanismElementNeighbors(mesh) {
  if (Array.isArray(mesh?.safetyMechanismElementNeighbors)
      && mesh.safetyMechanismElementNeighbors.length === (mesh.elements?.length || 0)) {
    return mesh.safetyMechanismElementNeighbors;
  }

  const elements = Array.isArray(mesh?.elements) ? mesh.elements : [];
  const edgeMap = new Map();
  elements.forEach((element, elementIndex) => {
    const nodes = elementCornerNodeIds(element);
    if (nodes.length < 3) return;
    [[nodes[0], nodes[1]], [nodes[1], nodes[2]], [nodes[2], nodes[0]]].forEach(([n1, n2]) => {
      const key = edgeKey(n1, n2);
      if (!edgeMap.has(key)) edgeMap.set(key, []);
      edgeMap.get(key).push(elementIndex);
    });
  });

  const neighbors = Array.from({ length: elements.length }, () => new Set());
  edgeMap.forEach((elementIndices) => {
    if (elementIndices.length <= 1) return;
    for (let i = 0; i < elementIndices.length; i += 1) {
      for (let j = i + 1; j < elementIndices.length; j += 1) {
        neighbors[elementIndices[i]].add(elementIndices[j]);
        neighbors[elementIndices[j]].add(elementIndices[i]);
      }
    }
  });

  const out = neighbors.map((set) => [...set]);
  if (mesh && typeof mesh === 'object') mesh.safetyMechanismElementNeighbors = out;
  return out;
}

function meshBounds(mesh) {
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  (mesh?.nodes || []).forEach((node) => {
    const x = Number(node?.x);
    const y = Number(node?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    xMin = Math.min(xMin, x);
    xMax = Math.max(xMax, x);
    yMin = Math.min(yMin, y);
    yMax = Math.max(yMax, y);
  });
  if (!(Number.isFinite(xMin) && Number.isFinite(xMax) && Number.isFinite(yMin) && Number.isFinite(yMax))) {
    return { xMin: 0, xMax: 0, yMin: 0, yMax: 0, diagonal: 0 };
  }
  return { xMin, xMax, yMin, yMax, diagonal: Math.hypot(xMax - xMin, yMax - yMin) };
}

function boundaryNodeSets(mesh, load) {
  const terrainNodes = new Set();
  const nonTerrainBoundaryNodes = new Set();
  const loadedTerrainNodes = new Set();
  const q = Math.abs(Number(load?.q) || 0);
  const xStart = Math.min(Number(load?.xStart) || 0, Number(load?.xEnd) || 0);
  const xEnd = Math.max(Number(load?.xStart) || 0, Number(load?.xEnd) || 0);
  const hasLoadFootprint = q > EPS && xEnd > xStart + EPS;

  (mesh?.constraintEdges || []).forEach((edge) => {
    if (edge?.markerType !== 'outer') return;
    const ids = edge?.nodeIds || [edge?.n1, edge?.n2];
    const isTerrain = edge?.source === 'terrain' || edge?.type === 'terrain';
    ids.forEach((rawNodeId) => {
      const nodeId = Math.trunc(Number(rawNodeId));
      if (!Number.isInteger(nodeId) || nodeId < 0) return;
      if (isTerrain) {
        terrainNodes.add(nodeId);
        const x = Number(mesh?.nodes?.[nodeId]?.x);
        if (hasLoadFootprint && Number.isFinite(x) && x >= xStart - EPS && x <= xEnd + EPS) {
          loadedTerrainNodes.add(nodeId);
        }
      } else {
        nonTerrainBoundaryNodes.add(nodeId);
      }
    });
  });

  return { terrainNodes, nonTerrainBoundaryNodes, loadedTerrainNodes };
}

function elementCentroidDisplacement(element, nodalDisplacements) {
  const nodeIds = elementCornerNodeIds(element);
  if (!nodeIds.length) return { ux: 0, uy: 0 };
  let ux = 0;
  let uy = 0;
  nodeIds.forEach((nodeId) => {
    ux += Number(nodalDisplacements?.[nodeId]?.ux) || 0;
    uy += Number(nodalDisplacements?.[nodeId]?.uy) || 0;
  });
  return { ux: ux / nodeIds.length, uy: uy / nodeIds.length };
}

function elementPlasticMetrics(elementResult, plasticThreshold) {
  const gaussPoints = Array.isArray(elementResult?.gaussPoints) ? elementResult.gaussPoints : [];
  let maxIncrement = Math.max(Number(elementResult?.materialDiagnostics?.safetyEquivalentPlasticIncrement) || 0, 0);
  let plasticMass = 0;
  let activePointCount = 0;
  if (gaussPoints.length) {
    gaussPoints.forEach((gp) => {
      const increment = Math.max(Number(gp?.materialDiagnostics?.safetyEquivalentPlasticIncrement) || 0, 0);
      const weight = finitePositive(gp?.areaWeight, 1 / gaussPoints.length);
      maxIncrement = Math.max(maxIncrement, increment);
      plasticMass += increment * weight;
      if (increment >= plasticThreshold) activePointCount += 1;
    });
  } else {
    plasticMass = maxIncrement * finitePositive(elementResult?.area, 1);
    activePointCount = maxIncrement >= plasticThreshold ? 1 : 0;
  }
  return {
    maxIncrement,
    plasticMass,
    activePointCount,
    active: activePointCount > 0
  };
}

function connectedComponents(activeElementSet, neighbors) {
  const seen = new Set();
  const components = [];
  activeElementSet.forEach((start) => {
    if (seen.has(start)) return;
    const stack = [start];
    const component = [];
    seen.add(start);
    while (stack.length) {
      const current = stack.pop();
      component.push(current);
      (neighbors[current] || []).forEach((neighborIndex) => {
        if (!activeElementSet.has(neighborIndex) || seen.has(neighborIndex)) return;
        seen.add(neighborIndex);
        stack.push(neighborIndex);
      });
    }
    components.push(component);
  });
  return components;
}

function componentBounds(mesh, component) {
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  component.forEach((elementIndex) => {
    elementCornerNodeIds(mesh?.elements?.[elementIndex]).forEach((nodeId) => {
      const node = mesh?.nodes?.[nodeId];
      const x = Number(node?.x);
      const y = Number(node?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      xMin = Math.min(xMin, x);
      xMax = Math.max(xMax, x);
      yMin = Math.min(yMin, y);
      yMax = Math.max(yMax, y);
    });
  });
  if (!(Number.isFinite(xMin) && Number.isFinite(xMax) && Number.isFinite(yMin) && Number.isFinite(yMax))) {
    return { diagonal: 0 };
  }
  return { xMin, xMax, yMin, yMax, diagonal: Math.hypot(xMax - xMin, yMax - yMin) };
}

function componentTouchFlags(mesh, load, component) {
  const { terrainNodes, nonTerrainBoundaryNodes, loadedTerrainNodes } = boundaryNodeSets(mesh, load);
  let touchesLoaded = false;
  let touchesFreeSurface = false;
  let touchesFreeSurfaceAwayFromLoad = false;
  let touchesBoundary = false;

  component.forEach((elementIndex) => {
    elementCornerNodeIds(mesh?.elements?.[elementIndex]).forEach((nodeId) => {
      if (loadedTerrainNodes.has(nodeId)) touchesLoaded = true;
      if (terrainNodes.has(nodeId)) {
        touchesFreeSurface = true;
        if (!loadedTerrainNodes.has(nodeId)) touchesFreeSurfaceAwayFromLoad = true;
      }
      if (nonTerrainBoundaryNodes.has(nodeId)) touchesBoundary = true;
    });
  });

  return {
    mechanismTouchesLoadedZone: touchesLoaded,
    mechanismTouchesFreeSurface: touchesFreeSurface,
    mechanismTouchesBoundary: touchesBoundary,
    mechanismCrossesSlopeOrFoundationZone: touchesLoaded && (touchesFreeSurfaceAwayFromLoad || touchesBoundary)
  };
}

function displacementDirectionCoherence(mesh, component, elementMasses, nodalDisplacements, displacementTolerance) {
  const vectors = [];
  component.forEach((elementIndex) => {
    const disp = elementCentroidDisplacement(mesh?.elements?.[elementIndex], nodalDisplacements);
    const norm = Math.hypot(disp.ux, disp.uy);
    if (!(norm > displacementTolerance)) return;
    vectors.push({
      ux: disp.ux,
      uy: disp.uy,
      nx: disp.ux / norm,
      ny: disp.uy / norm,
      weight: finitePositive(elementMasses[elementIndex], EPS)
    });
  });
  if (!vectors.length) return 0;

  const totalWeight = vectors.reduce((sum, item) => sum + item.weight, 0);
  const meanUx = vectors.reduce((sum, item) => sum + item.weight * item.ux, 0) / Math.max(totalWeight, EPS);
  const meanUy = vectors.reduce((sum, item) => sum + item.weight * item.uy, 0) / Math.max(totalWeight, EPS);
  let cxx = 0;
  let cxy = 0;
  let cyy = 0;
  vectors.forEach((item) => {
    const dx = item.ux - meanUx;
    const dy = item.uy - meanUy;
    cxx += item.weight * dx * dx;
    cxy += item.weight * dx * dy;
    cyy += item.weight * dy * dy;
  });
  cxx /= Math.max(totalWeight, EPS);
  cxy /= Math.max(totalWeight, EPS);
  cyy /= Math.max(totalWeight, EPS);

  let px = 1;
  let py = 0;
  if (Math.abs(cxx) + Math.abs(cxy) + Math.abs(cyy) > EPS) {
    const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    px = Math.cos(angle);
    py = Math.sin(angle);
  } else {
    const meanNorm = Math.hypot(meanUx, meanUy);
    if (!(meanNorm > displacementTolerance)) return 0;
    px = meanUx / meanNorm;
    py = meanUy / meanNorm;
  }

  const orientation = vectors.reduce((sum, item) => sum + item.weight * (item.nx * px + item.ny * py), 0);
  if (orientation < 0) {
    px = -px;
    py = -py;
  }
  const meanCosine = vectors.reduce((sum, item) => sum + item.weight * (item.nx * px + item.ny * py), 0)
    / Math.max(totalWeight, EPS);
  return clamp01(meanCosine);
}

function plasticGrowthOverWindow(curve, options) {
  const history = Array.isArray(curve) ? curve.filter((point) => Number.isFinite(Number(point?.maxDeltaPlasticStrain))) : [];
  if (history.length < 2) return 0;
  const windowSize = Math.max(Math.round(Number(options?.safetyMechanismPlateauWindow) || 4), 2);
  const window = history.slice(-windowSize);
  const first = Number(window[0]?.maxDeltaPlasticStrain) || 0;
  const last = Number(window[window.length - 1]?.maxDeltaPlasticStrain) || 0;
  return Math.max(last - first, 0);
}

export function emptySafetyMechanismSummary(overrides = {}) {
  return {
    status: 'none',
    score: 0,
    threshold: DEFAULT_MECHANISM_SCORE_THRESHOLD,
    maxDeltaPlasticStrain: 0,
    totalDeltaPlasticStrain: 0,
    activePlasticPointCount: 0,
    activePlasticElementCount: 0,
    connectedComponentCount: 0,
    largestConnectedComponentElementCount: 0,
    largestConnectedComponentPlasticMass: 0,
    componentMassRatio: 0,
    mechanismLength: 0,
    plasticGrowthOverWindow: 0,
    mechanismTouchesLoadedZone: false,
    mechanismTouchesFreeSurface: false,
    mechanismTouchesBoundary: false,
    mechanismCrossesSlopeOrFoundationZone: false,
    displacementDirectionCoherence: 0,
    ...overrides
  };
}

export function buildSafetyMechanismSummary({
  mesh,
  load,
  elementResults,
  nodalDisplacements,
  safetyCurve = [],
  options = {}
}) {
  const elements = Array.isArray(mesh?.elements) ? mesh.elements : [];
  const results = Array.isArray(elementResults) ? elementResults : [];
  if (!elements.length || !results.length) return emptySafetyMechanismSummary();

  const plasticThreshold = Math.max(
    Number(options?.safetyMechanismPlasticThreshold ?? options?.mechanismPlasticThreshold ?? DEFAULT_MECHANISM_PLASTIC_THRESHOLD) || DEFAULT_MECHANISM_PLASTIC_THRESHOLD,
    0
  );
  const scoreThreshold = Math.max(
    Number(options?.safetyMechanismScoreThreshold) || DEFAULT_MECHANISM_SCORE_THRESHOLD,
    EPS
  );
  const candidateThreshold = Math.min(
    Math.max(Number(options?.safetyMechanismCandidateThreshold) || DEFAULT_MECHANISM_CANDIDATE_THRESHOLD, 0),
    scoreThreshold
  );
  const displacementTolerance = Math.max(Number(options?.safetyMechanismDisplacementTolerance) || 1e-12, 0);
  const minPlateauPlasticGrowth = Math.max(Number(options?.safetyMechanismMinPlasticIncrement) || 1e-8, EPS);

  const elementMasses = new Array(elements.length).fill(0);
  const activeElementSet = new Set();
  let maxDeltaPlasticStrain = 0;
  let totalDeltaPlasticStrain = 0;
  let activePlasticPointCount = 0;

  for (let elementIndex = 0; elementIndex < elements.length; elementIndex += 1) {
    const metrics = elementPlasticMetrics(results[elementIndex], plasticThreshold);
    elementMasses[elementIndex] = metrics.plasticMass;
    totalDeltaPlasticStrain += metrics.plasticMass;
    maxDeltaPlasticStrain = Math.max(maxDeltaPlasticStrain, metrics.maxIncrement);
    activePlasticPointCount += metrics.activePointCount;
    if (metrics.active) activeElementSet.add(elementIndex);
  }

  if (activeElementSet.size === 0) {
    return emptySafetyMechanismSummary({
      threshold: scoreThreshold,
      maxDeltaPlasticStrain,
      totalDeltaPlasticStrain
    });
  }

  const neighbors = buildSafetyMechanismElementNeighbors(mesh);
  const components = connectedComponents(activeElementSet, neighbors);
  let largestComponent = [];
  let largestMass = 0;
  components.forEach((component) => {
    const mass = component.reduce((sum, elementIndex) => sum + finitePositive(elementMasses[elementIndex], 0), 0);
    if (mass > largestMass || (mass === largestMass && component.length > largestComponent.length)) {
      largestMass = mass;
      largestComponent = component;
    }
  });

  const bounds = meshBounds(mesh);
  const largestBounds = componentBounds(mesh, largestComponent);
  const mechanismLength = largestComponent.length >= 2 ? largestBounds.diagonal : 0;
  const touchFlags = componentTouchFlags(mesh, load, largestComponent);
  const coherence = displacementDirectionCoherence(
    mesh,
    largestComponent,
    elementMasses,
    nodalDisplacements,
    displacementTolerance
  );
  const growth = plasticGrowthOverWindow(safetyCurve, options);

  const componentMassRatio = largestMass / Math.max(totalDeltaPlasticStrain, EPS);
  const componentMassScore = clamp01(componentMassRatio);
  const mechanismLengthScore = clamp01(mechanismLength / Math.max(bounds.diagonal, EPS));
  const boundaryContactScore = clamp01(
    0.4 * (touchFlags.mechanismTouchesLoadedZone ? 1 : 0)
    + 0.4 * ((touchFlags.mechanismTouchesFreeSurface || touchFlags.mechanismTouchesBoundary) ? 1 : 0)
    + 0.2 * (touchFlags.mechanismCrossesSlopeOrFoundationZone ? 1 : 0)
  );
  const directionScore = clamp01(coherence);
  const plasticGrowthScore = clamp01(growth / Math.max(minPlateauPlasticGrowth, EPS));
  const score = clamp01(
    0.35 * componentMassScore
    + 0.20 * mechanismLengthScore
    + 0.15 * boundaryContactScore
    + 0.15 * directionScore
    + 0.15 * plasticGrowthScore
  );
  const status = score >= scoreThreshold
    ? 'coherent'
    : score >= candidateThreshold
      ? 'candidate'
      : 'scattered';

  return emptySafetyMechanismSummary({
    status,
    score,
    threshold: scoreThreshold,
    maxDeltaPlasticStrain,
    totalDeltaPlasticStrain,
    activePlasticPointCount,
    activePlasticElementCount: activeElementSet.size,
    connectedComponentCount: components.length,
    largestConnectedComponentElementCount: largestComponent.length,
    largestConnectedComponentPlasticMass: largestMass,
    componentMassRatio,
    mechanismLength,
    plasticGrowthOverWindow: growth,
    ...touchFlags,
    displacementDirectionCoherence: coherence
  });
}
