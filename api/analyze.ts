export const config = { runtime: "edge" };

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-api-key"
};

const ttl = 900; // 15 min cache
const upstreamTimeout = 12000; // 12s timeout

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return j({ error: "method_not_allowed" }, 405);

  // 1) Client auth
  const clientKey = req.headers.get("x-api-key");
  if (!clientKey || clientKey !== process.env.PUBLIC_API_KEY) {
    return j({ error: "unauthorized" }, 401);
  }

  // 2) Body lezen
  let body: any;
  try { body = await req.json(); } catch { return j({ error: "invalid_json" }, 400); }
  const topic = (body?.topic || "").toString().trim();
  const language = (body?.language || "en").toString();
  const geo = (body?.geo || "").toString();
  if (!topic) return j({ error: "missing_topic" }, 400);

  // 3) Cache check (Edge cache)
  const cacheKey = `insight:${language}:${geo}:${topic.toLowerCase()}`;
  const cache = await caches.open("insight-cache");
  const cached = await cache.match(cacheKey);
  if (cached) {
    return new Response(await cached.blob(), {
      status: 200,
      headers: { ...cors, "content-type": "application/json", "x-cache": "HIT" }
    });
  }

  // 4) Call naar jouw Lovable-flow (orchestrator)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), upstreamTimeout);

  try {
    const resp = await fetch(process.env.LOVABLE_FLOW_URL as string, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.LOVABLE_FLOW_TOKEN
          ? { authorization: `Bearer ${process.env.LOVABLE_FLOW_TOKEN}` }
          : {})
      },
      body: JSON.stringify({ topic, language, geo }),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return j({ error: "upstream_error", status: resp.status, detail: text.slice(0, 300) }, 502);
    }

    const data = await resp.text(); // text zodat we het 1-op-1 kunnen cachen
    const res = new Response(data, {
      status: 200,
      headers: {
        ...cors,
        "content-type": "application/json",
        "x-cache": "MISS",
        "cache-control": `public, max-age=${ttl}`
      }
    });

    // 5) In cache zetten (async)
    await cache.put(cacheKey, new Response(data, { headers: { "content-type": "application/json" } }), { ignoreMethod: true });

    return res;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    return j({ error: aborted ? "upstream_timeout" : "gateway_exception" }, 504);
  }
}

function j(obj: any, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "content-type": "application/json" }
  });
}
