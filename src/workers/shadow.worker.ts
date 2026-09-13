/// <reference lib="webworker" />
/**
 * Off-main-thread shade engine. Layers are sent once ("init"); each "compute"
 * message carries a sun position and a request id. The main thread ignores
 * responses whose id is older than the latest request.
 */
import { computeShadowResult, createShadowEngine, type ShadeResult, type ShadowEngine } from "../lib/shadow-engine";
import type { CasterFlags, ShadeLayers, SunPosition } from "../types/map";

export type ShadowWorkerRequest =
  | { type: "init"; layers: ShadeLayers }
  | { type: "compute"; id: number; sun: SunPosition; flags: CasterFlags };

export type ShadowWorkerResponse = { type: "result"; id: number; result: ShadeResult };

let engine: ShadowEngine | null = null;

self.onmessage = (ev: MessageEvent<ShadowWorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    engine = createShadowEngine(msg.layers);
    return;
  }
  if (msg.type === "compute") {
    const res: ShadowWorkerResponse = { type: "result", id: msg.id, result: computeShadowResult(engine, msg.sun, msg.flags) };
    self.postMessage(res);
  }
};
