// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/run/workers.js — the worker lifecycle of the three Seep / Slope runs behind one
// explicit adapter. Refactor step 9c (01-monolith-map.md §3.4 **#8** "workers are module
// singletons keyed by run-id", §5 rows 1-3, §6.2 step 9c; PLAN §2 row 18c). Replaces the six
// module-level variables of legacy-controller.js (integration-r f5b4a9b lines 301-306:
// stage6BishopWorker / RunId, SeepageWorker / RunId, DeformationWorker / RunId) and the creation
// halves of stage6BishopEnsureWorker 3872-3918, EnsureSeepageWorker 3920-3994 and
// EnsureDeformationWorker 3996-4116.
//
// Why an adapter rather than three closures: the monolith's `onmessage` handlers closed over the
// singleton *and* read `S?.stage6?.bishop` at message time, so the run logic, the run-id guard and
// the worker's identity were one tangle that could not be tested without a browser. Here the
// adapter owns nothing but `{ worker, runId }` per kind; the guard is the `handled:false` branch
// of the pure reducers in search.js / seepage.js / deformation.js, and the host passes a
// `getState()` hook that resolves the active CPT's bishop block at message time — the one thing
// the package cannot know.
//
//   const workers = createWorkerAdapter();
//   workers.ensure('seepage', { onMessage(payload, adapter){…}, onError(adapter){…} }) → Worker|null
//   workers.nextRunId('seepage') → n     workers.runId('seepage') → n
//   workers.post('seepage', message)     workers.stop('seepage', { silent, runId })
//   workers.terminate('seepage')         workers.terminateAll()      workers.get('seepage')
//
// `stop`:
//   · silent (an invalidation, a CPT switch — incl. the deformation worker, PLAN §4 defect 2 —
//     or the start of another run) always terminates: the run is abandoned, not finished;
//   · non-silent posts the kind's stop message so a running solve can finish early and keep its
//     latest solved state. The search worker has no stop protocol (it never yields), so it is
//     terminated either way — exactly as stage6BishopStopSearch did.
//
// Run ids are per kind and monotonic, so a reply for an abandoned run is dropped by the guard even
// when a terminated worker's last message is already in flight.

/** The three engines of the app (map §5 rows 1-3). */
export const WORKER_KINDS = Object.freeze(['search', 'seepage', 'deformation']);

/** The message type each kind accepts to stop a running solve; the search worker has none. */
export const WORKER_STOP_TYPES = Object.freeze({
  search: null,
  seepage: 'stop-seepage',
  deformation: 'stop-deformation'
});

/**
 * The production worker constructors. The `new Worker(new URL(…, import.meta.url), {type:'module'})`
 * literals must stay statically analysable — that is how Vite discovers the three worker entry
 * modules and emits their chunks — so they are written out per kind rather than built from a map.
 */
export const DEFAULT_WORKER_FACTORIES = Object.freeze({
  search: () => new Worker(new URL('../../stage6-bishop-worker.js', import.meta.url), {type:'module'}),
  seepage: () => new Worker(new URL('../../seepage/seepage-worker.js', import.meta.url), {type:'module'}),
  deformation: () => new Worker(new URL('../../deformation/deformation-worker.js', import.meta.url), {type:'module'})
});

/**
 * One adapter per host (the controller creates a single instance at module scope; a verifier can
 * create as many as it likes with stub factories).
 *
 * @param {object} [options]
 * @param {object} [options.factories]  kind → () => Worker; defaults to the three real workers
 * @param {function} [options.hasWorker]  the environment check (default: a global `Worker`)
 */
export function createWorkerAdapter({ factories = DEFAULT_WORKER_FACTORIES, hasWorker = () => typeof Worker !== 'undefined' } = {}){
  const slots = Object.create(null);
  for(const kind of WORKER_KINDS) slots[kind] = { worker: null, runId: 0 };

  const slot = (kind) => {
    const found = slots[kind];
    if(!found) throw new Error(`unknown worker kind: ${kind}`);
    return found;
  };

  const adapter = {
    /** The live worker of `kind`, or null. */
    get(kind){
      return slot(kind).worker;
    },
    /** The last run id handed out for `kind` (0 before the first run). */
    runId(kind){
      return slot(kind).runId;
    },
    /** The next run id for `kind` — bumped exactly where the monolith bumped its counter. */
    nextRunId(kind){
      const s = slot(kind);
      s.runId += 1;
      return s.runId;
    },
    /**
     * The worker of `kind`, created and bound on first use. `null` when the environment has no
     * Worker constructor (SSR, Node, the golden Tier-B loader) — the run handlers turn that into
     * their "Web Worker is not available in this browser context." rejection.
     */
    ensure(kind, { onMessage, onError } = {}){
      const s = slot(kind);
      if(s.worker || !hasWorker()) return s.worker;
      const worker = factories[kind]();
      s.worker = worker;
      worker.onmessage = (event)=>{
        onMessage?.(event?.data || {}, adapter);
      };
      worker.onerror = ()=>{
        onError?.(adapter);
        adapter.terminate(kind);
      };
      return s.worker;
    },
    /** Post to the live worker of `kind`; a no-op when there is none. */
    post(kind, message){
      const worker = slot(kind).worker;
      if(!worker) return false;
      worker.postMessage(message);
      return true;
    },
    /**
     * Stop the run of `kind`. Returns what happened: `'terminated'` (the worker is gone),
     * `'requested'` (a stop message was posted and the worker keeps running until it yields) or
     * `'none'` (there was no worker, or nothing to ask).
     */
    stop(kind, { silent = false, runId = null } = {}){
      const s = slot(kind);
      if(!s.worker) return 'none';
      const stopType = WORKER_STOP_TYPES[kind];
      if(silent || !stopType){
        adapter.terminate(kind);
        return 'terminated';
      }
      if(!runId) return 'none';
      s.worker.postMessage({type:stopType, runId});
      return 'requested';
    },
    /** Terminate and forget the worker of `kind`; the next `ensure` builds a fresh one. */
    terminate(kind){
      const s = slot(kind);
      if(!s.worker) return false;
      s.worker.terminate();
      s.worker = null;
      return true;
    },
    /** Terminate every live worker (a CPT switch, a teardown). */
    terminateAll(){
      return WORKER_KINDS.filter((kind)=>adapter.terminate(kind));
    },
    /** Debug / verifier view: which kinds hold a worker and at which run id. */
    snapshot(){
      const out = {};
      for(const kind of WORKER_KINDS) out[kind] = { alive: !!slots[kind].worker, runId: slots[kind].runId };
      return out;
    }
  };
  return adapter;
}
