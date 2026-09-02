export default {
  async fetch(request, env, ctx) {
    return new Response(JSON.stringify({ status: "ok", message: "Worker running" }), {
      headers: { "content-type": "application/json" },
    });
  },
  async scheduled(event, env, ctx) {
    console.log("Cron executed");
  }
};