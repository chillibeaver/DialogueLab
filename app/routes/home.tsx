import type { Route } from "./+types/home";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "TTS Studio" },
    { name: "description", content: "French-first text-to-speech powered by Google Cloud voices." },
  ];
}

// Placeholder page until the frontend is built; it confirms SSR works end to end.
export default function Home() {
  return (
    <main className="mx-auto max-w-xl px-4 pt-16">
      <h1 className="text-2xl font-semibold">TTS Studio</h1>
      <p className="mt-4 text-gray-700 dark:text-gray-300">
        The API is running. See <code>/api/catalog</code> for available voices and languages.
      </p>
    </main>
  );
}
