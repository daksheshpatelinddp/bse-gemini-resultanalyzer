/*
 * BSE GEMINI RESULT ANALYZER - BASIC INITIALIZATION FILE
 * Repository: bse-gemini-resultanalyzer
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Basic health check endpoint
    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({
          status: "active",
          project: "bse-gemini-resultanalyzer",
          message: "Worker successfully connected to Cloudflare and GitHub.",
          kv_bound: !!env.BSE_GEMINI_DATA
        }, null, 2),
        {
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    return new Response(JSON.stringify({ error: "Endpoint not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  },

  async scheduled(event, env, ctx) {
    console.log("Cron trigger executed successfully.");
  }
};