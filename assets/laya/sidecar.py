"""Line-delimited local Laya inference for AelionBot's opt-in shadow decisions."""

import json
import os
import sys
import time


def main():
    if hasattr(os, "nice"):
        os.nice(10)
    runtime = os.environ.get("AELION_LAYA_RUNTIME", "standard")
    started = time.monotonic()
    if runtime == "mlx":
        import mlx.core as mx
        mx.set_cache_limit(64 * 1024 * 1024)
        import laya_mlx as laya

        model = os.environ.get("AELION_LAYA_MODEL", "aac6fef/laya-multilingual-mlx")
    elif runtime == "standard":
        import laya

        model = os.environ.get("AELION_LAYA_MODEL", "convaiinnovations/laya-multilingual")
    else:
        raise ValueError("AELION_LAYA_RUNTIME must be standard or mlx")

    agent = laya.load(model)
    agent.predict("ready", {"decision": {"type": "choice", "instructions": "Choose observe.",
                  "criteria": {"observe": "Observe", "participate": "Participate"}}})
    readiness = {"ready": True, "loadMs": round((time.monotonic() - started) * 1000)}
    if runtime == "mlx":
        readiness.update(activeMemoryBytes=mx.get_active_memory(), cacheMemoryBytes=mx.get_cache_memory())
    print(json.dumps(readiness), flush=True)
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            started = time.monotonic()
            result = agent.predict(request["state"], request["questions"])
            response = {"id": request["id"], "result": result,
                        "inferenceMs": round((time.monotonic() - started) * 1000)}
            if runtime == "mlx":
                response.update(activeMemoryBytes=mx.get_active_memory(), cacheMemoryBytes=mx.get_cache_memory())
        except Exception as exc:
            response = {"id": request.get("id") if isinstance(request, dict) else None,
                        "error": str(exc)}
        print(json.dumps(response, ensure_ascii=False, default=str), flush=True)


if __name__ == "__main__":
    main()
