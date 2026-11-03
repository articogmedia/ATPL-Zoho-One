import { warmZohoToken } from "@/lib/zoho/client";

export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  try {
    await warmZohoToken();
    console.info(`[warm] zoho token ${Date.now() - started}ms`);
    return new Response(null, { status: 200 });
  } catch (error) {
    console.warn(`[warm] zoho token failed ${Date.now() - started}ms`, error instanceof Error ? error.message : "unknown error");
    return new Response(null, { status: 503 });
  }
}
