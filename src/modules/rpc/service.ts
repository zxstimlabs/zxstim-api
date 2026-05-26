const FORWARD_HEADERS = new Set(["content-type", "accept"]);

const PROXY_USER_AGENT = "zxstim-api/1.0";

export abstract class RpcService {
  static async proxy(request: Request, upstream: string): Promise<Response> {
    const outboundHeaders = new Headers();
    for (const [key, value] of request.headers) {
      if (FORWARD_HEADERS.has(key.toLowerCase())) {
        outboundHeaders.set(key, value);
      }
    }
    outboundHeaders.set("user-agent", PROXY_USER_AGENT);

    const init: RequestInit = {
      method: request.method,
      headers: outboundHeaders,
      redirect: "follow",
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = await request.arrayBuffer();
    }

    const response = await fetch(upstream, init);

    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    responseHeaders.delete("transfer-encoding");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  }
}
