import { useEffect, useRef, useState } from "react";
import type { CasterFlags, ShadeLayers, SunPosition } from "../types/map";
import type { ShadeResult, ShadowEngine } from "./shadow-engine";
import type { ShadowWorkerRequest, ShadowWorkerResponse } from "../workers/shadow.worker";

interface Job {
  sun: SunPosition;
  flags: CasterFlags;
}
interface Completed extends Job {
  layers: ShadeLayers;
  result: ShadeResult;
}

/** Coalesce slider requests, discard obsolete responses, and recover from worker failure. */
export function useShadows(layers: ShadeLayers | null, sun: SunPosition | null, flags: CasterFlags) {
  const [completed, setCompleted] = useState<Completed | null>(null);
  const requestRef = useRef<((job: Job) => void) | null>(null);

  useEffect(() => {
    if (!layers) return;
    let alive = true;
    let worker: Worker | null = null;
    let latestJob: Job | null = null;
    let currentJob: Job | null = null;
    let pending: Job | null = null;
    let fallbackEngine: ShadowEngine | null = null;
    let busy = false;
    let requestId = 0;

    const fallback = async (job: Job) => {
      const engine = await import("./shadow-engine");
      if (!alive || latestJob !== job) return;
      fallbackEngine ??= engine.createShadowEngine(layers);
      const result = engine.computeShadowResult(fallbackEngine, job.sun, job.flags);
      if (alive && latestJob === job) setCompleted({ ...job, layers, result });
    };
    const send = (job: Job) => {
      if (!worker) { void fallback(job); return; }
      busy = true;
      currentJob = job;
      try {
        worker.postMessage({ type: "compute", id: ++requestId, sun: job.sun, flags: job.flags } satisfies ShadowWorkerRequest);
      } catch {
        recover();
      }
    };
    const recover = () => {
      worker?.terminate();
      worker = null;
      busy = false;
      pending = null;
      // Recover the failed request immediately, without requiring another slider change.
      if (alive && latestJob) void fallback(latestJob);
    };

    try {
      worker = new Worker(new URL("../workers/shadow.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (ev: MessageEvent<ShadowWorkerResponse>) => {
        if (!alive || ev.data.id !== requestId) return;
        if (!pending && currentJob) setCompleted({ ...currentJob, layers, result: ev.data.result });
        busy = false;
        if (pending) {
          const next = pending;
          pending = null;
          send(next);
        }
      };
      worker.onerror = recover;
      worker.postMessage({ type: "init", layers } satisfies ShadowWorkerRequest);
    } catch {
      recover();
    }

    requestRef.current = (job) => {
      latestJob = job;
      if (busy) pending = job;
      else send(job);
    };
    return () => {
      alive = false;
      worker?.terminate();
      requestRef.current = null;
    };
  }, [layers]);

  useEffect(() => {
    if (!layers || !sun) return;
    const raf = requestAnimationFrame(() => requestRef.current?.({ sun, flags }));
    return () => cancelAnimationFrame(raf);
  }, [layers, sun, flags]);

  return {
    result: completed?.layers === layers ? completed?.result ?? null : null,
    isComputing: !!layers && !!sun && (completed?.layers !== layers || completed.sun !== sun || completed.flags !== flags),
  };
}
