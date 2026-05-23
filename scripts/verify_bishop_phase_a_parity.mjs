import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(__dirname, 'fixtures', 'bishop-phase-a');
const REL_TOL = 1e-6;
const ABS_TOL = 1e-8;

function approxEqual(a, b, relTol = REL_TOL, absTol = ABS_TOL) {
  if (a == null && b == null) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= Math.max(absTol, relTol * scale);
}

function fail(messages, message) {
  messages.push(message);
}

function compareCounts(messages, legacy, regions, fixtureName) {
  const legacyCount = legacy?.allResults?.length || 0;
  const regionCount = regions?.allResults?.length || 0;
  if (legacyCount !== regionCount) {
    fail(messages, `${fixtureName}: result count mismatch ${legacyCount} vs ${regionCount}`);
  }

  const legacyRejects = legacy?.rejectionCounts || {};
  const regionRejects = regions?.rejectionCounts || {};
  const allReasons = new Set([...Object.keys(legacyRejects), ...Object.keys(regionRejects)]);
  [...allReasons].sort().forEach((reason) => {
    const left = legacyRejects[reason] || 0;
    const right = regionRejects[reason] || 0;
    if (left !== right) {
      fail(messages, `${fixtureName}: rejection count mismatch for "${reason}" ${left} vs ${right}`);
    }
  });
}

function compareSlices(messages, legacy, regions, fixtureName) {
  const legacySlices = legacy?.critical?.slices || [];
  const regionSlices = regions?.critical?.slices || [];
  if (legacySlices.length !== regionSlices.length) {
    fail(messages, `${fixtureName}: slice count mismatch ${legacySlices.length} vs ${regionSlices.length}`);
    return;
  }
  legacySlices.forEach((legacySlice, index) => {
    const regionSlice = regionSlices[index];
    if (!approxEqual(legacySlice.W, regionSlice.W)) {
      fail(messages, `${fixtureName}: slice ${index + 1} weight mismatch ${legacySlice.W} vs ${regionSlice.W}`);
    }
    if ((legacySlice.baseMaterial?.id || null) !== (regionSlice.baseMaterial?.id || null)) {
      fail(
        messages,
        `${fixtureName}: slice ${index + 1} base material mismatch ${legacySlice.baseMaterial?.id} vs ${regionSlice.baseMaterial?.id}`
      );
    }
    const legacyAreas = new Map((legacySlice.layerAreas || []).map((item) => [item.materialId, item]));
    const regionAreas = new Map((regionSlice.layerAreas || []).map((item) => [item.materialId, item]));
    const allMaterialIds = new Set([...legacyAreas.keys(), ...regionAreas.keys()]);
    [...allMaterialIds].forEach((materialId) => {
      const left = legacyAreas.get(materialId);
      const right = regionAreas.get(materialId);
      if (!left || !right) {
        fail(messages, `${fixtureName}: slice ${index + 1} layerAreas missing material ${materialId}`);
        return;
      }
      if (!approxEqual(left.area, right.area)) {
        fail(messages, `${fixtureName}: slice ${index + 1} area mismatch for ${materialId}: ${left.area} vs ${right.area}`);
      }
      if (!approxEqual(left.weight, right.weight)) {
        fail(
          messages,
          `${fixtureName}: slice ${index + 1} weight mismatch for ${materialId}: ${left.weight} vs ${right.weight}`
        );
      }
    });
  });
}

function compareCritical(messages, legacy, regions, fixtureName) {
  compareCounts(messages, legacy, regions, fixtureName);
  if (!legacy?.critical && !regions?.critical) {
    return;
  }
  if (!legacy?.critical || !regions?.critical) {
    fail(messages, `${fixtureName}: critical result presence mismatch`);
    return;
  }
  const fields = ['FS', 'F_bishop', 'F_m', 'F_f', 'lambda', 'wallForceTotal'];
  fields.forEach((field) => {
    if (!approxEqual(legacy.critical?.[field], regions.critical?.[field])) {
      fail(messages, `${fixtureName}: critical ${field} mismatch ${legacy.critical?.[field]} vs ${regions.critical?.[field]}`);
    }
  });
  if ((legacy.critical?.method || null) !== (regions.critical?.method || null)) {
    fail(messages, `${fixtureName}: critical method mismatch ${legacy.critical?.method} vs ${regions.critical?.method}`);
  }
  if ((legacy.critical?.spencerConverged || false) !== (regions.critical?.spencerConverged || false)) {
    fail(messages, `${fixtureName}: critical Spencer convergence mismatch`);
  }
  if ((legacy.critical?.intersectsWall || false) !== (regions.critical?.intersectsWall || false)) {
    fail(messages, `${fixtureName}: critical wall-intersection flag mismatch`);
  }
  compareSlices(messages, legacy, regions, fixtureName);
}

function compareWallProbes(messages, debugWallPassiveSegmentsForTest, legacyModel, regionModel, probes, fixtureName) {
  (probes || []).forEach((probe, index) => {
    const wallIndex = Number.isInteger(probe?.wallIndex) ? probe.wallIndex : 0;
    const yIntersect = Number(probe?.yIntersect);
    const legacyWall = legacyModel?.walls?.[wallIndex];
    const regionWall = regionModel?.walls?.[wallIndex];
    if (!legacyWall || !regionWall || !Number.isFinite(yIntersect)) {
      fail(messages, `${fixtureName}: invalid wall probe ${index + 1}`);
      return;
    }

    const legacy = debugWallPassiveSegmentsForTest(legacyModel, legacyWall, yIntersect, 'legacy-bands');
    const regions = debugWallPassiveSegmentsForTest(regionModel, regionWall, yIntersect, 'regions');

    if (!approxEqual(legacy?.xProbe, regions?.xProbe)) {
      fail(messages, `${fixtureName}: wall probe ${index + 1} xProbe mismatch ${legacy?.xProbe} vs ${regions?.xProbe}`);
    }
    if (!approxEqual(legacy?.terrainSurfaceY, regions?.terrainSurfaceY)) {
      fail(
        messages,
        `${fixtureName}: wall probe ${index + 1} terrain surface mismatch ${legacy?.terrainSurfaceY} vs ${regions?.terrainSurfaceY}`
      );
    }

    const legacySegments = legacy?.segments || [];
    const regionSegments = regions?.segments || [];
    if (legacySegments.length !== regionSegments.length) {
      fail(messages, `${fixtureName}: wall probe ${index + 1} segment count mismatch ${legacySegments.length} vs ${regionSegments.length}`);
      return;
    }

    legacySegments.forEach((segment, segmentIndex) => {
      const other = regionSegments[segmentIndex];
      if (!approxEqual(segment.yBottom, other?.yBottom) || !approxEqual(segment.yTop, other?.yTop)) {
        fail(
          messages,
          `${fixtureName}: wall probe ${index + 1} segment ${segmentIndex + 1} bounds mismatch ${segment.yBottom}-${segment.yTop} vs ${other?.yBottom}-${other?.yTop}`
        );
      }
      if (!approxEqual(segment.gamma, other?.gamma)) {
        fail(
          messages,
          `${fixtureName}: wall probe ${index + 1} segment ${segmentIndex + 1} gamma mismatch ${segment.gamma} vs ${other?.gamma}`
        );
      }
      if ((segment.material?.id || null) !== (other?.material?.id || null)) {
        fail(
          messages,
          `${fixtureName}: wall probe ${index + 1} segment ${segmentIndex + 1} material mismatch ${segment.material?.id} vs ${other?.material?.id}`
        );
      }
    });
  });
}

function verifyWallBypassClassification(messages, analyzeBishopSearch, buildBishopModelFromStageLayers) {
  const layers = [{ top: 0, bot: 12, type: 'Sand', subtype: 'Sand', c: 3, phi: 30, g: 18, gs: 20 }];
  const baseState = {
    terrain: [{ x: 0, y: 4 }, { x: 8, y: 4 }, { x: 20, y: 0 }],
    phreatic: [],
    activeCptX: 4,
    analysisDepth: 12,
    strengthSet: 'characteristic',
    surfaceLoads: []
  };
  const baseSearch = {
    entryZone: { xStart: 1, xEnd: 4 },
    exitZone: { xStart: 14, xEnd: 19 },
    methodMode: 'bishop_only',
    searchConfig: {
      nEntry: 4,
      nExit: 5,
      nCenter: 8,
      centerOffsetMin: 0.7,
      centerOffsetMax: 3.0,
      minChordLength: 2,
      minSlipThickness: 0.5,
      maxExitAngleDeg: 65,
      validationSamples: 24,
      geomTol: 0.001,
      minSliceWidth: 0.05,
      targetSlices: 28,
      keepBest: 8
    },
    solverConfig: { initialFS: 1, tolerance: 1e-4, maxIterations: 60, minMAlpha: 1e-6 }
  };
  const cases = [
    {
      name: 'vertical shallow wall',
      wall: { id: 'w1', x: 9, yTop: 4, yTip: 3.2, passiveSide: 'right' }
    },
    {
      name: 'inclined shallow wall',
      wall: {
        id: 'w1',
        head: { x: 9, y: 4 },
        tip: { x: 10, y: 3.2 },
        x: 9,
        yTop: 4,
        yTip: 3.2,
        passiveSide: 'right'
      }
    }
  ];

  cases.forEach(({ name, wall }) => {
    const model = buildBishopModelFromStageLayers(layers, { ...baseState, walls: [wall] });
    const result = analyzeBishopSearch({ ...baseSearch, model });
    const belowCount = (result.allResults || []).filter((item) => item.passesBelowWall).length;
    if (belowCount <= 0) {
      fail(messages, `${name}: expected at least one below-wall classification`);
    }
    if (!result.wallSummary?.criticalBelowWall) {
      fail(messages, `${name}: expected wallSummary.criticalBelowWall to be populated`);
    }
  });
}

async function main() {
  const server = await createServer({
    configFile: false,
    appType: 'custom',
    logLevel: 'error',
    server: {
      middlewareMode: true,
      hmr: false,
      ws: false
    }
  });

  try {
    const { analyzeBishopSearch, buildBishopModelFromStageLayers, debugWallPassiveSegmentsForTest } = await server.ssrLoadModule(
      '/src/lib/cpt-app/stage6-bishop.js'
    );
    const files = fs.readdirSync(fixtureDir).filter((name) => name.endsWith('.json')).sort();
    const messages = [];

    for (const file of files) {
      const fixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, file), 'utf8'));
      const legacyModel = buildBishopModelFromStageLayers(fixture.layers, fixture.bishopState, {
        includeLegacyBands: true
      });
      const regionModel = buildBishopModelFromStageLayers(fixture.layers, fixture.bishopState);
      const baseInput = {
        entryZone: fixture.entryZone,
        exitZone: fixture.exitZone,
        methodMode: fixture.methodMode,
        searchConfig: fixture.searchConfig,
        solverConfig: fixture.solverConfig,
        spencerConfig: fixture.spencerConfig
      };
      const legacy = analyzeBishopSearch({
        ...baseInput,
        model: legacyModel,
        soilSource: 'legacy-bands'
      });
      const regions = analyzeBishopSearch({
        ...baseInput,
        model: regionModel,
        soilSource: 'regions'
      });

      compareCritical(messages, legacy, regions, fixture.name || file);
      compareWallProbes(
        messages,
        debugWallPassiveSegmentsForTest,
        legacyModel,
        regionModel,
        fixture.wallProbes,
        fixture.name || file
      );
    }

    verifyWallBypassClassification(messages, analyzeBishopSearch, buildBishopModelFromStageLayers);

    if (messages.length) {
      console.error('Phase A parity verification failed:\n');
      messages.forEach((message) => console.error(`- ${message}`));
      process.exitCode = 1;
      return;
    }

    console.log(`Phase A parity verification passed for ${files.length} fixture(s).`);
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
