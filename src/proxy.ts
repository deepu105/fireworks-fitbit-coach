import { NextRequest, NextResponse } from "next/server";
import { getAuth0 } from "./lib/auth0";
import { ConfigurationError } from "./lib/config";

export async function proxy(request: NextRequest) {
  try {
    return await getAuth0().middleware(request);
  } catch (error) {
    // Let the home page show setup instructions before credentials are added.
    if (error instanceof ConfigurationError && request.nextUrl.pathname === "/") {
      return NextResponse.next();
    }
    return NextResponse.json({ error: "Check the Auth0 configuration in .env.local." }, { status: 503 });
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};
