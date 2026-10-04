import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

import type { Route } from "./+types/root";
import "./app.css";
import { LS_KEY } from "./reader/model";

/**
 * The page is dark until told otherwise. The HTML says so, and this runs
 * before the first paint to apply a theme the visitor chose, so neither a
 * light system nor a saved choice makes the page flash the other theme
 * while the app loads.
 */
const THEME_SCRIPT = `try {
  var theme = JSON.parse(localStorage.getItem(${JSON.stringify(LS_KEY)})).prefs.theme;
  if (theme === "light") document.documentElement.dataset.theme = "light";
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
} catch (error) {}`;

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  {
    rel: "stylesheet",
    // Atkinson Hyperlegible for the interface, Literata for the lines being read.
    href: "https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Literata:opsz,wght@7..72,400;7..72,600&display=swap",
  },
];

/**
 * Describes the tool for search engines. The page is rendered to HTML (the home
 * page at build time), so this and the content itself are there before any
 * JavaScript runs.
 */
const STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "DialogueLab",
  applicationCategory: "MultimediaApplication",
  operatingSystem: "Any",
  description: "French-first text to speech using Google Cloud Chirp 3: HD and Gemini-TTS voices.",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  featureList: [
    "Chirp 3: HD voices",
    "Gemini-TTS style prompts",
    "Two-speaker dialogue",
    "MP3, WAV and OGG Opus output",
  ],
};

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    // The theme script may change data-theme before React hydrates.
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#09090b" />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <Meta />
        <Links />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }} />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Something went wrong";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "Page not found" : `Error ${error.status}`;
    details = error.status === 404 ? "That page does not exist." : error.statusText || details;
  } else if (import.meta.env.DEV && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-16">
      <h1 className="text-2xl font-semibold text-zinc-100">{message}</h1>
      <p className="mt-2 text-sm text-zinc-400">{details}</p>
      <a href="/" className="mt-6 inline-block text-sm font-medium text-emerald-400 hover:text-emerald-300">
        Back to DialogueLab
      </a>
      {stack && (
        <pre className="mt-6 overflow-x-auto rounded-md border border-zinc-800 bg-zinc-900 p-4 text-xs text-zinc-400">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
