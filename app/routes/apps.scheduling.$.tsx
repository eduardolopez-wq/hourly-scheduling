import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * /apps/scheduling/portal/:token → redirige al portal de la app.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const splat = params["*"] ?? "";
  const portalMatch = splat.match(/^portal\/([^/]+)/);
  if (portalMatch) {
    const token = portalMatch[1];
    return redirect(`${new URL(request.url).origin}/portal/${token}`);
  }
  await authenticate.public.appProxy(request);
  return new Response("Not Found", { status: 404 });
};
