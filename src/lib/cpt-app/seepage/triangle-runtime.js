// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

const IS_NODE = typeof process === 'object' && typeof process?.versions?.node === 'string';
const triangleWasmUrl = new URL('./assets/triangle.out.wasm', import.meta.url);

let modulePromise = null;
let triangleLogs = [];

function pushTriangleLog(message) {
  const text = String(message || '').trim();
  if (!text) return;
  triangleLogs.push(text);
  if (triangleLogs.length > 40) triangleLogs = triangleLogs.slice(-40);
}

function clearTriangleLogs() {
  triangleLogs = [];
}

function summarizeTriangleLogs() {
  const deduped = [];
  triangleLogs.forEach((line) => {
    if (!deduped.includes(line)) deduped.push(line);
  });
  return deduped;
}

function resetTriangleModule() {
  modulePromise = null;
}

async function loadWasmBinary() {
  if (IS_NODE) {
    const fs = await import('node:fs/promises');
    return new Uint8Array(await fs.readFile(triangleWasmUrl));
  }

  const response = await fetch(triangleWasmUrl.href);
  if (!response.ok) {
    throw new Error(`Failed to load Triangle WASM (${response.status} ${response.statusText}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function getTriangleModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const { default: createTriangleModule } = await import('triangle-wasm/triangle.out.js');
      const wasmBinary = await loadWasmBinary();
      return createTriangleModule({
        wasmBinary,
        noExitRuntime: true,
        print: pushTriangleLog,
        printErr: pushTriangleLog,
        onAbort: pushTriangleLog
      });
    })();
  }
  return modulePromise;
}

function getHeapName(type) {
  switch (type) {
    case Float64Array:
      return 'HEAPF64';
    case Int32Array:
      return 'HEAP32';
    default:
      return 'HEAP8';
  }
}

function ensureTypedArray(values, type) {
  if (!values) return null;
  return values.constructor === type ? values : new type(values);
}

function arrayToHeap(Module, values, type = Int32Array) {
  if (!values?.length) return 0;
  const typed = ensureTypedArray(values, type);
  const ptr = Module._malloc(typed.length * typed.BYTES_PER_ELEMENT);
  const heap = Module[getHeapName(type)];
  const offset = ptr / typed.BYTES_PER_ELEMENT;
  heap.subarray(offset, offset + typed.length).set(typed);
  return ptr;
}

function heapToArray(Module, ptr, length, type = Int32Array) {
  if (!ptr || !length) return [];
  const heap = Module[getHeapName(type)];
  const offset = ptr / type.BYTES_PER_ELEMENT;
  return Array.from(heap.subarray(offset, offset + length));
}

function stringToHeap(Module, value) {
  const text = String(value || '');
  const length = Module.lengthBytesUTF8(text) + 1;
  const ptr = Module._malloc(length);
  Module.stringToUTF8(text, ptr, length);
  return ptr;
}

function buildSwitchesString(switches) {
  if (typeof switches === 'string') return switches;
  const config = typeof switches === 'object' && switches ? switches : {};
  let out = '';

  if (config.pslg !== false) out += 'p';
  out += 'z';
  if (config.quiet !== false) out += 'Q';
  if (config.refine === true) out += 'r';
  if (config.regionAttr === true) out += 'A';
  if (config.convexHull === true) out += 'c';
  if (config.ccdt === true) out += 'D';
  if (config.jettison === true) out += 'j';
  if (config.edges === true) out += 'e';
  if (config.neighbors === true) out += 'n';
  if (config.quadratic === true) out += 'o2';
  if (config.bndMarkers === false) out += 'B';
  if (config.holes === false) out += 'O';
  if (typeof config.steiner === 'number') out += `S${config.steiner}`;
  if (typeof config.quality === 'number') out += `q${config.quality}`;
  else if (config.quality === true) out += 'q';
  if (typeof config.area === 'number') out += `a${config.area}`;
  else if (config.area === true) out += 'a';

  return out;
}

class TriangulateIO {
  static LENGTH = 23;

  constructor(Module, props = null) {
    this.Module = Module;
    this.ptr = Module._malloc(TriangulateIO.LENGTH * Int32Array.BYTES_PER_ELEMENT);
    this.arr = Module.HEAP32.subarray(this.ptr / Int32Array.BYTES_PER_ELEMENT, this.ptr / Int32Array.BYTES_PER_ELEMENT + TriangulateIO.LENGTH);
    this.arr.set(new Int32Array(TriangulateIO.LENGTH));
    Object.entries(props || {}).forEach(([key, value]) => {
      if (key in this) this[key] = value;
    });
  }

  destroy(all = false) {
    const Module = this.Module;
    [0, 1, 2, 5, 6, 7, 8, 12, 13, 19, 20, 21].forEach((index) => {
      Module._free(this.arr[index]);
    });
    if (all) {
      Module._free(this.arr[15]);
      Module._free(this.arr[17]);
    }
    Module._free(this.ptr);
  }

  set pointlist(value) {
    this.arr[0] = arrayToHeap(this.Module, value, Float64Array);
    this.arr[3] = value ? ~~(value.length * 0.5) : 0;
  }

  set pointattributelist(value) {
    this.arr[1] = arrayToHeap(this.Module, value, Float64Array);
    this.arr[4] = value ? ~~(value.length / Math.max(this.numberofpoints, 1)) : 0;
  }

  set pointmarkerlist(value) {
    this.arr[2] = arrayToHeap(this.Module, value, Int32Array);
  }

  set trianglelist(value) {
    this.arr[5] = arrayToHeap(this.Module, value, Int32Array);
    this.arr[9] = value ? ~~(value.length / 3) : 0;
  }

  set triangleattributelist(value) {
    this.arr[6] = arrayToHeap(this.Module, value, Float64Array);
    this.arr[11] = value ? ~~(value.length / Math.max(this.numberoftriangles, 1)) : 0;
  }

  set trianglearealist(value) {
    this.arr[7] = arrayToHeap(this.Module, value, Float64Array);
  }

  set neighborlist(value) {
    this.arr[8] = arrayToHeap(this.Module, value, Int32Array);
  }

  set segmentlist(value) {
    this.arr[12] = arrayToHeap(this.Module, value, Int32Array);
    this.arr[14] = value ? ~~(value.length * 0.5) : 0;
  }

  set segmentmarkerlist(value) {
    this.arr[13] = arrayToHeap(this.Module, value, Int32Array);
  }

  set holelist(value) {
    this.arr[15] = arrayToHeap(this.Module, value, Float64Array);
    this.arr[16] = value ? ~~(value.length * 0.5) : 0;
  }

  set regionlist(value) {
    this.arr[17] = arrayToHeap(this.Module, value, Float64Array);
    this.arr[18] = value ? ~~(value.length * 0.25) : 0;
  }

  set edgelist(value) {
    this.arr[19] = arrayToHeap(this.Module, value, Int32Array);
    this.arr[22] = value ? ~~(value.length * 0.5) : 0;
  }

  set edgemarkerlist(value) {
    this.arr[20] = arrayToHeap(this.Module, value, Int32Array);
  }

  set normlist(value) {
    this.arr[21] = arrayToHeap(this.Module, value, Float64Array);
  }

  get numberofpoints() {
    return this.arr[3];
  }

  get numberofpointattributes() {
    return this.arr[4];
  }

  get numberoftriangles() {
    return this.arr[9];
  }

  get numberofcorners() {
    return this.arr[10];
  }

  get numberoftriangleattributes() {
    return this.arr[11];
  }

  get numberofsegments() {
    return this.arr[14];
  }

  get numberofholes() {
    return this.arr[16];
  }

  get numberofregions() {
    return this.arr[18];
  }

  get numberofedges() {
    return this.arr[22];
  }

  get pointlist() {
    return heapToArray(this.Module, this.arr[0], this.numberofpoints * 2, Float64Array);
  }

  get pointmarkerlist() {
    return heapToArray(this.Module, this.arr[2], this.numberofpoints, Int32Array);
  }

  get trianglelist() {
    return heapToArray(this.Module, this.arr[5], this.numberoftriangles * this.numberofcorners, Int32Array);
  }

  get triangleattributelist() {
    return heapToArray(this.Module, this.arr[6], this.numberoftriangles * this.numberoftriangleattributes, Float64Array);
  }

  get segmentlist() {
    return heapToArray(this.Module, this.arr[12], this.numberofsegments * 2, Int32Array);
  }

  get segmentmarkerlist() {
    return heapToArray(this.Module, this.arr[13], this.numberofsegments, Int32Array);
  }

  get holelist() {
    return heapToArray(this.Module, this.arr[15], this.numberofholes * 2, Float64Array);
  }

  get regionlist() {
    return heapToArray(this.Module, this.arr[17], this.numberofregions * 4, Float64Array);
  }

  get edgelist() {
    return heapToArray(this.Module, this.arr[19], this.numberofedges * 2, Int32Array);
  }

  get edgemarkerlist() {
    return heapToArray(this.Module, this.arr[20], this.numberofedges, Int32Array);
  }

  get neighborlist() {
    return heapToArray(this.Module, this.arr[8], this.numberoftriangles * 3, Int32Array);
  }
}

export async function triangulatePslg(data, switches = null) {
  clearTriangleLogs();
  const Module = await getTriangleModule();
  const input = new TriangulateIO(Module, data);
  const output = new TriangulateIO(Module);
  const switchString = buildSwitchesString(switches);
  const switchPtr = stringToHeap(Module, switchString);
  try {
    Module._triangulate(switchPtr, input.ptr, output.ptr, 0);
    return {
      pointlist: output.pointlist,
      pointmarkerlist: output.pointmarkerlist,
      trianglelist: output.trianglelist,
      triangleattributelist: output.triangleattributelist,
      segmentlist: output.segmentlist,
      segmentmarkerlist: output.segmentmarkerlist,
      edgelist: output.edgelist,
      edgemarkerlist: output.edgemarkerlist,
      neighborlist: output.neighborlist,
      numberofpoints: output.numberofpoints,
      numberoftriangles: output.numberoftriangles,
      numberofcorners: output.numberofcorners,
      numberofedges: output.numberofedges
    };
  } catch (error) {
    const logged = summarizeTriangleLogs();
    resetTriangleModule();
    const message = logged.length
      ? `Triangle meshing failed (${switchString}): ${logged.join(' ')}`
      : error?.message || String(error);
    throw new Error(message);
  } finally {
    Module._free(switchPtr);
    input.destroy(true);
    output.destroy();
  }
}
